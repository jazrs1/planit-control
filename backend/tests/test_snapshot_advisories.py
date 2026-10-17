"""/sites and /sites/{id}: a replay stop-work never drops a real "lightning approaching" advisory.

Database tests run inside one rolled-back transaction (skipped without DATABASE_URL), on test-only sites,
with alerts and advisories inserted directly. No replay is started: the replay case fakes the app clock."""

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import psycopg
import pytest
from psycopg.rows import dict_row

from app import clock, site_data
from app.config import get_settings
from app.schemas import Site, SiteDetail

SIM = datetime(2031, 1, 6, 17, 0, tzinfo=timezone.utc)
MIN = timedelta(minutes=1)
SITES = ("test-adv-replay-stop", "test-adv-real-stop", "test-adv-replay-only", "test-adv-quiet")


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
    monkeypatch.setattr(site_data, "_real_sites", lambda: {s: {"id": s, "name": s} for s in SITES})
    with psycopg.connect(url, row_factory=dict_row, connect_timeout=15) as conn:
        try:
            if conn.execute("SELECT to_regclass('lightning_advisories') AS t").fetchone()["t"] is None:
                pytest.skip("migration 008 not applied")
            for i, site in enumerate(SITES):
                conn.execute(
                    """INSERT INTO sites (plant_id, id, name, utility, county, lat, lon, technology, capacity_mw, timezone)
                       VALUES (%s, %s, %s, 'Test', 'Test', %s, -84.5, 'Test', 0, 'America/New_York')""",
                    (-940_000 - i, site, site, 24.0 + i * 0.3))
            real = clock.real_now()
            advisory(conn, "test-adv-replay-stop", real, replay=False)   # real advisory + replay stop-work
            stop_work(conn, "test-adv-replay-stop", SIM, replay=True)
            advisory(conn, "test-adv-real-stop", real, replay=False)     # real advisory + real stop-work
            stop_work(conn, "test-adv-real-stop", real, replay=False)
            advisory(conn, "test-adv-replay-only", SIM, replay=True)     # replay advisory + replay stop-work
            stop_work(conn, "test-adv-replay-only", SIM, replay=True)
            advisory(conn, "test-adv-quiet", real, replay=False)         # real advisory, no stop-work
            yield conn
        finally:
            conn.rollback()


def advisory(conn, site, now, replay):
    conn.execute(
        """INSERT INTO lightning_advisories (site_id, replay, started_at, updated_at, arrival_at, first_arrival_at,
                                             from_bearing_deg, heading_deg, speed_mph, distance_mi, cell_flashes)
           VALUES (%s, %s, %s, %s, %s, %s, 250, 70, 18, 16.0, 60)""",
        (site, replay, now - 3 * MIN, now, now + 20 * MIN, now + 22 * MIN))


def stop_work(conn, site, now, replay):
    conn.execute(
        """INSERT INTO alerts (site_id, type, status, started_at, all_clear_at, last_strike_at, last_strike_distance_mi, replay)
           VALUES (%s, 'lightning', 'active', %s, %s, %s, 3.2, %s)""",
        (site, now - 5 * MIN, now + 25 * MIN, now - 5 * MIN, replay))


def approach(conn) -> dict[str, dict | None]:
    listed = [Site(**s) for s in site_data.list_sites(FakePool(conn))]
    return {s.id: s.lightning_approach.model_dump() if s.lightning_approach else None for s in listed if s.id in SITES}


def test_during_a_replay_a_replay_stop_work_keeps_the_real_advisory(conn, monkeypatch):
    monkeypatch.setattr(clock, "is_simulated", lambda: True)
    monkeypatch.setattr(clock, "now", lambda: SIM)
    got = approach(conn)
    assert got["test-adv-replay-stop"] is not None and got["test-adv-replay-stop"]["replay"] is False
    assert got["test-adv-real-stop"] is None          # a real stop-work: the stop-work is the bigger news
    assert got["test-adv-replay-only"] is None        # a replay advisory superseded by its own stop-work
    assert got["test-adv-quiet"] is not None and got["test-adv-quiet"]["replay"] is False
    detail = SiteDetail(**site_data.get_site_detail(FakePool(conn), "test-adv-replay-stop"))
    assert detail.lightning_approach is not None and detail.lightning_approach.replay is False


def test_without_a_replay_only_a_real_stop_work_drops_the_advisory(conn):
    got = approach(conn)                              # replay rows are ignored without a replay
    assert got["test-adv-replay-stop"] is not None and got["test-adv-replay-stop"]["replay"] is False
    assert got["test-adv-real-stop"] is None
    assert got["test-adv-replay-only"] is None        # its advisory is a replay one: never shown live
    assert got["test-adv-quiet"] is not None
