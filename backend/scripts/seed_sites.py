"""Upsert backend/data/sites.json into the sites table.

    cd backend && python -m scripts.seed_sites

Safe to rerun: rows are matched on plant_id and updated in place.
"""

import json
import sys
from pathlib import Path

import psycopg

from app.config import get_settings

SITES_FILE = Path(__file__).resolve().parent.parent / "data" / "sites.json"
COLUMNS = ["plant_id", "id", "name", "utility", "county", "lat", "lon", "technology",
           "capacity_mw", "timezone"]


def main() -> None:
    url = get_settings().database_url
    if not url:
        sys.exit("DATABASE_URL is not set in backend/.env")
    sites = json.loads(SITES_FILE.read_text())["sites"]

    cols = ", ".join(COLUMNS)
    placeholders = ", ".join(f"%({c})s" for c in COLUMNS)
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in COLUMNS if c != "plant_id")
    with psycopg.connect(url, connect_timeout=15) as conn:
        with conn.cursor() as cur:
            cur.executemany(
                f"INSERT INTO sites ({cols}) VALUES ({placeholders}) "
                f"ON CONFLICT (plant_id) DO UPDATE SET {updates}",
                sites,
            )
        total = conn.execute("SELECT count(*) FROM sites").fetchone()[0]
        extra = total - len(sites)
    print(f"Upserted {len(sites)} sites from {SITES_FILE.name}; sites table now has {total} rows")
    if extra > 0:
        print(f"Note: {extra} rows are not in sites.json (left in place; other tables may reference them)")


if __name__ == "__main__":
    main()
