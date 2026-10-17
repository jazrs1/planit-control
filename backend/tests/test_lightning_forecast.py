"""Lightning arrival forecast: clustering, tracking, arrival estimates, advisories, beacon.
Pure functions, plus database tests (rolled back) that advisories never touch stop-work alerts."""

import inspect
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest

from alerts import approach, engine
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


def adv(site, updated_ago_min=0.5):
    return approach.Advisory(f"adv-{site}", site, NOW - timedelta(minutes=10), NOW - timedelta(minutes=updated_ago_min),
                             NOW + timedelta(minutes=10), NOW + timedelta(minutes=12))


def test_plan_creates_updates_and_clears_with_grace():
    actions = approach.plan({"a": arr(), "b": arr(), "c": None, "d": None},
                            stop_work=set(), active={"b": adv("b"), "c": adv("c", 3), "d": adv("d", 1)}, now=NOW)
    assert {(x.kind, x.site_id) for x in actions} == {("create", "a"), ("update", "b"), ("clear", "c")}  # d: in grace


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


from tests.test_crew_reports import conn  # noqa: E402,F401 - the rolled-back DB fixture
