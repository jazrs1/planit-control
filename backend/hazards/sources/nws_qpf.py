"""NWS gridpoint precipitation forecast (QPF), the briefing's cross-check on our rain forecast.

Our rain comes from one high-resolution model (Open-Meteo gfs_seamless, HRRR over Florida), which can
swing a lot from one hourly run to the next at a single point. Before rain alone can stop work, the NWS
forecast for the same point has to agree (briefing/inputs.py). This never feeds the ML model.

Requests go through hazards/http.py (the NWS_CONTACT User-Agent). Each site's grid URL comes from one
/points lookup per API process; each grid's forecast is cached for CACHE_SECONDS, so a 6 PM run makes
one gridpoint request per site. Any failure returns None: the caller treats NWS as unavailable.
"""

import logging
import re
import threading
import time
from datetime import datetime, timedelta, timezone

from hazards import http

log = logging.getLogger(__name__)

API = "https://api.weather.gov"
NAME = "nws-qpf"
CACHE_SECONDS = 1800
MM_PER_IN = 25.4
_DURATION = re.compile(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$")

_lock = threading.Lock()
_grid_urls: dict[tuple[float, float], str] = {}
_cache: dict[str, tuple[float, list[tuple[datetime, float]]]] = {}


def _hours(duration: str) -> int:
    """ISO 8601 duration ("PT6H", "P1D", "P1DT6H") in whole hours (at least 1)."""
    m = _DURATION.match(duration)
    if not m:
        raise ValueError(f"unexpected duration {duration!r}")
    days, hours, minutes = (int(g) if g else 0 for g in m.groups())
    return max(1, days * 24 + hours + (1 if minutes else 0))


def hourly(values: list[dict]) -> list[tuple[datetime, float]]:
    """NWS quantitativePrecipitation values (mm per validTime interval) -> (hour start UTC, inches),
    each interval's amount spread evenly over its hours."""
    out = []
    for v in values:
        start, duration = v["validTime"].split("/")
        begin = datetime.fromisoformat(start.replace("Z", "+00:00")).astimezone(timezone.utc)
        n = _hours(duration)
        per_hour = (v["value"] or 0.0) / MM_PER_IN / n
        out += [(begin + timedelta(hours=k), per_hour) for k in range(n)]
    return out


def total(series: list[tuple[datetime, float]], start: datetime, end: datetime) -> float:
    """Inches forecast for hours starting in [start, end)."""
    return sum(amount for t, amount in series if start <= t < end)


def _grid_url(lat: float, lon: float) -> str:
    key = (round(lat, 4), round(lon, 4))
    with _lock:
        if key in _grid_urls:
            return _grid_urls[key]
    url = http.get_json(f"{API}/points/{key[0]:.4f},{key[1]:.4f}", retries=1)["properties"]["forecastGridData"]
    with _lock:
        _grid_urls[key] = url
    return url


def forecast(site: dict) -> list[tuple[datetime, float]] | None:
    """The site's hourly NWS rain forecast in inches, or None if NWS can't be reached or parsed."""
    try:
        url = _grid_url(site["lat"], site["lon"])
        with _lock:
            cached = _cache.get(url)
        if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
            return cached[1]
        props = http.get_json(url, retries=1)["properties"]
        qpf = props["quantitativePrecipitation"]
        if "mm" not in (qpf.get("uom") or "wmoUnit:mm"):
            raise ValueError(f"unexpected QPF unit {qpf.get('uom')}")
        series = hourly(qpf["values"])
        with _lock:
            _cache[url] = (time.monotonic(), series)
        return series
    except Exception as err:  # noqa: BLE001 - NWS down or changed: the briefing treats it as unavailable
        log.warning("NWS gridpoint forecast failed for %s: %s: %s", site.get("id"), type(err).__name__, err)
        return None
