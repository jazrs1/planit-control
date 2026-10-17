"""hazard_index_live and replay_override on /sites and /sites/{id}.

Database tests run inside one rolled-back transaction (skipped without DATABASE_URL), on test-only
sites, with alerts inserted directly. They never start a replay or take the alert engine's lock: the
replay cases only switch the app clock to simulated time in this process."""

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import psycopg
import pytest
from psycopg.rows import dict_row

from app import clock, site_data
from app.config import get_settings
from app.schemas import Site, SiteDetail

SIM_NOW = datetime(2031, 1, 6, 17, 0, tzinfo=timezone.utc)
MIN = timedelta(minutes=1)
REAL_AND_REPLAY, REPLAY_ONLY, QUIET = "test-live-both", "test-live-replay", "test-live-quiet"


class FakePool:
    def __init__(self, conn):
        self.conn = conn

    @contextmanager
    def connection(self, timeout=None):
        yield self.conn


@pytest.fixture
def conn(monkeypatch):
    url = get_settings().database_url
    if not url:
        pytest.skip("DATABASE_URL not set")
    monkeypatch.setattr(site_data, "_real_sites",
                        lambda: {s: {"id": s, "name": s} for s in (REAL_AND_REPLAY, REPLAY_ONLY, QUIET)})
    with psycopg.connect(url, row_factory=dict_row, connect_timeout=15) as conn:
        try:
            for i, site in enumerate((REAL_AND_REPLAY, REPLAY_ONLY, QUIET)):
                conn.execute(
                    """INSERT INTO sites (plant_id, id, name, utility, county, lat, lon, technology, capacity_mw, timezone)
                       VALUES (%s, %s, %s, 'Test', 'Test', %s, -84.5, 'Test', 0, 'America/New_York')""",
                    (-930_000 - i, site, site, 24.0 + i * 0.5))   # open Gulf: no real readings
            real_now = clock.real_now()
            stop_work(conn, REAL_AND_REPLAY, real_now, replay=False)
            stop_work(conn, REAL_AND_REPLAY, SIM_NOW, replay=True)
            stop_work(conn, REPLAY_ONLY, SIM_NOW, replay=True)
            yield conn
        finally:
            clock.stop_simulation()
            conn.rollback()


def stop_work(conn, site, now, replay):
    conn.execute(
        """INSERT INTO alerts (site_id, type, status, started_at, all_clear_at, last_strike_at, last_strike_distance_mi, replay)
           VALUES (%s, 'lightning', 'active', %s, %s, %s, 3.2, %s)""",
        (site, now - 5 * MIN, now + 25 * MIN, now - 5 * MIN, replay))


def sites(conn) -> dict[str, dict]:
    rows = [Site(**s) for s in site_data.list_sites(FakePool(conn))]
    return {s.id: s.model_dump() for s in rows if s.id.startswith("test-live-")}


def test_no_replay_running_live_equals_shown(conn):
    got = sites(conn)                                   # replay alerts exist, but no replay is running
    assert all(s["hazard_index_live"] == s["hazard_index"] and not s["replay_override"] for s in got.values())
    assert got[REAL_AND_REPLAY]["hazard_index"] >= 9    # its real stop-work
    assert got[REPLAY_ONLY]["hazard_index"] < 9


def test_replay_only_site_is_raised_and_flagged(conn):
    before = sites(conn)
    clock.start_simulation(SIM_NOW, 1)
    during = sites(conn)
    site = during[REPLAY_ONLY]
    assert site["hazard_index"] >= 9 and site["replay_override"] is True
    assert site["hazard_index_live"] == before[REPLAY_ONLY]["hazard_index"]   # what it'd show with no replay
    assert during[QUIET] == {**before[QUIET]}                                 # no replay alert: untouched


def test_real_and_replay_stop_work_is_not_a_replay_override(conn):
    clock.start_simulation(SIM_NOW, 1)
    site = sites(conn)[REAL_AND_REPLAY]
    assert site["hazard_index"] >= 9 and site["hazard_index_live"] == site["hazard_index"]
    assert site["replay_override"] is False


def test_site_detail_matches_the_list(conn):
    clock.start_simulation(SIM_NOW, 1)
    listed = sites(conn)[REPLAY_ONLY]
    detail = SiteDetail(**site_data.get_site_detail(FakePool(conn), REPLAY_ONLY))
    assert (detail.hazard_index, detail.hazard_index_live, detail.replay_override) == (
        listed["hazard_index"], listed["hazard_index_live"], listed["replay_override"])


def test_without_a_database_live_equals_shown():
    for s in site_data.list_sites(None):
        assert s["hazard_index_live"] == s["hazard_index"] and s["replay_override"] is False
