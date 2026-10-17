"""Apply pending SQL migrations in backend/db/migrations/ to DATABASE_URL.

    cd backend && python -m scripts.migrate

Each file runs in its own transaction and is recorded in schema_migrations, so
rerunning only applies new files. Never edit an applied file; add the next number.
"""

import sys
from pathlib import Path

import psycopg

from app.config import get_settings

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "db" / "migrations"


def main() -> None:
    url = get_settings().database_url
    if not url:
        sys.exit("DATABASE_URL is not set in backend/.env")

    with psycopg.connect(url, connect_timeout=15) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version     text PRIMARY KEY,
                applied_at  timestamptz NOT NULL DEFAULT now()
            )""")
        conn.commit()
        applied = {r[0] for r in conn.execute("SELECT version FROM schema_migrations")}

        pending = [f for f in sorted(MIGRATIONS_DIR.glob("*.sql")) if f.name not in applied]
        if not pending:
            print(f"Up to date ({len(applied)} migrations applied)")
            return
        for f in pending:
            try:
                with conn.transaction():
                    conn.execute(f.read_text())
                    conn.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (f.name,))
            except psycopg.Error as err:
                sys.exit(f"FAILED {f.name}: {err.diag.message_primary or type(err).__name__}")
            print(f"Applied {f.name}")


if __name__ == "__main__":
    main()
