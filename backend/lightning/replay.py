"""Replay a downloaded GLM window as if it were happening now.

Files from backend/data/replay/<window>/ (made by scripts/find_replay_window.py) go through
glm.ingest_cycle(), the same function the live loop uses, one file per cycle, in time order.
The app clock (app/clock.py) is switched to a simulated clock that starts at the window's
first file and runs `speed` times faster, and each file is ingested when the simulated clock
reaches the moment it would have appeared live (its start + 20 s). After the last file it keeps
cycling with no new flashes for 31 simulated minutes so alert countdowns can finish (status shows
files_done == files_total while still running). /lightning/recent and anything else using
clock.now() see the replayed storm as live. Replay cycles write replay alerts (replay = true); the
live loop keeps ingesting on real time meanwhile, so real stop-work alerts stay current and
GET /alerts shows both.
"""

import asyncio
import logging
from datetime import datetime, timedelta
from pathlib import Path

import psycopg
from psycopg_pool import ConnectionPool

from app import clock
from app.cache import api_cache
from lightning import glm, health, timeline

log = logging.getLogger(__name__)

REPLAY_DIR = timeline.REPLAY_DIR

# After the last file, keep cycling with no new flashes (like live does on a quiet night) long
# enough for every 30-minute all-clear countdown to finish.
QUIET_TAIL = timeline.QUIET_TAIL   # lightning/timeline.py simulates the same tail
FILE_PERIOD = timedelta(seconds=glm.FILE_SECONDS)

def available_windows() -> list[str]:
    if not REPLAY_DIR.exists():
        return []
    return sorted(d.name for d in REPLAY_DIR.iterdir() if d.is_dir() and any(d.glob("*.nc")))


class ReplayRunner:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self.window: str | None = None
        self.speed: float | None = None
        self.files_total = 0
        self.files_done = 0
        self.flashes_ingested = 0
        self.times: dict | None = None            # window_start, window_end, quiet_until (lightning/timeline.py)
        self.ended_at: datetime | None = None     # simulated time when the last run stopped or finished

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def start(self, pool: ConnectionPool, window: str, speed: float) -> None:
        if self.running:
            raise RuntimeError("A replay is already running")
        files = sorted((REPLAY_DIR / window).glob("*.nc"), key=lambda p: glm.file_start(p.name))
        if not files:
            raise FileNotFoundError(f"No GLM files in data/replay/{window}")
        self.window, self.speed = window, speed
        self.files_total, self.files_done, self.flashes_ingested = len(files), 0, 0
        self.times, self.ended_at = timeline.window_times(window), None
        timeline.ensure(window)   # the whole storm's events for GET /replay/events (background, cached)
        self._task = asyncio.create_task(self._run(pool, files))

    async def stop(self) -> None:
        if self.running:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def status(self) -> dict:
        return {
            "running": self.running,
            "window": self.window,
            "speed": self.speed,
            "simulated_now": clock.now() if self.running and clock.is_simulated() else None,
            "files_total": self.files_total,
            "files_done": self.files_done,
            "flashes_ingested": self.flashes_ingested,
            "window_start": self.times["window_start"] if self.times else None,
            "window_end": self.times["window_end"] if self.times else None,
            "quiet_until": self.times["quiet_until"] if self.times else None,
        }

    def simulated_until(self) -> datetime | None:
        """How far the current or most recent run has got: simulated now, or where it stopped or ended."""
        if self.running and clock.is_simulated():
            return clock.now()
        return self.ended_at

    async def _run(self, pool: ConnectionPool, files: list[Path]) -> None:
        names = [p.name for p in files]
        start = glm.file_start(names[0])
        end = glm.file_start(names[-1]) + timedelta(seconds=glm.FILE_SECONDS)
        await asyncio.to_thread(_reset_window, pool, names, start, end)

        health.reset(replay=True)   # unknown until the first replay cycle succeeds
        clock.start_simulation(start, self.speed)
        api_cache.invalidate()
        log.info("Replay %s started at %sx (%d files)", self.window, self.speed, len(files))
        try:
            for path in files:
                # A file appears live once its 20 s scan ends; wait for that moment on the simulated clock.
                due = glm.file_start(path.name) + FILE_PERIOD
                await clock.sleep_until(due)
                if clock.now() > due + FILE_PERIOD:
                    # Ingestion fell behind the requested speed. Hold the clock back to this file's
                    # moment instead of letting simulated time race ahead of the data.
                    clock.start_simulation(due, self.speed)
                now = clock.now()
                result = await asyncio.to_thread(glm.ingest_cycle, pool, [(path.name, path.read_bytes)], now, True)
                if result.ok:
                    health.record_success(now, replay=True)
                self.files_done += 1
                self.flashes_ingested += len(result.new_flashes)
            log.info("Replay %s: all files in (%d Florida flashes); quiet tail for countdowns",
                     self.window, self.flashes_ingested)
            tail_end = end + QUIET_TAIL
            while clock.now() < tail_end:
                await clock.sleep_until(min(clock.now() + FILE_PERIOD, tail_end))
                now = clock.now()
                if (await asyncio.to_thread(glm.ingest_cycle, pool, [], now, True)).ok:
                    health.record_success(now, replay=True)
            log.info("Replay %s finished", self.window)
        except asyncio.CancelledError:
            log.info("Replay %s stopped after %d/%d files", self.window, self.files_done, self.files_total)
            raise
        except Exception:  # noqa: BLE001 - a broken replay must not take the API down
            log.exception("Replay %s failed", self.window)
        finally:
            self.ended_at = clock.now() if clock.is_simulated() else None
            clock.stop_simulation()
            api_cache.invalidate()


def _reset_window(pool: ConnectionPool, names: list[str], start, end) -> None:
    """Remove earlier replay runs (this window's flashes, all replay alerts and advisories) so every replay
    starts clean and re-ingests the storm as new."""
    with pool.connection() as conn:
        conn.execute("DELETE FROM alerts WHERE replay")  # alert_events cascade
        try:
            with conn.transaction():  # savepoint: the table doesn't exist until migration 008
                conn.execute("DELETE FROM lightning_advisories WHERE replay")
        except psycopg.errors.UndefinedTable:
            pass
        conn.execute(
            "DELETE FROM lightning_flashes WHERE ts BETWEEN %s AND %s AND source_file = ANY(%s)",
            (start - timedelta(minutes=1), end + timedelta(minutes=1), names),
        )
    glm.forget(names)
    glm.refresh_rollup(pool, start - timedelta(minutes=1), end + timedelta(minutes=1))


runner = ReplayRunner()
