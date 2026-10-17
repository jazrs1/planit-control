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
WORK_HOURS = (7, 17)   # site-local; hard stops count only inside these hours
THUNDERSTORM_LIKELY_PCT = 30
THUNDERSTORM_CODES = range(95, 100)   # WMO weather codes 95-99
TROPICAL_LEVELS = {"Tornado Watch": 1, "Tropical Storm Watch": 1, "Hurricane Watch": 1,
                   "Tropical Storm Warning": 2, "Hurricane Warning": 2}
RELEVANT_NWS = {**FLOOD_LEVELS, **HEAT_LEVELS, **STORM_LEVELS, **FIRE_LEVELS, **TROPICAL_LEVELS}
# NWS warnings that stop work when in effect during work hours (Red Flag only with a fire within 10 mi).
HARD_STOP_WARNINGS = {"Hurricane Warning", "Tropical Storm Warning", "Tornado Warning", "Flood Warning",
                      "Flash Flood Warning", "Coastal Flood Warning", "Excessive Heat Warning", "Extreme Heat Warning"}
RED_FLAG_FIRE_MI = 10
FIRE_STOP_MI = 5
HARD_STOP_CREW = ("Downed line", "Flooding or washout")


def local_tomorrow(site: dict, now: datetime) -> date:
    return now.astimezone(ZoneInfo(site["timezone"])).date() + timedelta(days=1)


def clock_time(dt: datetime, tz: ZoneInfo) -> str:
    """'2 PM' on the hour, else '6:58 AM' (crews read these; the grounding check matches them)."""
    local = dt.astimezone(tz)
    fmt = "%I %p" if local.minute == 0 else "%I:%M %p"
    return local.strftime(fmt).lstrip("0")


def hard_stops(inputs: dict) -> list[dict]:
    """Named reasons to stop work tomorrow, each during work hours (7 AM-5 PM site time):
    {"name", "when", "text"}. NO-GO happens only for these."""
    stops = []
    fire_mi = (inputs.get("wildfire") or {}).get("nearest_detection_mi")
    for a in inputs["nws_alerts"]:
        if not a.get("work_hours"):
            continue
        if a["event"] in HARD_STOP_WARNINGS or (
                a["event"] == "Red Flag Warning" and fire_mi is not None and fire_mi <= RED_FLAG_FIRE_MI):
            stops.append({"kind": "nws", "name": a["event"], "when": a["work_hours"], "text": f"{a['event']} {a['work_hours']}"})
    heat = inputs.get("heat") or {}
    if heat.get("work_hours_osha_risk_band") == "very high":
        stops.append({"kind": "heat", "name": "OSHA very high heat", "when": heat["work_hours_peak_time"],
                      "text": f"OSHA very high heat: heat index {heat['work_hours_peak_heat_index_f']}°F around "
                              f"{heat['work_hours_peak_time']}"})
    # A fire within 5 mi stops work only once confirmed (2+ satellite passes or high confidence), the same
    # rule that makes it danger on the wildfire card; one pass is watch (CAUTION through the index).
    if fire_mi is not None and fire_mi <= FIRE_STOP_MI and (inputs.get("wildfire") or {}).get("confirmed_within_5_mi"):
        stops.append({"kind": "fire", "name": "Fire detected", "when": "all day", "text": f"Fire detected {fire_mi} mi away"})
    crew = inputs.get("crew_reports_last_48_h_within_2_mi") or []
    for category in HARD_STOP_CREW:                       # a downed line first, then site flooding
        for r in crew:
            if r["category"].startswith(category):
                name = "downed line" if category == "Downed line" else "site flooding"
                stops.append({"kind": "crew", "name": name, "when": r["reported"],
                              "text": f"Crew reported {'a ' if category == 'Downed line' else ''}{name} {r['reported']}"})
    return stops


def go_status(inputs: dict) -> str:
    """The verdict, made in code (never by the writer). NO-GO only for a named hard stop during work
    hours (hard_stops). A high hazard index alone, hazards outside work hours, thunderstorms likely
    during work hours, any NWS watch or warning tomorrow, or a crew report of heat illness give at
    most CAUTION; otherwise GO."""
    if inputs.get("hard_stops"):
        return "no_go"
    crew = [r["category"] for r in inputs.get("crew_reports_last_48_h_within_2_mi") or []]
    if (inputs["hazard_index"] >= 4
            or inputs["thunderstorm_chance_work_hours_pct"] >= THUNDERSTORM_LIKELY_PCT
            or any(("Watch" in a["event"] or "Warning" in a["event"]) for a in inputs["nws_alerts"])
            or any(c.startswith("Heat illness") for c in crew)):
        return "caution"
    return "go"


def _window(start: datetime, end: datetime, tz: ZoneInfo) -> str:
    return f"{clock_time(start, tz)}-{clock_time(end, tz)}"


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

    # Heat during work hours: the peak that can stop work (OSHA very high or extreme).
    work_peak_i = max((i for i in work if hi[i] is not None), key=lambda i: hi[i], default=None)
    if heat is not None and work_peak_i is not None:
        wp = round(hi[work_peak_i])
        heat.update({"work_hours_peak_heat_index_f": wp, "work_hours_peak_time": clock_time(times[work_peak_i], tz),
                     "work_hours_osha_risk_band": osha_risk_band(wp).replace("_", " ")})

    # Wind: the strongest forecast gust during work hours (mph, the same units as the hazard model).
    gusts = h.get("wind_gusts_10m") or []
    gust_i = max((i for i in work if i < len(gusts) and gusts[i] is not None), key=lambda i: gusts[i], default=None)
    wind = {"max_gust_mph": round(gusts[gust_i]), "peak_time": clock_time(times[gust_i], tz)} if gust_i is not None else None

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
            "rain_in": round(sum(h["precipitation"][i] or 0 for i in idx), 1),
            "thunderstorm_chance_pct": storm_pct(start_h, end_h),
        })
    storms_from = next((clock_time(e_times[i], tz) for i in _day_hours(e_times, tz, day, *WORK_HOURS)
                        if sum(1 for m in members if (e[m][i] or 0) in THUNDERSTORM_CODES) * 100
                        >= THUNDERSTORM_LIKELY_PCT * len(members)), None)
    work_storm_pct = storm_pct(*WORK_HOURS)
    # Rain, one decimal everywhere: the whole day and the work-hours share.
    day_rain = sum(h["precipitation"][i] or 0 for i in _day_hours(times, tz, day, 0, 24))
    work_rain = sum(h["precipitation"][i] or 0 for i in work)

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
    work_start, work_end = (datetime.combine(day, time(WORK_HOURS[0]), tz), datetime.combine(day, time(WORK_HOURS[1]), tz))
    nws = []
    for a in inp.nws:
        if a["event"] not in RELEVANT_NWS or (a["ends_at"] is not None and a["ends_at"] <= day_start):
            continue
        # The part of tomorrow's work hours the alert covers, e.g. "7 AM-3 PM" (null: none).
        start, end = max(a.get("onset") or work_start, work_start), min(a["ends_at"] or work_end, work_end)
        nws.append({"event": a["event"],
                    "until": a["ends_at"].astimezone(tz).strftime("%a %I %p").replace(" 0", " ") if a["ends_at"] else "further notice",
                    "work_hours": _window(start, end, tz) if start < end else None})
    vwc = inp.readings.get(("soil", "vwc_surface"))
    level = soil_level(vwc[0]) if vwc else None
    fire = inp.readings.get(("wildfire", "detections_25mi"))
    fire_mi = inp.readings.get(("wildfire", "nearest_detection_mi"))
    fire_mi = round(fire_mi[0], 1) if fire_mi and fire_mi[0] == fire_mi[0] else None   # NaN: no detection
    passes, high = inp.readings.get(("wildfire", "passes_5mi")), inp.readings.get(("wildfire", "high_confidence_5mi"))
    # Same rule as the wildfire card (hazards/scoring.py): readings from before pass counts existed count.
    confirmed = passes is None or passes[0] >= 2 or (high is not None and high[0] >= 1)
    index = scored["hazard_index_tomorrow"]
    # Crew reports (no free-text notes: they're untrusted text and could carry unchecked numbers).
    crew = [{"category": crew_label(r), "reported": ago(r["created_at"], now),
             "reported_at": clock_time(r["created_at"], tz), "distance_mi": r["distance_mi"]}
            for r in inp.crew_reports]
    inputs = {
        "site": {"name": site["name"], "county": site["county"], "timezone": site["timezone"]},
        "for_date": day.isoformat(),
        "day": datetime.combine(day, time(12), tz).strftime("%A, %b %d").replace(" 0", " "),
        "work_hours": _window(work_start, work_end, tz),
        "hazard_index": index,
        "hazard_index_scale": "0 to 10; green under 4, amber 4 to under 7, red 7 and up",
        "top_hazard": scored["top_hazard_tomorrow"],
        "top_factors": [{"hazard": f["hazard"], "label": f["label"]} for f in scored["top_factors_tomorrow"]],
        "daylight": daylight or None,
        "heat": heat,
        "wind": wind,
        "periods": periods,
        "rain_total_in": round(day_rain, 1),
        "rain_work_hours_in": round(work_rain, 1),
        "thunderstorms_likely_from": storms_from,
        "thunderstorm_chance_work_hours_pct": work_storm_pct,
        "soil": {"level": level, "moisture_pct": round(vwc[0] * 100), "crew_note": SOIL_READING[level]} if level else None,
        "flood": {"fema_flood_zone": site.get("fema_flood_zone"), "in_special_flood_hazard_area": site.get("fema_sfha"),
                  "named_river_within_1_mi": site.get("river_name")},
        "nws_alerts": nws,
        "wildlife": {"sightings_last_30_days": [{"species": k, "count": v} for k, v in snap.species_counts[site["id"]].items()],
                     "crew_reports_within_2_mi_last_30_days": inp.crew_wildlife_reports},
        "wildfire": ({"detections_within_25_mi": int(fire[0]), "nearest_detection_mi": fire_mi,
                      "confirmed_within_5_mi": bool(fire_mi is not None and fire_mi <= FIRE_STOP_MI and confirmed)} if fire
                     else {"detections_within_25_mi": "unavailable", "nearest_detection_mi": None, "confirmed_within_5_mi": False}),
        "crew_reports_last_48_h_within_2_mi": crew,
        "rules": {"lightning_stop_work_radius_mi": int(STOP_WORK_RADIUS_MI),
                  "lightning_all_clear_wait_min": int(ALL_CLEAR_AFTER.total_seconds() // 60)},
    }
    inputs["hard_stops"] = hard_stops(inputs)
    inputs["go_status"] = go_status(inputs)
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
