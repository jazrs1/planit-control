"""Sites served by /sites and /sites/{id}.

With a database, every hazard is real:
  - locations: backend/data/sites.json (EIA-860M), seeded into the sites table
  - lightning: GOES-19 flashes and stop-work alerts (alerts/engine.py)
  - heat, rain, soil: Open-Meteo; NWS alerts; FEMA flood zones; USGS rivers; NASA FIRMS fires;
    iNaturalist wildlife (hazards/sources/, polled by hazards/scheduler.py into `conditions`)
  - hazard_index / top_factors: hybrid of the ML weather model and safety rules (hazards/risk.py)
A card whose source has no reading yet keeps the shape's required numbers from the placeholder
mock and says "No live ... data yet" with as_of = null.

Without a database (no DATABASE_URL) everything except locations is the shared/mocks placeholder.
"""

import json
import math
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from psycopg_pool import ConnectionPool

from alerts import approach
from app import clock, mocks
from app.config import BACKEND_DIR
from hazards import snapshot
from hazards.risk import predict
from hazards.scoring import soil_level

SITES_FILE = BACKEND_DIR / "data" / "sites.json"

LIGHTNING_WINDOW = timedelta(minutes=30)
ROLLUP_BUCKET = timedelta(minutes=5)
# Search box for the nearest flash: ~50 mi each way (0.75° lat; 0.85° lon at Florida latitudes).
NEAREST_SEARCH_DEG = (0.75, 0.85)
NO_LIGHTNING = {"nearest_strike_mi": None, "nearest_strike_at": None, "strikes_last_30_min": 0}


@lru_cache
def _real_sites() -> dict[str, dict]:
    return {s["id"]: s for s in json.loads(SITES_FILE.read_text())["sites"]}


def _placeholder_for(site: dict) -> dict:
    """The mock SiteDetail used where no live reading exists yet (or there is no database)."""
    details = mocks.load("site_details")
    if site["id"] in details:
        return details[site["id"]]
    return min(details.values(), key=lambda m: snapshot.miles(site["lat"], site["lon"], m["lat"], m["lon"]))


def _lightning_conditions(pool: ConnectionPool, site: dict, now: datetime) -> dict:
    """Nearest flash in the last 30 min (raw flashes, ~50 mi search) and flashes within 10 mi
    (5-minute rollup, whole buckets, so 30-35 minutes)."""
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
    return {"nearest_strike_mi": round(nearest["mi"], 1) if nearest else None,
            "nearest_strike_at": nearest["ts"] if nearest else None, "strikes_last_30_min": int(count)}


def _reading(inputs, hazard: str, metric: str) -> float | None:
    v = inputs.readings.get((hazard, metric))
    return None if v is None or (isinstance(v[0], float) and math.isnan(v[0])) else v[0]


def _build(site: dict, snap: snapshot.Snapshot, lightning: dict, detail: bool) -> dict:
    inputs = snap.inputs[site["id"]]
    scored = predict(inputs, snap.species_counts[site["id"]])
    cards = scored["cards"]
    mock = _placeholder_for(site)["conditions"]

    hi = _reading(inputs, "heat", "heat_index_f")
    heat = ({"heat_index_f": round(hi, 1), "air_temp_f": _reading(inputs, "heat", "air_temp_f"),
             "humidity_pct": _reading(inputs, "heat", "humidity_pct")} if hi is not None else dict(mock["heat"]))
    vwc = _reading(inputs, "soil", "vwc_surface")
    soil = ({"moisture_pct": round(vwc * 100, 1), "saturated": soil_level(vwc) == "saturated"}
            if vwc is not None else dict(mock["soil"]))
    as_of = [c.get("as_of") for c in cards.values() if c.get("as_of")]
    return {
        "id": site["id"], "name": site["name"], "lat": site["lat"], "lon": site["lon"],
        "county": site["county"], "timezone": site["timezone"],
        "conditions": {
            "heat": {**heat, **cards["heat"]},
            "lightning": {**lightning, **cards["lightning"]},
            "flood": cards["flood"],
            "soil": {**soil, **cards["soil_saturation"]},
            "wildfire": cards["wildfire"],
            "wildlife": snap.sightings[site["id"]] if detail else [],
            "wildlife_summary": cards["wildlife"],
            "crew_hazards": cards["crew_hazards"],
        },
        # Hybrid: ML weather score or safety rules, whichever is higher (hazards/risk.py).
        "hazard_index": scored["hazard_index_today"],
        "hazard_index_today": scored["hazard_index_today"],
        "hazard_index_tomorrow": scored["hazard_index_tomorrow"],
        "top_hazard": scored["top_hazard"],
        "top_factors": scored["top_factors"],
        "lightning_approach": approach.view(snap.approaching.get(site["id"]), snap.clock_now or clock.now()),
        "updated_at": max(as_of) if as_of else datetime.now(timezone.utc),
        "nws_alerts": [{"event": a["event"], "severity": a["severity"], "headline": a["headline"],
                        "ends_at": a["ends_at"]} for a in inputs.nws] if detail else [],
    }


NO_DATA_READING = "No live data: database unavailable"
CARD_KEYS = ("heat", "lightning", "flood", "soil", "wildfire", "wildlife_summary")


def _no_data(card: dict | None) -> dict | None:
    """A placeholder card the frontend must show as "No data": no hazard_status, as_of null,
    and a reading that doesn't sound live (the mock's own numbers would)."""
    if card is None:
        return None
    card = {k: v for k, v in card.items() if k != "hazard_status"}
    return {**card, "as_of": None, "reading": NO_DATA_READING}


def _placeholder_detail(site: dict) -> dict:
    """No database: placeholder hazards from shared/mocks (lightning never claimed). Every card
    is marked as having no live data, so it never looks current."""
    mock = _placeholder_for(site)
    top = mock["top_hazard"]
    if top == "lightning":
        top = next((f["hazard"] for f in mock["top_factors"] if f["hazard"] != "lightning"), "heat")
    conditions = {**mock["conditions"], "lightning": NO_LIGHTNING}
    conditions.update({k: _no_data(conditions.get(k)) for k in CARD_KEYS if conditions.get(k) is not None})
    return {
        "id": site["id"], "name": site["name"], "lat": site["lat"], "lon": site["lon"],
        "county": site["county"], "timezone": site["timezone"],
        "conditions": conditions,
        "hazard_index": mock["hazard_index"], "hazard_index_today": mock["hazard_index_today"],
        "hazard_index_tomorrow": mock["hazard_index_tomorrow"], "top_hazard": top,
        "top_factors": [f for f in mock["top_factors"] if f["hazard"] != "lightning"],
        "updated_at": mock["updated_at"],
    }


def list_sites(pool: ConnectionPool | None) -> list[dict]:
    """All sites, largest capacity first. The route's response model trims each to Site."""
    if pool is None:
        return [_placeholder_detail(s) for s in _real_sites().values()]
    snap = snapshot.load(pool)
    return [_build(s, snap, NO_LIGHTNING, detail=False) for s in snap.sites]


def known_site(site_id: str) -> dict | None:
    """The site from sites.json (id, name, lat, lon, timezone, ...), or None."""
    return _real_sites().get(site_id)


def get_site_detail(pool: ConnectionPool | None, site_id: str) -> dict | None:
    site = _real_sites().get(site_id)
    if site is None:
        return None
    if pool is None:
        return _placeholder_detail(site)
    snap = snapshot.load(pool)
    db_site = next((s for s in snap.sites if s["id"] == site_id), None)
    if db_site is None:
        return None
    return _build(db_site, snap, _lightning_conditions(pool, db_site, clock.now()), detail=True)
