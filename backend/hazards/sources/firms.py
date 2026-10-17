"""NASA FIRMS VIIRS active-fire detections over Florida, last 24 hours.

Needs FIRMS_MAP_KEY (free: https://firms.modaps.eosdis.nasa.gov/api/map_key/). Without it the
poll is skipped and recorded as such, and wildfire cards say satellite detection is off.

Writes per site (wildfire): nearest_detection_mi, nearest_detection_epoch, nearest_confidence
(0 low, 1 nominal, 2 high), detections_25mi. NaN means no detection over Florida.
"""

import csv
import io
import math
from datetime import datetime, timedelta, timezone

from psycopg_pool import ConnectionPool

from app.config import get_settings
from hazards import http
from hazards.store import write_readings
from lightning.glm import FL_BBOX

NAME = "firms"
API = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
SOURCES = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"]
CONFIDENCE = {"l": "low", "n": "nominal", "h": "high", "low": "low", "nominal": "nominal", "high": "high"}
CONFIDENCE_CODE = {"low": 0, "nominal": 1, "high": 2}
NEARBY_MI = 25


class SkipSource(Exception):
    """The source can't run (e.g. no API key). Not an error: nothing to retry."""


def parse_csv(text: str) -> list[dict]:
    """FIRMS VIIRS CSV rows -> detections. acq_date + acq_time (HHMM, UTC) give the time."""
    detections = []
    for row in csv.DictReader(io.StringIO(text)):
        hhmm = row["acq_time"].zfill(4)
        ts = datetime.strptime(f"{row['acq_date']} {hhmm}", "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)
        detections.append({
            "ts": ts, "lat": float(row["latitude"]), "lon": float(row["longitude"]),
            "satellite": row.get("satellite", ""), "confidence": CONFIDENCE.get(row.get("confidence", "").lower()),
            "frp_mw": float(row["frp"]) if row.get("frp") else None,
        })
    return detections


def fetch(key: str) -> list[dict]:
    lat0, lat1 = FL_BBOX["lat"]
    lon0, lon1 = FL_BBOX["lon"]
    area = f"{lon0:.2f},{lat0:.2f},{lon1:.2f},{lat1:.2f}"
    detections = []
    for source in SOURCES:
        # Day range 1 is "today's UTC date" only (empty just after midnight UTC), so ask for 2 days;
        # poll() keeps the last 24 hours.
        text = http.get(f"{API}/{key}/{source}/{area}/2", accept="text/csv", retries=2).decode()
        if not text.startswith("latitude"):
            raise ValueError(f"FIRMS {source}: {text[:80]}")  # e.g. "Invalid MAP_KEY."
        detections += parse_csv(text)
    return detections


def _miles(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 3958.8 * math.asin(math.sqrt(h))


def site_readings(site: dict, detections: list[dict]) -> list[tuple[str, str, float]]:
    nan = float("nan")
    if not detections:
        return [("wildfire", "nearest_detection_mi", nan), ("wildfire", "nearest_detection_epoch", nan),
                ("wildfire", "nearest_confidence", nan), ("wildfire", "detections_25mi", 0.0)]
    dist = [(_miles(site["lat"], site["lon"], d["lat"], d["lon"]), d) for d in detections]
    miles, nearest = min(dist, key=lambda x: x[0])
    return [("wildfire", "nearest_detection_mi", round(miles, 2)),
            ("wildfire", "nearest_detection_epoch", nearest["ts"].timestamp()),
            ("wildfire", "nearest_confidence", float(CONFIDENCE_CODE.get(nearest["confidence"], 1))),
            ("wildfire", "detections_25mi", float(sum(1 for m, _ in dist if m <= NEARBY_MI)))]


def poll(pool: ConnectionPool, sites: list[dict], now: datetime) -> str:
    key = get_settings().firms_map_key
    if not key:
        raise SkipSource("FIRMS_MAP_KEY not set")
    detections = fetch(key)
    with pool.connection() as conn, conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO fire_detections (ts, lat, lon, satellite, confidence, frp_mw)
               VALUES (%(ts)s, %(lat)s, %(lon)s, %(satellite)s, %(confidence)s, %(frp_mw)s)
               ON CONFLICT DO NOTHING""", detections)
    recent = [d for d in detections if d["ts"] >= now - timedelta(hours=24)]
    rows = [(s["id"], now, hz, m, v, NAME) for s in sites for hz, m, v in site_readings(s, recent)]
    write_readings(pool, rows)
    return f"{len(recent)} detections over Florida in 24 h"
