"""Hazard cards and a TEMPORARY rule-based hazard index. Pure functions, no database.

TEMPORARY: replace hazard_index / top_factors with the ML model when it exists. Until then the
score is deliberately simple and explainable:

  1. Each hazard gets a 0-10 sub-score from fixed rules below.
     Card hazard_status follows the risk bands: < 4 ok, 4 to < 7 watch, >= 7 danger.
  2. hazard_index = highest sub-score + 0.5 for each OTHER hazard at watch or danger, capped at 10.
  3. Override (today only): while the site has an active lightning stop-work alert, the index is
     at least 9.0 and the top factor is "Active stop-work: lightning within 10 mi".
  4. Tomorrow uses the same rules on tomorrow's forecast (heat peak, rain), carries over soil,
     wildfire and wildlife, and never applies the lightning override (lightning isn't forecast).
"""

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from hazards.heat import osha_risk_band
from hazards.sources.nws import FIRE_LEVELS, FLOOD_LEVELS, HEAT_LEVELS, STORM_LEVELS

STOP_WORK_FACTOR = "Active stop-work: lightning within 10 mi"
OSHA_LABEL = {"lower": "lower", "moderate": "moderate", "high": "high", "very_high": "very high"}
SOIL_DRY_BELOW, SOIL_SATURATED_FROM = 0.15, 0.30   # m³/m³, top 9 cm; see soil_level()


@dataclass
class Inputs:
    """Everything known about one site right now (assembled by hazards/snapshot.py)."""
    site: dict
    readings: dict[tuple[str, str], tuple[float, datetime]]  # (hazard, metric) -> (value, ts)
    nws: list[dict] = field(default_factory=list)            # active NWS alerts at the site
    lightning_alert: dict | None = None
    flood_alert: dict | None = None
    crew_wildlife_reports: int = 0
    firms_detail: str | None = None                          # e.g. "skipped: FIRMS_MAP_KEY not set"


@dataclass
class Hazard:
    card: dict                 # extra card fields: status, reading, as_of, ...
    today: float
    tomorrow: float
    label_today: str
    label_tomorrow: str


def status_for(score: float) -> str:
    return "danger" if score >= 7 else "watch" if score >= 4 else "ok"


def _value(inp: Inputs, hazard: str, metric: str) -> float | None:
    v = inp.readings.get((hazard, metric))
    return None if v is None or (isinstance(v[0], float) and math.isnan(v[0])) else v[0]


def _as_of(inp: Inputs, hazard: str, metric: str) -> datetime | None:
    v = inp.readings.get((hazard, metric))
    return v[1] if v else None


def _time(dt: datetime, site: dict) -> str:
    return dt.astimezone(ZoneInfo(site["timezone"])).strftime("%I:%M %p").lstrip("0")


def _nws(inp: Inputs, levels: dict) -> tuple[int, dict | None]:
    """Highest NWS level among the site's alerts for one hazard, and that alert."""
    best = max(inp.nws, key=lambda a: levels.get(a["event"], 0), default=None)
    level = levels.get(best["event"], 0) if best else 0
    return level, best if level else None


def _until(alert: dict, site: dict) -> str:
    return f"{alert['event']} until {_time(alert['ends_at'], site)}" if alert.get("ends_at") else alert["event"]


# ---------- per hazard ----------

def heat(inp: Inputs) -> Hazard:
    hi_now = _value(inp, "heat", "heat_index_f")
    if hi_now is None:
        return Hazard({"reading": "No live heat data yet", "as_of": None}, 0, 0, "", "")
    peak = _value(inp, "heat", "peak_heat_index_f") or hi_now
    peak_at = _value(inp, "heat", "peak_at_epoch")
    rest = max(hi_now, _value(inp, "heat", "rest_of_day_peak_heat_index_f") or hi_now)
    tomorrow_peak = _value(inp, "heat", "tomorrow_peak_heat_index_f")
    # Heat index is reported in whole degrees, so classify the rounded value (90.7 -> 91 -> moderate).
    band = osha_risk_band(round(peak))

    def sub(hi: float) -> float:
        return {"lower": 0 if round(hi) < 80 else 2, "moderate": 5, "high": 7.5, "very_high": 9.5}[osha_risk_band(round(hi))]

    level, nws_alert = _nws(inp, HEAT_LEVELS)
    today = max(sub(rest), {0: 0, 1: 6, 2: 8}[level])
    tomorrow = sub(tomorrow_peak) if tomorrow_peak is not None else 0
    peak_time = datetime.fromtimestamp(peak_at, timezone.utc) if peak_at else None
    as_of = _as_of(inp, "heat", "heat_index_f")
    peak_past = peak_time is not None and as_of is not None and peak_time < as_of
    reading = f"Heat index {hi_now:.0f}°F now; today {'peaked at' if peak_past else 'peaks at'} {peak:.0f}°F"
    reading += f" at {_time(peak_time, inp.site)}" if peak_time else ""
    reading += f" (OSHA {OSHA_LABEL[band]} risk)"
    if nws_alert:
        reading = f"{_until(nws_alert, inp.site)}. {reading}"
    card = {"risk_band": band, "peak_heat_index_f": round(peak, 1), "peak_at": peak_time,
            "hazard_status": status_for(today), "reading": reading, "as_of": as_of}
    return Hazard(card, today, tomorrow,
                  nws_alert["event"] if nws_alert and level else f"Heat index up to {rest:.0f}°F (OSHA {OSHA_LABEL[osha_risk_band(round(rest))]})",
                  f"Heat index peak {tomorrow_peak:.0f}°F tomorrow" if tomorrow_peak else "")


def lightning(inp: Inputs) -> Hazard:
    alert = inp.lightning_alert
    level, nws_alert = _nws(inp, STORM_LEVELS)
    if alert:
        reading = (f"Stop work: strike {alert['last_strike_distance_mi']:.1f} mi away at "
                   f"{_time(alert['last_strike_at'], inp.site)}; all clear at "
                   f"{_time(alert['all_clear_at'], inp.site)} if no new strikes")
        return Hazard({"hazard_status": "danger", "reading": reading}, 9.0, 0, STOP_WORK_FACTOR, "")
    today = {0: 0, 1: 4, 2: 7}[level]
    reading = _until(nws_alert, inp.site) if nws_alert else "No lightning within 10 mi in the last 30 min"
    return Hazard({"hazard_status": status_for(today), "reading": reading}, today, 0,
                  nws_alert["event"] if nws_alert else "", "")


def soil_level(vwc: float) -> str:
    """Top-9 cm volumetric water content -> dry / moist / saturated. Florida's sandy soils hold
    roughly 0.35-0.45 m³/m³ when saturated; 0.30+ is wet enough to rut and bog vehicles."""
    return "dry" if vwc < SOIL_DRY_BELOW else "saturated" if vwc >= SOIL_SATURATED_FROM else "moist"


SOIL_READING = {
    "dry": "Dry, firm ground",
    "moist": "Moist ground: soft spots possible off pavement",
    "saturated": "Saturated ground: vehicles may get stuck off pavement",
}


def soil(inp: Inputs) -> Hazard:
    vwc = _value(inp, "soil", "vwc_surface")
    if vwc is None:
        return Hazard({"reading": "No live soil data yet", "as_of": None}, 0, 0, "", "")
    level = soil_level(vwc)
    rain_24h = _value(inp, "flood", "rain_past_24h_in") or 0
    rain_tomorrow = _value(inp, "flood", "rain_tomorrow_in") or 0
    today = {"dry": 0, "moist": 2, "saturated": 5}[level] + (2 if level == "saturated" and rain_24h >= 2 else 0)
    tomorrow_level = {"dry": "moist", "moist": "saturated", "saturated": "saturated"}[level] if rain_tomorrow >= 1 else level
    tomorrow = {"dry": 0, "moist": 2, "saturated": 5}[tomorrow_level]
    card = {"level": level, "hazard_status": status_for(today), "reading": SOIL_READING[level],
            "as_of": _as_of(inp, "soil", "vwc_surface")}
    return Hazard(card, today, tomorrow, f"{level.capitalize()} soil ({vwc * 100:.0f}% moisture)",
                  f"{tomorrow_level.capitalize()} soil expected")


def flood(inp: Inputs) -> Hazard:
    site = inp.site
    r12, r24, r72 = (_value(inp, "flood", m) for m in ("rain_past_12h_in", "rain_past_24h_in", "rain_past_72h_in"))
    nxt, tmrw = _value(inp, "flood", "rain_next_24h_in"), _value(inp, "flood", "rain_tomorrow_in")
    level, nws_alert = _nws(inp, FLOOD_LEVELS)
    in_zone = bool(site.get("fema_sfha") or site.get("near_river"))
    zone = site.get("fema_flood_zone")

    today = 1 if site.get("fema_sfha") else 0
    if r24 is not None:
        today = max(today, 6 if r24 >= 2 else 3 if r24 >= 1 else today) + (1 if r24 >= 1 and in_zone else 0)
    if nxt is not None:
        today = max(today, 5 if nxt >= 2 else 3 if nxt >= 1 else 0)
    today = max(today, {0: 0, 1: 4, 2: 5, 3: 8}[level], 7 if inp.flood_alert else 0)
    tomorrow = max(1 if site.get("fema_sfha") else 0,
                   (5 if tmrw >= 2 else 3 if tmrw >= 1 else 0) + (1 if tmrw >= 1 and in_zone else 0) if tmrw is not None else 0)

    zone_text = (f"FEMA zone {zone}" + (" (high-risk floodplain)" if site.get("fema_sfha") else "")
                 if zone and zone != "unmapped" else "No FEMA flood map here")
    river_text = f"; {site['river_name']} within 1 mi" if site.get("near_river") else ""
    if r12 is not None:
        reading = f"{r12:.1f} in of rain in 12 h, {r24:.1f} in in 24 h; {nxt:.1f} in expected next 24 h. {zone_text}{river_text}"
    else:
        reading = f"No live rain data yet. {zone_text}{river_text}"
    if nws_alert:
        reading = f"{_until(nws_alert, site)}. {reading}"
    elif inp.flood_alert:
        reading = f"Flood risk: heavy rain in a flood-prone area. {reading}"

    status_word = {0: "none", 1: "advisory", 2: "watch", 3: "warning"}[level]
    if inp.flood_alert:
        status_word = "warning"
    card = {
        "status": status_word,  # FloodConditions.status keeps its original meaning (NWS-style level)
        "source": nws_alert["headline"] if nws_alert else (
            f"Rain rule: {r12:.1f} in in 12 h in a flood-prone area" if inp.flood_alert else zone_text),
        "rain_past_12h_in": r12, "rain_past_24h_in": r24, "rain_past_72h_in": r72, "rain_next_24h_in": nxt,
        "fema_flood_zone": zone, "in_special_flood_hazard_area": site.get("fema_sfha"),
        "near_river": site.get("near_river"),
        "hazard_status": status_for(today), "reading": reading, "as_of": _as_of(inp, "flood", "rain_past_12h_in"),
    }
    label = (nws_alert["event"] if nws_alert else "Flood-risk alert: heavy rain in flood-prone area" if inp.flood_alert
             else f"{r24:.1f} in of rain in 24 h" if r24 and r24 >= 1 else f"{nxt:.1f} in of rain expected" if nxt and nxt >= 1
             else zone_text)
    return Hazard(card, today, tomorrow, label, f"{tmrw:.1f} in of rain forecast tomorrow" if tmrw else "")


def wildfire(inp: Inputs) -> Hazard:
    level, nws_alert = _nws(inp, FIRE_LEVELS)
    nws_score = {0: 0, 1: 3, 2: 5}[level]
    nearest = _value(inp, "wildfire", "nearest_detection_mi")
    have_firms = ("wildfire", "detections_25mi") in inp.readings
    card: dict = {"red_flag_warning": level == 2}
    if not have_firms:
        off = "Satellite fire detection off (no FIRMS key)" if inp.firms_detail and "FIRMS_MAP_KEY" in inp.firms_detail \
            else "No live fire data yet"
        reading = f"{_until(nws_alert, inp.site)}. {off}" if nws_alert else off
        card.update({"reading": reading, "as_of": None, "nearest_detection_mi": None, "detected_at": None,
                     "confidence": None})
        if nws_alert:
            card["hazard_status"] = status_for(nws_score)
        return Hazard(card, nws_score, nws_score, nws_alert["event"] if nws_alert else "", "")

    count = int(_value(inp, "wildfire", "detections_25mi") or 0)
    detected = _value(inp, "wildfire", "nearest_detection_epoch")
    conf = _value(inp, "wildfire", "nearest_confidence")
    score = 8 if nearest is not None and nearest <= 5 else 6 if nearest is not None and nearest <= 10 else \
        4 if nearest is not None and nearest <= 25 else 0
    score = max(score, nws_score)
    detected_at = datetime.fromtimestamp(detected, timezone.utc) if detected else None
    if nearest is not None and nearest <= 25:
        reading = f"Fire detected {nearest:.1f} mi away at {_time(detected_at, inp.site)} ({count} within 25 mi in 24 h)"
    else:
        reading = "No fires detected within 25 mi in the last 24 h"
    hot_spots = int(_value(inp, "wildfire", "plant_hot_spots_ignored") or 0)
    if hot_spots:
        reading += f"; {hot_spots} hot spot{'s' if hot_spots != 1 else ''} at the plant ignored (plant heat)"
    if nws_alert:
        reading = f"{_until(nws_alert, inp.site)}. {reading}"
    card.update({"nearest_detection_mi": nearest, "detected_at": detected_at,
                 "confidence": {0: "low", 1: "nominal", 2: "high"}.get(int(conf)) if conf is not None else None,
                 "detections_25mi": count, "hazard_status": status_for(score), "reading": reading,
                 "as_of": _as_of(inp, "wildfire", "detections_25mi")})
    label = nws_alert["event"] if level == 2 else f"Fire detected {nearest:.0f} mi away" if score >= 4 else ""
    return Hazard(card, score, score, label, label)


def wildlife(inp: Inputs, species_counts: dict[str, int]) -> Hazard:
    obs = _value(inp, "wildlife", "observations_30d")
    venomous = int(_value(inp, "wildlife", "venomous_30d") or 0)
    crew = inp.crew_wildlife_reports
    score = 5 if crew else 4 if venomous else 2 if obs else 0
    if obs and obs >= 5:
        score = min(6, score + 1)
    if species_counts:
        parts = [f"{name} ({n})" for name, n in sorted(species_counts.items(), key=lambda x: -x[1])]
        reading = f"{', '.join(parts)} sighted within 3 mi in 30 days"
    elif obs is None:
        reading = "No live wildlife data yet"
    else:
        reading = "No alligator or venomous snake sightings within 3 mi in 30 days"
    if crew:
        reading += f"; {crew} crew report{'s' if crew != 1 else ''} within 2 mi"
    summary = {"hazard_status": status_for(score), "reading": reading, "as_of": _as_of(inp, "wildlife", "observations_30d"),
               "observations_30d": int(obs or 0), "venomous_30d": venomous, "crew_reports_2mi": crew}
    label = ("Crew wildlife report nearby" if crew else "Venomous snake sighted nearby" if venomous
             else "Alligator sighted nearby" if obs else "")
    return Hazard(summary, score, score, label, label)


# ---------- index ----------

def combine(scores: dict[str, tuple[float, str]], stop_work: bool) -> tuple[float, str, list[dict]]:
    """(hazard_index, top_hazard, top_factors) from {hazard: (sub_score, label)}. TEMPORARY rule."""
    ranked = sorted(((h, s, label) for h, (s, label) in scores.items()), key=lambda x: -x[1])
    top_h, top_s, _ = ranked[0]
    index = min(10.0, top_s + 0.5 * sum(1 for h, s, _ in ranked[1:] if s >= 4))
    if stop_work:
        index = max(index, 9.0)
        top_h = "lightning"
    positive = [(h, s, label) for h, s, label in ranked if s > 0 and label]
    total = sum(s for _, s, _ in positive) or 1
    factors = [{"hazard": h, "label": label, "weight": round(s / total, 2)} for h, s, label in positive[:4]]
    if stop_work:
        factors = [f for f in factors if f["hazard"] != "lightning"]
        factors.insert(0, {"hazard": "lightning", "label": STOP_WORK_FACTOR,
                           "weight": round(9.0 / max(total, 9.0), 2)})
        factors = factors[:4]
    return round(index, 1), top_h, factors


def score_site(inp: Inputs, species_counts: dict[str, int]) -> dict:
    """All card extras plus today's and tomorrow's index for one site."""
    parts = {"heat": heat(inp), "lightning": lightning(inp), "flood": flood(inp),
             "soil_saturation": soil(inp), "wildfire": wildfire(inp), "wildlife": wildlife(inp, species_counts)}
    today, top, factors = combine({h: (p.today, p.label_today) for h, p in parts.items()},
                                  stop_work=inp.lightning_alert is not None)
    tomorrow, top_tomorrow, factors_tomorrow = combine(
        {h: (p.tomorrow, p.label_tomorrow) for h, p in parts.items()}, stop_work=False)
    return {"cards": {h: p.card for h, p in parts.items()}, "hazard_index_today": today,
            "hazard_index_tomorrow": tomorrow, "top_hazard": top, "top_factors": factors,
            "top_hazard_tomorrow": top_tomorrow, "top_factors_tomorrow": factors_tomorrow}
