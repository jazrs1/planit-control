"""Connection pool for Tiger Data (TimescaleDB). Opened and closed by the app lifespan in main.py.

Routes that need the database take `pool: ConnectionPool = Depends(get_pool)`.
If DATABASE_URL is unset the app still starts; those routes return 503.
"""

import logging

from fastapi import HTTPException
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from app.config import get_settings

log = logging.getLogger(__name__)

_pool: ConnectionPool | None = None


def open_pool() -> None:
    global _pool
    url = get_settings().database_url
    if not url:
        log.warning("DATABASE_URL is not set; database routes will return 503")
        return
    _pool = ConnectionPool(
        url,
        min_size=1,
        max_size=5,
        open=False,
        name="planit",
        kwargs={"row_factory": dict_row, "connect_timeout": 10},
        # Cloud Postgres drops idle connections; check each one before handing it out.
        check=ConnectionPool.check_connection,
    )
    _pool.open(wait=False)


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


def get_pool() -> ConnectionPool:
    if _pool is None:
        raise HTTPException(status_code=503, detail="Database is not configured")
    return _pool


def ping(timeout: float = 5.0) -> str:
    """'ok', 'not_configured', or 'unreachable'. Never includes connection details."""
    if _pool is None:
        return "not_configured"
    try:
        with _pool.connection(timeout=timeout) as conn:
            conn.execute("SELECT 1")
        return "ok"
    except Exception as err:  # noqa: BLE001 - health check reports any failure the same way
        log.warning("Database health check failed: %s", type(err).__name__)
        return "unreachable"
