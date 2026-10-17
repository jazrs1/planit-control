from datetime import timedelta

from fastapi import APIRouter, Depends, Query, Response
from psycopg_pool import ConnectionPool
from pydantic import TypeAdapter

from alerts import approach
from app import clock
from app.cache import api_cache
from app.db import get_pool
from app.schemas import LightningCell, LightningFlash
from lightning import cells as cellmod

router = APIRouter(prefix="/lightning", tags=["lightning"])

MAX_FLASHES = 10_000
_flashes = TypeAdapter(list[LightningFlash])
_cells = TypeAdapter(list[LightningCell])


@router.get("/recent", response_model=list[LightningFlash])
def recent_flashes(minutes: int = Query(15, ge=1, le=180), pool: ConnectionPool = Depends(get_pool)):
    """Flashes over Florida (+30 mi) in the last `minutes`, newest first. Uses the app clock,
    so during replay this is the last `minutes` of simulated time. Cached for API_CACHE_SECONDS,
    separately for live and replay; replay start/stop clears it (app/cache.py)."""
    def compute() -> bytes:
        now = clock.now()
        with pool.connection() as conn:
            rows = conn.execute(
                "SELECT ts, lat, lon FROM lightning_flashes WHERE ts > %s AND ts <= %s "
                "ORDER BY ts DESC LIMIT %s",
                (now - timedelta(minutes=minutes), now, MAX_FLASHES),
            ).fetchall()
        return _flashes.dump_json(_flashes.validate_python(rows))

    return Response(api_cache.get_or_compute(("lightning", minutes, clock.is_simulated()), compute),
                    media_type="application/json")


@router.get("/cells", response_model=list[LightningCell])
def storm_cells(pool: ConnectionPool = Depends(get_pool)):
    """Storm cells from the last 20 minutes of flashes (app clock, so simulated during replay), largest
    first: center, size, flash counts and, when tracked, motion. Same cells the "approaching"
    forecast uses (lightning/cells.py). Cached like /lightning/recent."""
    def compute() -> bytes:
        now = clock.now()
        with pool.connection() as conn:
            found = approach.current_cells(conn, now)
        rows = [{**c.__dict__, "moving_toward": cellmod.compass(c.heading_deg) if c.heading_deg is not None else None}
                for c in found]
        return _cells.dump_json(_cells.validate_python(rows))

    return Response(api_cache.get_or_compute(("lightning-cells", clock.is_simulated()), compute),
                    media_type="application/json")
