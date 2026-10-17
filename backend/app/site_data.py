"""Sites served by /sites and /sites/{id}.

Locations are real: backend/data/sites.json, built from EIA-860M by scripts/load_sites.py.
Hazard values are NOT real yet. Each one is a placeholder copied from shared/mocks, from the
site's own mock if it has one (6 plants do) or else from the nearest mock site. Every
placeholder is marked TODO(<hazard>) so they can be replaced one at a time:

    grep -n "TODO(" backend/app/site_data.py
"""

import json
import math
from functools import lru_cache

from app import mocks
from app.config import BACKEND_DIR

SITES_FILE = BACKEND_DIR / "data" / "sites.json"


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


def _build_detail(site: dict) -> dict:
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
            # TODO(lightning): placeholder from shared/mocks. Replace with real strike data near the site.
            "lightning": conditions["lightning"],
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
        # once the conditions above are real; top_hazard and top_factors come from the same model.
        "hazard_index": mock["hazard_index"],
        "hazard_index_today": mock["hazard_index_today"],
        "hazard_index_tomorrow": mock["hazard_index_tomorrow"],
        "top_hazard": mock["top_hazard"],
        "top_factors": mock["top_factors"],
        # TODO(updated-at): placeholder; set to when the hazard data was last fetched.
        "updated_at": mock["updated_at"],
    }


def list_sites() -> list[dict]:
    """All sites, largest capacity first. Full details; the route's response model trims them to Site."""
    return [_build_detail(s) for s in _real_sites().values()]


def get_site_detail(site_id: str) -> dict | None:
    site = _real_sites().get(site_id)
    return _build_detail(site) if site else None
