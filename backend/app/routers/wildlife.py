from fastapi import APIRouter, Depends, Response
from psycopg_pool import ConnectionPool
from pydantic import TypeAdapter

from app import clock
from app.cache import api_cache
from app.db import get_pool
from app.schemas import WildlifeSightingPoint
from hazards import map_points

router = APIRouter(prefix="/wildlife", tags=["wildlife"])

_sightings = TypeAdapter(list[WildlifeSightingPoint])


@router.get("/recent", response_model=list[WildlifeSightingPoint])
def recent_wildlife(pool: ConnectionPool = Depends(get_pool)):
    """Alligator and venomous-snake sightings near our sites (iNaturalist) and crew wildlife reports from
    the last 30 days, newest first, with coordinates. Crew notes are never included."""
    def compute() -> bytes:
        with pool.connection() as conn:
            return _sightings.dump_json(_sightings.validate_python(map_points.recent_wildlife(conn, clock.real_now())))

    return Response(api_cache.get_or_compute(("wildlife-recent",), compute), media_type="application/json")
