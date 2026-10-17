"""Background task that polls GOES-19 GLM every ~20 s (started in app/main.py's lifespan)."""

import asyncio
import logging

from psycopg_pool import ConnectionPool

from app import clock
from lightning import glm, replay

log = logging.getLogger(__name__)


async def run_live_loop(pool: ConnectionPool, interval_seconds: float) -> None:
    """Never raises (except on cancellation): failures are logged and retried next cycle."""
    log.info("GLM live ingestion started (every %.0f s)", interval_seconds)
    loop = asyncio.get_running_loop()
    while True:
        async with replay.ingest_lock:  # blocks here while a replay runs
            started = loop.time()
            try:
                result = await asyncio.to_thread(glm.poll_latest, pool, clock.now())
                if result.files_ingested or result.files_failed:
                    log.info("GLM live: %d files, %d new Florida flashes, %d failed",
                             result.files_ingested, len(result.new_flashes), result.files_failed)
            except Exception as err:  # noqa: BLE001 - e.g. S3 listing or DB unreachable
                log.warning("GLM live cycle failed, retrying next cycle: %s: %s", type(err).__name__, err)
        await asyncio.sleep(max(0.0, interval_seconds - (loop.time() - started)))
