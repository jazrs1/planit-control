"""Distances from flashes to our sites (vectorized, for counting and filtering)."""

import json
from functools import lru_cache

import numpy as np

from app.config import BACKEND_DIR

EARTH_RADIUS_MI = 3958.8


@lru_cache
def site_coords() -> tuple[np.ndarray, np.ndarray]:
    """(lats, lons) of the sites in backend/data/sites.json, in radians."""
    sites = json.loads((BACKEND_DIR / "data" / "sites.json").read_text())["sites"]
    return (np.radians([s["lat"] for s in sites]), np.radians([s["lon"] for s in sites]))


def nearest_site_miles(lats, lons) -> np.ndarray:
    """Distance in miles from each point to its nearest site."""
    lat = np.radians(np.asarray(lats, dtype=float))[:, None]
    lon = np.radians(np.asarray(lons, dtype=float))[:, None]
    site_lat, site_lon = site_coords()
    h = (np.sin((site_lat - lat) / 2) ** 2
         + np.cos(lat) * np.cos(site_lat) * np.sin((site_lon - lon) / 2) ** 2)
    miles = 2 * EARTH_RADIUS_MI * np.arcsin(np.sqrt(h))
    return miles.min(axis=1) if miles.size else np.empty(0)


def count_near_sites(lats, lons, miles: float = 10.0) -> int:
    return int((nearest_site_miles(lats, lons) <= miles).sum()) if len(lats) else 0
