"""Turns a briefing's input JSON into the crew supervisor's text.

A model writes a headline, the top 3 risks with times, and concrete actions, as structured JSON,
from the input JSON only. Every answer is checked: every number in it must appear in the input
JSON, hazard words must match it (no "saturated" soil that is only moist, no NWS alert that isn't
in effect, no thunderstorms at 0% chance), and the whole briefing must be under 150 words. An
answer that passes those checks is then reread against the same JSON by a second model
(CLAUDE_REVIEW_MODEL, default claude-haiku-5-5), which flags contradictory, garbled or wrongly
labeled statements (e.g. a time attached to the wrong event). A rejected answer gets one retry with
the problems listed. Writers, in order:

  1. Claude (CLAUDE_MODEL, default claude-sonnet-5-5), if ANTHROPIC_API_KEY is set;
  2. Gemini (GEMINI_MODEL, default gemini-3.8-flash), if GEMINI_API_KEY is set and its free-tier
     quota isn't used up;
  3. a template built from the same JSON (always grounded by construction).

Each writer is used when the one before it is not configured, fails, or is rejected twice. But
once the reviewer has flagged a writer's answer and the retry doesn't pass, the briefing goes
straight to the template. The briefing records which one wrote it (`generator`) and the model that
answered (`model`).

The go / caution / no-go decision is never the writer's: it comes from the input (briefing/inputs.py).
"""

import json
import logging
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from functools import lru_cache

import anthropic

from app.config import get_settings

log = logging.getLogger(__name__)

GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
MAX_WORDS = 150
HEADLINE_WORD = {"go": "GO", "caution": "CAUTION", "no_go": "NO-GO"}
_NUMBER = re.compile(r"\d{1,2}:\d{2}|\d+(?:\.\d+)?")

SYSTEM = f"""You write next-day safety briefings for utility field crew supervisors in Florida.
Use ONLY the facts in the JSON you are given. Never add a hazard, number, time, place or
distance that is not in the JSON, and copy every number and time exactly as it is written there
(for example "2 PM", "0.25", "6:52 AM"). Skip anything that is null, empty, or "unavailable".
Don't mention a hazard the JSON doesn't have, even to say it won't happen: write "dry", not
"no thunderstorms"; "moist ground", not "not saturated".
Return JSON with:
- "headline": one sentence about the day; do not repeat the go/no-go word, it is added for you.
- "risks": the 3 most important risks, most important first, each with when it happens.
- "actions": 2 or 3 concrete, plain-language actions tied to those risks, e.g. when to start and
  finish heavy work, expecting lightning stops (use the rules in the JSON), bringing mats for
  vehicles on wet ground, checking for snakes or alligators before staging.
Crew reports in "crew_reports_last_48_h_within_2_mi" are what crews saw on site: always mention a
downed line or heat illness among the risks, with how long ago it was reported, and give the
matching action (stay clear of the line and treat it as energized; check on the crew, water, shade
and rest). The go / caution / no-go word is decided for you from "hard_stops" (named reasons to stop
work during "work_hours"): if "hard_stops" is not empty, the headline must name the first one with its
time, e.g. "Flood Warning 7 AM-3 PM". Lead with the main hazard during work hours; for a hazard outside
work hours (e.g. rain mostly after work), give a plan-ahead action, not a stop. If there is little risk,
say so plainly instead of inventing risks. The whole briefing must be
under {MAX_WORDS} words, so aim for about 110: the headline and each risk and action under 20 words."""

# Gemini's schema dialect (upper-case types).
GEMINI_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "headline": {"type": "STRING"},
        "risks": {"type": "ARRAY", "items": {"type": "STRING"}},
        "actions": {"type": "ARRAY", "items": {"type": "STRING"}},
    },
    "required": ["headline", "risks", "actions"],
}

# Claude structured output (JSON Schema; every object needs additionalProperties false).
CLAUDE_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "risks": {"type": "array", "items": {"type": "string"}},
        "actions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["headline", "risks", "actions"],
    "additionalProperties": False,
}


@dataclass
class Written:
    headline: str
    risks: list[str]
    actions: list[str]
    text: str
    generator: str          # "claude" | "gemini" | "template"
    model: str | None       # the model that answered; None for the template


# ---------- grounding ----------

def _numbers(text: str) -> set[str]:
    out = set()
    for token in _NUMBER.findall(text):
        out.add(token[:-3] if token.endswith(":00") else token)   # "2:00" == "2"
        if "." in token:
            out.add(token.rstrip("0").rstrip("."))                 # "0.50" == "0.5"
    return out


def ungrounded_numbers(text: str, inputs: dict) -> list[str]:
    """Numbers (and clock times) in `text` that don't appear anywhere in the input JSON."""
    allowed = _numbers(json.dumps(inputs))
    return sorted(n for n in _numbers(text) if n not in allowed)


def compose(go_status: str, day: str, headline: str, risks: list[str], actions: list[str], max_risks: int = 3) -> str:
    lines = [f"{HEADLINE_WORD[go_status]} for {day}: {headline.strip()}"]
    if risks:
        lines += ["Top risks:"] + [f"- {r.strip()}" for r in risks[:max_risks]]
    if actions:
        lines += ["Actions:"] + [f"- {a.strip()}" for a in actions[:4]]
    return "\n".join(lines)


NWS_EVENT_WORDS = ["flood warning", "flash flood warning", "flood watch", "flash flood watch", "flood advisory",
                   "heat advisory", "excessive heat warning", "extreme heat warning", "red flag warning",
                   "fire weather watch", "severe thunderstorm warning", "severe thunderstorm watch", "tornado warning"]


def unsupported_claims(text: str, inputs: dict) -> list[str]:
    """Hazard words the input doesn't support (numbers are checked separately). Catches e.g.
    "saturated soil" when the soil is only moist, or a Flood Warning that isn't in effect."""
    lowered = text.lower()
    claims = []
    soil = (inputs.get("soil") or {}).get("level")
    expected = any("saturated" in f["label"].lower() for f in inputs.get("top_factors") or [])  # e.g. "Saturated soil expected"
    if "saturated" in lowered and soil != "saturated" and not expected:
        claims.append(f"'saturated' (soil is {soil or 'unknown'})")
    events = {a["event"].lower() for a in inputs.get("nws_alerts") or []}
    for phrase in NWS_EVENT_WORDS:
        if phrase in lowered and phrase not in events and not any(phrase in e for e in events):
            claims.append(f"'{phrase}' (no such NWS alert)")
    storm_chance = max([p.get("thunderstorm_chance_pct") or 0 for p in inputs.get("periods", [])] + [0])
    if "thunderstorm" in lowered and storm_chance == 0 and not any("thunderstorm" in e for e in events):
        claims.append("'thunderstorm' (0% thunderstorm chance)")
    crew = {r["category"] for r in inputs.get("crew_reports_last_48_h_within_2_mi") or []}
    if ("downed line" in lowered or "line down" in lowered) and "Downed line" not in crew:
        claims.append("'downed line' (no crew report of one)")
    band = ((inputs.get("heat") or {}).get("osha_risk_band") or "")
    if ("very high" in lowered or "extreme" in lowered) and band != "very high" and not any("extreme" in e for e in events):
        claims.append(f"'very high'/'extreme' heat (OSHA band is {band or 'unknown'})")
    return claims


def problems(text: str, inputs: dict) -> list[str]:
    issues = []
    stops = inputs.get("hard_stops") or []
    if stops and stops[0]["name"].lower() not in text.lower():
        issues.append(f"a NO-GO must name its hard stop in the headline: {stops[0]['text']}")
    if (bad := ungrounded_numbers(text, inputs)):
        issues.append(f"these numbers are not in the JSON: {', '.join(bad)}")
    if (claims := unsupported_claims(text, inputs)):
        issues.append(f"these hazards are not in the JSON: {'; '.join(claims)}")
    if (words := len(text.split())) >= MAX_WORDS:
        issues.append(f"{words} words; must be under {MAX_WORDS}, so cut at least {words - MAX_WORDS + 15} words")
    return issues


# ---------- template ----------
#
# Every risk line comes from a reading in the input JSON that crosses a threshold (RISK_CHECKS); a model
# factor never creates a risk line by itself. The verdict's main factor is the risk line behind it.

RAIN_THRESHOLD_IN = 0.25           # the flood line: rain expected tomorrow
GUST_THRESHOLD_MPH = 30            # the wind line: peak gust during work hours
SEVERE_WEATHER = "Higher than normal chance of severe weather"
SEVERE_WEATHER_ACTION = "Check radar before starting and be ready to stop work."
# A forecast plans the day; a stop-work order only ever comes from the live lightning engine.
THUNDERSTORM_ACTION = ("Thunderstorms are likely during work hours. Plan shelter in a vehicle or building and "
                       "schedule exposed work early.")
LOCATION_LABEL = "Area with frequent past severe-weather reports"
RAIN_PLAN_AHEAD = ("Most of the rain falls outside work hours: secure tools and materials before you leave, "
                   "and expect soft ground and standing water the next morning.")
NO_RISKS = {True: "No significant weather or site hazards in the forecast.",    # GO
            False: "No reading crosses a hazard threshold on its own."}         # CAUTION / NO-GO from the model
NWS_ACTION = {   # an NWS alert with no reading of its own gets its hazard's usual action
    "flood": "Stay off low ground and out of standing water; don't drive through flooded roads.",
    "heat": "Schedule water and shade breaks through the afternoon.",
    "storm": "Check radar before starting and be ready to stop work.",
    "wildfire": "Check where the fire is and which way the smoke is moving before staging; keep an escape route "
                "clear and stop work if smoke or flames reach the site.",
}
CREW_HAZARD = {"Downed line": None, "Heat illness": "heat", "Flooding or washout": "flood", "Unsafe ground": "soil_saturation",
               "Fire or smoke": "wildfire", "Wildlife": "wildlife", "Other": None}


def _band(index: float) -> str:
    return "no_go" if index >= 7 else "caution" if index >= 4 else "go"


def nws_hazard(event: str) -> str:
    """The hazard an NWS event belongs to (briefings only list flood, heat, storm and fire alerts)."""
    lowered = event.lower()
    if "heat" in lowered:
        return "heat"
    if "flood" in lowered:
        return "flood"
    if "fire" in lowered or "red flag" in lowered:
        return "wildfire"
    return "storm"   # thunderstorm, tornado, tropical storm, hurricane


@dataclass
class Risk:
    check: str            # the threshold check behind the line (RISK_CHECKS)
    hazard: str | None    # HazardType it answers for (matched against the index's factors)
    text: str             # the risk line
    short: str            # the same fact as a short headline phrase ("heat peaks at 94°F around 1 PM")
    action: str | None
    work_hours: bool = True   # False: the hazard falls outside work hours (plan ahead, not a stop)


def _crew_category(report: dict) -> str:
    return next((c for c in CREW_HAZARD if report["category"].startswith(c)), "Other")


def threshold_risks(inputs: dict) -> list[Risk]:
    """Every risk the input JSON supports, one per reading that crosses its threshold, in priority order:
    crew reports of a downed line or heat illness, other crew reports, then the hazards."""
    heat, soil, wild, wind = inputs.get("heat"), inputs.get("soil"), inputs["wildlife"], inputs.get("wind")
    crew, hazards = [], []
    for report in inputs.get("crew_reports_last_48_h_within_2_mi") or []:
        category = _crew_category(report)
        what = report["category"][0].lower() + report["category"][1:]
        what = "a downed line" if category == "Downed line" else what
        text = f"Crew reported {what} {report['distance_mi']} mi away, reported {report['reported']}."
        action = {"Downed line": "Stay clear of the reported downed line and treat it as energized until it is confirmed safe.",
                  "Heat illness": "Check on every crew member; enforce water, shade and rest breaks from the start of the shift."}.get(category)
        crew.append((category in ("Downed line", "Heat illness"),
                     Risk("crew", CREW_HAZARD[category], text, f"crew reported {what} {report['reported']}", action)))

    if inputs.get("thunderstorms_likely_from"):
        t, pct = inputs["thunderstorms_likely_from"], inputs["thunderstorm_chance_work_hours_pct"]
        hazards.append(Risk("thunderstorms", "storm", f"Thunderstorms likely from {t} ({pct}% chance during work hours).",
                            f"thunderstorms likely from {t}", THUNDERSTORM_ACTION))
    if inputs["rain_total_in"] >= RAIN_THRESHOLD_IN:
        wettest = max(inputs["periods"], key=lambda p: p["rain_in"])
        # Mostly outside work hours (e.g. 6 PM-12 AM): plan ahead, it isn't a work-hours hazard.
        outside = inputs.get("rain_work_hours_in", inputs["rain_total_in"]) < RAIN_THRESHOLD_IN
        hazards.append(Risk("rain", "flood", f"{inputs['rain_total_in']} in of rain expected, most in the {wettest['period']} "
                                             f"({wettest['hours']}, {wettest['rain_chance_pct']}% chance).",
                            f"{inputs['rain_total_in']} in of rain, mostly {wettest['hours']}",
                            RAIN_PLAN_AHEAD if outside else
                            "Stay off low ground and out of standing water; don't drive through flooded roads.",
                            work_hours=not outside))
    if wind and wind["max_gust_mph"] >= GUST_THRESHOLD_MPH:
        hazards.append(Risk("gusts", "storm", f"Wind gusts up to {wind['max_gust_mph']} mph around {wind['peak_time']}.",
                            f"gusts to {wind['max_gust_mph']} mph around {wind['peak_time']}",
                            "Stop aerial lift and bucket work if gusts exceed the equipment's rated limit; secure loose materials."))
    if heat and heat["osha_risk_band"] != "lower":
        window = heat["heat_index_91_or_higher"]
        when = f"from {window['from']} to {window['until']}" if window else f"around {heat['peak_time']}"
        action = (f"Start at {inputs['daylight']['sunrise']} and finish heavy work before {window['from']}; schedule water and shade breaks."
                  if window and (inputs.get("daylight") or {}).get("sunrise") else "Schedule water and shade breaks through the afternoon.")
        hazards.append(Risk("heat", "heat", f"Heat index peaks at {heat['peak_heat_index_f']}°F around {heat['peak_time']} "
                                            f"(OSHA {heat['osha_risk_band']} risk), 91°F or higher {when}.",
                            f"heat peaks at {heat['peak_heat_index_f']}°F around {heat['peak_time']}", action))
    if soil and soil["level"] in ("moist", "saturated"):
        hazards.append(Risk("soil", "soil_saturation", f"{soil['crew_note']} (soil moisture {soil['moisture_pct']}%).",
                            "saturated ground" if soil["level"] == "saturated" else "soft, wet ground",
                            "Bring mats for vehicles and stay on pavement or gravel where you can."))
    fires = (inputs.get("wildfire") or {}).get("detections_within_25_mi")
    if isinstance(fires, int) and fires > 0:
        near_mi = (inputs.get("wildfire") or {}).get("nearest_detection_mi")
        near = f"Fire detected {near_mi} mi away" if near_mi is not None else \
            next((f["label"] for f in inputs["top_factors"] if f["label"].startswith("Fire detected")), None)
        text = f"{near}; {fires} fire detection(s) within 25 mi in the last day." if near else \
            f"{fires} fire detection(s) within 25 mi in the last day."
        hazards.append(Risk("fire", "wildfire", text, near[0].lower() + near[1:] if near else f"{fires} fire detection(s) within 25 mi",
                            "Check where the fire is and which way the smoke is moving before staging; keep an escape route "
                            "clear and stop work if smoke or flames reach the site."))
    if wild["sightings_last_30_days"] or wild["crew_reports_within_2_mi_last_30_days"]:
        seen = ", ".join(f"{s['species']} ({s['count']})" for s in wild["sightings_last_30_days"])
        crew_n = wild["crew_reports_within_2_mi_last_30_days"]
        text = (f"Wildlife seen nearby in the last 30 days: {seen}." if seen else "") + \
            (f" {crew_n} crew wildlife report(s) within 2 mi." if crew_n else "")
        hazards.append(Risk("wildlife", "wildlife", text.strip(), "wildlife seen nearby",
                            "Walk the work area before staging and watch for snakes and alligators near water and brush."))
    # NWS alerts join their hazard's line (a Heat Advisory with the heat risk), or are their own line.
    for alert in inputs["nws_alerts"]:
        hazard, note = nws_hazard(alert["event"]), f"NWS {alert['event']} in effect until {alert['until']}"
        same = next((r for r in hazards if r.hazard == hazard), None)
        if same:
            same.text, same.check = f"{same.text[:-1]}; {note}.", same.check + "+nws"
        else:
            hazards.append(Risk("nws", hazard, f"{note}.", f"NWS {alert['event']} until {alert['until']}",
                                NWS_ACTION.get(hazard, f"Follow the NWS {alert['event']} and recheck it before each shift.")))
    first = [r for urgent, r in crew if urgent]
    return first + [r for urgent, r in crew if not urgent] + hazards


def _hard_stop_risk(stop: dict, risks: list[Risk]) -> Risk:
    """The risk line behind a hard stop, with the hard stop as its headline phrase."""
    kind, name = stop["kind"], stop["name"]
    if kind == "heat":
        match = next((r for r in risks if r.check.startswith("heat")), None)
    elif kind == "fire":
        match = next((r for r in risks if r.check == "fire"), None)
    elif kind == "crew":
        what = "a downed line" if name == "downed line" else "flooding"
        match = next((r for r in risks if r.check == "crew" and what in r.short), None)
    else:
        match = next((r for r in risks if "nws" in r.check and r.hazard == nws_hazard(name)), None)
    if match is None:
        return Risk("hardstop", None, f"{stop['text']}.", stop["text"], SEVERE_WEATHER_ACTION)
    return Risk(match.check, match.hazard, match.text, stop["text"], match.action)


def verdict_lead(inputs: dict, risks: list[Risk]) -> Risk | None:
    """The risk behind the go / caution / no-go decision (briefing/inputs.go_status). NO-GO: the first hard
    stop, named. CAUTION: what raised it (heat illness report, NWS watch or warning, likely thunderstorms),
    else the index's own drivers, preferring a work-hours hazard over one outside work hours, else a
    model-only risk. None on a GO with no risks."""
    go = inputs["go_status"]
    if go == "no_go" and inputs.get("hard_stops"):
        return _hard_stop_risk(inputs["hard_stops"][0], risks)
    if go != "go" and _band(inputs["hazard_index"]) == "go":   # a green index raised to caution
        for r in risks:
            if r.check == "crew" and r.short.startswith("crew reported heat illness"):
                return r
        for alert in inputs["nws_alerts"]:
            if "Watch" in alert["event"] or "Warning" in alert["event"]:
                return next(r for r in risks if r.hazard == nws_hazard(alert["event"]) and "nws" in r.check)
        if inputs.get("thunderstorms_likely_from"):
            return next(r for r in risks if r.check == "thunderstorms")
    matches = []
    for f in inputs["top_factors"]:                            # the index's own drivers, in order
        label = f["label"]
        if label == LOCATION_LABEL or label.startswith(("Peak storm season", "Time of year")):
            continue                                           # context, not a hazard
        if label.startswith("Crew report"):               # "Crew report: Flooding or washout"
            category = label.split(": ", 1)[-1].split(",")[0].lower()
            match = next((r for r in risks if r.check == "crew" and category in r.short), None)
        elif label.startswith("NWS"):
            match = next((r for r in risks if "nws" in r.check and r.hazard == f["hazard"]), None)
        else:
            match = next((r for r in risks if r.hazard == f["hazard"] and r.check != "crew"), None)
        if match:
            matches.append(match)
    if matches:
        return next((m for m in matches if m.work_hours), matches[0])
    if go != "go":
        return Risk("model", None, f"{SEVERE_WEATHER}.", SEVERE_WEATHER, SEVERE_WEATHER_ACTION)
    return next((r for r in risks if r.work_hours), risks[0] if risks else None)


def template(inputs: dict) -> Written:
    """Briefing built only from the input JSON (every number is copied from it).

    Risk lines come only from readings that cross a threshold (threshold_risks); a model factor never
    adds one. The verdict's cause (verdict_lead) is the headline's main factor and its action comes first;
    crew reports of a downed line or heat illness still lead the risks, and every crew report gets a line.
    "Area with frequent past severe-weather reports" is context: one short sentence, no action.
    "Normal operations" only appears on a GO with nothing to act on."""
    go = inputs["go_status"]
    risks = threshold_risks(inputs)
    lead = verdict_lead(inputs, risks)
    crew = [r for r in risks if r.check == "crew"]
    urgent = [r for r in crew if r.action]
    def same(a: Risk, b: Risk | None) -> bool:
        return b is not None and a.text == b.text
    rest = [r for r in risks if r.check != "crew" and not same(r, lead)]
    order = urgent + ([lead] if lead and lead.check != "model" and not any(same(u, lead) for u in urgent) else []) + \
        [r for r in crew if r not in urgent and not same(r, lead)] + \
        [r for r in rest if r.work_hours] + [r for r in rest if not r.work_hours]
    shown = order[:max(3, len(crew) + (1 if lead and lead.check != "crew" else 0))]
    if lead and lead.check == "model" and len(shown) > 2 and not crew:
        shown = shown[:2]                                     # room for the severe-weather context

    actions: list[str] = []
    for r in urgent + ([lead] if lead and go != "go" else []) + shown:   # downed line / heat illness first
        if r.action and r.action not in actions:
            actions.append(r.action)
    actions = actions[:3]
    if not actions:
        actions = (["Normal operations; hold the standard tailboard safety briefing."] if go == "go"
                   else [SEVERE_WEATHER_ACTION])

    # A plain sentence that leads with the main work-hours hazard: "Heat peaks at 94°F around 1 PM; 2.3 in of
    # rain, mostly 6 PM-12 AM." NO-GO leads with its hard stop ("Flood Warning 7 AM-3 PM; ...").
    phrases = [lead.short] if lead else []
    second = next((r for r in shown if not same(r, lead) and not r.work_hours), None) or \
        next((r for r in shown if not same(r, lead)), None)
    if second and lead and lead.check != "model":
        phrases.append(second.short)
    sentence = "; ".join(phrases) if phrases else "low risk, no significant hazards in the forecast"
    headline = f"{sentence[0].upper()}{sentence[1:]}."
    if any(f["label"] == LOCATION_LABEL for f in inputs["top_factors"]):
        headline += " This area has frequent past severe-weather reports."
    top = [r.text for r in shown] or [NO_RISKS[go == "go"]]
    text = compose(go, inputs["day"], headline, top, actions, max_risks=len(top))
    return Written(headline, top, actions, text, "template", None)


def template_audit(inputs: dict) -> list[str]:
    """Risk lines in the template briefing with no threshold-crossing reading behind them (should be [])."""
    by_text = {r.text: r for r in threshold_risks(inputs)}
    wind, heat, soil = inputs.get("wind") or {}, inputs.get("heat") or {}, inputs.get("soil") or {}
    fires = (inputs.get("wildfire") or {}).get("detections_within_25_mi")
    wild = inputs["wildlife"]
    supported = {
        "crew": bool(inputs.get("crew_reports_last_48_h_within_2_mi")),
        "thunderstorms": bool(inputs.get("thunderstorms_likely_from")),
        "gusts": (wind.get("max_gust_mph") or 0) >= GUST_THRESHOLD_MPH,
        "heat": heat.get("osha_risk_band") not in (None, "lower"),
        "rain": inputs["rain_total_in"] >= RAIN_THRESHOLD_IN,
        "soil": soil.get("level") in ("moist", "saturated"),
        "fire": isinstance(fires, int) and fires > 0,
        "wildlife": bool(wild["sightings_last_30_days"] or wild["crew_reports_within_2_mi_last_30_days"]),
        "nws": bool(inputs["nws_alerts"]),
    }
    problems_found = []
    for line in template(inputs).risks:
        risk = by_text.get(line)
        if line in NO_RISKS.values():
            continue
        if risk is None or not all(supported.get(c, False) for c in risk.check.split("+")):
            problems_found.append(line)
    return problems_found


def _prompt(inputs: dict, feedback: str | None) -> str:
    prompt = json.dumps(inputs, ensure_ascii=False)
    if feedback:
        prompt += f"\n\nYour previous answer was rejected: {feedback}. Fix that and answer again."
    return prompt


def _parts(out: dict) -> tuple[str, list[str], list[str]]:
    return out["headline"], list(out["risks"])[:3], list(out["actions"])[:4]


def _checked(inputs: dict, out: dict, generator: str, model: str) -> tuple[Written | None, str | None, bool]:
    """(briefing, None, False) if it passes the grounding and word checks and then the review;
    otherwise (None, problems, flagged), where flagged means the reviewer rejected it."""
    headline, risks, actions = _parts(out)
    text = compose(inputs["go_status"], inputs["day"], headline, risks, actions)
    issues = problems(text, inputs)
    if issues:
        return None, "; ".join(issues), False
    if (flags := review(inputs, text)):
        return None, f"a reviewer found these statements wrong or garbled: {'; '.join(flags)}", True
    return Written(headline, risks, actions, text, generator, model), None, False


# A writer whose answer the reviewer flagged, and whose retry still didn't pass: use the template.
REVIEW_FAILED = object()


def _give_up(flagged: bool):
    return REVIEW_FAILED if flagged else None


# ---------- review (second check) ----------

REVIEW_SYSTEM = """You proofread a next-day safety briefing for a utility crew supervisor in Florida.
Another model wrote it from the JSON of facts you are given. A program has already checked that
every number in it appears somewhere in the JSON and that it names no hazard the JSON lacks.
Find statements a crew could misread or act on wrongly:
- a statement that contradicts the JSON (wrong period or day, wrong level, a risk called low when
  the JSON makes it high, or the reverse);
- a number or time attached to the wrong thing (e.g. the sunset time given as when rain starts, a
  PM time written as AM, one period's rain given as the whole day's);
- a garbled, self-contradictory or nonsensical sentence.
Don't flag: style, wording or tone; anything left out; rounding that keeps the meaning; the
GO / CAUTION / NO-GO word and the day at the start (set by the program); general safety advice that
states no fact (e.g. "bring water", "check for snakes before staging"); loose timing such as "all
day" or "through the shift" for a hazard the JSON doesn't time (wildlife, fires, flood zones, soil).
Return JSON {"problems": [...]}: one short entry per problem that quotes the words and says what is
wrong. Return an empty list when there is nothing to flag."""

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {"problems": {"type": "array", "items": {"type": "string"}}},
    "required": ["problems"],
    "additionalProperties": False,
}
REVIEW_EFFORT = "medium"


def _call_review(inputs: dict, text: str, key: str, model: str) -> list[str]:
    """The reviewer's problems with `text` ([] = none). Raises on API errors or a refusal."""
    response = _claude_client(key).messages.create(
        model=model,
        max_tokens=8000,
        system=REVIEW_SYSTEM,
        messages=[{"role": "user", "content": f"Input JSON:\n{json.dumps(inputs, ensure_ascii=False)}\n\nBriefing:\n{text}"}],
        output_config={"effort": REVIEW_EFFORT, "format": {"type": "json_schema", "schema": REVIEW_SCHEMA}},
    )
    if response.stop_reason != "end_turn":
        raise ValueError(f"review stop_reason {response.stop_reason}")
    answer = next(b.text for b in response.content if b.type == "text")
    return [p.strip() for p in json.loads(answer)["problems"] if p.strip()]


def review(inputs: dict, text: str) -> list[str]:
    """Statements in a briefing that contradict its input JSON, are garbled, or attach a number to the
    wrong thing. Skipped ([]) without ANTHROPIC_API_KEY or CLAUDE_REVIEW_MODEL, and if the review call
    fails: the briefing has already passed the number and word checks. Never raises."""
    settings = get_settings()
    if not settings.anthropic_api_key or not settings.claude_review_model:
        return []
    try:
        flags = _call_review(inputs, text, settings.anthropic_api_key, settings.claude_review_model)
    except Exception as err:  # noqa: BLE001 - API error, refusal, bad JSON: keep the checked briefing
        log.warning("Briefing review failed for %s (%s); using the briefing unreviewed",
                    inputs["site"]["name"], type(err).__name__)
        return []
    if flags:
        log.info("Briefing review flagged %s: %s", inputs["site"]["name"], "; ".join(flags))
    return flags


# ---------- Claude ----------

CLAUDE_TIMEOUT_SECONDS = 120
# Short structured writing from a small JSON: medium effort keeps calls fast; the grounding check
# (with one retry) catches what slips through.
CLAUDE_EFFORT = "medium"


class Refused(Exception):
    pass


@lru_cache
def _claude_client(key: str) -> anthropic.Anthropic:
    """One thread-safe client per key. The SDK retries 429, 5xx, overloads and connection errors
    twice with backoff (honouring retry-after) before raising."""
    return anthropic.Anthropic(api_key=key, timeout=CLAUDE_TIMEOUT_SECONDS, max_retries=2)


def _call_claude(inputs: dict, key: str, model: str, feedback: str | None) -> tuple[dict, str]:
    """(headline/risks/actions, the model that answered). The server-side fallback re-runs a
    request a safety classifier declines on Anthropic's recommended model for that category, so
    the answering model can differ from `model`."""
    response = _claude_client(key).beta.messages.create(
        model=model,
        max_tokens=16000,
        system=SYSTEM,
        messages=[{"role": "user", "content": _prompt(inputs, feedback)}],
        output_config={"effort": CLAUDE_EFFORT, "format": {"type": "json_schema", "schema": CLAUDE_SCHEMA}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    if response.stop_reason == "refusal":
        raise Refused(response.stop_details.category if response.stop_details else None)
    if response.stop_reason != "end_turn":
        raise ValueError(f"Claude stop_reason {response.stop_reason}")
    text = next(b.text for b in response.content if b.type == "text")
    return json.loads(text), response.model or model


def _try_claude(inputs: dict):
    """Claude's briefing if it passes the checks (one retry); REVIEW_FAILED if the reviewer flagged an
    answer and the retry didn't pass; else None (try the next writer). Never raises."""
    settings = get_settings()
    if not settings.anthropic_api_key:
        return None
    name, feedback, flagged = inputs["site"]["name"], None, False
    for attempt in range(2):
        try:
            out, model = _call_claude(inputs, settings.anthropic_api_key, settings.claude_model, feedback)
            written, feedback, was_flagged = _checked(inputs, out, "claude", model)
        except anthropic.APIStatusError as err:       # after the SDK's own retries
            log.warning("Claude HTTP %s for %s; trying the next writer", err.status_code, name)
            return _give_up(flagged)
        except anthropic.APIConnectionError as err:   # includes APITimeoutError
            log.warning("Claude unreachable for %s (%s); trying the next writer", name, type(err).__name__)
            return _give_up(flagged)
        except Refused as err:
            log.warning("Claude declined %s (%s); trying the next writer", name, err)
            return _give_up(flagged)
        except Exception as err:  # noqa: BLE001 - bad JSON, missing fields: next writer
            log.warning("Claude failed for %s (%s); trying the next writer", name, type(err).__name__)
            return _give_up(flagged)
        if written:
            return written
        flagged = flagged or was_flagged
        log.info("Claude briefing for %s rejected (%s)%s", name, feedback,
                 ", retrying" if attempt == 0 else "; using the template" if flagged else "; trying the next writer")
    return _give_up(flagged)


# ---------- Gemini ----------

def _call_gemini(inputs: dict, key: str, model: str, feedback: str | None) -> dict:
    prompt = _prompt(inputs, feedback)
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        # thinkingLevel "low" is the lowest gemini-3.8-flash accepts (verified: invalid values get a 400).
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": GEMINI_SCHEMA,
                             "temperature": 0.2, "maxOutputTokens": 4096,
                             "thinkingConfig": {"thinkingLevel": "low"}},
    }
    request = urllib.request.Request(
        GEMINI_API.format(model=model), data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "x-goog-api-key": key})
    with urllib.request.urlopen(request, timeout=GEMINI_TIMEOUT_SECONDS) as resp:
        data = json.load(resp)
    candidate = (data.get("candidates") or [{}])[0]
    if candidate.get("finishReason") not in (None, "STOP"):
        raise ValueError(f"Gemini finishReason {candidate.get('finishReason')}")
    text = "".join(p.get("text", "") for p in candidate.get("content", {}).get("parts", []) if not p.get("thought"))
    return json.loads(text)


_last_call = 0.0
_rate_lock = threading.Lock()
# A 429 asking us to wait longer than this means a quota is used up (the free tier's limit is per
# day): skip Gemini until then instead of failing every remaining site one by one.
QUOTA_PAUSE_AFTER_SECONDS = 60
_paused_until = 0.0   # time.monotonic()


def _retry_delay_seconds(err: urllib.error.HTTPError) -> float | None:
    """How long Gemini asks us to wait, from RetryInfo.retryDelay ("72675s") or the message
    ("Please retry in 20h11m15s"). None if it doesn't say."""
    try:
        error = json.loads(err.read() or b"{}").get("error", {})
    except (ValueError, OSError):
        return None
    for detail in error.get("details", []):
        if detail.get("@type", "").endswith("RetryInfo") and str(detail.get("retryDelay", "")).endswith("s"):
            try:
                return float(detail["retryDelay"][:-1])
            except ValueError:
                pass
    m = re.search(r"retry in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?", error.get("message", ""))
    if m and any(m.groups()):
        h, mi, s = (float(g) if g else 0.0 for g in m.groups())
        return h * 3600 + mi * 60 + s
    return None


def gemini_paused_seconds() -> float:
    """Seconds until Gemini is tried again after a used-up quota (0 when it isn't paused)."""
    return max(0.0, _paused_until - time.monotonic())
GEMINI_TIMEOUT_SECONDS = 150   # calls took 12-90 s in testing


def _wait_turn(min_interval: float) -> None:
    """Space out call starts (thread-safe: briefings are written concurrently)."""
    global _last_call
    with _rate_lock:
        wait = min_interval - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.monotonic()


def _try_gemini(inputs: dict):
    """Gemini's briefing if it passes the checks (one retry); REVIEW_FAILED or None otherwise (both
    mean the template). Never raises."""
    settings = get_settings()
    if not settings.gemini_api_key or gemini_paused_seconds() > 0:
        return None
    feedback, flagged = None, False
    for attempt in range(2):
        _wait_turn(settings.gemini_min_interval_seconds)  # stay under the per-minute rate limit
        try:
            out = _call_gemini(inputs, settings.gemini_api_key, settings.gemini_model, feedback)
            written, feedback, was_flagged = _checked(inputs, out, "gemini", settings.gemini_model)
        except urllib.error.HTTPError as err:
            if err.code == 429:
                delay = _retry_delay_seconds(err)
                if delay is not None and delay > QUOTA_PAUSE_AFTER_SECONDS:
                    global _paused_until
                    _paused_until = max(_paused_until, time.monotonic() + delay)
                    log.warning("Gemini quota used up; using the template for the next %.1f h", delay / 3600)
                    return None
                if attempt == 0:
                    time.sleep(delay if delay is not None else 10)   # short rate limit: wait it out once
                    continue
            log.warning("Gemini HTTP %s for %s; using the template", err.code, inputs["site"]["name"])
            return None
        except TimeoutError:
            if attempt == 0:
                log.info("Gemini timed out for %s; retrying once", inputs["site"]["name"])
                continue
            log.warning("Gemini timed out twice for %s; using the template", inputs["site"]["name"])
            return None
        except Exception as err:  # noqa: BLE001 - network, bad JSON, blocked output: fall back
            log.warning("Gemini failed for %s (%s); using the template", inputs["site"]["name"], type(err).__name__)
            return None
        if written:
            return written
        flagged = flagged or was_flagged
        log.info("Gemini briefing for %s rejected (%s)%s", inputs["site"]["name"], feedback,
                 ", retrying" if attempt == 0 else "; using the template")
    return _give_up(flagged)


def write(inputs: dict) -> Written:
    """Claude, then Gemini, then the template (see the module docstring). Never raises."""
    for writer in (_try_claude, _try_gemini):
        written = writer(inputs)
        if written is REVIEW_FAILED:
            return template(inputs)
        if written:
            return written
    return template(inputs)
