"""One-time flood context per site: FEMA flood zone (National Flood Hazard Layer) and whether a
named river is within 1 mile (USGS National Hydrography Dataset). Stored on the sites table."""

import time
from datetime import datetime

from psycopg_pool import ConnectionPool

from hazards import http

FEMA_ZONES = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query"
NHD_FLOWLINES = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query"
RIVER_RADIUS_M = 1609


def _arcgis_point_query(url: str, site: dict, **extra) -> list[dict]:
    data = http.get_json(url, {
        "geometry": f"{site['lon']},{site['lat']}", "geometryType": "esriGeometryPoint", "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects", "returnGeometry": "false", "f": "json", **extra,
    }, retries=3, backoff=3.0)  # the FEMA service intermittently returns empty bodies
    if "error" in data:
        raise ValueError(f"ArcGIS error: {data['error']}")
    return [f["attributes"] for f in data.get("features", [])]


def fema_zone(site: dict) -> tuple[str, bool | None]:
    """(zone, in Special Flood Hazard Area). 'unmapped' / None where FEMA has no polygon."""
    features = _arcgis_point_query(FEMA_ZONES, site, outFields="FLD_ZONE,SFHA_TF")
    if not features:
        return "unmapped", None
    # Overlapping polygons: prefer the higher-risk (SFHA) one.
    best = max(features, key=lambda f: f.get("SFHA_TF") == "T")
    return best["FLD_ZONE"], best.get("SFHA_TF") == "T"


def nearby_river(site: dict) -> str | None:
    features = _arcgis_point_query(NHD_FLOWLINES, site, distance=RIVER_RADIUS_M, units="esriSRUnit_Meter",
                                   where="gnis_name LIKE '%River%'", outFields="gnis_name",
                                   returnDistinctValues="true")
    names = sorted({f["gnis_name"] for f in features if f.get("gnis_name")})
    return names[0] if names else None


def lookup_fema(pool: ConnectionPool, now: datetime) -> str:
    with pool.connection() as conn:
        todo = conn.execute("SELECT id, lat, lon FROM sites WHERE fema_checked_at IS NULL").fetchall()
    failed = 0
    for s in todo:
        try:
            zone, sfha = fema_zone(s)
        except Exception:  # noqa: BLE001 - leave unchecked; retried on the next lookup run
            failed += 1
            continue
        with pool.connection() as conn:
            conn.execute("UPDATE sites SET fema_flood_zone = %s, fema_sfha = %s, fema_checked_at = %s WHERE id = %s",
                         (zone, sfha, now, s["id"]))
        time.sleep(0.5)
    if failed and failed == len(todo):
        raise RuntimeError(f"FEMA lookup failed for all {failed} sites")
    return f"FEMA zones for {len(todo) - failed} sites ({failed} failed, will retry)"


def lookup_rivers(pool: ConnectionPool, now: datetime) -> str:
    with pool.connection() as conn:
        todo = conn.execute("SELECT id, lat, lon FROM sites WHERE river_checked_at IS NULL").fetchall()
    failed = 0
    for s in todo:
        try:
            river = nearby_river(s)
        except Exception:  # noqa: BLE001
            failed += 1
            continue
        with pool.connection() as conn:
            conn.execute("UPDATE sites SET river_name = %s, near_river = %s, river_checked_at = %s WHERE id = %s",
                         (river, river is not None, now, s["id"]))
        time.sleep(0.5)
    if failed and failed == len(todo):
        raise RuntimeError(f"River lookup failed for all {failed} sites")
    return f"river check for {len(todo) - failed} sites ({failed} failed, will retry)"
