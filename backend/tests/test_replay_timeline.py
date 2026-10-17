"""The replay timeline (lightning/timeline.py) and GET /replay/events, /replay/series, plus the
`replay` flag on approach advisories. Synthetic GLM files: names only, with glm.parse stubbed, so
the tests don't need the 150 MB replay download."""

import json
import math
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import psycopg
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from psycopg.rows import dict_row

from alerts import approach, engine
from app.cache import api_cache
from app.config import BACKEND_DIR, get_settings
from app.db import get_pool
from app.routers import replay as replay_route
from app.schemas import LightningApproach, ReplayEvent, ReplaySeries, ReplayStatus
from lightning import cells as cellmod
from lightning import glm, timeline
from lightning.replay import runner

T0 = datetime(2031, 1, 6, 17, 0, tzinfo=timezone.utc)
SEC = timedelta(seconds=1)
MIN = timedelta(minutes=1)
SITE = engine.Site("test-a", 25.0, -84.5)
MILES_PER_DEG_LAT = engine.EARTH_RADIUS_MI * math.pi / 180
WINDOW = "2031-01-06_1700-1740"
N_FILES = 120   # 40 minutes of 20-second files


def name(i: int) -> str:
    t = T0 + i * 20 * SEC
    doy = t.timetuple().tm_yday
    return f"OR_GLM-L2-LCFA_G19_s{t:%Y}{doy:03d}{t:%H%M%S}0_e0_c0.nc"


def flash(file_i: int, miles: float, offset_s: int = 5) -> glm.Flash:
    """A flash `miles` south of the test site, `offset_s` into file `file_i`."""
    return glm.Flash(T0 + file_i * 20 * SEC + offset_s * SEC, SITE.lat - miles / MILES_PER_DEG_LAT, SITE.lon,
                     None, name(file_i))


@pytest.fixture
def storm(tmp_path, monkeypatch):
    """A 40-minute window: strikes 3 mi away in files 2 and 10, then 2 mi away in file 110 (36 min later,
    so the first stop-work has cleared and a second one starts). Returns {file name: flashes}."""
    folder = tmp_path / "replay" / WINDOW
    folder.mkdir(parents=True)
    by_file = {name(i): [] for i in range(N_FILES)}
    by_file[name(2)] = [flash(2, 3.0)]
    by_file[name(10)] = [flash(10, 4.0), flash(10, 30.0)]   # the 30-mile one counts as a flash, not a strike
    by_file[name(110)] = [flash(110, 2.0)]
    for n in by_file:
        (folder / n).write_bytes(b"x")
    monkeypatch.setattr(timeline, "REPLAY_DIR", tmp_path / "replay")
    monkeypatch.setattr(timeline, "_sites", lambda: [SITE])
    monkeypatch.setattr(glm, "parse", lambda data, file_name: ([], by_file[file_name]))
    monkeypatch.setattr(timeline, "_cache", {})
    return by_file


def test_window_times(storm):
    t = timeline.window_times(WINDOW)
    assert t["window_start"] == T0
    assert t["window_end"] == T0 + N_FILES * 20 * SEC
    assert t["quiet_until"] == t["window_end"] + 31 * MIN


def test_the_whole_storm_is_worked_out(storm):
    tl = timeline.simulate(WINDOW)
    got = [(e["kind"], datetime.fromisoformat(e["at"]), e["site_id"], e["distance_mi"]) for e in tl["events"]]
    first, second = T0 + 45 * SEC, T0 + 110 * 20 * SEC + 5 * SEC
    last_of_first = T0 + 10 * 20 * SEC + 5 * SEC
    assert got == [
        ("stop_work_start", first, "test-a", 3.0),
        ("all_clear", last_of_first + 30 * MIN, "test-a", None),        # extended by the file-10 strike
        ("stop_work_start", second, "test-a", 2.0),                     # a new storm: a new stop-work
        ("all_clear", second + 30 * MIN, "test-a", None),               # in the quiet tail
    ]
    assert [e["id"] for e in tl["events"]] == [f"{WINDOW}:{i}" for i in range(4)]
    assert sum(tl["flashes_per_minute"].values()) == 4


def test_approach_starts_come_from_the_forecast_rules(storm, monkeypatch):
    issue_at = T0 + 5 * 20 * SEC + 20 * SEC   # the cycle for file 5

    def arrivals(sites, found, stop_work, now):
        if now == issue_at and "test-a" not in stop_work:
            return {"test-a": cellmod.Arrival("c1", now + 20 * MIN, 20, 250.0, 17.94, 18.0, 70.0, 40)}
        return {"test-a": None}
    monkeypatch.setattr(approach, "arrivals_for", arrivals)
    monkeypatch.setattr(glm, "parse", lambda data, file_name: ([], []))   # no stop-work in the way
    tl = timeline.simulate(WINDOW)
    assert [(e["kind"], datetime.fromisoformat(e["at"]), e["distance_mi"]) for e in tl["events"]] == [
        ("approach_start", issue_at, 17.9)]


def test_series_bins_and_partial_bin(storm):
    tl = timeline.simulate(WINDOW)
    full = timeline.series(tl, T0 + 3 * 60 * MIN)
    assert [b["start"] for b in full] == [T0 + i * 5 * MIN for i in range(15)]   # 71 min: the last bin is partial
    assert sum(b["flashes"] for b in full) == 4
    assert full[0]["flashes"] == 3 and full[0]["sites_in_stop_work"] == 1   # files 2 and 10
    assert full[1]["flashes"] == 0                      # file 10 is at 3:20, still bin 0
    # Bin ends 17:30, 17:35, 17:40, 17:45: the first stop-work shows until 17:33:25, the second from the
    # 17:37:00 cycle (its strike was at 17:36:45).
    assert [b["sites_in_stop_work"] for b in full][5:9] == [1, 0, 1, 1]
    partial = timeline.series(tl, T0 + 2 * MIN)         # 17:02, before the file-10 strike
    assert len(partial) == 1 and partial[0]["flashes"] == 1 and partial[0]["sites_in_stop_work"] == 1
    assert timeline.series(tl, T0 - MIN) == []


def test_built_once_saved_and_rebuilt_when_files_change(storm):
    assert timeline.get(WINDOW) is None
    built = timeline.build(WINDOW)
    assert (timeline.REPLAY_DIR / WINDOW / "timeline.json").exists()
    timeline._cache.clear()
    assert timeline.get(WINDOW) == json.loads(json.dumps(built))         # from disk
    (timeline.REPLAY_DIR / WINDOW / name(0)).write_bytes(b"different size")
    assert timeline.get(WINDOW) is None                                    # stale: rebuild


# ---------- routes ----------

class FakePool:
    def __init__(self, conn=None):
        self.conn = conn

    @contextmanager
    def connection(self, timeout=None):
        yield self.conn


STORED: list[dict] = []   # what approach.replay_approach_starts returns in route tests


@pytest.fixture
def client(monkeypatch):
    api_cache.invalidate()
    STORED.clear()
    monkeypatch.setattr(runner, "window", None)
    monkeypatch.setattr(runner, "ended_at", None)
    monkeypatch.setattr(runner, "times", None)
    monkeypatch.setattr(approach, "replay_approach_starts", lambda conn: list(STORED))
    app = FastAPI()
    app.include_router(replay_route.router)
    app.dependency_overrides[get_pool] = FakePool
    yield TestClient(app)
    api_cache.invalidate()


def test_nothing_before_any_replay(client):
    assert client.get("/replay/events").json() == []
    assert client.get("/replay/series").json() == {"bin_minutes": 5, "bins": []}
    status = client.get("/replay/status").json()
    assert status["window_start"] is None and status["window_end"] is None and status["quiet_until"] is None


def test_503_while_the_timeline_is_being_built(client, storm, monkeypatch):
    started = []
    monkeypatch.setattr(timeline, "ensure", started.append)
    monkeypatch.setattr(runner, "window", WINDOW)
    r = client.get("/replay/events")
    assert r.status_code == 503 and r.headers["Retry-After"] == "5" and started == [WINDOW]


def test_events_and_series_after_a_run(client, storm, monkeypatch):
    timeline.build(WINDOW)
    monkeypatch.setattr(runner, "window", WINDOW)
    monkeypatch.setattr(runner, "times", timeline.window_times(WINDOW))
    monkeypatch.setattr(runner, "ended_at", T0 + 12 * MIN)   # stopped early
    STORED.append({"id": "adv_test1", "at": T0 + 20 * MIN, "kind": "approach_start", "site_id": "test-a",
                   "distance_mi": 14.2})
    events = [ReplayEvent(**e) for e in client.get("/replay/events").json()]
    assert [(e.kind, e.id) for e in events] == [
        ("stop_work_start", f"{WINDOW}:0"), ("approach_start", "adv_test1"), ("all_clear", f"{WINDOW}:1"),
        ("stop_work_start", f"{WINDOW}:2"), ("all_clear", f"{WINDOW}:3")]   # merged, oldest first
    series = ReplaySeries(**client.get("/replay/series").json())
    assert [b.start for b in series.bins] == [T0, T0 + 5 * MIN, T0 + 10 * MIN]
    status = ReplayStatus(**client.get("/replay/status").json())
    assert status.window_start == T0 and status.quiet_until == T0 + 71 * MIN


def test_precomputed_approach_starts_are_never_served(client, storm, monkeypatch):
    """The forecast run ahead of time predicts an advisory; the app (STORED) never issued it."""
    issue_at = T0 + 105 * 20 * SEC + 20 * SEC   # 17:35:20, between the two stop-works

    def arrivals(sites, found, stop_work, now):
        hit = now == issue_at and "test-a" not in stop_work
        return {"test-a": cellmod.Arrival("c1", now + 20 * MIN, 20, 250.0, 17.9, 18.0, 70.0, 40) if hit else None}
    monkeypatch.setattr(approach, "arrivals_for", arrivals)
    built = timeline.build(WINDOW)
    assert any(e["kind"] == "approach_start" for e in built["events"])        # it's in the file, for checks
    monkeypatch.setattr(runner, "window", WINDOW)
    kinds = [e["kind"] for e in client.get("/replay/events").json()]
    assert "approach_start" not in kinds and kinds.count("stop_work_start") == 2


@pytest.fixture
def conn():
    url = get_settings().database_url
    if not url:
        pytest.skip("DATABASE_URL not set")
    with psycopg.connect(url, row_factory=dict_row, connect_timeout=15) as conn:
        try:
            yield conn
        finally:
            conn.rollback()


def test_stored_replay_advisories_become_approach_starts(conn):
    def add(replay, at, dist):
        return conn.execute(
            """INSERT INTO lightning_advisories (site_id, replay, status, started_at, updated_at, arrival_at, first_arrival_at,
                                                 from_bearing_deg, heading_deg, speed_mph, distance_mi, cell_flashes)
               VALUES ('big-bend', %s, 'cleared', %s, %s, %s, %s, 250, 70, 18, %s, 40) RETURNING id""",
            (replay, at, at, at + 20 * MIN, at + 20 * MIN, dist)).fetchone()["id"]
    replayed, live = add(True, T0, 14.25), add(False, T0, 9.0)
    starts = {e["id"]: e for e in approach.replay_approach_starts(conn)}
    assert live not in starts                                  # never live advisories
    assert starts[replayed] == {"id": replayed, "at": T0, "kind": "approach_start", "site_id": "big-bend",
                                "distance_mi": 14.2}
    ReplayEvent(**starts[replayed])


# ---------- the replay flag on advisories ----------

def advisory(**extra):
    return {"arrival_at": T0 + 20 * MIN, "from_bearing_deg": 250.0, "heading_deg": 70.0, "speed_mph": 18.0,
            "distance_mi": 17.9, "started_at": T0, "updated_at": T0, **extra}


def test_advisories_say_whether_they_are_replay():
    assert LightningApproach(**approach.view(advisory(replay=True), T0)).replay is True
    assert LightningApproach(**approach.view(advisory(replay=False), T0)).replay is False
    assert approach.view(advisory(), T0)["replay"] is False


def test_mocks_match_the_schemas():
    mocks = BACKEND_DIR.parent / "shared" / "mocks"
    [ReplayEvent(**e) for e in json.loads((mocks / "replay_events.json").read_text())]
    ReplaySeries(**json.loads((mocks / "replay_series.json").read_text()))
    status = ReplayStatus(**json.loads((mocks / "replay_status.json").read_text()))
    assert status.window_start is not None
