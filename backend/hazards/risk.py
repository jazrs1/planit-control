"""The one place hazard indexes come from: /sites, /sites/{id}, the stored score history and the
evening briefing all call predict().

Hybrid index, for today and tomorrow (site-local dates):

  index = the highest of
    - the ML weather score: the hazard model's calibrated probability mapped to 0-10 by lift over
      the 2024 base rate (4 = 2x, 7 = 5x; ml/model.py; scored hourly from the weather poll and
      re-mapped from the stored probability on read, hazards/model_scores.py)
    - the OSHA heat-index band score (lower 0-2, moderate 5, high 7.5, very high 9.5)
    - the wildfire rule (FIRMS distance), the wildlife rule, and crew reports
      (a crew report that raises a card to watch counts 4.0; today only). Chronic conditions,
      wildlife sightings over 30 days and fires 10-25 mi away, count at most 3 (CHRONIC_MAX): they
      are always listed as factors but can't color a site on their own
    - floors that only ever raise the index:
        an NWS Hurricane Warning for the site                                      at least 9
        an NWS warning for the site (flood, flash flood, coastal flood, severe thunderstorm,
          tornado, tropical storm, excessive/extreme heat, red flag)              at least 7
        an NWS watch or advisory in the same families (incl. hurricane and tropical
          storm watches), or our own flood-risk alert                             at least 4
        a downed-line crew report within 2 mi in the last 48 h (today only)        at least 7
      Today counts alerts in effect at any point in the rest of today; tomorrow counts only
      watches and warnings in effect during tomorrow.
  plus the lightning override, today only: while the site has an active stop-work alert, the index
  is at least 9.0 and the first factor is the stop-work.

The ML model is the weather part (storms, rain, flooding); the rules cover what it can't learn
from its labels (heat, fire, wildlife), what crews see on the ground, and what forecasters have
officially warned about. Every factor says whether it came from the model or a rule. Factors list
the stop-work first, then warning-level floors (official warnings, downed lines), then the winning
part's reasons, then any other part at watch or above or chronic; weight = that part's share of the summed
scores (the model's share split by its own factor weights). top_hazard is the first factor's hazard.
Returns:

  hazard_index_today, top_hazard, top_factors            (today, with the lightning override)
  hazard_index_tomorrow, top_hazard_tomorrow, top_factors_tomorrow   (never the override)
  model_today, model_tomorrow                            (the ML part, or None before the first run)
  cards                                                  (per-hazard status and reading)
"""

import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from hazards.scoring import STOP_WORK_FACTOR, Inputs, ago, nws_rain, rain_text, score_site

STOP_WORK_MIN = 9.0
HURRICANE_FLOOR = 9.0
WARNING_FLOOR = 7.0
WATCH_FLOOR = 4.0
SHOW_RULES_FROM = 4.0  # rule factors at watch or above are listed even when another source wins
CHRONIC_MAX = 3.0      # wildlife sightings and fires 10-25 mi away count at most this (always listed)
MAX_FACTORS = 4

# NWS event -> (family, hazard, floor). Each family gives one floor, from its most severe alert, so a
# Hurricane Warning doesn't hide a Tornado Warning. Storm and tropical alerts use the `storm` hazard,
# like the model's storm factors (`lightning` means satellite-detected strikes only).
NWS_FLOORS = {
    "Flood Warning": ("flood", "flood", WARNING_FLOOR),
    "Flash Flood Warning": ("flood", "flood", WARNING_FLOOR),
    "Coastal Flood Warning": ("flood", "flood", WARNING_FLOOR),
    "Flood Watch": ("flood", "flood", WATCH_FLOOR),
    "Flash Flood Watch": ("flood", "flood", WATCH_FLOOR),
    "Coastal Flood Watch": ("flood", "flood", WATCH_FLOOR),
    "Flood Advisory": ("flood", "flood", WATCH_FLOOR),
    "Coastal Flood Advisory": ("flood", "flood", WATCH_FLOOR),
    "Severe Thunderstorm Warning": ("storm", "storm", WARNING_FLOOR),
    "Tornado Warning": ("storm", "storm", WARNING_FLOOR),
    "Severe Thunderstorm Watch": ("storm", "storm", WATCH_FLOOR),
    "Tornado Watch": ("storm", "storm", WATCH_FLOOR),
    "Hurricane Warning": ("tropical", "storm", HURRICANE_FLOOR),
    "Tropical Storm Warning": ("tropical", "storm", WARNING_FLOOR),
    "Hurricane Watch": ("tropical", "storm", WATCH_FLOOR),
    "Tropical Storm Watch": ("tropical", "storm", WATCH_FLOOR),
    "Excessive Heat Warning": ("heat", "heat", WARNING_FLOOR),
    "Extreme Heat Warning": ("heat", "heat", WARNING_FLOOR),  # NWS renamed Excessive to Extreme in 2025
    "Excessive Heat Watch": ("heat", "heat", WATCH_FLOOR),
    "Extreme Heat Watch": ("heat", "heat", WATCH_FLOOR),
    "Heat Advisory": ("heat", "heat", WATCH_FLOOR),
    "Red Flag Warning": ("fire", "wildfire", WARNING_FLOOR),
    "Fire Weather Watch": ("fire", "wildfire", WATCH_FLOOR),
}
ADVISORIES = {"Flood Advisory", "Coastal Flood Advisory", "Heat Advisory"}  # today only
NWS_EVENTS = NWS_FLOORS.keys()
FLOOD_ALERT_FACTOR = "Flood-risk alert: heavy rain in flood-prone area"
# The API can't attach a factor to the crew-hazards card, and no HazardType fits an electrical
# hazard, so the downed-line factor has no hazard (null); conditions.crew_hazards shows the report.
DOWNED_LINE_HAZARD = None


@dataclass
class Component:
    source: str            # "model" | "rule"
    hazard: str | None     # the component's leading HazardType (None: a downed line)
    score: float           # 0-10
    factors: list[tuple[str, str, float]] = field(default_factory=list)  # (hazard, label, share of this component)
    urgent: bool = False   # an official warning or downed line: listed right after the stop-work
    listed: bool = False   # always listed as a factor, even below SHOW_RULES_FROM (chronic rules)


def _model_component(model: dict | None) -> Component | None:
    if not model:
        return None
    factors = [(f["hazard"], f["label"], f["weight"]) for f in model.get("factors") or []]
    return Component("model", factors[0][0] if factors else "storm", float(model["score"]), factors)


def _rule(hazard: str | None, score: float, label: str, urgent: bool = False) -> Component | None:
    return Component("rule", hazard, float(score), [(hazard, label, 1.0)], urgent) if score > 0 and label else None


def combine(components: list[Component | None], stop_work: bool) -> tuple[float, str, list[dict]]:
    """(hazard_index, top_hazard, top_factors) from model and rule components."""
    comps = sorted((c for c in components if c is not None), key=lambda c: -c.score)  # stable: model first on ties
    winner = comps[0] if comps else None
    index = winner.score if winner else 0.0
    if stop_work:
        index = max(index, STOP_WORK_MIN)
    shown = [c for c in comps if c.score > 0 and (c is winner or c.score >= SHOW_RULES_FROM or c.listed)]
    shown.sort(key=lambda c: not c.urgent)  # stable: urgent first, then winner first by score
    total = sum(c.score for c in shown) + (STOP_WORK_MIN if stop_work else 0.0)
    factors = [{"hazard": h, "label": label, "weight": c.score / total * share, "source": c.source}
               for c in shown for h, label, share in sorted(c.factors, key=lambda f: -f[2])]
    if stop_work:
        factors.insert(0, {"hazard": "lightning", "label": STOP_WORK_FACTOR, "weight": STOP_WORK_MIN / total,
                           "source": "rule"})
    factors = factors[:MAX_FACTORS]
    for f in factors:  # floor, so the weights never sum past 1
        f["weight"] = math.floor(f["weight"] * 100) / 100
    # top_hazard must be a HazardType: the first factor that has one (a downed line has none).
    top = next((f["hazard"] for f in factors if f["hazard"]), None) or next(
        (c.hazard for c in comps if c.hazard and c.score > 0), "heat")
    return round(min(index, 10.0), 1), top, factors


# ---------- floors ----------

def _clock(dt: datetime, tz: ZoneInfo, day: date) -> str:
    """'4:30 PM' or '4 PM' on `day`; 'Sat 4 PM' on another day."""
    local = dt.astimezone(tz)
    text = local.strftime("%I %p" if local.minute == 0 else "%I:%M %p").lstrip("0")
    return text if local.date() == day else f"{local.strftime('%a')} {text}"


def _in_effect(alert: dict, start: datetime, end: datetime) -> bool:
    """The alert's period overlaps [start, end). No onset = already in effect; no end = open-ended."""
    onset, ends = alert.get("onset"), alert.get("ends_at")
    return (onset is None or onset < end) and (ends is None or ends > start)


def nws_floors(inp: Inputs, day: date, start: datetime, end: datetime, advisories: bool) -> list[Component]:
    """One floor per alert family: the most severe NWS alert in effect between start and end."""
    tz = ZoneInfo(inp.site["timezone"])
    best: dict[str, tuple[float, str, str]] = {}   # family -> (floor, hazard, label)
    for a in inp.nws:
        event = a["event"]
        if event not in NWS_FLOORS or (event in ADVISORIES and not advisories) or not _in_effect(a, start, end):
            continue
        family, hazard, floor = NWS_FLOORS[event]
        until = f" until {_clock(a['ends_at'], tz, day)}" if a.get("ends_at") else ""
        if floor > best.get(family, (0.0, "", ""))[0]:
            best[family] = (floor, hazard, f"NWS {event}{until}")
    return [_rule(h, floor, label, urgent=floor >= WARNING_FLOOR) for floor, h, label in best.values()]


def today_floors(inp: Inputs, now: datetime, today: date) -> list[Component | None]:
    tz = ZoneInfo(inp.site["timezone"])
    midnight = datetime.combine(today + timedelta(days=1), time(0), tz)
    floors: list[Component | None] = nws_floors(inp, today, now, midnight, advisories=True)
    if inp.flood_alert and not any(c.hazard == "flood" and c.score >= WATCH_FLOOR for c in floors if c):
        floors.append(_rule("flood", WATCH_FLOOR, FLOOD_ALERT_FACTOR))
    downed = next((r for r in inp.crew_reports if r["category"] == "downed_line"), None)  # newest first
    if downed:
        floors.append(_rule(DOWNED_LINE_HAZARD, WARNING_FLOOR, f"Crew report: downed line, {ago(downed['created_at'], now)}",
                            urgent=True))
    return floors


def tomorrow_floors(inp: Inputs, tomorrow: date) -> list[Component]:
    """Watches and warnings in effect at any point tomorrow (advisories don't carry over)."""
    tz = ZoneInfo(inp.site["timezone"])
    start = datetime.combine(tomorrow, time(0), tz)
    return nws_floors(inp, tomorrow, start, start + timedelta(days=1), advisories=False)


# ---------- index ----------

def _rule_part(rules: dict, hazard: str, when: str) -> Component | None:
    """A card rule's sub-score. NWS alerts count only through the floors, so a rule whose factor is
    just the NWS event (e.g. the wildfire rule's "Red Flag Warning") isn't listed twice."""
    label = rules[hazard][f"label_{when}"]
    if label in NWS_EVENTS:
        return None
    part = _rule(hazard, rules[hazard][when], label)
    if part and rules[hazard].get("chronic"):
        part.score, part.listed = min(part.score, CHRONIC_MAX), True
    return part


_MODEL_RAIN = re.compile(r"^(\d+(?:\.\d+)?) in of rain forecast$")


def _nws_checked(model: dict | None, nws: float | None) -> dict | None:
    """The model part with its rain factor's label following the same rule as every rain forecast in text
    (scoring.rain_text): a range and "(forecasts disagree)" when the model's rain and NWS disagree."""
    if not model or nws is None:
        return model
    factors = []
    for f in model.get("factors") or []:
        m = _MODEL_RAIN.match(f.get("label", "")) if f.get("factor") == "rain_in" else None
        factors.append({**f, "label": rain_text(float(m.group(1)), nws, "of rain forecast")} if m else f)
    return {**model, "factors": factors}


def local_days(inputs: Inputs) -> tuple[str, str]:
    """Today's and tomorrow's site-local dates (ISO). Live data, so real time, not the replay clock."""
    now = inputs.now or datetime.now(timezone.utc)
    today = now.astimezone(ZoneInfo(inputs.site["timezone"])).date()
    return today.isoformat(), (today + timedelta(days=1)).isoformat()


def predict(inputs: Inputs, species_counts: dict[str, int]) -> dict:
    scored = score_site(inputs, species_counts)
    rules, crew = scored["rules"], scored["crew"]
    now = inputs.now or datetime.now(timezone.utc)
    today, tomorrow = local_days(inputs)
    model_today = _nws_checked(inputs.model.get(today), nws_rain(inputs, "today"))
    model_tomorrow = _nws_checked(inputs.model.get(tomorrow), nws_rain(inputs, "tomorrow"))

    index_today, top_today, factors_today = combine(
        [_model_component(model_today)]
        + [_rule_part(rules, h, "today") for h in ("heat", "wildfire", "wildlife")]
        + [_rule(c["hazard"], c["score"], c["label"]) for c in crew]
        + today_floors(inputs, now, date.fromisoformat(today)),
        stop_work=inputs.lightning_alert is not None)
    index_tomorrow, top_tomorrow, factors_tomorrow = combine(
        [_model_component(model_tomorrow)]
        + [_rule_part(rules, h, "tomorrow") for h in ("heat", "wildfire", "wildlife")]
        + tomorrow_floors(inputs, date.fromisoformat(tomorrow)),
        stop_work=False)
    return {"cards": scored["cards"],
            "hazard_index_today": index_today, "top_hazard": top_today, "top_factors": factors_today,
            "hazard_index_tomorrow": index_tomorrow, "top_hazard_tomorrow": top_tomorrow,
            "top_factors_tomorrow": factors_tomorrow,
            "model_today": model_today, "model_tomorrow": model_tomorrow}
