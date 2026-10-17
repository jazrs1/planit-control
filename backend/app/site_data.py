"""Sites served by /sites and /sites/{id}.

Locations are real: backend/data/sites.json, built from EIA-860M by scripts/load_sites.py.
Lightning is real: active stop-work alerts (alerts/engine.py) and GOES-19 flashes from the database.
The other hazard values are NOT real yet. Each one is a placeholder copied from shared/mocks,
from the site's own mock if it has one (6 plants do) or else from the nearest mock site. Every
placeholder is marked TODO(<hazard>) so they can be replaced one at a time:

    grep -n "TODO(" backend/app/site_data.py

Without a database (no DATABASE_URL), lightning shows no data and no alerts.
"""

import json
import math
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from psycopg_pool import ConnectionPool

from alerts import engine
from app import clock, mocks
from app.config import BACKEND_DIR

SITES_FILE = BACKEND_DIR / "data" / "sites.json"

LIGHTNING_WINDOW = timedelta(minutes=30)
ROLLUP_BUCKET = timedelta(minutes=5)
# Search box for the nearest flash: ~50 mi each way (0.75° lat; 0.85° lon at Florida latitudes).
NEAREST_SEARCH_DEG = (0.75, 0.85)
NO_LIGHTNING = {"nearest_strike_mi": None, "nearest_strike_at": None, "strikes_last_30_min": 0}


@lru_cache
def _real_sites() -> dict[str, dict]:
    return {s["id"]: s for s in json.loads(SITES_FILE.read_text())["sites"]}


def _miles(a: dict, b: dict) -> float:
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    dlat, dlon = lat2 - lat1, math.radians(b["lon"] - a["lon"])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(h))


def _placeholder_for(site: dict) -> dict:
    """The mock SiteDetail whose hazard values this site borrows until real data exists."""
    details = mocks.load("site_details")
    if site["id"] in details:
        return details[site["id"]]
    return min(details.values(), key=lambda mock: _miles(site, mock))


# ---------- Lightning (real) ----------

def _lightning_alerts(pool: ConnectionPool | None, now: datetime, site_id: str | None = None) -> dict[str, dict]:
    """Active lightning stop-work alerts at `now`, by site id."""
    if pool is None:
        return {}
    with pool.connection() as conn:
        rows = engine.active_alerts(conn, now, replay=clock.is_simulated(), site_id=site_id)
    return {a["site_id"]: a for a in rows if a["type"] == engine.ALERT_TYPE}


def _lightning_conditions(pool: ConnectionPool | None, site: dict, now: datetime) -> dict:
    """The site's lightning card. nearest_strike_*: nearest flash in the last 30 min (raw flashes,
    searched within ~50 mi). strikes_last_30_min: flashes within the 10-mile stop-work radius,
    from the 5-minute rollup (whole buckets, so it covers 30-35 minutes)."""
    if pool is None:
        return NO_LIGHTNING
    epoch = datetime(2000, 1, 1, tzinfo=timezone.utc)
    since = now - LIGHTNING_WINDOW
    first_bucket = since - (since - epoch) % ROLLUP_BUCKET
    dlat, dlon = NEAREST_SEARCH_DEG
    with pool.connection() as conn:
        nearest = conn.execute(
            """SELECT ts, miles_between(%(lat)s, %(lon)s, lat, lon) AS mi FROM lightning_flashes
               WHERE ts > %(since)s AND ts <= %(now)s
                 AND lat BETWEEN %(lat)s - %(dlat)s AND %(lat)s + %(dlat)s
                 AND lon BETWEEN %(lon)s - %(dlon)s AND %(lon)s + %(dlon)s
               ORDER BY mi LIMIT 1""",
            {"lat": site["lat"], "lon": site["lon"], "since": since, "now": now, "dlat": dlat, "dlon": dlon},
        ).fetchone()
        count = conn.execute(
            """SELECT coalesce(sum(flash_count), 0) AS n FROM lightning_flashes_5m_by_site
               WHERE site_id = %s AND bucket >= %s AND bucket <= %s""",
            (site["id"], first_bucket, now),
        ).fetchone()["n"]
    return {
        "nearest_strike_mi": round(nearest["mi"], 1) if nearest else None,
        "nearest_strike_at": nearest["ts"] if nearest else None,
        "strikes_last_30_min": int(count),
    }


def _top_hazard(placeholder: dict, lightning_alert: dict | None) -> str:
    """Lightning is the top hazard exactly when the site has an active stop-work alert."""
    if lightning_alert:
        return "lightning"
    if placeholder["top_hazard"] != "lightning":
        return placeholder["top_hazard"]
    return next((f["hazard"] for f in placeholder["top_factors"] if f["hazard"] != "lightning"), "heat")


# ---------- Build ----------

def _build_detail(site: dict, lightning_alert: dict | None, lightning: dict) -> dict:
    mock = _placeholder_for(site)
    conditions = mock["conditions"]
    return {
        # Real (EIA-860M).
        "id": site["id"],
        "name": site["name"],
        "lat": site["lat"],
        "lon": site["lon"],
        "county": site["county"],
        "timezone": site["timezone"],
        "conditions": {
            # TODO(heat): placeholder from shared/mocks. Replace with real heat index for site lat/lon.
            "heat": conditions["heat"],
            # Real: GOES-19 GLM flashes.
            "lightning": lightning,
            # TODO(flood): placeholder from shared/mocks. Replace with real NWS/USGS flood status.
            "flood": conditions["flood"],
            # TODO(soil): placeholder from shared/mocks. Replace with real soil moisture.
            "soil": conditions["soil"],
            # TODO(wildfire): placeholder from shared/mocks. Replace with real NASA FIRMS detections.
            "wildfire": conditions["wildfire"],
            # TODO(wildlife): placeholder from shared/mocks. Replace with real sightings near the site.
            "wildlife": conditions["wildlife"],
        },
        # TODO(hazard-index): placeholder from shared/mocks. Replace with the ML model's scores
        # once the conditions above are real; top_factors come from the same model. Placeholder
        # lightning factors are dropped because lightning is real now.
        "hazard_index": mock["hazard_index"],
        "hazard_index_today": mock["hazard_index_today"],
        "hazard_index_tomorrow": mock["hazard_index_tomorrow"],
        # Real when lightning is active (stop-work alert), otherwise the placeholder's.
        "top_hazard": _top_hazard(mock, lightning_alert),
        "top_factors": [f for f in mock["top_factors"] if f["hazard"] != "lightning"],
        # TODO(updated-at): placeholder; set to when the hazard data was last fetched.
        "updated_at": mock["updated_at"],
    }


def list_sites(pool: ConnectionPool | None) -> list[dict]:
    """All sites, largest capacity first. Full details; the route's response model trims them to
    Site, so the per-site lightning card isn't queried here (top_hazard only needs alerts)."""
    alerts = _lightning_alerts(pool, clock.now())
    return [_build_detail(s, alerts.get(s["id"]), NO_LIGHTNING) for s in _real_sites().values()]


def get_site_detail(pool: ConnectionPool | None, site_id: str) -> dict | None:
    site = _real_sites().get(site_id)
    if site is None:
        return None
    now = clock.now()
    alert = _lightning_alerts(pool, now, site_id).get(site_id)
    return _build_detail(site, alert, _lightning_conditions(pool, site, now))
