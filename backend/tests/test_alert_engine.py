"""Alert engine tests.

They run the engine's real SQL against DATABASE_URL, each test inside one transaction that is
always rolled back, so nothing is left behind. Skipped when DATABASE_URL is not set.

    cd backend && python -m pytest -v
"""

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import psycopg
import pytest
from psycopg.rows import dict_row

from alerts import engine
from alerts.engine import Site
from app.config import get_settings

T0 = datetime(2025, 8, 4, 22, 0, tzinfo=timezone.utc)
MIN = timedelta(minutes=1)
MILES_PER_DEG_LAT = engine.EARTH_RADIUS_MI * math.pi / 180

# Test sites in the open Gulf, far from every real site. B is 6 miles due north of A.
SITE_A = Site("test-site-a", 25.0, -84.5)
SITE_B = Site("test-site-b", 25.0 + 6 / MILES_PER_DEG_LAT, -84.5)
SITES = [SITE_A, SITE_B]


@dataclass(frozen=True)
class FakeFlash:
    ts: datetime
    lat: float
    lon: float


def flash(site: Site, miles: float, at: datetime, direction: int = -1) -> FakeFlash:
    """A flash `miles` due south (default) or north (direction=+1) of a site."""
    return FakeFlash(at, site.lat + direction * miles / MILES_PER_DEG_LAT, site.lon)


@pytest.fixture
def conn():
    url = get_settings().database_url
    if not url:
        pytest.skip("DATABASE_URL not set")
    with psycopg.connect(url, row_factory=dict_row, connect_timeout=15) as conn:
        for i, s in enumerate(SITES):
            conn.execute(
                """INSERT INTO sites (plant_id, id, name, utility, county, lat, lon, technology,
                                      capacity_mw, timezone)
                   VALUES (%s, %s, 'Test', 'Test', 'Test', %s, %s, 'Test', 0, 'America/New_York')""",
                (-900_000 - i, s.id, s.lat, s.lon),
            )
        try:
            yield conn
        finally:
            conn.rollback()


def cycle(conn, flashes, now, replay=False):
    return engine.process(conn, flashes, now, SITES, replay=replay)


def alerts_for(conn, site: Site, replay=False) -> list[dict]:
    return conn.execute(
        "SELECT * FROM alerts WHERE site_id = %s AND replay = %s ORDER BY started_at, id",
        (site.id, replay),
    ).fetchall()


def events_for(conn, alert_id: str) -> list[str]:
    rows = conn.execute("SELECT event FROM alert_events WHERE alert_id = %s ORDER BY id", (alert_id,))
    return [r["event"] for r in rows]


# ---------- the six required behaviors ----------

def test_first_strike_creates_alert(conn):
    cycle(conn, [flash(SITE_A, 2.0, T0)], now=T0 + timedelta(seconds=20))

    [alert] = alerts_for(conn, SITE_A)
    assert alert["status"] == "active"
    assert alert["type"] == "lightning"
    assert alert["started_at"] == T0
    assert alert["last_strike_at"] == T0
    assert alert["all_clear_at"] == T0 + 30 * MIN
    assert alert["last_strike_distance_mi"] == pytest.approx(2.0, abs=0.01)
    assert events_for(conn, alert["id"]) == ["created"]


def test_newer_strike_extends_all_clear(conn):
    cycle(conn, [flash(SITE_A, 2.0, T0)], now=T0 + MIN)
    cycle(conn, [flash(SITE_A, 4.5, T0 + 10 * MIN)], now=T0 + 11 * MIN)

    [alert] = alerts_for(conn, SITE_A)  # same alert, not a second one
    assert alert["all_clear_at"] == T0 + 40 * MIN
    assert alert["last_strike_at"] == T0 + 10 * MIN
    assert alert["last_strike_distance_mi"] == pytest.approx(4.5, abs=0.01)
    assert alert["started_at"] == T0
    assert events_for(conn, alert["id"]) == ["created", "extended"]


def test_strike_at_10_5_miles_does_nothing(conn):
    cycle(conn, [flash(SITE_A, 10.5, T0)], now=T0 + MIN)

    assert alerts_for(conn, SITE_A) == []


def test_late_file_with_older_strike_does_not_shorten_timer(conn):
    cycle(conn, [flash(SITE_A, 3.0, T0 + 10 * MIN)], now=T0 + 11 * MIN)
    # A file that arrives late, carrying a strike from 5 minutes earlier.
    cycle(conn, [flash(SITE_A, 1.0, T0 + 5 * MIN)], now=T0 + 12 * MIN)

    [alert] = alerts_for(conn, SITE_A)
    assert alert["all_clear_at"] == T0 + 40 * MIN       # still 30 min after the NEWEST strike
    assert alert["last_strike_at"] == T0 + 10 * MIN
    assert alert["started_at"] == T0 + 5 * MIN          # but the storm did start earlier
    assert events_for(conn, alert["id"]) == ["created"]


def test_alert_clears_after_30_quiet_minutes(conn):
    cycle(conn, [flash(SITE_A, 2.0, T0)], now=T0 + MIN)

    cycle(conn, [], now=T0 + 30 * MIN - timedelta(seconds=1))
    assert alerts_for(conn, SITE_A)[0]["status"] == "active"

    cycle(conn, [], now=T0 + 30 * MIN)  # a cycle with no flashes still clears
    [alert] = alerts_for(conn, SITE_A)
    assert alert["status"] == "cleared"
    assert events_for(conn, alert["id"]) == ["created", "cleared"]
    cleared_at = conn.execute("SELECT at FROM alert_events WHERE alert_id = %s AND event = 'cleared'",
                              (alert["id"],)).fetchone()["at"]
    assert cleared_at == T0 + 30 * MIN


def test_one_flash_near_two_sites_alerts_both(conn):
    between = flash(SITE_A, 3.0, T0, direction=+1)  # 3 mi north of A = 3 mi south of B

    summary = cycle(conn, [between], now=T0 + MIN)

    assert {"test-site-a", "test-site-b"} <= set(summary.created)
    for site in SITES:
        [alert] = alerts_for(conn, site)
        assert alert["status"] == "active"
        assert alert["last_strike_distance_mi"] == pytest.approx(3.0, abs=0.01)


# ---------- edge cases the rules imply ----------

def test_strike_after_countdown_ran_out_starts_new_alert(conn):
    cycle(conn, [flash(SITE_A, 2.0, T0)], now=T0 + MIN)
    # The next cycle comes late: the old countdown ended at T0+30, the new strike is at T0+31.
    cycle(conn, [flash(SITE_A, 2.0, T0 + 31 * MIN)], now=T0 + 32 * MIN)

    old, new = alerts_for(conn, SITE_A)
    assert old["status"] == "cleared" and old["all_clear_at"] == T0 + 30 * MIN
    assert new["status"] == "active" and new["started_at"] == T0 + 31 * MIN


def test_very_late_strike_whose_countdown_is_over_is_ignored(conn):
    cycle(conn, [flash(SITE_A, 2.0, T0)], now=T0 + 45 * MIN)

    assert alerts_for(conn, SITE_A) == []


def test_unordered_batch_uses_newest_strike(conn):
    flashes = [flash(SITE_A, 6.0, T0 + 3 * MIN), flash(SITE_A, 1.0, T0), flash(SITE_A, 8.0, T0 + 1 * MIN)]
    cycle(conn, flashes, now=T0 + 4 * MIN)

    [alert] = alerts_for(conn, SITE_A)
    assert alert["started_at"] == T0
    assert alert["last_strike_at"] == T0 + 3 * MIN
    assert alert["last_strike_distance_mi"] == pytest.approx(6.0, abs=0.01)


def test_replay_alerts_never_touch_live_alerts(conn):
    cycle(conn, [flash(SITE_A, 2.0, T0)], now=T0 + MIN, replay=False)
    cycle(conn, [flash(SITE_A, 2.0, T0 + 5 * MIN)], now=T0 + 6 * MIN, replay=True)

    [live] = alerts_for(conn, SITE_A, replay=False)
    [replayed] = alerts_for(conn, SITE_A, replay=True)
    assert live["all_clear_at"] == T0 + 30 * MIN
    assert replayed["all_clear_at"] == T0 + 35 * MIN


def test_active_alerts_hides_expired_alert_between_cycles(conn):
    cycle(conn, [flash(SITE_A, 2.0, T0)], now=T0 + MIN)

    def visible(now):
        return [a for a in engine.active_alerts(conn, now, replay=False) if a["site_id"] == SITE_A.id]

    assert len(visible(T0 + 29 * MIN)) == 1
    assert visible(T0 + 30 * MIN) == []  # no engine cycle has run yet, but the countdown is over


def test_api_shows_live_and_replay_alerts_together_each_on_its_own_clock(conn):
    real = datetime(2026, 10, 17, 15, 0, tzinfo=timezone.utc)
    cycle(conn, [flash(SITE_A, 5.0, real)], now=real + MIN, replay=False)               # real: A only
    cycle(conn, [flash(SITE_B, 5.0, T0, direction=1)], now=T0 + MIN, replay=True)      # replay: B only

    def ours(rows):
        return [(a["site_id"], a["replay"]) for a in rows if a["site_id"] in (SITE_A.id, SITE_B.id)]

    # During the replay: both, the replay one checked against simulated time, the live one against real time.
    assert ours(engine.alerts_for_api(conn, real + 5 * MIN, T0 + 5 * MIN)) == [(SITE_B.id, True), (SITE_A.id, False)]
    # No replay running: live only.
    assert ours(engine.alerts_for_api(conn, real + 5 * MIN, None)) == [(SITE_A.id, False)]
    # The live countdown ends on real time even while the replay clock is earlier.
    assert ours(engine.alerts_for_api(conn, real + 31 * MIN, T0 + 5 * MIN)) == [(SITE_B.id, True)]
    assert ours(engine.alerts_for_api(conn, real + 5 * MIN, None, site_id=SITE_B.id)) == []


def test_live_and_replay_cycles_pass_their_own_mode_to_the_engine(monkeypatch):
    from alerts import approach
    from lightning import alert_hook, glm
    seen = []
    monkeypatch.setattr(engine, "run", lambda flashes, now, replay: seen.append(("engine", now, replay)))
    monkeypatch.setattr(approach, "run", lambda now, replay: seen.append(("approach", now, replay)))
    glm.ingest_cycle(None, [], T0, replay=True)
    alert_hook.wait_for_forecast()
    alert_hook.on_new_flashes([], T0 + MIN)
    alert_hook.wait_for_forecast()
    assert seen == [("engine", T0, True), ("approach", T0, True),
                    ("engine", T0 + MIN, False), ("approach", T0 + MIN, False)]


def test_ingestion_never_waits_for_the_forecast_and_skips_one_still_running(monkeypatch):
    import threading

    from alerts import approach
    from lightning import alert_hook
    release, started, runs = threading.Event(), threading.Event(), []

    def slow_forecast(now, replay):
        runs.append(now)
        started.set()
        release.wait(5)
    monkeypatch.setattr(engine, "run", lambda flashes, now, replay: None)
    monkeypatch.setattr(approach, "run", slow_forecast)
    alert_hook.on_new_flashes([], T0, replay=True)
    assert started.wait(5)
    alert_hook.on_new_flashes([], T0 + MIN, replay=True)      # returns at once; this cycle's forecast is skipped
    release.set()
    alert_hook.wait_for_forecast()
    alert_hook.on_new_flashes([], T0 + 2 * MIN, replay=True)  # free again
    alert_hook.wait_for_forecast()
    assert runs == [T0, T0 + 2 * MIN]


def test_a_failing_forecast_frees_the_next_cycle(monkeypatch):
    from alerts import approach
    from lightning import alert_hook
    calls = []

    def broken(now, replay):
        calls.append(now)
        raise RuntimeError("forecast bug")
    monkeypatch.setattr(engine, "run", lambda flashes, now, replay: None)
    monkeypatch.setattr(approach, "run", broken)
    for i in range(2):
        alert_hook.on_new_flashes([], T0 + i * MIN, replay=False)
        alert_hook.wait_for_forecast()
    assert calls == [T0, T0 + MIN]


def test_miles_between_one_degree_of_latitude():
    assert engine.miles_between(25.0, -84.0, 26.0, -84.0) == pytest.approx(69.09, abs=0.01)
    assert engine.miles_between(27.0, -82.0, 27.0, -82.0) == 0
