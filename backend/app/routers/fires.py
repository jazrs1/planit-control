from fastapi import APIRouter, Depends, Response
from psycopg_pool import ConnectionPool
from pydantic import TypeAdapter

from app import clock
from app.cache import api_cache
from app.db import get_pool
from app.schemas import FireDetection
from hazards import map_points

router = APIRouter(prefix="/fires", tags=["fires"])

_fires = TypeAdapter(list[FireDetection])
CACHE_SECONDS = 60   # FIRMS is polled every 30 minutes


@router.get("/recent", response_model=list[FireDetection])
def recent_fires(pool: ConnectionPool = Depends(get_pool)):
    """Satellite fire detections over Florida from the last 24 h, newest first, without the plant hot
    spots the wildfire cards ignore. passes_24h: separate satellite passes that saw fire within 5 mi of
    the point (2+ is what the wildfire card calls confirmed). Map points for the layers panel."""
    def compute() -> bytes:
        with pool.connection() as conn:
            return _fires.dump_json(_fires.validate_python(map_points.recent_fires(conn, clock.real_now())))

    return Response(api_cache.get_or_compute(("fires-recent",), compute, ttl=CACHE_SECONDS),
                    media_type="application/json")
