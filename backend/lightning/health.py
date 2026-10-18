"""Is lightning data current? The last successful ingestion cycle, per mode (live / replay).

A cycle succeeds when every file it tried was ingested, the stop-work engine ran, and (live) NOAA's
newest GLM file started within STALE_AFTER of now, so a stalled satellite feed counts as a failure
too. Live cycles are judged on real time, replay cycles on the replay clock. Kept in memory: the API
runs as one process (deploy/planit-api.service), and after a restart it is unknown until the first
cycle succeeds.

The beacon (GET /sites/{id}/beacon) reports "unknown" instead of "clear" when the last success is
older than STALE_AFTER: no data must never look like no lightning.
"""

import threading
from datetime import datetime, timedelta

STALE_AFTER = timedelta(minutes=2)

_lock = threading.Lock()
_last_success: dict[bool, datetime] = {}   # replay? -> clock time of the last successful cycle
_stalled: set[bool] = set()   # modes whose newest file was too old: not current, but the last success is kept


def record_success(at: datetime, *, replay: bool) -> None:
    with _lock:
        _last_success[replay] = max(at, _last_success.get(replay, at))
        _stalled.discard(replay)


def reset(*, replay: bool) -> None:
    """Forget the mode's last success (a new replay starts unknown until its first cycle)."""
    with _lock:
        _last_success.pop(replay, None)
        _stalled.discard(replay)


def mark_stalled(*, replay: bool) -> None:
    """The feed is stalled: not current from now on, until the next success. Unlike reset(), the last
    success is kept, so the first cycle after the stall can look back to it for files published late."""
    with _lock:
        _stalled.add(replay)


def last_success(*, replay: bool) -> datetime | None:
    with _lock:
        return _last_success.get(replay)


def is_current(now: datetime, *, replay: bool) -> bool:
    """True when the mode's last successful cycle is within STALE_AFTER of `now` (its own clock)."""
    with _lock:
        if replay in _stalled:
            return False
    last = last_success(replay=replay)
    return last is not None and now - last <= STALE_AFTER
