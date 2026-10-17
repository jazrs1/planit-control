"""Turns a briefing's input JSON into the crew supervisor's text.

  1. Gemini (GEMINI_MODEL, default gemini-3.8-flash) writes a headline, the top 3 risks with times,
     and concrete actions, as structured JSON, from the input JSON only.
  2. The result is checked: every number in it must appear in the input JSON, hazard words must
     match it (no "saturated" soil that is only moist, no NWS alert that isn't in effect, no
     thunderstorms at 0% chance), and the whole briefing must be under 150 words. One retry with the problems listed; then
  3. a template built from the same JSON (always grounded by construction) is used instead.
     The template is also used when GEMINI_API_KEY is missing or Gemini fails.

The go / caution / no-go decision is never the writer's: it comes from the input (briefing/inputs.py).
"""

import json
import logging
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

from app.config import get_settings

log = logging.getLogger(__name__)

API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
MAX_WORDS = 150
HEADLINE_WORD = {"go": "GO", "caution": "CAUTION", "no_go": "NO-GO"}
_NUMBER = re.compile(r"\d{1,2}:\d{2}|\d+(?:\.\d+)?")

SYSTEM = f"""You write next-day safety briefings for utility field crew supervisors in Florida.
Use ONLY the facts in the JSON you are given. Never add a hazard, number, time, place or
distance that is not in the JSON, and copy every number and time exactly as it is written there
(for example "2 PM", "0.25", "6:52 AM"). Skip anything that is null, empty, or "unavailable".
Return JSON with:
- "headline": one sentence about the day; do not repeat the go/no-go word, it is added for you.
- "risks": the 3 most important risks, most important first, each with when it happens.
- "actions": 2 to 4 concrete, plain-language actions tied to those risks, e.g. when to start and
  finish heavy work, expecting lightning stops (use the rules in the JSON), bringing mats for
  vehicles on wet ground, checking for snakes or alligators before staging.
If there is little risk, say so plainly instead of inventing risks. The whole briefing must be
under {MAX_WORDS} words."""

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "headline": {"type": "STRING"},
        "risks": {"type": "ARRAY", "items": {"type": "STRING"}},
        "actions": {"type": "ARRAY", "items": {"type": "STRING"}},
    },
    "required": ["headline", "risks", "actions"],
}


@dataclass
class Written:
    headline: str
    risks: list[str]
    actions: list[str]
    text: str
    generator: str          # "gemini" | "template"
    model: str | None


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


def compose(go_status: str, day: str, headline: str, risks: list[str], actions: list[str]) -> str:
    lines = [f"{HEADLINE_WORD[go_status]} for {day}: {headline.strip()}"]
    if risks:
        lines += ["Top risks:"] + [f"- {r.strip()}" for r in risks[:3]]
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
    if "saturated" in lowered and soil != "saturated":
        claims.append(f"'saturated' (soil is {soil or 'unknown'})")
    events = {a["event"].lower() for a in inputs.get("nws_alerts") or []}
    for phrase in NWS_EVENT_WORDS:
        if phrase in lowered and phrase not in events and not any(phrase in e for e in events):
            claims.append(f"'{phrase}' (no such NWS alert)")
    storm_chance = max([p.get("thunderstorm_chance_pct") or 0 for p in inputs.get("periods", [])] + [0])
    if "thunderstorm" in lowered and storm_chance == 0 and not any("thunderstorm" in e for e in events):
        claims.append("'thunderstorm' (0% thunderstorm chance)")
    band = ((inputs.get("heat") or {}).get("osha_risk_band") or "")
    if ("very high" in lowered or "extreme" in lowered) and band != "very high":
        claims.append(f"'very high'/'extreme' heat (OSHA band is {band or 'unknown'})")
    return claims


def problems(text: str, inputs: dict) -> list[str]:
    issues = []
    if (bad := ungrounded_numbers(text, inputs)):
        issues.append(f"these numbers are not in the JSON: {', '.join(bad)}")
    if (claims := unsupported_claims(text, inputs)):
        issues.append(f"these hazards are not in the JSON: {'; '.join(claims)}")
    if (words := len(text.split())) >= MAX_WORDS:
        issues.append(f"{words} words; must be under {MAX_WORDS}")
    return issues


# ---------- template ----------

def template(inputs: dict) -> Written:
    """Briefing built only from the input JSON (every number is copied from it)."""
    heat, soil, wild = inputs.get("heat"), inputs.get("soil"), inputs["wildlife"]
    periods = {p["period"]: p for p in inputs["periods"]}
    rules = inputs["rules"]
    risks: list[tuple[int, str]] = []          # (priority, text)
    actions: list[str] = []
    priority = {f["hazard"]: i for i, f in enumerate(inputs["top_factors"])}

    for alert in inputs["nws_alerts"]:
        risks.append((-1, f"NWS {alert['event']} in effect until {alert['until']}."))
    if inputs.get("thunderstorms_likely_from"):
        pct = inputs["thunderstorm_chance_work_hours_pct"]
        risks.append((priority.get("lightning", 0), f"Thunderstorms likely from {inputs['thunderstorms_likely_from']} ({pct}% chance during work hours)."))
        actions.append(f"Expect lightning stops after {inputs['thunderstorms_likely_from']}: stop work for strikes within "
                       f"{rules['lightning_stop_work_radius_mi']} mi and wait {rules['lightning_all_clear_wait_min']} min after the last one.")
    if heat and heat["osha_risk_band"] != "lower":
        window = heat["heat_index_91_or_higher"]
        when = f"from {window['from']} to {window['until']}" if window else f"around {heat['peak_time']}"
        risks.append((priority.get("heat", 5), f"Heat index peaks at {heat['peak_heat_index_f']}°F around {heat['peak_time']} "
                                               f"(OSHA {heat['osha_risk_band']} risk), 91°F or higher {when}."))
        if window and inputs.get("daylight", {}).get("sunrise"):
            actions.append(f"Start at {inputs['daylight']['sunrise']} and finish heavy work before {window['from']}; schedule water and shade breaks.")
        else:
            actions.append("Schedule water and shade breaks through the afternoon.")
    wettest = max(inputs["periods"], key=lambda p: p["rain_in"])
    if inputs["rain_total_in"] >= 0.25:
        risks.append((priority.get("flood", 5), f"{inputs['rain_total_in']} in of rain expected, most in the {wettest['period']} "
                                                f"({wettest['hours']}, {wettest['rain_chance_pct']}% chance)."))
    if soil and soil["level"] != "dry":
        risks.append((priority.get("soil_saturation", 6), f"{soil['crew_note']} (soil moisture {soil['moisture_pct']}%)."))
        if soil["level"] == "saturated" or inputs["rain_total_in"] >= 0.5:
            actions.append("Bring mats for vehicles and stay on pavement or gravel where you can.")
    if wild["sightings_last_30_days"] or wild["crew_reports_within_2_mi_last_30_days"]:
        seen = ", ".join(f"{s['species']} ({s['count']})" for s in wild["sightings_last_30_days"])
        crew = wild["crew_reports_within_2_mi_last_30_days"]
        text = f"Wildlife seen nearby in the last 30 days: {seen}." if seen else ""
        text += f" {crew} crew wildlife report(s) within 2 mi." if crew else ""
        risks.append((priority.get("wildlife", 7), text.strip()))
        actions.append("Walk the work area before staging and watch for snakes and alligators near water and brush.")

    risks.sort(key=lambda r: r[0])
    top = [r for _, r in risks[:3]]
    if not top:
        top = ["No significant weather or site hazards in the forecast."]
    if not actions:
        actions = ["Normal operations; hold the standard tailboard safety briefing."]
    factor = inputs["top_factors"][0]["label"] if inputs["top_factors"] else "low overall risk"
    headline = f"hazard index {inputs['hazard_index']} of 10; main factor: {factor}."
    text = compose(inputs["go_status"], inputs["day"], headline, top, actions[:3])
    return Written(headline, top, actions[:3], text, "template", None)


# ---------- Gemini ----------

def _call_gemini(inputs: dict, key: str, model: str, feedback: str | None) -> dict:
    prompt = json.dumps(inputs, ensure_ascii=False)
    if feedback:
        prompt += f"\n\nYour previous answer was rejected: {feedback}. Fix that and answer again."
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": SCHEMA,
                             "temperature": 0.2, "maxOutputTokens": 4096},
    }
    request = urllib.request.Request(
        API.format(model=model), data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "x-goog-api-key": key})
    with urllib.request.urlopen(request, timeout=60) as resp:
        data = json.load(resp)
    candidate = (data.get("candidates") or [{}])[0]
    if candidate.get("finishReason") not in (None, "STOP"):
        raise ValueError(f"Gemini finishReason {candidate.get('finishReason')}")
    text = "".join(p.get("text", "") for p in candidate.get("content", {}).get("parts", []) if not p.get("thought"))
    return json.loads(text)


_last_call = 0.0


def write(inputs: dict) -> Written:
    """Gemini if configured and grounded, else the template. Never raises."""
    settings = get_settings()
    if not settings.gemini_api_key:
        return template(inputs)
    global _last_call
    feedback = None
    for attempt in range(2):
        wait = settings.gemini_min_interval_seconds - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)  # stay under the API's per-minute rate limit
        _last_call = time.monotonic()
        try:
            out = _call_gemini(inputs, settings.gemini_api_key, settings.gemini_model, feedback)
            headline, risks, actions = out["headline"], list(out["risks"])[:3], list(out["actions"])[:4]
        except urllib.error.HTTPError as err:
            log.warning("Gemini HTTP %s for %s; using template", err.code, inputs["site"]["name"])
            if err.code == 429 and attempt == 0:
                time.sleep(10)
                continue
            return template(inputs)
        except Exception as err:  # noqa: BLE001 - network, bad JSON, blocked output: fall back
            log.warning("Gemini failed for %s (%s); using template", inputs["site"]["name"], type(err).__name__)
            return template(inputs)
        text = compose(inputs["go_status"], inputs["day"], headline, risks, actions)
        issues = problems(text, inputs)
        if not issues:
            return Written(headline, risks, actions, text, "gemini", settings.gemini_model)
        feedback = "; ".join(issues)
        log.info("Gemini briefing for %s rejected (%s)%s", inputs["site"]["name"], feedback,
                 ", retrying" if attempt == 0 else "; using template")
    return template(inputs)
