"""The JSON a briefing is written from: one per site, built only from live data.

Everything the briefing may say must be in here, including derived times crews act on (sunrise,
when the heat index reaches 91°F, when thunderstorms become likely) and the stop-work rules, so
the writer never has to invent a number. briefing/writer.py checks that it didn't.
"""

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from psycopg_pool import ConnectionPool

from alerts.engine import ALL_CLEAR_AFTER, STOP_WORK_RADIUS_MI
from hazards import http, snapshot
from hazards.heat import heat_index_f, osha_risk_band
from hazards.risk import predict
from hazards.scoring import SOIL_READING, ago, crew_label, soil_level
from hazards.sources import open_meteo
from hazards.sources.nws import FIRE_LEVELS, FLOOD_LEVELS, HEAT_LEVELS, STORM_LEVELS
from hazards.store import write_readings

ENSEMBLE_URL = "https://ensemble-api.open-meteo.com/v1/ensemble"
# The periods cover the whole calendar day, so rain_total_in is the same window as the index's
# "in of rain forecast tomorrow" factor (hazards/scoring.py, rain_tomorrow_in).
PERIODS = [("early morning", 0, 6), ("morning", 6, 12), ("afternoon", 12, 18), ("evening", 18, 24)]
WORK_HOURS = (6, 20)
THUNDERSTORM_LIKELY_PCT = 30
THUNDERSTORM_CODES = range(95, 100)   # WMO weather codes 95-99
RELEVANT_NWS = {**FLOOD_LEVELS, **HEAT_LEVELS, **STORM_LEVELS, **FIRE_LEVELS}


def local_tomorrow(site: dict, now: datetime) -> date:
    return now.astimezone(ZoneInfo(site["timezone"])).date() + timedelta(days=1)


def clock_time(dt: datetime, tz: ZoneInfo) -> str:
    """'2 PM' on the hour, else '6:58 AM' (crews read these; the grounding check matches them)."""
    local = dt.astimezone(tz)
    fmt = "%I %p" if local.minute == 0 else "%I:%M %p"
    return local.strftime(fmt).lstrip("0")


CREW_CAUTION = {"downed_line", "heat_illness"}


def go_status(index: float, storm_chance: int, nws_events: list[str], crew_categories: list[str] = ()) -> str:
    """Headline decision, made in code (never by the writer). Band of tomorrow's index
    (green go / amber caution / red no_go), raised to at least caution when thunderstorms are
    likely during work hours, NWS has a watch or warning in effect for tomorrow, or a crew reported
    a downed line or heat illness nearby in the last 48 hours."""
    status = "no_go" if index >= 7 else "caution" if index >= 4 else "go"
    if status == "go" and (storm_chance >= THUNDERSTORM_LIKELY_PCT
                           or any(("Watch" in e or "Warning" in e) for e in nws_events)
                           or any(c in CREW_CAUTION for c in crew_categories)):
        status = "caution"
    return status


def fetch_weather(pool: ConnectionPool, sites: list[dict], now: datetime) -> tuple[list[dict], list[dict]]:
    """Fresh forecast (also written to `conditions`, so the index and briefing agree) and the GFS
    ensemble's weather codes for thunderstorm chances. Two requests for all sites."""
    forecasts = open_meteo.fetch(sites, extra_hourly=("precipitation_probability",), daily=("sunrise", "sunset"))
    rows = [(s["id"], now, hz, m, v, open_meteo.NAME)
            for s, f in zip(sites, forecasts) for hz, m, v in open_meteo.site_readings(s, f, now)]
    write_readings(pool, rows)
    ensemble = http.get_json(ENSEMBLE_URL, {
        "latitude": ",".join(f"{s['lat']:.4f}" for s in sites),
        "longitude": ",".join(f"{s['lon']:.4f}" for s in sites),
        "hourly": "weather_code", "models": "gfs025", "forecast_days": 3,
        "timezone": "GMT", "timeformat": "unixtime",
    }, retries=2)
    ensemble = ensemble if isinstance(ensemble, list) else [ensemble]
    return forecasts, ensemble


def _day_hours(times: list[datetime], tz: ZoneInfo, day: date, start_h: int, end_h: int) -> list[int]:
    return [i for i, t in enumerate(times) if t.astimezone(tz).date() == day and start_h <= t.astimezone(tz).hour < end_h]


def site_inputs(site: dict, forecast: dict, ensemble: dict, snap: snapshot.Snapshot, now: datetime) -> tuple[dict, list[dict]]:
    """(inputs JSON, tomorrow's top factors with weights for the API)."""
    tz = ZoneInfo(site["timezone"])
    day = local_tomorrow(site, now)
    h = forecast["hourly"]
    times = [datetime.fromtimestamp(t, timezone.utc) for t in h["time"]]
    hi = [heat_index_f(t, rh) if t is not None and rh is not None else None
          for t, rh in zip(h["temperature_2m"], h["relative_humidity_2m"])]

    # Heat: peak, when, and the hours at or above OSHA's moderate band (91°F).
    day_idx = _day_hours(times, tz, day, 0, 24)
    peak_i = max((i for i in day_idx if hi[i] is not None), key=lambda i: hi[i], default=None)
    work = _day_hours(times, tz, day, *WORK_HOURS)
    hot = [i for i in work if hi[i] is not None and round(hi[i]) >= 91]
    heat = None
    if peak_i is not None:
        peak = round(hi[peak_i])
        heat = {"peak_heat_index_f": peak, "peak_time": clock_time(times[peak_i], tz),
                "osha_risk_band": osha_risk_band(peak).replace("_", " "),
                "heat_index_91_or_higher": {"from": clock_time(times[hot[0]], tz),
                                            "until": clock_time(times[hot[-1]] + timedelta(hours=1), tz)} if hot else None}

    # Rain and thunderstorms by time of day. Storm chance = share of the 31 GFS ensemble runs
    # with a thunderstorm weather code in that period.
    e = ensemble["hourly"]
    e_times = [datetime.fromtimestamp(t, timezone.utc) for t in e["time"]]
    members = [k for k in e if k.startswith("weather_code")]

    def storm_pct(start_h: int, end_h: int) -> int:
        idx = _day_hours(e_times, tz, day, start_h, end_h)
        if not idx or not members:
            return 0
        hits = sum(1 for m in members if any((e[m][i] or 0) in THUNDERSTORM_CODES for i in idx))
        return round(100 * hits / len(members))

    periods = []
    for name, start_h, end_h in PERIODS:
        idx = _day_hours(times, tz, day, start_h, end_h)
        probs = [h["precipitation_probability"][i] for i in idx if h["precipitation_probability"][i] is not None]
        periods.append({
            "period": name,
            "hours": f"{clock_time(datetime.combine(day, time(start_h), tz), tz)}-"
                     f"{clock_time(datetime.combine(day, time(0), tz) + timedelta(hours=end_h), tz)}",
            "rain_chance_pct": max(probs) if probs else None,
            "rain_in": round(sum(h["precipitation"][i] or 0 for i in idx), 2),
            "thunderstorm_chance_pct": storm_pct(start_h, end_h),
        })
    storms_from = next((clock_time(e_times[i], tz) for i in _day_hours(e_times, tz, day, *WORK_HOURS)
                        if sum(1 for m in members if (e[m][i] or 0) in THUNDERSTORM_CODES) * 100
                        >= THUNDERSTORM_LIKELY_PCT * len(members)), None)
    work_storm_pct = storm_pct(*WORK_HOURS)

    # Daylight.
    d = forecast.get("daily") or {}
    daylight = {}
    for key in ("sunrise", "sunset"):
        for ts in d.get(key) or []:
            t = datetime.fromtimestamp(ts, timezone.utc)
            if t.astimezone(tz).date() == day:
                daylight[key] = clock_time(t, tz)

    # Site context from the live snapshot, and tomorrow's index from the shared risk function.
    inp = snap.inputs[site["id"]]
    scored = predict(inp, snap.species_counts[site["id"]])
    day_start = datetime.combine(day, time(0), tz)
    nws = [{"event": a["event"], "until": a["ends_at"].astimezone(tz).strftime("%a %I %p").replace(" 0", " ")
            if a["ends_at"] else "further notice"}
           for a in inp.nws if a["event"] in RELEVANT_NWS and (a["ends_at"] is None or a["ends_at"] > day_start)]
    vwc = inp.readings.get(("soil", "vwc_surface"))
    level = soil_level(vwc[0]) if vwc else None
    fire = inp.readings.get(("wildfire", "detections_25mi"))
    index = scored["hazard_index_tomorrow"]
    # Crew reports (no free-text notes: they're untrusted text and could carry unchecked numbers).
    crew = [{"category": crew_label(r), "reported": ago(r["created_at"], now),
             "reported_at": clock_time(r["created_at"], tz), "distance_mi": r["distance_mi"]}
            for r in inp.crew_reports]
    inputs = {
        "site": {"name": site["name"], "county": site["county"], "timezone": site["timezone"]},
        "for_date": day.isoformat(),
        "day": datetime.combine(day, time(12), tz).strftime("%A, %b %d").replace(" 0", " "),
        "go_status": go_status(index, work_storm_pct, [n["event"] for n in nws], [r["category"] for r in inp.crew_reports]),
        "hazard_index": index,
        "hazard_index_scale": "0 to 10; green under 4, amber 4 to under 7, red 7 and up",
        "top_hazard": scored["top_hazard_tomorrow"],
        "top_factors": [{"hazard": f["hazard"], "label": f["label"]} for f in scored["top_factors_tomorrow"]],
        "daylight": daylight or None,
        "heat": heat,
        "periods": periods,
        "rain_total_in": round(sum(p["rain_in"] for p in periods), 2),
        "thunderstorms_likely_from": storms_from,
        "thunderstorm_chance_work_hours_pct": work_storm_pct,
        "soil": {"level": level, "moisture_pct": round(vwc[0] * 100), "crew_note": SOIL_READING[level]} if level else None,
        "flood": {"fema_flood_zone": site.get("fema_flood_zone"), "in_special_flood_hazard_area": site.get("fema_sfha"),
                  "named_river_within_1_mi": site.get("river_name")},
        "nws_alerts": nws,
        "wildlife": {"sightings_last_30_days": [{"species": k, "count": v} for k, v in snap.species_counts[site["id"]].items()],
                     "crew_reports_within_2_mi_last_30_days": inp.crew_wildlife_reports},
        "wildfire": {"detections_within_25_mi": int(fire[0])} if fire else {"detections_within_25_mi": "unavailable"},
        "crew_reports_last_48_h_within_2_mi": crew,
        "rules": {"lightning_stop_work_radius_mi": int(STOP_WORK_RADIUS_MI),
                  "lightning_all_clear_wait_min": int(ALL_CLEAR_AFTER.total_seconds() // 60)},
    }
    return inputs, scored["top_factors_tomorrow"]


def build_all(pool: ConnectionPool, site_ids: list[str] | None, now: datetime) -> dict[str, tuple[dict, list[dict]]]:
    """{site_id: (inputs, top factors)} for the given sites (all when None)."""
    snap = snapshot.load(pool)
    sites = [s for s in snap.sites if site_ids is None or s["id"] in site_ids]
    if not sites:
        return {}
    forecasts, ensemble = fetch_weather(pool, sites, now)
    snap = snapshot.load(pool)  # re-read so tomorrow's index uses the forecast just written
    by_id = {s["id"]: s for s in snap.sites}
    return {s["id"]: site_inputs(by_id[s["id"]], f, e, snap, now) for s, f, e in zip(sites, forecasts, ensemble)}
