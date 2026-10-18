"""Lightning arrival forecast: clustering, tracking, arrival estimates, advisories, beacon.
Pure functions, plus database tests (rolled back) that advisories never touch stop-work alerts."""

import inspect
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest

from alerts import approach, engine
from lightning import health
from lightning import cells
from lightning.cells import Cell, arrival, dbscan, find_cells

NOW = datetime(2025, 8, 4, 22, 30, tzinfo=timezone.utc)
SITE = (28.0, -82.0)
MI_LAT = 69.0
MI_LON = 69.0 * math.cos(math.radians(28.0))


def storm(n=400, start_xy=(-30.0, 0.0), velocity_mph=(30.0, 0.0), spread_mi=1.5, minutes=20, seed=0, origin=SITE,
          now=NOW):
    """Flashes from one cell moving at a constant velocity over the last `minutes`.
    Positions in miles east/north of `origin`; returns (ts, lats, lons)."""
    rng = np.random.default_rng(seed)
    ages = rng.uniform(0, minutes, n)                         # minutes before NOW
    x = start_xy[0] + velocity_mph[0] / 60 * (minutes - ages) + rng.normal(0, spread_mi, n)
    y = start_xy[1] + velocity_mph[1] / 60 * (minutes - ages) + rng.normal(0, spread_mi, n)
    ts = [now - timedelta(minutes=float(a)) for a in ages]
    return ts, (origin[0] + y / MI_LAT).tolist(), (origin[1] + x / MI_LON).tolist()


def tracked_cell(x_mi, y_mi, speed, heading, radius=2.0, edge=()):
    return Cell(id="c", lat=SITE[0] + y_mi / MI_LAT, lon=SITE[1] + x_mi / MI_LON, flash_count=200,
                recent_flashes=50, radius_mi=radius, last_flash_at=NOW, tracked=True, speed_mph=speed,
                heading_deg=heading, residual_mi=0.5, edge=edge)


# ---------- clustering ----------

def test_dbscan_separates_cells_and_ignores_scattered_flashes():
    rng = np.random.default_rng(1)
    a = rng.normal((0, 0), 1.0, (100, 2))
    b = rng.normal((30, 10), 1.0, (100, 2))
    noise = rng.uniform(-60, 60, (15, 2)) + np.array([0, 60])   # sparse, far from both
    pts = np.vstack([a, b, noise])
    labels = dbscan(pts[:, 0], pts[:, 1])
    assert len(set(labels[:100])) == 1 and len(set(labels[100:200])) == 1
    assert labels[0] != labels[100] and labels[0] >= 0 and labels[100] >= 0
    assert (labels[200:] == -1).mean() > 0.8


def test_small_cells_are_dropped():
    ts, lats, lons = storm(n=cells.MIN_CELL_FLASHES - 5)
    assert find_cells(ts, lats, lons, NOW) == []


def test_flashes_outside_the_20_minutes_are_ignored():
    ts, lats, lons = storm(n=300)
    later = [NOW + timedelta(minutes=1)] * 50
    old = [NOW - timedelta(minutes=25)] * 50
    found = find_cells(ts + later + old, lats + lats[:50] + lats[:50], lons + lons[:50] + lons[:50], NOW)
    assert len(found) == 1 and found[0].flash_count == 300


# ---------- tracking ----------

@pytest.mark.parametrize("velocity, speed, heading", [((30.0, 0.0), 30, 90), ((0.0, -20.0), 20, 180),
                                                       ((-15.0, 15.0), 21.2, 315)])
def test_tracking_recovers_speed_and_heading(velocity, speed, heading):
    ts, lats, lons = storm(velocity_mph=velocity)
    (cell,) = find_cells(ts, lats, lons, NOW)
    assert cell.tracked
    assert cell.speed_mph == pytest.approx(speed, abs=3)
    assert abs((cell.heading_deg - heading + 180) % 360 - 180) < 8
    # The fitted center now is where the cell has moved to (start + 20 min of motion).
    x_now = -30 + velocity[0] / 3
    assert (cell.lon - SITE[1]) * MI_LON == pytest.approx(x_now, abs=1.5)


def test_unstable_track_is_not_tracked():
    # Two blobs 12 mi apart that take turns flashing: the centroid jumps back and forth.
    rng = np.random.default_rng(3)
    ts, lats, lons = [], [], []
    for w in range(4):
        cx = -30.0 if w % 2 == 0 else -18.0
        for _ in range(60):
            age = rng.uniform(w * 5, w * 5 + 5)
            ts.append(NOW - timedelta(minutes=20 - age if 20 - age > 0 else 0.01))
            lats.append(SITE[0] + rng.normal(0, 1.0) / MI_LAT)
            lons.append(SITE[1] + (cx + rng.normal(0, 1.0)) / MI_LON)
    # Bridge them so DBSCAN sees one cell.
    for k in range(40):
        ts.append(NOW - timedelta(minutes=rng.uniform(0, 20)))
        lats.append(SITE[0])
        lons.append(SITE[1] + (-30 + 12 * k / 39) / MI_LON)
    found = find_cells(ts, lats, lons, NOW)
    assert len(found) == 1 and not found[0].tracked and found[0].speed_mph is None


def test_a_cell_that_stopped_flashing_is_not_tracked():
    ts, lats, lons = storm()
    keep = [i for i, t in enumerate(ts) if t < NOW - timedelta(minutes=6)]   # nothing in the last 5 min
    found = find_cells([ts[i] for i in keep], [lats[i] for i in keep], [lons[i] for i in keep], NOW)
    assert found and not found[0].tracked


# ---------- arrival ----------

def test_arrival_time_for_a_cell_heading_straight_at_the_site():
    cell = tracked_cell(-40, 0, speed=30, heading=90, radius=2.0)          # 40 mi west, moving east at 30 mph
    a = arrival(cell, *SITE, NOW, edge="radius")
    assert a.minutes == pytest.approx((40 - 10 - 2) / 0.5, abs=0.2)          # edge reaches 10 mi after 56 min
    assert cells.compass(a.from_bearing_deg) == "W" and a.distance_mi == pytest.approx(38, abs=0.2)


def test_nearest_flash_edge_and_earliest_picks_the_sooner():
    edge = ((SITE[0], SITE[1] - 25 / MI_LON),)                              # a flash 25 mi west, ahead of the core
    cell = tracked_cell(-40, 0, speed=30, heading=90, radius=2.0, edge=edge)
    nearest = arrival(cell, *SITE, NOW, edge="nearest_flash")
    assert nearest.minutes == pytest.approx((25 - 10) / 0.5, abs=0.2)
    assert arrival(cell, *SITE, NOW, edge="earliest").minutes == nearest.minutes


@pytest.mark.parametrize("cell, why", [
    (tracked_cell(-40, 0, speed=30, heading=270), "moving away"),
    (tracked_cell(-40, 0, speed=30, heading=0), "passing north of the ring"),
    (tracked_cell(-80, 0, speed=30, heading=90), "arrives after 60 min"),
    (tracked_cell(-40, 0, speed=0.0, heading=None), "stationary and far"),
])
def test_no_arrival(cell, why):
    assert arrival(cell, *SITE, NOW, edge="radius") is None, why


def test_already_at_the_ring_means_arriving_now_and_untracked_cells_never_project():
    assert arrival(tracked_cell(-11, 0, speed=0.0, heading=None, radius=2.0), *SITE, NOW, edge="radius").minutes == 0
    untracked = Cell(**{**tracked_cell(-20, 0, 30, 90).__dict__, "tracked": False})
    assert arrival(untracked, *SITE, NOW) is None


def test_end_to_end_moving_storm_gets_an_arrival():
    ts, lats, lons = storm(start_xy=(-35.0, 0.0), velocity_mph=(30.0, 0.0))   # center 25 mi west now
    found = find_cells(ts, lats, lons, NOW)
    a = cells.earliest_arrival(found, *SITE, NOW)
    assert a is not None and 10 <= a.minutes <= 30 and cells.compass(a.from_bearing_deg) == "W"


# ---------- advisories (plan) ----------

def arr(minutes=20.0):
    return cells.Arrival("c", NOW + timedelta(minutes=minutes), minutes, 270.0, 20.0, 30.0, 90.0, 200)


def adv(site, updated_ago_min=0.5, arrival_in_min=10.0):
    return approach.Advisory(f"adv-{site}", site, NOW - timedelta(minutes=40), NOW - timedelta(minutes=updated_ago_min),
                             NOW + timedelta(minutes=arrival_in_min), NOW + timedelta(minutes=12))


def test_plan_creates_updates_and_clears_after_the_hold():
    actions = approach.plan(
        {"a": arr(), "b": arr(), "c": None, "d": None, "e": None},
        stop_work=set(),
        active={"b": adv("b"),
                "c": adv("c", updated_ago_min=16, arrival_in_min=-20),   # 16 min unsupported, arrival long past
                "d": adv("d", updated_ago_min=14, arrival_in_min=-20),   # unsupported for 14 min: held
                "e": adv("e", updated_ago_min=20, arrival_in_min=-10)},  # arrival only 10 min ago: held
        now=NOW)
    assert {(x.kind, x.site_id) for x in actions} == {("create", "a"), ("update", "b"), ("clear", "c")}


def test_an_advisory_is_held_until_15_min_after_its_arrival_estimate():
    # Vandolah, Aug 4 2025: last supported 22:14, estimated arrival 22:23, stop-work 22:34. A hold of 15 min
    # past the last valid cycle alone would have shown "clear" from 22:29 to 22:34.
    held = adv("v", updated_ago_min=15, arrival_in_min=-6)
    assert approach.plan({"v": None}, stop_work=set(), active={"v": held}, now=NOW) == []
    gone = adv("v", updated_ago_min=21, arrival_in_min=-15)
    assert [x.kind for x in approach.plan({"v": None}, stop_work=set(), active={"v": gone}, now=NOW)] == ["clear"]


def test_aug_4_replay_has_no_green_gap_before_any_stop_work():
    from lightning.replay import available_windows
    from scripts import evaluate_lightning_forecast as ev
    if "2025-08-04_2200-2300" not in available_windows():
        pytest.skip("replay files not downloaded (python -m scripts.find_replay_window)")
    report = ev.simulate("2025-08-04_2200-2300")        # in memory; writes nothing
    assert report["green_gaps"] == []
    vandolah = [r for r in report["per_stop_work"] if r["site_id"] == "vandolah-power-station"]
    assert vandolah and vandolah[0]["lead_min"] is not None


def test_plan_never_advises_a_site_in_stop_work_and_supersedes_its_advisory():
    actions = approach.plan({"a": arr()}, stop_work={"a", "b"}, active={"b": adv("b")}, now=NOW)
    assert [(x.kind, x.site_id) for x in actions] == [("supersede", "b")]


def test_advisory_code_has_no_way_to_write_stop_work_alerts():
    src = inspect.getsource(approach)
    for stmt in ("INSERT INTO alerts", "UPDATE alerts", "DELETE FROM alerts"):
        assert stmt not in src


# ---------- beacon ----------

def test_beacon_priority_stop_approaching_flood_clear():
    stop = {"type": "lightning", "all_clear_at": NOW + timedelta(minutes=12, seconds=30)}
    flood = {"type": "flood", "all_clear_at": None}
    advisory = {"arrival_at": NOW + timedelta(minutes=17, seconds=10)}
    assert approach.beacon("s", [stop, flood], advisory, NOW) == {
        "site_id": "s", "state": "stop", "seconds_to_all_clear": 750, "minutes_to_arrival": None, "as_of": NOW}
    b = approach.beacon("s", [flood], advisory, NOW)
    assert (b["state"], b["minutes_to_arrival"], b["seconds_to_all_clear"]) == ("approaching", 18, None)
    assert approach.beacon("s", [flood], None, NOW)["state"] == "flood"
    assert approach.beacon("s", [], None, NOW)["state"] == "clear"


def test_lead_times_and_summary():
    rows = approach.lead_times([("a", NOW), ("b", NOW), ("c", NOW)],
                               [("a", NOW - timedelta(minutes=12)), ("a", NOW - timedelta(minutes=5)),
                                ("b", NOW - timedelta(minutes=90)), ("c", NOW + timedelta(minutes=1))])
    assert [r["lead_min"] for r in rows] == [12.0, None, None]   # b: too early to count; c: after the start
    assert approach.summarize(rows) == {"stop_works": 3, "warned": 1, "warned_share": 0.333, "median_lead_min": 12.0}


# ---------- database: advisories never touch stop-work alerts ----------

def _ensure_table(conn):
    if conn.execute("SELECT to_regclass('lightning_advisories') AS t").fetchone()["t"] is None:
        migration = Path(__file__).resolve().parents[1] / "db" / "migrations" / "008_lightning_advisories.sql"
        conn.execute(migration.read_text())   # rolled back with the test


def test_advisories_never_change_stop_work_alerts(conn):  # noqa: F811
    _ensure_table(conn)
    now = datetime(2001, 6, 1, 20, 0, tzinfo=timezone.utc)   # far from any real or replayed lightning
    conn.execute("UPDATE alerts SET status = 'cleared' WHERE replay AND status = 'active'")
    conn.execute("DELETE FROM lightning_advisories WHERE replay")
    sites = {r["id"]: r for r in conn.execute("SELECT id, lat, lon FROM sites WHERE id IN ('sanford', 'big-bend')")}
    # A stop-work at Sanford, and a storm 30 mi west of each site moving east at 30 mph.
    conn.execute("""INSERT INTO alerts (site_id, type, status, started_at, all_clear_at, last_strike_at,
                                        last_strike_distance_mi, replay)
                    VALUES ('sanford', 'lightning', 'active', %s, %s, %s, 3.0, true)""",
                 (now - timedelta(minutes=5), now + timedelta(minutes=25), now - timedelta(minutes=5)))
    before = conn.execute("SELECT * FROM alerts WHERE replay ORDER BY id").fetchall()
    with conn.cursor() as cur:
        for i, (sid, s) in enumerate(sorted(sites.items())):
            ts, lats, lons = storm(n=300, start_xy=(-40.0, 0.0), velocity_mph=(30.0, 0.0), origin=(s["lat"], s["lon"]),
                                   seed=i, now=now)
            cur.executemany("INSERT INTO lightning_flashes (ts, lat, lon, energy, source_file) VALUES (%s, %s, %s, NULL, %s)",
                            [(t, la, lo, f"test-{sid}") for t, la, lo in zip(ts, lats, lons)])

    actions = approach.process(conn, now, replay=True)

    assert conn.execute("SELECT * FROM alerts WHERE replay ORDER BY id").fetchall() == before   # untouched
    advised = {a["site_id"] for a in approach.active_advisories(conn, replay=True)}
    assert "big-bend" in advised and "sanford" not in advised                                  # stop-work site skipped
    assert all(a.site_id != "sanford" for a in actions if a.kind in ("create", "update"))

    # When Sanford's stop-work ends and the storm still approaches, it can get an advisory; when a new
    # stop-work starts at Big Bend, its advisory is superseded and the stop-work is still untouched.
    conn.execute("""INSERT INTO alerts (site_id, type, status, started_at, all_clear_at, last_strike_at,
                                        last_strike_distance_mi, replay)
                    VALUES ('big-bend', 'lightning', 'active', %s, %s, %s, 8.0, true)""",
                 (now, now + timedelta(minutes=30), now))
    before = conn.execute("SELECT * FROM alerts WHERE replay ORDER BY id").fetchall()
    approach.process(conn, now + timedelta(seconds=20), replay=True)
    assert conn.execute("SELECT * FROM alerts WHERE replay ORDER BY id").fetchall() == before
    status = conn.execute("SELECT status FROM lightning_advisories WHERE replay AND site_id = 'big-bend'").fetchone()
    assert status["status"] == "superseded"


def test_beacon_and_sites_show_the_advisory(conn, monkeypatch):  # noqa: F811
    import json

    from app import clock, site_data
    from app.cache import TTLCache
    from app.routers import sites as route
    from tests.test_crew_reports import FakePool
    _ensure_table(conn)
    monkeypatch.setattr(route, "api_cache", TTLCache())
    now = datetime.now(timezone.utc)
    conn.execute("DELETE FROM lightning_advisories WHERE NOT replay AND site_id = 'sanford'")
    if engine.active_alerts(conn, now, False, site_id="sanford"):
        pytest.skip("live alert active at sanford right now")
    conn.execute("""INSERT INTO lightning_advisories (site_id, replay, started_at, updated_at, arrival_at, first_arrival_at,
                                                      from_bearing_deg, heading_deg, speed_mph, distance_mi, cell_flashes)
                    VALUES ('sanford', false, %s, %s, %s, %s, 250, 70, 22, 18.5, 140)""",
                 (now - timedelta(minutes=4), now, now + timedelta(minutes=14, seconds=30), now + timedelta(minutes=16)))
    monkeypatch.setattr(clock, "is_simulated", lambda: False)
    monkeypatch.setattr(health, "_last_success", {False: now})      # live ingestion just succeeded
    body = json.loads(route.site_beacon("sanford", FakePool(conn)).body)
    assert body["state"] == "approaching" and body["minutes_to_arrival"] == 15
    detail = site_data.get_site_detail(FakePool(conn), "sanford")
    assert detail["lightning_approach"]["from_direction"] == "WSW"
    assert detail["lightning_approach"]["minutes_to_arrival"] in (14, 15)


def test_beacon_reports_a_live_stop_work_during_a_replay(conn, monkeypatch):  # noqa: F811
    import json

    from app import clock
    from app.cache import TTLCache
    from app.routers import sites as route
    from tests.test_crew_reports import FakePool
    _ensure_table(conn)
    monkeypatch.setattr(route, "api_cache", TTLCache())
    real = datetime.now(timezone.utc)
    conn.execute("DELETE FROM alerts WHERE site_id = 'sanford' AND type = 'lightning' AND status = 'active'")
    conn.execute("""INSERT INTO alerts (site_id, type, started_at, all_clear_at, last_strike_at, last_strike_distance_mi, replay)
                    VALUES ('sanford', 'lightning', %s, %s, %s, 4.2, false)""",
                 (real - timedelta(minutes=5), real + timedelta(minutes=25), real - timedelta(minutes=5)))
    monkeypatch.setattr(clock, "is_simulated", lambda: True)                       # a replay is running,
    monkeypatch.setattr(clock, "now", lambda: datetime(2025, 8, 4, 22, 5, tzinfo=timezone.utc))  # quiet at Sanford
    body = json.loads(route.site_beacon("sanford", FakePool(conn)).body)
    assert body["state"] == "stop" and 24 * 60 < body["seconds_to_all_clear"] <= 25 * 60


def test_beacon_is_unknown_not_clear_when_lightning_ingestion_is_stale(conn, monkeypatch):  # noqa: F811
    import json

    from app import clock
    from app.config import get_settings
    from app.cache import TTLCache
    from app.routers import sites as route
    from tests.test_crew_reports import FakePool
    _ensure_table(conn)
    monkeypatch.setattr(route, "api_cache", TTLCache())
    real = datetime.now(timezone.utc)
    conn.execute("DELETE FROM alerts WHERE site_id = 'sanford' AND status = 'active'")
    conn.execute("DELETE FROM lightning_advisories WHERE site_id = 'sanford'")
    monkeypatch.setattr(get_settings(), "lightning_ingest_enabled", True)   # stale, not turned off
    monkeypatch.setattr(clock, "is_simulated", lambda: False)

    def state(last_live_success):
        route.api_cache.invalidate()
        monkeypatch.setattr(health, "_last_success", {False: last_live_success} if last_live_success else {})
        return json.loads(route.site_beacon("sanford", FakePool(conn)).body)["state"]

    assert state(real - timedelta(seconds=30)) == "clear"
    assert state(real - timedelta(minutes=3)) == "unknown"          # nothing ingested for 3 min
    assert state(None) == "unknown"                                 # never since the API started

    # During a replay, replay cycles are judged on the replay clock and live ones on real time; either
    # being stale makes the beacon unknown.
    sim = datetime(2025, 8, 4, 22, 5, tzinfo=timezone.utc)
    monkeypatch.setattr(clock, "is_simulated", lambda: True)
    monkeypatch.setattr(clock, "now", lambda: sim)

    def replay_state(last):
        route.api_cache.invalidate()
        monkeypatch.setattr(health, "_last_success", last)
        return json.loads(route.site_beacon("sanford", FakePool(conn)).body)["state"]

    assert replay_state({True: sim - timedelta(seconds=20), False: real - timedelta(seconds=20)}) == "clear"
    assert replay_state({True: sim - timedelta(minutes=5), False: real}) == "unknown"
    assert replay_state({True: sim, False: real - timedelta(hours=1)}) == "unknown"     # real data stale


def test_beacon_priority_with_stale_data():
    now = datetime(2025, 8, 4, 22, 0, tzinfo=timezone.utc)
    stop = {"type": "lightning", "all_clear_at": now + timedelta(minutes=10)}
    flood = {"type": "flood", "all_clear_at": None}
    advisory = {"arrival_at": now + timedelta(minutes=12)}
    assert approach.beacon("s", [stop], advisory, now, current=False)["state"] == "stop"   # a known stop stays a stop
    for alerts, adv in (([], None), ([flood], None), ([], advisory)):
        b = approach.beacon("s", alerts, adv, now, current=False)
        assert b["state"] == "unknown" and b["seconds_to_all_clear"] is None and b["minutes_to_arrival"] is None


def test_combined_beacon_real_first():
    def b(state, replay, seconds=None, minutes=None):
        return {"site_id": "s", "state": state, "seconds_to_all_clear": seconds, "minutes_to_arrival": minutes,
                "as_of": None, "replay": replay}
    combine = approach.combine_beacons
    # Any real state other than clear wins over every replay state, stop included.
    for real_state in ("approaching", "unknown", "flood"):
        shown = combine([b(real_state, False, minutes=12 if real_state == "approaching" else None), b("stop", True, 1500)])
        assert (shown["state"], shown["replay"]) == (real_state, False)
    assert combine([b("flood", False), b("approaching", True, minutes=8)])["state"] == "flood"
    real_stop, replay_stop = b("stop", False, 600), b("stop", True, 1500)
    for pair in ([real_stop, replay_stop], [replay_stop, real_stop]):   # order doesn't matter
        assert combine(pair) is real_stop
    # The replay shows only when the real state is clear, and then it says so.
    shown = combine([b("clear", False), b("stop", True, 1500)])
    assert (shown["state"], shown["replay"], shown["seconds_to_all_clear"]) == ("stop", True, 1500)
    assert combine([b("clear", False), b("approaching", True, minutes=20)])["replay"] is True
    assert combine([b("clear", False), b("clear", True)])["replay"] is False      # both clear: the real one
    assert combine([b("clear", False)])["replay"] is False                         # no replay running
    assert combine([b("approaching", True, minutes=5)])["replay"] is True         # no real layer (ingest off)


def test_beacon_during_a_replay_keeps_real_flood_and_real_advisories(conn, monkeypatch):  # noqa: F811
    import json

    from app import clock
    from app.config import get_settings
    from app.cache import TTLCache
    from app.routers import sites as route
    from tests.test_crew_reports import FakePool
    _ensure_table(conn)
    monkeypatch.setattr(route, "api_cache", TTLCache())
    real = datetime.now(timezone.utc)
    sim = datetime(2025, 8, 4, 22, 5, tzinfo=timezone.utc)
    monkeypatch.setattr(clock, "is_simulated", lambda: True)
    monkeypatch.setattr(clock, "now", lambda: sim)
    monkeypatch.setattr(health, "_last_success", {True: sim, False: real})
    monkeypatch.setattr(get_settings(), "lightning_ingest_enabled", True)
    conn.execute("DELETE FROM alerts WHERE site_id = 'sanford' AND status = 'active'")
    conn.execute("DELETE FROM lightning_advisories WHERE site_id = 'sanford'")

    def state():
        route.api_cache.invalidate()
        return json.loads(route.site_beacon("sanford", FakePool(conn)).body)

    assert state()["state"] == "clear"
    conn.execute("INSERT INTO alerts (site_id, type, started_at, replay) VALUES ('sanford', 'flood', %s, false)",
                 (real - timedelta(hours=1),))
    assert state()["state"] == "flood" and state()["replay"] is False      # a real flood alert, replay is quiet
    conn.execute("""INSERT INTO lightning_advisories (site_id, replay, started_at, updated_at, arrival_at, first_arrival_at,
                                                      from_bearing_deg, heading_deg, speed_mph, distance_mi, cell_flashes)
                    VALUES ('sanford', false, %s, %s, %s, %s, 250, 70, 22, 18.5, 140)""",
                 (real - timedelta(minutes=4), real, real + timedelta(minutes=9, seconds=30), real + timedelta(minutes=12)))
    body = state()
    assert body["state"] == "approaching" and body["minutes_to_arrival"] == 10   # real advisory, on real time
    conn.execute("""INSERT INTO alerts (site_id, type, started_at, all_clear_at, last_strike_at, last_strike_distance_mi, replay)
                    VALUES ('sanford', 'lightning', %s, %s, %s, 3.0, true)""",
                 (sim - timedelta(minutes=2), sim + timedelta(minutes=28), sim - timedelta(minutes=2)))
    body = state()
    assert body["state"] == "approaching" and body["replay"] is False   # a real advisory beats a replay stop-work
    conn.execute("DELETE FROM lightning_advisories WHERE site_id = 'sanford' AND NOT replay")
    body = state()
    assert body["state"] == "flood" and body["replay"] is False        # so does a real flood alert
    conn.execute("DELETE FROM alerts WHERE site_id = 'sanford' AND type = 'flood' AND NOT replay")
    body = state()
    assert body["state"] == "stop" and body["seconds_to_all_clear"] == 28 * 60    # real is clear: the replay shows
    assert body["replay"] is True                                                 # its countdown is simulated


def test_sites_during_a_replay_still_show_real_stop_work_and_flood_alerts(conn, monkeypatch):  # noqa: F811
    from app import clock, site_data
    from tests.test_crew_reports import FakePool
    _ensure_table(conn)
    real = datetime.now(timezone.utc)
    sim = datetime(2025, 8, 4, 22, 5, tzinfo=timezone.utc)
    monkeypatch.setattr(clock, "is_simulated", lambda: True)
    monkeypatch.setattr(clock, "now", lambda: sim)
    conn.execute("DELETE FROM alerts WHERE site_id IN ('sanford', 'big-bend', 'polk') AND status = 'active'")
    conn.execute("DELETE FROM lightning_advisories WHERE site_id IN ('sanford', 'big-bend', 'polk')")
    lightning = """INSERT INTO alerts (site_id, type, started_at, all_clear_at, last_strike_at, last_strike_distance_mi, replay)
                   VALUES (%s, 'lightning', %s, %s, %s, %s, %s)"""
    conn.execute(lightning, ("sanford", real - timedelta(minutes=5), real + timedelta(minutes=25),
                             real - timedelta(minutes=5), 4.2, False))                      # real stop-work
    conn.execute(lightning, ("big-bend", sim - timedelta(minutes=2), sim + timedelta(minutes=28),
                             sim - timedelta(minutes=2), 7.7, True))                        # replayed stop-work
    conn.execute(lightning, ("big-bend", real - timedelta(minutes=1), real + timedelta(minutes=29),
                             real - timedelta(minutes=1), 2.1, False))                      # and a real one too
    conn.execute("INSERT INTO alerts (site_id, type, started_at, replay) VALUES ('polk', 'flood', %s, false)",
                 (real - timedelta(hours=1),))                                              # real flood alert

    sanford = site_data.get_site_detail(FakePool(conn), "sanford")
    assert sanford["hazard_index_today"] >= 9.0 and sanford["top_hazard"] == "lightning"
    assert sanford["conditions"]["lightning"]["hazard_status"] == "danger"
    assert "4.2 mi" in sanford["conditions"]["lightning"]["reading"]
    big_bend = site_data.get_site_detail(FakePool(conn), "big-bend")
    assert "2.1 mi" in big_bend["conditions"]["lightning"]["reading"]                  # the real one wins
    polk = site_data.get_site_detail(FakePool(conn), "polk")
    assert polk["conditions"]["flood"]["hazard_status"] == "danger" and polk["hazard_index_today"] >= 4
    listed = {s["id"]: s for s in site_data.list_sites(FakePool(conn))}
    assert listed["sanford"]["hazard_index_today"] >= 9.0 and listed["big-bend"]["hazard_index_today"] >= 9.0

    # Stored history (replay=False) never sees the replayed stop-work.
    from hazards import snapshot
    snap = snapshot.load(FakePool(conn), replay=False)
    assert snap.inputs["big-bend"].lightning_alert["replay"] is False


def test_health_window_and_reset():
    t = datetime(2025, 8, 4, 22, 0, tzinfo=timezone.utc)
    health.reset(replay=True)
    assert not health.is_current(t, replay=True)
    health.record_success(t, replay=True)
    assert health.is_current(t + timedelta(minutes=2), replay=True)
    assert not health.is_current(t + timedelta(minutes=2, seconds=1), replay=True)
    health.record_success(t - timedelta(minutes=5), replay=True)        # an older time never moves it back
    assert health.last_success(replay=True) == t
    health.reset(replay=True)
    assert health.last_success(replay=True) is None


def test_live_poll_counts_as_success_only_when_complete_and_fresh(monkeypatch):
    from lightning import glm
    now = datetime(2026, 10, 17, 18, 0, tzinfo=timezone.utc)
    fresh = now.strftime("OR_GLM-L2-LCFA_G19_s%Y%j%H%M") + "000_e0_c0.nc"     # started at `now`
    old = (now - timedelta(minutes=3)).strftime("OR_GLM-L2-LCFA_G19_s%Y%j%H%M") + "000_e0_c0.nc"
    monkeypatch.setattr(glm, "processed_files", lambda pool, names: set(names))   # nothing new to download

    def poll(keys, result):
        monkeypatch.setattr(health, "_last_success", {})
        monkeypatch.setattr(glm, "newest_keys", lambda now, lookback: keys)
        monkeypatch.setattr(glm, "ingest_cycle", lambda pool, todo, now, replay, **_: result)
        glm.poll_latest(None, now)
        return health.is_current(now, replay=False)

    assert poll([f"GLM/{fresh}"], glm.CycleResult()) is True
    assert poll([f"GLM/{old}"], glm.CycleResult()) is False                  # NOAA feed stalled
    assert poll([], glm.CycleResult()) is False                              # no files at all
    assert poll([f"GLM/{fresh}"], glm.CycleResult(files_failed=1)) is False
    assert poll([f"GLM/{fresh}"], glm.CycleResult(hook_failed=True)) is False  # stop-work engine failed


from tests.test_crew_reports import conn  # noqa: E402,F401 - the rolled-back DB fixture


def _replay_beacon_setup(conn, monkeypatch, *, ingest_enabled: bool, last_success: dict):
    """Sanford during a replay, with no active alerts or advisories; returns (state(), sim, real)."""
    import json

    from app import clock
    from app.cache import TTLCache
    from app.config import get_settings
    from app.routers import sites as route
    from tests.test_crew_reports import FakePool
    _ensure_table(conn)
    monkeypatch.setattr(route, "api_cache", TTLCache())
    real = datetime.now(timezone.utc)
    sim = datetime(2025, 8, 4, 22, 5, tzinfo=timezone.utc)
    monkeypatch.setattr(clock, "is_simulated", lambda: True)
    monkeypatch.setattr(clock, "now", lambda: sim)
    monkeypatch.setattr(get_settings(), "lightning_ingest_enabled", ingest_enabled)
    monkeypatch.setattr(health, "_last_success", last_success(sim, real))
    conn.execute("DELETE FROM alerts WHERE site_id = 'sanford' AND status = 'active'")
    conn.execute("DELETE FROM lightning_advisories WHERE site_id = 'sanford'")

    def state():
        route.api_cache.invalidate()
        return json.loads(route.site_beacon("sanford", FakePool(conn)).body)
    return state, sim, real


def _replay_advisory(conn, sim):
    conn.execute("""INSERT INTO lightning_advisories (site_id, replay, started_at, updated_at, arrival_at, first_arrival_at,
                                                      from_bearing_deg, heading_deg, speed_mph, distance_mi, cell_flashes)
                    VALUES ('sanford', true, %s, %s, %s, %s, 250, 70, 22, 18.5, 140)""",
                 (sim - timedelta(minutes=4), sim, sim + timedelta(minutes=9, seconds=30), sim + timedelta(minutes=12)))


def _stop(conn, at, minutes_left, replay):
    conn.execute("""INSERT INTO alerts (site_id, type, started_at, all_clear_at, last_strike_at, last_strike_distance_mi, replay)
                    VALUES ('sanford', 'lightning', %s, %s, %s, 3.0, %s)""",
                 (at - timedelta(minutes=2), at + timedelta(minutes=minutes_left), at - timedelta(minutes=2), replay))


def test_beacon_with_live_ingestion_turned_off_shows_the_replay(conn, monkeypatch):  # noqa: F811
    # No live cycle ever runs on this backend, so its real layer is always "unknown": that is "off by
    # design", not a stalled feed, and must not hide the replay's clear / approaching.
    state, sim, real = _replay_beacon_setup(conn, monkeypatch, ingest_enabled=False,
                                            last_success=lambda sim, real: {True: sim})
    assert state()["state"] == "clear" and state()["replay"] is True
    _replay_advisory(conn, sim)
    body = state()
    assert body["state"] == "approaching" and body["minutes_to_arrival"] == 10 and body["replay"] is True
    _stop(conn, real, 25, replay=False)        # a real stop-work in the shared DB (another backend's engine)
    body = state()
    assert body["state"] == "stop" and body["replay"] is False and 24 * 60 < body["seconds_to_all_clear"] <= 25 * 60


def test_beacon_real_unknown_beats_a_replay_stop_work(conn, monkeypatch):  # noqa: F811
    # Ingestion is on but hasn't succeeded for an hour: real data is unknown, which outranks every replay
    # state, its stop-work included (a demo must never cover up missing real data).
    state, sim, real = _replay_beacon_setup(conn, monkeypatch, ingest_enabled=True,
                                            last_success=lambda sim, real: {True: sim, False: real - timedelta(hours=1)})
    assert state()["state"] == "unknown"
    _replay_advisory(conn, sim)
    assert state()["state"] == "unknown"
    _stop(conn, sim, 28, replay=True)
    body = state()
    assert body["state"] == "unknown" and body["replay"] is False   # real unknown beats even a replay stop-work


@pytest.mark.parametrize("ingest_enabled", [True, False])
def test_beacon_real_stop_work_beats_an_overlapping_replay_one(conn, monkeypatch, ingest_enabled):  # noqa: F811
    # Real: 10 real minutes left. Replay: 28 simulated minutes (under a real minute at 30x). The beacon
    # shows the real wait on real time (replay false), so the bridge never speeds it up.
    state, sim, real = _replay_beacon_setup(conn, monkeypatch, ingest_enabled=ingest_enabled,
                                            last_success=lambda sim, real: {True: sim, False: real})
    _stop(conn, sim, 28, replay=True)
    _stop(conn, real, 10, replay=False)
    body = state()
    assert body["state"] == "stop" and body["replay"] is False
    assert 9 * 60 < body["seconds_to_all_clear"] <= 10 * 60


def test_beacon_real_approaching_beats_a_replay_stop_work(conn, monkeypatch):  # noqa: F811
    state, sim, real = _replay_beacon_setup(conn, monkeypatch, ingest_enabled=True,
                                            last_success=lambda sim, real: {True: sim, False: real})
    _stop(conn, sim, 28, replay=True)
    conn.execute("""INSERT INTO lightning_advisories (site_id, replay, started_at, updated_at, arrival_at, first_arrival_at,
                                                      from_bearing_deg, heading_deg, speed_mph, distance_mi, cell_flashes)
                    VALUES ('sanford', false, %s, %s, %s, %s, 250, 70, 22, 18.5, 140)""",
                 (real - timedelta(minutes=4), real, real + timedelta(minutes=9, seconds=30), real + timedelta(minutes=12)))
    body = state()
    assert body["state"] == "approaching" and body["replay"] is False and body["minutes_to_arrival"] == 10


def test_beacon_real_clear_shows_the_replay_stop_work(conn, monkeypatch):  # noqa: F811
    state, sim, real = _replay_beacon_setup(conn, monkeypatch, ingest_enabled=True,
                                            last_success=lambda sim, real: {True: sim, False: real})
    assert state()["state"] == "clear" and state()["replay"] is False   # both clear: the real one
    _stop(conn, sim, 28, replay=True)
    body = state()
    assert body["state"] == "stop" and body["replay"] is True and body["seconds_to_all_clear"] == 28 * 60


def test_live_poll_tells_the_engine_when_the_feed_is_stale_and_reads_the_backlog(monkeypatch):
    from lightning import glm
    now = datetime(2026, 10, 17, 18, 0, tzinfo=timezone.utc)
    name = lambda t: "GLM/" + t.strftime("OR_GLM-L2-LCFA_G19_s%Y%j%H%M") + "000_e0_c0.nc"   # noqa: E731
    monkeypatch.setattr(glm, "processed_files", lambda pool, names: set(names))
    seen = []

    def poll(keys, last=None):
        monkeypatch.setattr(health, "_last_success", {False: last} if last else {})
        monkeypatch.setattr(glm, "newest_keys", lambda now, lookback: seen.append(lookback) or keys)
        monkeypatch.setattr(glm, "ingest_cycle", lambda pool, todo, now, replay, fresh: seen.append(fresh) or glm.CycleResult())
        glm.poll_latest(None, now)
        return health.is_current(now, replay=False)

    assert poll([name(now)]) is True and seen[-1] is True
    # Stalled: the engine is told, and health goes not current at once (not 2 minutes after the last success).
    assert poll([name(now - timedelta(minutes=3))], last=now - timedelta(seconds=20)) is False and seen[-1] is False
    # After a 40-minute stall the cycle looks back to the last success, capped at BACKLOG_MAX.
    poll([name(now)], last=now - timedelta(minutes=40))
    assert seen[-2] == timedelta(minutes=41)
    poll([name(now)], last=now - timedelta(hours=5))
    assert seen[-2] == glm.BACKLOG_MAX


def test_newest_keys_lists_every_hour_of_a_long_lookback(monkeypatch):
    from lightning import glm
    listed = []
    monkeypatch.setattr(glm, "list_keys", lambda prefix: listed.append(prefix) or [])
    glm.newest_keys(datetime(2026, 10, 17, 18, 10, tzinfo=timezone.utc), timedelta(hours=2))
    assert [p.rsplit("/", 2)[-2] for p in listed] == ["16", "17", "18"]
