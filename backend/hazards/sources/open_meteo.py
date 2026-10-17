"""Open-Meteo hourly forecast for every site in one request: heat, rain, soil moisture, and the
hazard model's inputs.

The request asks for exactly what the hazard model was trained on (ml/openmeteo.py): model
gfs_seamless (HRRR over Florida), the same 7 hourly variables and units, and 8 past days so the
model's 7-day rain history is complete. 7 variables x 12 days is still one Open-Meteo "call" per
site (<= 10 variables, <= 14 days), so 55 sites hourly = 1,320 calls/day, the same as before.

Writes per site (hazard / metric):
  heat:  heat_index_f, air_temp_f, humidity_pct (current hour), peak_heat_index_f and
         peak_at_epoch (today, site-local day), rest_of_day_peak_heat_index_f,
         tomorrow_peak_heat_index_f
  flood: rain_past_12h_in, rain_past_24h_in, rain_past_72h_in, rain_next_24h_in, rain_tomorrow_in
  soil:  vwc_0_10cm (m³/m³, GFS top layer), vwc_surface (the same value; what the soil card reads)
"""

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from psycopg_pool import ConnectionPool

from hazards import http
from hazards.heat import heat_index_f
from hazards.store import write_readings
from ml import openmeteo as trained  # the model, variables and units the hazard model learned from

URL = "https://api.open-meteo.com/v1/forecast"
NAME = "open-meteo"
SOIL_VAR = "soil_moisture_0_to_10cm"
PAST_DAYS = trained.LEAD_IN_DAYS   # 7-day rain history for today, plus one day of slack
FORECAST_DAYS = 4                  # GMT days: covers all of tomorrow in both site timezones


def fetch(sites: list[dict], extra_hourly: tuple[str, ...] = (), daily: tuple[str, ...] = ()) -> list[dict]:
    """One request for all sites; Open-Meteo returns one forecast per coordinate, in order."""
    hourly = list(trained.HOURLY_VARS) + [v for v in extra_hourly if v not in trained.HOURLY_VARS]
    extra = {"daily": ",".join(daily)} if daily else {}
    data = http.get_json(URL, {**extra,
        "latitude": ",".join(f"{s['lat']:.4f}" for s in sites),
        "longitude": ",".join(f"{s['lon']:.4f}" for s in sites),
        "hourly": ",".join(hourly),
        "models": trained.MODEL,
        **trained.UNITS,
        "past_days": PAST_DAYS,
        "forecast_days": FORECAST_DAYS,
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

    vwc = h[SOIL_VAR][current]
    rows += [("soil", "vwc_0_10cm", vwc), ("soil", "vwc_surface", vwc)]
    return [(hz, m, round(float(v), 4)) for hz, m, v in rows if v is not None]


def store(pool: ConnectionPool, sites: list[dict], forecasts: list[dict], now: datetime) -> str:
    rows = [(s["id"], now, hz, metric, value, NAME)
            for s, f in zip(sites, forecasts) for hz, metric, value in site_readings(s, f, now)]
    return f"{write_readings(pool, rows)} readings for {len(sites)} sites"
