"""Writing hazard readings to the conditions hypertable, and tracking source health."""

import math
from datetime import datetime

from psycopg import Connection
from psycopg_pool import ConnectionPool


def write_readings(pool: ConnectionPool, rows: list[tuple[str, datetime, str, str, float, str]]) -> int:
    """Insert (site_id, ts, hazard, metric, value, source) rows; a repeat of the same key updates it.
    NaN means "none" (e.g. no fire detected) and is stored as NaN."""
    if not rows:
        return 0
    with pool.connection() as conn, conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO conditions (site_id, ts, hazard, metric, value, source)
               VALUES (%s, %s, %s, %s, %s, %s)
               ON CONFLICT (site_id, hazard, metric, ts) DO UPDATE
               SET value = EXCLUDED.value, source = EXCLUDED.source""",
            rows,
        )
    return len(rows)


def mark_source(pool: ConnectionPool, name: str, now: datetime, *, error: str | None = None,
                detail: str | None = None) -> None:
    """Record a poll attempt. On error, last_success_at is left alone: it is the timestamp of the
    last good value, which keeps being served."""
    with pool.connection() as conn:
        conn.execute(
            """INSERT INTO data_sources (name, last_success_at, last_attempt_at, last_error, detail)
               VALUES (%(name)s, CASE WHEN %(ok)s THEN %(now)s END, %(now)s, %(error)s, %(detail)s)
               ON CONFLICT (name) DO UPDATE SET
                   last_success_at = CASE WHEN %(ok)s THEN %(now)s ELSE data_sources.last_success_at END,
                   last_attempt_at = %(now)s,
                   last_error = %(error)s,
                   detail = coalesce(%(detail)s, data_sources.detail)""",
            {"name": name, "ok": error is None, "now": now, "error": error, "detail": detail},
        )


def last_success(conn: Connection, name: str) -> datetime | None:
    row = conn.execute("SELECT last_success_at FROM data_sources WHERE name = %s", (name,)).fetchone()
    return row["last_success_at"] if row else None


def clean(value: float | None) -> float | None:
    """NaN (stored for "none") -> None."""
    return None if value is None or (isinstance(value, float) and math.isnan(value)) else value
