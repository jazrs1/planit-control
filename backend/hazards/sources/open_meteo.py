"""Open-Meteo hourly forecast for every site in one request: heat, rain, soil moisture.

Writes per site (hazard / metric):
  heat:  heat_index_f, air_temp_f, humidity_pct (current hour), peak_heat_index_f and
         peak_at_epoch (today, site-local day), rest_of_day_peak_heat_index_f,
         tomorrow_peak_heat_index_f
  flood: rain_past_12h_in, rain_past_24h_in, rain_past_72h_in, rain_next_24h_in, rain_tomorrow_in
  soil:  vwc_0_1cm .. vwc_27_81cm (m³/m³), vwc_surface (0-9 cm, thickness-weighted)
"""

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from psycopg_pool import ConnectionPool

from hazards import http
from hazards.heat import heat_index_f
from hazards.store import write_readings

URL = "https://api.open-meteo.com/v1/forecast"
NAME = "open-meteo"
SOIL_LAYERS = ["0_to_1cm", "1_to_3cm", "3_to_9cm", "9_to_27cm", "27_to_81cm"]
SURFACE_WEIGHTS = {"0_to_1cm": 1, "1_to_3cm": 2, "3_to_9cm": 6}  # layer thickness in cm


def fetch(sites: list[dict]) -> list[dict]:
    """One request for all sites; Open-Meteo returns one forecast per coordinate, in order."""
    hourly = ["temperature_2m", "relative_humidity_2m", "precipitation"] + [f"soil_moisture_{l}" for l in SOIL_LAYERS]
    data = http.get_json(URL, {
        "latitude": ",".join(f"{s['lat']:.4f}" for s in sites),
        "longitude": ",".join(f"{s['lon']:.4f}" for s in sites),
        "hourly": ",".join(hourly),
        "temperature_unit": "fahrenheit",
        "precipitation_unit": "inch",
        "past_days": 3,
        "forecast_days": 3,
        "timezone": "GMT",
        "timeformat": "unixtime",
    }, retries=2)
    forecasts = data if isinstance(data, list) else [data]
    if len(forecasts) != len(sites):
        raise ValueError(f"Open-Meteo returned {len(forecasts)} forecasts for {len(sites)} sites")
    return forecasts


def site_readings(site: dict, forecast: dict, now: datetime) -> list[tuple[str, str, float]]:
    """(hazard, metric, value) for one site. Precipitation at hour t is the total for (t-1h, t]."""
    h = forecast["hourly"]
    times = [datetime.fromtimestamp(t, timezone.utc) for t in h["time"]]
    current = max(i for i, t in enumerate(times) if t <= now)
    tz = ZoneInfo(site["timezone"])
    today = now.astimezone(tz).date()

    def heat_at(i: int) -> float | None:
        t, rh = h["temperature_2m"][i], h["relative_humidity_2m"][i]
        return None if t is None or rh is None else heat_index_f(t, rh)

    def day_peak(day, only_after: datetime | None = None) -> tuple[float, datetime] | None:
        hours = [(heat_at(i), t) for i, t in enumerate(times)
                 if t.astimezone(tz).date() == day and (only_after is None or t >= only_after)]
        hours = [(v, t) for v, t in hours if v is not None]
        return max(hours, key=lambda x: x[0]) if hours else None

    def rain(start: datetime, end: datetime) -> float:
        return sum(p or 0.0 for p, t in zip(h["precipitation"], times) if start < t <= end)

    rows = [
        ("heat", "air_temp_f", h["temperature_2m"][current]),
        ("heat", "humidity_pct", h["relative_humidity_2m"][current]),
        ("heat", "heat_index_f", heat_at(current)),
        ("flood", "rain_past_12h_in", rain(now - timedelta(hours=12), now)),
        ("flood", "rain_past_24h_in", rain(now - timedelta(hours=24), now)),
        ("flood", "rain_past_72h_in", rain(now - timedelta(hours=72), now)),
        ("flood", "rain_next_24h_in", rain(now, now + timedelta(hours=24))),
    ]
    tomorrow_start = datetime.combine(today + timedelta(days=1), datetime.min.time(), tz)
    rows.append(("flood", "rain_tomorrow_in", rain(tomorrow_start, tomorrow_start + timedelta(days=1))))
    if peak := day_peak(today):
        rows += [("heat", "peak_heat_index_f", peak[0]), ("heat", "peak_at_epoch", peak[1].timestamp())]
    if rest := day_peak(today, only_after=times[current]):
        rows.append(("heat", "rest_of_day_peak_heat_index_f", rest[0]))
    if tomorrow := day_peak(today + timedelta(days=1)):
        rows.append(("heat", "tomorrow_peak_heat_index_f", tomorrow[0]))

    layers = {l: h[f"soil_moisture_{l}"][current] for l in SOIL_LAYERS}
    rows += [("soil", f"vwc_{l.replace('_to_', '_')}", v) for l, v in layers.items()]
    if all(layers[l] is not None for l in SURFACE_WEIGHTS):
        total = sum(SURFACE_WEIGHTS.values())
        rows.append(("soil", "vwc_surface", sum(layers[l] * w for l, w in SURFACE_WEIGHTS.items()) / total))
    return [(hz, m, round(float(v), 4)) for hz, m, v in rows if v is not None]


def poll(pool: ConnectionPool, sites: list[dict], now: datetime) -> str:
    forecasts = fetch(sites)
    rows = [(s["id"], now, hz, metric, value, NAME)
            for s, f in zip(sites, forecasts) for hz, metric, value in site_readings(s, f, now)]
    return f"{write_readings(pool, rows)} readings for {len(sites)} sites"
