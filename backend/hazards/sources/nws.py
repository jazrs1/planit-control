"""National Weather Service: each site's forecast/county/fire zones (looked up once) and active alerts.

Active alerts are fetched once for all of Florida (/alerts/active?area=FL) and matched to each
site point: alerts with a polygon (storm-based warnings) match if the site is inside it; zone-based
alerts match the site's forecast, county, or fire-weather zone. That is the same answer as asking
/alerts/active?point=lat,lon per site, in one request instead of 55.
"""

import time
from datetime import datetime

from psycopg_pool import ConnectionPool

from hazards import http
from hazards.store import write_readings

API = "https://api.weather.gov"
NAME = "nws-alerts"

# Events we act on, by hazard card, with a numeric level for the conditions history.
FLOOD_LEVELS = {"Flood Advisory": 1, "Coastal Flood Advisory": 1, "Flood Watch": 2, "Flash Flood Watch": 2,
                "Coastal Flood Watch": 2, "Flood Warning": 3, "Flash Flood Warning": 3, "Coastal Flood Warning": 3}
HEAT_LEVELS = {"Heat Advisory": 1, "Excessive Heat Watch": 1, "Extreme Heat Watch": 1,
               "Excessive Heat Warning": 2, "Extreme Heat Warning": 2}
STORM_LEVELS = {"Severe Thunderstorm Watch": 1, "Severe Thunderstorm Warning": 2, "Tornado Warning": 2}
FIRE_LEVELS = {"Fire Weather Watch": 1, "Red Flag Warning": 2}


def lookup_zones(pool: ConnectionPool, now: datetime) -> str:
    """Fill nws_*_zone for sites not looked up yet (one /points call per site, once)."""
    with pool.connection() as conn:
        todo = conn.execute("SELECT id, lat, lon FROM sites WHERE nws_zones_checked_at IS NULL").fetchall()
    for s in todo:
        props = http.get_json(f"{API}/points/{s['lat']:.4f},{s['lon']:.4f}", retries=2)["properties"]
        zone = lambda key: (props.get(key) or "").rsplit("/", 1)[-1] or None  # noqa: E731
        with pool.connection() as conn:
            conn.execute(
                """UPDATE sites SET nws_forecast_zone = %s, nws_county_zone = %s, nws_fire_zone = %s,
                                    nws_zones_checked_at = %s WHERE id = %s""",
                (zone("forecastZone"), zone("county"), zone("fireWeatherZone"), now, s["id"]))
        time.sleep(0.3)
    return f"zones looked up for {len(todo)} sites"


def _in_ring(lon: float, lat: float, ring: list) -> bool:
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def covers(alert: dict, site: dict) -> bool:
    geometry = alert.get("geometry")
    if geometry:
        polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
        return any(_in_ring(site["lon"], site["lat"], poly[0]) for poly in polygons)
    ugc = set((alert["properties"].get("geocode") or {}).get("UGC") or [])
    return bool(ugc & {site["nws_forecast_zone"], site["nws_county_zone"], site["nws_fire_zone"]})


def poll(pool: ConnectionPool, sites: list[dict], now: datetime) -> str:
    features = http.get_json(f"{API}/alerts/active", {"area": "FL"}, accept="application/geo+json",
                             retries=2)["features"]
    matches = [(s["id"], f) for f in features for s in sites if covers(f, s)]

    with pool.connection() as conn, conn.transaction():
        for f in features:
            p = f["properties"]
            conn.execute(
                """INSERT INTO nws_alerts (id, event, severity, headline, sender_name, onset, ends_at, fetched_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (id) DO UPDATE SET ends_at = EXCLUDED.ends_at, headline = EXCLUDED.headline,
                                                  fetched_at = EXCLUDED.fetched_at""",
                (p["id"], p["event"], p.get("severity"), p.get("headline"), p.get("senderName"),
                 p.get("onset"), p.get("ends") or p.get("expires"), now))
        conn.execute("DELETE FROM site_nws_alerts")  # replaced wholesale: these are the active ones
        for site_id, f in matches:
            conn.execute("INSERT INTO site_nws_alerts (site_id, alert_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                         (site_id, f["properties"]["id"]))

    # Numeric levels per site for the conditions history (0 = none).
    rows = []
    for s in sites:
        events = [f["properties"]["event"] for site_id, f in matches if site_id == s["id"]]
        for hazard, metric, levels in [("flood", "nws_flood_level", FLOOD_LEVELS), ("heat", "nws_heat_level", HEAT_LEVELS),
                                       ("lightning", "nws_storm_level", STORM_LEVELS), ("wildfire", "nws_fire_level", FIRE_LEVELS)]:
            rows.append((s["id"], now, hazard, metric, float(max((levels.get(e, 0) for e in events), default=0)), "nws"))
    write_readings(pool, rows)
    return f"{len(features)} Florida alerts, {len(matches)} site matches"
