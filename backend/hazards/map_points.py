"""Map points for the dashboard's layers panel, from data we already store.

- Fires (GET /fires/recent): FIRMS VIIRS detections over Florida from the last 24 hours, without
  the hot spots the wildfire cards ignore (within 1 km of our sites or of any Florida thermal plant,
  hazards/sources/firms.py). `passes_24h` is the wildfire card's confirmation measure for each point:
  separate satellite passes that saw fire within 5 miles of it in those 24 hours (2+ = confirmed).
- Wildlife (GET /wildlife/recent): iNaturalist alligator and venomous-snake sightings near our sites
  (hazards/sources/inaturalist.py) plus crew wildlife reports, last 30 days. Crew notes are never included.

Both use real time: the poller data isn't replayed.
"""

import math
from collections import defaultdict
from datetime import datetime, timedelta

from psycopg import Connection

from hazards.sources import firms

FIRE_WINDOW = timedelta(hours=24)
WILDLIFE_WINDOW = timedelta(days=30)
MAX_POINTS = 5000
_GRID_DEG = 0.1   # >= 5 miles in both directions across Florida, so neighbors are in the 3x3 cells around


def fire_points(detections: list[dict]) -> list[dict]:
    """FireDetection rows (newest first) for detections already limited to the window."""
    kept, _ = firms.plant_hot_spots(detections, [*_our_sites(), *firms.thermal_plants()])
    grid: dict[tuple[int, int], list[dict]] = defaultdict(list)
    cell = lambda d: (math.floor(d["lat"] / _GRID_DEG), math.floor(d["lon"] / _GRID_DEG))   # noqa: E731
    for d in kept:
        grid[cell(d)].append(d)
    out = []
    for d in kept:
        i, j = cell(d)
        near = [n for di in (-1, 0, 1) for dj in (-1, 0, 1) for n in grid.get((i + di, j + dj), ())
                if firms._miles(d["lat"], d["lon"], n["lat"], n["lon"]) <= firms.CONFIRM_RADIUS_MI]
        out.append({"lat": d["lat"], "lon": d["lon"], "detected_at": d["ts"],
                    "confidence": d["confidence"] if d["confidence"] in ("low", "nominal", "high") else "nominal",
                    "passes_24h": firms.satellite_passes(near)})
    out.sort(key=lambda p: p["detected_at"], reverse=True)
    return out[:MAX_POINTS]


def recent_fires(conn: Connection, now: datetime) -> list[dict]:
    rows = conn.execute(
        """SELECT ts, lat, lon, satellite, confidence FROM fire_detections WHERE ts > %s AND ts <= %s""",
        (now - FIRE_WINDOW, now)).fetchall()
    return fire_points(rows)


def recent_wildlife(conn: Connection, now: datetime) -> list[dict]:
    """WildlifeSightingPoint rows, newest first."""
    since = now - WILDLIFE_WINDOW
    observed = conn.execute(
        """SELECT lat, lon, species, observed_at AS seen_at, 'inaturalist' AS source FROM wildlife_observations
           WHERE observed_at > %s AND observed_at <= %s""", (since, now)).fetchall()
    reported = conn.execute(
        """SELECT lat, lon, species, created_at AS seen_at, 'crew' AS source FROM reports
           WHERE category = 'wildlife' AND created_at > %s AND created_at <= %s""", (since, now)).fetchall()
    return sorted(observed + reported, key=lambda r: r["seen_at"], reverse=True)[:MAX_POINTS]


def _our_sites() -> list[dict]:
    from app.site_data import _real_sites   # sites.json, cached by the app

    return list(_real_sites().values())
