"""NASA FIRMS VIIRS active-fire detections over Florida, last 24 hours.

Needs FIRMS_MAP_KEY (free: https://firms.modaps.eosdis.nasa.gov/api/map_key/). Without it the
poll is skipped and recorded as such, and wildfire cards say satellite detection is off.

Writes per site (wildfire): nearest_detection_mi, nearest_detection_epoch, nearest_confidence
(0 low, 1 nominal, 2 high), detections_25mi, plant_hot_spots_ignored, and for detections within
CONFIRM_RADIUS_MI: passes_5mi (separate satellite passes that saw them) and high_confidence_5mi.
NaN means no detection.

One detection, or a cluster from a single satellite pass, is often a one-off (a flare, a hot roof,
a brief burn). The wildfire card treats a nearby fire as danger only once it is confirmed: seen on
2+ passes within 24 h, or detected with high confidence (hazards/scoring.py).

Power plants are hot: VIIRS flags their stacks and flares as "fires", and the near-real-time feed
has no industrial flag. Detections within PLANT_HOT_SPOT_KM of any of our sites, or of any other
Florida plant that burns fuel or makes steam (data/fl_thermal_plants.json, from EIA-860M), are
therefore treated as plant heat and not counted as wildfire (they stay in fire_detections).
Solar and battery sites aren't excluded: they give off no heat, so a hot spot there may be real.
Trade-off: a real fire inside that ring would be missed.
"""

import csv
import io
import json
import math
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from psycopg_pool import ConnectionPool

from app.config import BACKEND_DIR, get_settings
from hazards import http
from hazards.store import write_readings
from lightning.glm import FL_BBOX

NAME = "firms"
API = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
SOURCES = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"]
CONFIDENCE = {"l": "low", "n": "nominal", "h": "high", "low": "low", "nominal": "nominal", "high": "high"}
CONFIDENCE_CODE = {"low": 0, "nominal": 1, "high": 2}
NEARBY_MI = 25
CONFIRM_RADIUS_MI = 5          # the wildfire card's danger distance
PASS_GAP = timedelta(minutes=10)   # one satellite's detections closer together than this: one pass
PLANT_HOT_SPOT_KM = 1.0
PLANT_HOT_SPOT_MI = PLANT_HOT_SPOT_KM / 1.609344
THERMAL_PLANTS_FILE = BACKEND_DIR / "data" / "fl_thermal_plants.json"


@lru_cache
def thermal_plants() -> tuple[dict, ...]:
    """Every Florida plant that burns fuel or makes steam (rebuilt by scripts/load_sites.py)."""
    return tuple(json.loads(THERMAL_PLANTS_FILE.read_text())["plants"])


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


def plant_hot_spots(detections: list[dict], sites: list[dict]) -> tuple[list[dict], int]:
    """(detections that may be wildfire, count ignored as a plant's own heat)."""
    kept = [d for d in detections
            if all(_miles(s["lat"], s["lon"], d["lat"], d["lon"]) > PLANT_HOT_SPOT_MI for s in sites)]
    return kept, len(detections) - len(kept)


def satellite_passes(detections: list[dict]) -> int:
    """Separate satellite overpasses among these detections: per satellite, a new pass starts when
    detections are more than PASS_GAP apart."""
    passes = 0
    for sat in {d["satellite"] for d in detections}:
        times = sorted(d["ts"] for d in detections if d["satellite"] == sat)
        passes += 1 + sum(1 for a, b in zip(times, times[1:]) if b - a > PASS_GAP)
    return passes


def site_readings(site: dict, detections: list[dict], ignored_here: int = 0) -> list[tuple[str, str, float]]:
    nan = float("nan")
    tail = [("wildfire", "plant_hot_spots_ignored", float(ignored_here))]
    if not detections:
        return [("wildfire", "nearest_detection_mi", nan), ("wildfire", "nearest_detection_epoch", nan),
                ("wildfire", "nearest_confidence", nan), ("wildfire", "detections_25mi", 0.0),
                ("wildfire", "passes_5mi", 0.0), ("wildfire", "high_confidence_5mi", 0.0)] + tail
    dist = [(_miles(site["lat"], site["lon"], d["lat"], d["lon"]), d) for d in detections]
    miles, nearest = min(dist, key=lambda x: x[0])
    close = [d for m, d in dist if m <= CONFIRM_RADIUS_MI]
    return [("wildfire", "nearest_detection_mi", round(miles, 2)),
            ("wildfire", "nearest_detection_epoch", nearest["ts"].timestamp()),
            ("wildfire", "nearest_confidence", float(CONFIDENCE_CODE.get(nearest["confidence"], 1))),
            ("wildfire", "detections_25mi", float(sum(1 for m, _ in dist if m <= NEARBY_MI))),
            ("wildfire", "passes_5mi", float(satellite_passes(close))),
            ("wildfire", "high_confidence_5mi", float(sum(1 for d in close if d["confidence"] == "high")))] + tail


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
    fires, ignored = plant_hot_spots(recent, [*sites, *thermal_plants()])
    rows = [(s["id"], now, hz, m, v, NAME) for s in sites for hz, m, v in site_readings(
        s, fires, sum(1 for d in recent if _miles(s["lat"], s["lon"], d["lat"], d["lon"]) <= PLANT_HOT_SPOT_MI))]
    write_readings(pool, rows)
    return f"{len(recent)} detections over Florida in 24 h ({ignored} ignored as plant hot spots)"
