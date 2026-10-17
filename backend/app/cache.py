"""Short server-side cache for hot read endpoints (GET /sites, /sites/{id}, /alerts).

During a replay every open dashboard polls every 3 seconds, and /sites alone runs ~7 queries.
Caching the serialized response for API_CACHE_SECONDS (default 2.5 s) makes N dashboards cost
about one computation per endpoint per window instead of N.

- Single-flight: when an entry expires, one request recomputes it and concurrent requests for the
  same key wait for that result instead of all hitting the database.
- Freshness: anything that changes alerts calls invalidate() (the lightning engine, flood rule,
  replay start/stop), so alert changes show up on the very next request. Everything else is at
  most API_CACHE_SECONDS old. Errors are never cached.
- Keys include the replay mode, so live and replay responses never mix.
Per process: with several workers, each has its own cache (still bounded by the TTL).
"""

import threading
import time
from collections.abc import Callable, Hashable
from typing import TypeVar

from app.config import get_settings

T = TypeVar("T")


class TTLCache:
    def __init__(self) -> None:
        self._entries: dict[Hashable, tuple[float, int, object]] = {}  # key -> (expires, generation, value)
        self._key_locks: dict[Hashable, threading.Lock] = {}
        self._guard = threading.Lock()
        self._generation = 0

    def _fresh(self, key: Hashable) -> tuple[bool, object]:
        entry = self._entries.get(key)
        if entry and entry[0] > time.monotonic() and entry[1] == self._generation:
            return True, entry[2]
        return False, None

    def get_or_compute(self, key: Hashable, compute: Callable[[], T], ttl: float | None = None) -> T:
        ttl = get_settings().api_cache_seconds if ttl is None else ttl
        if ttl <= 0:
            return compute()
        with self._guard:
            hit, value = self._fresh(key)
            if hit:
                return value  # type: ignore[return-value]
            key_lock = self._key_locks.setdefault(key, threading.Lock())
        with key_lock:  # single-flight per key
            with self._guard:
                hit, value = self._fresh(key)  # another request may have just computed it
                if hit:
                    return value  # type: ignore[return-value]
                generation = self._generation
            value = compute()
            with self._guard:
                if generation == self._generation:  # don't store a result that an invalidate() raced
                    self._entries[key] = (time.monotonic() + ttl, generation, value)
            return value

    def invalidate(self) -> None:
        """Drop everything (cheap: entries are a few small responses)."""
        with self._guard:
            self._generation += 1
            self._entries.clear()


api_cache = TTLCache()
