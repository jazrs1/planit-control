"""Background polling of hazard sources (started from app/main.py's lifespan).

  weather (Open-Meteo)   every 60 min   heat, rain, soil (WEATHER_POLL_MINUTES; its models update
                                        at most hourly, so polling faster only repeats data), then
                                        the hazard model scores every site from the same forecasts
  NWS alerts             every  5 min
  FIRMS fires            every 30 min   (skipped without FIRMS_MAP_KEY)
  iNaturalist wildlife   every  6 h
  one-time lookups       FEMA flood zone, nearby river, NWS zones (retried hourly until done)

Each source runs in its own loop, so a slow one never delays another. A failed poll is logged and
recorded in data_sources; the last good readings stay in the database and keep being served with
their timestamps. After a restart, a source that succeeded recently waits until it is due again.
Pollers use real time, not the replay clock: their data is live even while lightning replays.
"""

import asyncio
import logging
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

from psycopg_pool import ConnectionPool

from alerts import flood
from app.config import get_settings
from hazards import model_scores
from hazards.sources import firms, flood_maps, inaturalist, nws, open_meteo
from hazards.store import last_success, mark_source

log = logging.getLogger(__name__)


def _sites(pool: ConnectionPool) -> list[dict]:
    with pool.connection() as conn:
        return conn.execute(
            "SELECT id, lat, lon, timezone, nws_forecast_zone, nws_county_zone, nws_fire_zone FROM sites ORDER BY id"
        ).fetchall()


def _weather(pool, now):
    sites = _sites(pool)
    forecasts = open_meteo.fetch(sites)
    result = open_meteo.store(pool, sites, forecasts, now)
    flood.evaluate(pool, now)
    # Same forecasts, no extra API calls: hazard model + hybrid index, stored in hazard_scores.
    return f"{result}; {model_scores.run(pool, sites, forecasts, now)}"


def _nws(pool, now):
    nws.lookup_zones(pool, now)  # no-op once every site has its zones
    result = nws.poll(pool, _sites(pool), now)
    flood.evaluate(pool, now)
    return result


def _lookups(pool, now):
    return "; ".join([flood_maps.lookup_fema(pool, now), flood_maps.lookup_rivers(pool, now)])


JOBS: list[tuple[str, timedelta, Callable]] = [
    ("site-lookups", timedelta(hours=1), _lookups),
    (open_meteo.NAME, timedelta(minutes=get_settings().weather_poll_minutes), _weather),
    (nws.NAME, timedelta(minutes=5), _nws),
    (firms.NAME, timedelta(minutes=30), lambda pool, now: firms.poll(pool, _sites(pool), now)),
    (inaturalist.NAME, timedelta(hours=6), lambda pool, now: inaturalist.poll(pool, _sites(pool), now)),
]


def run_once(pool: ConnectionPool, name: str, job: Callable) -> bool:
    """Run one poll and record the outcome. Never raises."""
    now = datetime.now(timezone.utc)
    try:
        detail = job(pool, now)
        mark_source(pool, name, now, detail=detail)
        log.info("Hazard source %s: %s", name, detail)
        return True
    except firms.SkipSource as reason:
        mark_source(pool, name, now, error=None, detail=f"skipped: {reason}")
        log.info("Hazard source %s skipped: %s", name, reason)
        return True
    except Exception as err:  # noqa: BLE001 - one bad source must not stop the others or the API
        try:
            mark_source(pool, name, now, error=f"{type(err).__name__}: {err}"[:500])
        except Exception:  # noqa: BLE001 - database may be the thing that's down
            pass
        log.warning("Hazard source %s failed; keeping last good data: %s: %s", name, type(err).__name__, err)
        return False


async def _job_loop(pool: ConnectionPool, name: str, interval: timedelta, job: Callable) -> None:
    try:
        with pool.connection() as conn:
            last = last_success(conn, name)
        wait = (last + interval - datetime.now(timezone.utc)).total_seconds() if last else 0
    except Exception:  # noqa: BLE001
        wait = 0
    await asyncio.sleep(max(0.0, wait))
    while True:
        started = asyncio.get_running_loop().time()
        await asyncio.to_thread(run_once, pool, name, job)
        elapsed = asyncio.get_running_loop().time() - started
        await asyncio.sleep(max(0.0, interval.total_seconds() - elapsed))


def start(pool: ConnectionPool) -> list[asyncio.Task]:
    return [asyncio.create_task(_job_loop(pool, name, interval, job)) for name, interval, job in JOBS]
