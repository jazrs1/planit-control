"""Daily model features from Open-Meteo hourly data. Shared by training and live scoring.

Everything is computed per site-day on the site's local calendar date (Open-Meteo is asked for
hourly data in the site's timezone), in °F, inches, and mph.
"""

import numpy as np
import pandas as pd

from ml.openmeteo import HOURLY_VARS

THUNDER_CODES = (95, 96, 99)  # WMO weather codes: thunderstorm, with slight/heavy hail

WEATHER_FEATURES = [
    "tmax_f",
    "heat_index_max_f",
    "rain_in",
    "rain_rate_max_in",
    "rain_prior3_in",
    "rain_prior7_in",
    "gust_max_mph",
    "cape_max",
    "thunder_hours",
    "soil_moisture_pct",
]
CALENDAR_FEATURES = ["doy_sin", "doy_cos"]
SITE_FEATURES = ["lat", "lon"]
FEATURES = WEATHER_FEATURES + CALENDAR_FEATURES + SITE_FEATURES


def heat_index_f(temp_f, rh_pct):
    """NWS heat index (Rothfusz regression with the NWS adjustments), vectorized."""
    t = np.asarray(temp_f, dtype=float)
    rh = np.asarray(rh_pct, dtype=float)
    simple = 0.5 * (t + 61.0 + (t - 68.0) * 1.2 + rh * 0.094)
    hi = (
        -42.379 + 2.04901523 * t + 10.14333127 * rh - 0.22475541 * t * rh
        - 6.83783e-3 * t * t - 5.481717e-2 * rh * rh + 1.22874e-3 * t * t * rh
        + 8.5282e-4 * t * rh * rh - 1.99e-6 * t * t * rh * rh
    )
    with np.errstate(invalid="ignore"):
        dry = (rh < 13) & (t >= 80) & (t <= 112)
        hi = np.where(dry, hi - ((13 - rh) / 4) * np.sqrt(np.clip((17 - np.abs(t - 95.0)) / 17, 0, None)), hi)
        humid = (rh > 85) & (t >= 80) & (t <= 87)
        hi = np.where(humid, hi + ((rh - 85) / 10) * ((87 - t) / 5), hi)
    # The regression only applies once the simple estimate (averaged with T) reaches 80 °F.
    return np.where((simple + t) / 2 >= 80, hi, simple)


def hourly_frame(payload: dict, suffix: str = "") -> pd.DataFrame:
    """Open-Meteo hourly block -> DataFrame indexed by local time, columns named as in HOURLY_VARS."""
    hourly = payload["hourly"]
    frame = pd.DataFrame(
        {v: pd.to_numeric(pd.Series(hourly.get(v + suffix)), errors="coerce") for v in HOURLY_VARS if v + suffix in hourly},
    )
    frame.index = pd.to_datetime(hourly["time"])
    return frame.reindex(columns=HOURLY_VARS)


def hourly_frame_unix(payload: dict, tz: str) -> pd.DataFrame:
    """Same as hourly_frame for a payload requested with timezone=GMT and timeformat=unixtime (the
    live poller's format): times are converted to the site's local wall clock."""
    hourly = payload["hourly"]
    frame = pd.DataFrame({v: pd.to_numeric(pd.Series(hourly.get(v)), errors="coerce") for v in HOURLY_VARS if v in hourly})
    frame.index = pd.to_datetime(hourly["time"], unit="s", utc=True).tz_convert(tz).tz_localize(None)
    return frame.reindex(columns=HOURLY_VARS)


def daily_weather(hourly: pd.DataFrame) -> pd.DataFrame:
    """Per local date: same-day weather features (no history yet)."""
    h = hourly.copy()
    h["heat_index"] = heat_index_f(h.temperature_2m, h.relative_humidity_2m)
    h["thunder"] = h.weather_code.isin(THUNDER_CODES).astype(float).where(h.weather_code.notna())
    g = h.groupby(h.index.date)
    daily = pd.DataFrame({
        "tmax_f": g.temperature_2m.max(),
        "heat_index_max_f": g.heat_index.max(),
        "rain_in": g.precipitation.sum(min_count=1),
        "rain_rate_max_in": g.precipitation.max(),
        "gust_max_mph": g.wind_gusts_10m.max(),
        "cape_max": g.cape.max(),
        "thunder_hours": g.thunder.sum(min_count=1),
        "soil_moisture_pct": g.soil_moisture_0_to_10cm.mean() * 100,
    })
    # A day with fewer than 20 hours (missing data) is unreliable; DST days have 23 or 25.
    daily[g.temperature_2m.count() < 20] = np.nan
    daily.index = pd.to_datetime(daily.index)
    daily.index.name = "date"
    return daily


def add_history(daily: pd.DataFrame, history_rain: pd.Series | None = None) -> pd.DataFrame:
    """Rain over the 3 and 7 days before each date (not including it).

    `history_rain` lets the day-ahead evaluation take past days from the analysis-like series while
    the target day comes from the older forecast; by default it is the same frame's rain_in.
    """
    rain = (daily.rain_in if history_rain is None else history_rain).reindex(
        pd.date_range(daily.index.min() - pd.Timedelta(days=7), daily.index.max())
    )
    out = daily.copy()
    for n in (3, 7):
        prior = rain.shift(1).rolling(n, min_periods=n).sum()
        out[f"rain_prior{n}_in"] = prior.reindex(daily.index).to_numpy()
    return out


def add_static(daily: pd.DataFrame, site: dict) -> pd.DataFrame:
    out = daily.copy()
    doy = out.index.dayofyear.to_numpy()
    out["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
    out["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)
    out["lat"] = site["lat"]
    out["lon"] = site["lon"]
    return out


def site_features(site: dict, hourly: pd.DataFrame) -> pd.DataFrame:
    """Full feature table (one row per local date) from one continuous hourly series."""
    return add_static(add_history(daily_weather(hourly)), site)[FEATURES]
