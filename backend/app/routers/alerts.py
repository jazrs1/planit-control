from fastapi import APIRouter, Depends
from psycopg_pool import ConnectionPool

from alerts import engine
from app import clock
from app.db import get_pool
from app.schemas import Alert

router = APIRouter(prefix="/alerts", tags=["alerts"])


@router.get("", response_model=list[Alert])
def list_active_alerts(pool: ConnectionPool = Depends(get_pool)):
    """Alerts in effect right now (simulated now during replay, showing replay alerts)."""
    with pool.connection() as conn:
        return engine.active_alerts(conn, clock.now(), replay=clock.is_simulated())
