from datetime import timedelta

from fastapi import APIRouter, Depends, Query
from psycopg_pool import ConnectionPool

from app import clock
from app.db import get_pool
from app.schemas import LightningFlash

router = APIRouter(prefix="/lightning", tags=["lightning"])

MAX_FLASHES = 10_000


@router.get("/recent", response_model=list[LightningFlash])
def recent_flashes(minutes: int = Query(15, ge=1, le=180), pool: ConnectionPool = Depends(get_pool)):
    """Flashes over Florida (+30 mi) in the last `minutes`, newest first. Uses the app clock,
    so during replay this is the last `minutes` of simulated time."""
    now = clock.now()
    with pool.connection() as conn:
        return conn.execute(
            "SELECT ts, lat, lon FROM lightning_flashes WHERE ts > %s AND ts <= %s "
            "ORDER BY ts DESC LIMIT %s",
            (now - timedelta(minutes=minutes), now, MAX_FLASHES),
        ).fetchall()
