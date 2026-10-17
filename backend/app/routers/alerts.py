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
    """Alerts in effect right now: live ones always, plus replay ones (at the simulated time) while a
    replay runs, each tagged with `replay`. Cached for API_CACHE_SECONDS; any alert change clears
    the cache (app/cache.py)."""
    def compute() -> bytes:
        replay_now = clock.now() if clock.is_simulated() else None
        with pool.connection() as conn:
            rows = engine.alerts_for_api(conn, clock.real_now(), replay_now)
        return _alerts.dump_json(_alerts.validate_python(rows))

    return Response(api_cache.get_or_compute(("alerts", clock.is_simulated()), compute),
                    media_type="application/json")
