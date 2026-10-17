"""Replay a downloaded GLM window as if it were happening now.

Files from backend/data/replay/<window>/ (made by scripts/find_replay_window.py) go through
glm.ingest_cycle(), the same function the live loop uses, one file per cycle, in time order.
The app clock (app/clock.py) is switched to a simulated clock that starts at the window's
first file and runs `speed` times faster, and each file is ingested when the simulated clock
reaches the moment it would have appeared live (its start + 20 s). The live loop pauses
meanwhile (ingest_lock), so /lightning/recent, the alert hook and anything else using clock.now() see the
replayed storm as live.
"""

import asyncio
import logging
from datetime import timedelta
from pathlib import Path

from psycopg_pool import ConnectionPool

from app import clock
from app.config import BACKEND_DIR
from lightning import glm

log = logging.getLogger(__name__)

REPLAY_DIR = BACKEND_DIR / "data" / "replay"

# Held by the live loop for each cycle and by a replay for its whole run, so the two never
# interleave (and the alert hook never sees real and simulated `now` mixed together).
ingest_lock = asyncio.Lock()


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
        }

    async def _run(self, pool: ConnectionPool, files: list[Path]) -> None:
        async with ingest_lock:  # waits for an in-flight live cycle, then pauses live polling
            await self._replay(pool, files)

    async def _replay(self, pool: ConnectionPool, files: list[Path]) -> None:
        names = [p.name for p in files]
        start = glm.file_start(names[0])
        end = glm.file_start(names[-1]) + timedelta(seconds=glm.FILE_SECONDS)
        await asyncio.to_thread(_reset_window, pool, names, start, end)

        clock.start_simulation(start, self.speed)
        log.info("Replay %s started at %sx (%d files)", self.window, self.speed, len(files))
        try:
            for path in files:
                # A file appears live once its 20 s scan ends; wait for that moment on the simulated clock.
                await clock.sleep_until(glm.file_start(path.name) + timedelta(seconds=glm.FILE_SECONDS))
                result = await asyncio.to_thread(
                    glm.ingest_cycle, pool, [(path.name, path.read_bytes)], clock.now())
                self.files_done += 1
                self.flashes_ingested += len(result.new_flashes)
            log.info("Replay %s finished: %d Florida flashes", self.window, self.flashes_ingested)
        except asyncio.CancelledError:
            log.info("Replay %s stopped after %d/%d files", self.window, self.files_done, self.files_total)
            raise
        except Exception:  # noqa: BLE001 - a broken replay must not take the API down
            log.exception("Replay %s failed", self.window)
        finally:
            clock.stop_simulation()


def _reset_window(pool: ConnectionPool, names: list[str], start, end) -> None:
    """Remove this window's flashes from earlier runs so every replay re-ingests them as new."""
    with pool.connection() as conn:
        conn.execute(
            "DELETE FROM lightning_flashes WHERE ts BETWEEN %s AND %s AND source_file = ANY(%s)",
            (start - timedelta(minutes=1), end + timedelta(minutes=1), names),
        )
    glm.forget(names)
    glm.refresh_rollup(pool, start - timedelta(minutes=1), end + timedelta(minutes=1))


runner = ReplayRunner()
