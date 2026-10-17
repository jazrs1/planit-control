"""Push tables for database tests, inside the test's rolled-back transaction.

Creates whatever of migrations 009-010 the database doesn't have yet, so the tests run before the
migrations are applied. 009's index on alert_events is skipped (it would lock that shared table for
the whole test); applying 010 to an existing push_subscriptions table locks only that table, and
only until the test rolls back.
"""

from app.config import BACKEND_DIR

MIGRATIONS = BACKEND_DIR / "db" / "migrations"


def ensure_push_schema(conn) -> None:
    conn.execute("SET LOCAL lock_timeout = '5s'")
    if conn.execute("SELECT to_regclass('push_subscriptions') AS t").fetchone()["t"] is None:
        sql = (MIGRATIONS / "009_push_notifications.sql").read_text()
        conn.execute(sql.split("CREATE INDEX alert_events_recorded_idx")[0])
    has_seen = conn.execute(
        """SELECT 1 FROM information_schema.columns
           WHERE table_name = 'push_subscriptions' AND column_name = 'last_seen_at'""").fetchone()
    if has_seen is None:
        conn.execute((MIGRATIONS / "010_push_limits.sql").read_text())
