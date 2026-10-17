"""GET /lightning/recent and /lightning/recent/counts: real lightning always, plus a running replay's.

Database tests run inside one rolled-back transaction (skipped without DATABASE_URL). The replay case
only fakes the app clock (no replay is started), and the test flashes sit at a spot no real flash has,
so the shared database's own lightning doesn't matter."""

import json
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import psycopg
import pytest
from psycopg.rows import dict_row

from app import clock
from app.cache import TTLCache
from app.config import BACKEND_DIR, get_settings
from app.routers import lightning as route
from app.schemas import LightningFlash, LightningRecentCounts

SIM = datetime(2031, 1, 6, 17, 0, tzinfo=timezone.utc)   # the fake replay clock: no stored flash is near it
LAT, LON = 24.123456, -83.654321
MIN = timedelta(minutes=1)


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
    monkeypatch.setattr(route, "api_cache", TTLCache())
    with psycopg.connect(url, row_factory=dict_row, connect_timeout=15) as conn:
        try:
            yield conn
        finally:
            conn.rollback()


def flash(conn, ts, lat=LAT):
    conn.execute("INSERT INTO lightning_flashes (ts, lat, lon, energy, source_file) VALUES (%s, %s, %s, NULL, 'test')",
                 (ts, lat, LON))


def recent(conn, minutes=15):
    route.api_cache.invalidate()
    return [LightningFlash(**f) for f in json.loads(route.recent_flashes(minutes, FakePool(conn)).body)]


def counts(conn, minutes=15):
    route.api_cache.invalidate()
    return LightningRecentCounts(**json.loads(route.recent_flash_counts(minutes, FakePool(conn)).body))


def mine(flashes):
    return [(f.ts, f.replay) for f in flashes if (round(f.lat, 6), round(f.lon, 6)) == (LAT, LON)]


def replaying(monkeypatch):
    monkeypatch.setattr(clock, "is_simulated", lambda: True)
    monkeypatch.setattr(clock, "now", lambda: SIM)


def test_without_a_replay_only_real_flashes_as_before(conn):
    real_now = clock.real_now()
    before = counts(conn)
    flash(conn, real_now - 2 * MIN)
    flash(conn, real_now - 20 * MIN)          # older than 15 min
    flash(conn, SIM - 1 * MIN)                # a stored "replay" flash: not shown without a replay
    got = recent(conn)
    assert mine(got) == [(real_now - 2 * MIN, False)]
    assert all(not f.replay for f in got)
    assert [f.ts for f in got] == sorted((f.ts for f in got), reverse=True)        # newest first, as before
    after = counts(conn)
    assert (after.real - before.real, after.replay) == (1, 0) and after.minutes == 15


def test_during_a_replay_real_and_replay_flashes_both_show(conn, monkeypatch):
    real_now = clock.real_now()
    flash(conn, real_now - 3 * MIN)
    flash(conn, real_now - 1 * MIN)
    flash(conn, SIM - 4 * MIN)
    flash(conn, SIM - 30 * MIN)               # outside the replay's last 15 simulated minutes
    replaying(monkeypatch)
    got = recent(conn)
    assert mine(got) == [(real_now - 1 * MIN, False), (real_now - 3 * MIN, False), (SIM - 4 * MIN, True)]
    first_replay = next(i for i, f in enumerate(got) if f.replay)
    assert all(not f.replay for f in got[:first_replay]) and all(f.replay for f in got[first_replay:])
    c = counts(conn)
    assert c.replay == 1                      # only the test flash is near the fake replay clock
    assert c.real == sum(not f.replay for f in got)


def test_minutes_applies_to_both_windows(conn, monkeypatch):
    real_now = clock.real_now()
    flash(conn, real_now - 10 * MIN)
    flash(conn, SIM - 10 * MIN)
    replaying(monkeypatch)
    assert mine(recent(conn, minutes=5)) == []
    assert mine(recent(conn, minutes=15)) == [(real_now - 10 * MIN, False), (SIM - 10 * MIN, True)]


def test_each_layer_has_its_own_cap(conn, monkeypatch):
    real_now = clock.real_now()
    monkeypatch.setattr(route, "MAX_FLASHES", 2)
    for i in range(3):
        flash(conn, SIM - (i + 1) * MIN)
    replaying(monkeypatch)
    got = recent(conn)
    assert sum(f.replay for f in got) == 2              # capped
    assert counts(conn).replay == 3                     # the count isn't
    assert sum(not f.replay for f in got) <= 2


def test_mocks_match_the_schemas():
    mocks = BACKEND_DIR.parent / "shared" / "mocks"
    flashes = [LightningFlash(**f) for f in json.loads((mocks / "lightning_recent.json").read_text())]
    assert flashes and all(f.replay is False for f in flashes)
    LightningRecentCounts(**json.loads((mocks / "lightning_recent_counts.json").read_text()))
