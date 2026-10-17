from fastapi import APIRouter, Depends, Response
from psycopg_pool import ConnectionPool
from pydantic import TypeAdapter

from alerts import engine
from app import clock
from app.cache import api_cache
from app.db import get_pool
from app.schemas import Alert

router = APIRouter(prefix="/alerts", tags=["alerts"])

_alerts = TypeAdapter(list[Alert])


@router.get("", response_model=list[Alert])
def list_active_alerts(pool: ConnectionPool = Depends(get_pool)):
    """Alerts in effect right now (simulated now during replay, showing replay alerts).
    Cached for API_CACHE_SECONDS; any alert change clears the cache (app/cache.py)."""
    def compute() -> bytes:
        with pool.connection() as conn:
            rows = engine.active_alerts(conn, clock.now(), replay=clock.is_simulated())
        return _alerts.dump_json(_alerts.validate_python(rows))

    return Response(api_cache.get_or_compute(("alerts", clock.is_simulated()), compute),
                    media_type="application/json")
