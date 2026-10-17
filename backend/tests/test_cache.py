"""The short API cache: TTL, single-flight, invalidation, and the alert engine clearing it."""

import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone

import pytest

from alerts import engine
from app.cache import TTLCache


def counter():
    calls = {"n": 0}

    def compute():
        calls["n"] += 1
        return calls["n"]
    return calls, compute


def test_reuses_value_within_ttl_and_recomputes_after():
    cache, (calls, compute) = TTLCache(), counter()
    assert cache.get_or_compute("k", compute, ttl=0.2) == 1
    assert cache.get_or_compute("k", compute, ttl=0.2) == 1
    time.sleep(0.25)
    assert cache.get_or_compute("k", compute, ttl=0.2) == 2


def test_zero_ttl_disables_caching():
    cache, (calls, compute) = TTLCache(), counter()
    cache.get_or_compute("k", compute, ttl=0)
    cache.get_or_compute("k", compute, ttl=0)
    assert calls["n"] == 2


def test_invalidate_forces_recompute_immediately():
    cache, (calls, compute) = TTLCache(), counter()
    cache.get_or_compute("k", compute, ttl=60)
    cache.invalidate()
    assert cache.get_or_compute("k", compute, ttl=60) == 2


def test_keys_are_separate():
    cache, (calls, compute) = TTLCache(), counter()
    cache.get_or_compute(("alerts", False), compute, ttl=60)
    cache.get_or_compute(("alerts", True), compute, ttl=60)   # replay mode never reuses live data
    assert calls["n"] == 2


def test_single_flight_under_concurrency():
    cache, calls = TTLCache(), {"n": 0}

    def slow():
        calls["n"] += 1
        time.sleep(0.2)
        return "body"

    results = []
    threads = [threading.Thread(target=lambda: results.append(cache.get_or_compute("sites", slow, ttl=5)))
               for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert calls["n"] == 1 and results == ["body"] * 20


def test_errors_are_not_cached():
    cache, calls = TTLCache(), {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("db down")
        return "ok"

    with pytest.raises(RuntimeError):
        cache.get_or_compute("k", flaky, ttl=60)
    assert cache.get_or_compute("k", flaky, ttl=60) == "ok"


def test_result_computed_across_an_invalidate_is_not_stored():
    cache = TTLCache()
    started, release = threading.Event(), threading.Event()

    def slow_old_data():
        started.set()
        release.wait(2)
        return "old"

    t = threading.Thread(target=lambda: cache.get_or_compute("alerts", slow_old_data, ttl=60))
    t.start()
    started.wait(2)
    cache.invalidate()          # an alert changed while "old" was being computed
    release.set()
    t.join()
    assert cache.get_or_compute("alerts", lambda: "new", ttl=60) == "new"


@pytest.mark.parametrize("changed, expect_invalidated", [(True, True), (False, False)])
def test_alert_engine_clears_cache_only_when_alerts_change(monkeypatch, changed, expect_invalidated):
    from app import cache as cache_module
    from app import db

    invalidated = []
    monkeypatch.setattr(cache_module.api_cache, "invalidate", lambda: invalidated.append(True))

    class Pool:
        @contextmanager
        def connection(self):
            yield None

    monkeypatch.setattr(db, "get_pool", lambda: Pool())
    monkeypatch.setattr(engine, "load_sites", lambda conn: [])
    summary = engine.CycleSummary(created=["s"] if changed else [])
    monkeypatch.setattr(engine, "process", lambda *a, **k: summary)
    engine.run([], datetime(2025, 8, 4, 22, tzinfo=timezone.utc), replay=False)
    assert bool(invalidated) == expect_invalidated
