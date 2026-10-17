"""Briefing writer: grounding check, template, go/no-go rule, Claude -> Gemini -> template, 6 PM timing."""

import copy
import json
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from briefing import writer
from briefing.inputs import go_status
from briefing.service import is_due, key_numbers

BUSY = {
    "site": {"name": "Test Plant", "county": "Polk", "timezone": "America/New_York"},
    "for_date": "2026-07-16", "day": "Thursday, Jul 16", "go_status": "caution", "hazard_index": 6.5,
    "hazard_index_scale": "0 to 10; green under 4, amber 4 to under 7, red 7 and up", "top_hazard": "heat",
    "top_factors": [{"hazard": "heat", "label": "Heat index peak 108°F tomorrow"},
                    {"hazard": "soil_saturation", "label": "Saturated soil expected"}],
    "daylight": {"sunrise": "6:41 AM", "sunset": "8:22 PM"},
    "heat": {"peak_heat_index_f": 108, "peak_time": "3 PM", "osha_risk_band": "high",
             "heat_index_91_or_higher": {"from": "10 AM", "until": "7 PM"}},
    "periods": [
        {"period": "morning", "hours": "6 AM-12 PM", "rain_chance_pct": 20, "rain_in": 0.0, "thunderstorm_chance_pct": 3},
        {"period": "afternoon", "hours": "12 PM-6 PM", "rain_chance_pct": 70, "rain_in": 0.85, "thunderstorm_chance_pct": 61},
        {"period": "evening", "hours": "6 PM-12 AM", "rain_chance_pct": 40, "rain_in": 0.2, "thunderstorm_chance_pct": 19}],
    "rain_total_in": 1.05, "thunderstorms_likely_from": "2 PM", "thunderstorm_chance_work_hours_pct": 61,
    "soil": {"level": "saturated", "moisture_pct": 34, "crew_note": "Saturated ground: vehicles may get stuck off pavement"},
    "flood": {"fema_flood_zone": "AE", "in_special_flood_hazard_area": True, "named_river_within_1_mi": "Peace River"},
    "nws_alerts": [{"event": "Heat Advisory", "until": "Thu 7 PM"}],
    "wildlife": {"sightings_last_30_days": [{"species": "Florida Cottonmouth", "count": 2}],
                 "crew_reports_within_2_mi_last_30_days": 1},
    "wildfire": {"detections_within_25_mi": "unavailable"},
    "rules": {"lightning_stop_work_radius_mi": 10, "lightning_all_clear_wait_min": 30},
}
CALM = {**copy.deepcopy(BUSY), "go_status": "go", "hazard_index": 1.0, "top_factors": [], "nws_alerts": [],
        "heat": {"peak_heat_index_f": 78, "peak_time": "2 PM", "osha_risk_band": "lower", "heat_index_91_or_higher": None},
        "thunderstorms_likely_from": None, "thunderstorm_chance_work_hours_pct": 0, "rain_total_in": 0.0,
        "soil": {"level": "dry", "moisture_pct": 12, "crew_note": "Dry, firm ground"},
        "wildlife": {"sightings_last_30_days": [], "crew_reports_within_2_mi_last_30_days": 0}}
CALM["periods"] = [{**p, "rain_in": 0.0, "rain_chance_pct": 0, "thunderstorm_chance_pct": 0} for p in BUSY["periods"]]


def test_grounding_check_catches_invented_numbers_and_times():
    assert writer.ungrounded_numbers("Heat index 108°F at 3 PM; start at 6:41 AM", BUSY) == []
    assert writer.ungrounded_numbers("Heat index 3:00 PM and 0.85 in", BUSY) == []      # 3:00 == 3
    assert set(writer.ungrounded_numbers("Heat index 112°F; storms at 1:30 PM", BUSY)) == {"1:30", "112"}


@pytest.mark.parametrize("inputs", [BUSY, CALM])
def test_template_is_grounded_short_and_complete(inputs):
    w = writer.template(inputs)
    assert writer.problems(w.text, inputs) == []
    assert w.text.startswith({"go": "GO", "caution": "CAUTION"}[inputs["go_status"]])
    assert 1 <= len(w.risks) <= 3 and w.actions and w.generator == "template"


def test_template_busy_day_has_timed_risks_and_concrete_actions():
    w = writer.template(BUSY)
    assert any("2 PM" in r for r in w.risks)                                   # thunderstorms likely from 2 PM
    assert any("Start at 6:41 AM" in a and "before 10 AM" in a for a in w.actions)
    assert writer.THUNDERSTORM_ACTION in w.actions                            # plan shelter; no stop-work order


def verdict(inputs: dict) -> str:
    """go_status from the same rules briefing/inputs.py applies (hard stops first)."""
    from briefing.inputs import hard_stops
    i = {**inputs, "wildfire": {"nearest_detection_mi": None, **(inputs.get("wildfire") or {})}}
    return go_status({**i, "hard_stops": hard_stops(i)})


def test_go_status_rules():
    def nws(event):
        return [{"event": event, "until": "Fri 8 AM", "work_hours": None}]
    assert verdict(CALM) == "go"
    assert verdict({**CALM, "thunderstorm_chance_work_hours_pct": 30}) == "caution"     # likely storms
    assert verdict({**CALM, "nws_alerts": nws("Flood Watch")}) == "caution"
    assert verdict({**CALM, "nws_alerts": nws("Rip Current Statement")}) == "go"
    assert verdict({**CALM, "hazard_index": 5.0}) == "caution"
    assert verdict({**CALM, "hazard_index": 9.5}) == "caution"           # a high index alone is never NO-GO


def test_key_numbers_flag_missing_data():
    numbers, unavailable = key_numbers(BUSY)
    assert numbers["max_heat_index_f"] == 108 and numbers["lightning_probability_pct"] == 61
    assert numbers["wildfire_detections_25mi"] == 0 and unavailable == ["wildfire_detections_25mi"]


# ---------- Gemini path (HTTP faked) ----------

@pytest.fixture(autouse=True)
def no_model_keys(monkeypatch):
    """Tests never call a real model, whatever keys backend/.env has."""
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "anthropic_api_key", "")
    monkeypatch.setattr(get_settings(), "gemini_api_key", "")


REAL_CALL_REVIEW = writer._call_review


@pytest.fixture(autouse=True)
def reviews(monkeypatch):
    """The second-check reviewer, faked: finds nothing unless a test queues problems with flag()."""
    queued, seen = [], []

    def call(inputs, text, key, model):
        seen.append((text, model))
        answer = queued.pop(0) if queued else []
        if isinstance(answer, Exception):
            raise answer
        return answer
    monkeypatch.setattr(writer, "_call_review", call)
    return {"queue": queued, "seen": seen}


@pytest.fixture
def claude_on(monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "anthropic_api_key", "test-key")


@pytest.fixture
def gemini_on(monkeypatch):
    from app.config import get_settings
    settings = get_settings()
    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    monkeypatch.setattr(settings, "gemini_min_interval_seconds", 0)


def fake(monkeypatch, *answers):
    calls = []

    def call(inputs, key, model, feedback):
        calls.append(feedback)
        answer = answers[len(calls) - 1]
        if isinstance(answer, Exception):
            raise answer
        return answer
    monkeypatch.setattr(writer, "_call_gemini", call)
    return calls


def fake_claude(monkeypatch, *answers, model="claude-sonnet-5-5"):
    calls = []

    def call(inputs, key, requested, feedback):
        calls.append(feedback)
        answer = answers[len(calls) - 1]
        if isinstance(answer, Exception):
            raise answer
        return answer, model
    monkeypatch.setattr(writer, "_call_claude", call)
    return calls


GOOD = {"headline": "Hot, stormy afternoon on saturated ground.",
        "risks": ["Thunderstorms likely from 2 PM", "Heat index 108°F at 3 PM", "Saturated ground"],
        "actions": ["Start at 6:41 AM and finish heavy work before 10 AM", "Bring mats for vehicles"]}


def test_gemini_answer_used_when_grounded(monkeypatch, gemini_on):
    calls = fake(monkeypatch, GOOD)
    w = writer.write(BUSY)
    assert w.generator == "gemini" and calls == [None] and writer.problems(w.text, BUSY) == []


def test_gemini_invented_number_gets_one_retry(monkeypatch, gemini_on):
    bad = {**GOOD, "risks": ["Heat index 112°F at 3 PM"]}
    calls = fake(monkeypatch, bad, GOOD)
    w = writer.write(BUSY)
    assert w.generator == "gemini" and "112" in calls[1]          # feedback named the bad number


def test_gemini_ungrounded_twice_falls_back_to_template(monkeypatch, gemini_on):
    bad = {**GOOD, "risks": ["Heat index 112°F at 3 PM"]}
    fake(monkeypatch, bad, bad)
    assert writer.write(BUSY).generator == "template"


def test_gemini_error_or_missing_key_falls_back(monkeypatch, gemini_on):
    fake(monkeypatch, TimeoutError())
    assert writer.write(BUSY).generator == "template"
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "gemini_api_key", "")
    assert writer.write(BUSY).generator == "template"


# ---------- 6 PM timing ----------

ET, CT = ZoneInfo("America/New_York"), ZoneInfo("America/Chicago")


def utc(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=timezone.utc)


def test_due_at_6_pm_site_time_central_an_hour_later():
    at_22_utc = utc(2026, 10, 16, 22, 5)              # 6:05 PM EDT, 5:05 PM CDT
    assert is_due(at_22_utc, ET, 18, None) is True
    assert is_due(at_22_utc, CT, 18, None) is False   # western panhandle waits until 6 PM Central
    assert is_due(utc(2026, 10, 16, 23, 1), CT, 18, None) is True


def test_not_due_twice_but_earlier_send_now_is_replaced():
    now = utc(2026, 10, 16, 22, 30)
    assert is_due(now, ET, 18, made_at=utc(2026, 10, 16, 22, 0)) is False      # made at 6:00 PM
    assert is_due(now, ET, 18, made_at=utc(2026, 10, 16, 19, 0)) is True       # send-now at 3 PM


def test_unsupported_hazard_words_are_rejected():
    calm = {**CALM, "soil": {"level": "moist", "moisture_pct": 20, "crew_note": "Moist ground"}}
    assert writer.unsupported_claims("Saturated soil and soft spots", calm)
    assert writer.unsupported_claims("A Flood Warning is in effect", calm)
    assert writer.unsupported_claims("Thunderstorms are possible", calm)
    assert writer.unsupported_claims("Extreme heat today", calm)
    assert writer.unsupported_claims("Moist ground, soft spots off pavement", calm) == []
    busy_ok = "Saturated ground; Heat Advisory in effect; thunderstorms likely from 2 PM"
    assert writer.unsupported_claims(busy_ok, BUSY) == []


@pytest.mark.parametrize("inputs", [BUSY, CALM])
def test_template_has_no_unsupported_claims(inputs):
    assert writer.unsupported_claims(writer.template(inputs).text, inputs) == []


def test_gemini_wrong_hazard_word_gets_retry(monkeypatch, gemini_on):
    calm = {**CALM, "soil": {"level": "moist", "moisture_pct": 12, "crew_note": "Moist ground"}}
    wrong = {"headline": "Quiet day.", "risks": ["Saturated soil off pavement"], "actions": ["Normal operations"]}
    right = {"headline": "Quiet day.", "risks": ["Moist ground off pavement"], "actions": ["Normal operations"]}
    calls = fake(monkeypatch, wrong, right)
    w = writer.write(calm)
    assert w.generator == "gemini" and "saturated" in calls[1]


def test_gemini_timeout_retries_once_then_template(monkeypatch, gemini_on):
    calls = fake(monkeypatch, TimeoutError(), GOOD)
    assert writer.write(BUSY).generator == "gemini" and len(calls) == 2
    fake(monkeypatch, TimeoutError(), TimeoutError())
    assert writer.write(BUSY).generator == "template"


def _http_429(body: dict):
    import io
    import urllib.error
    return urllib.error.HTTPError("https://gemini", 429, "Too Many Requests", {}, io.BytesIO(json.dumps(body).encode()))


def test_quota_used_up_pauses_gemini(monkeypatch, gemini_on):
    monkeypatch.setattr(writer, "_paused_until", 0.0)
    daily = {"error": {"code": 429, "message": "Quota exceeded ... limit: 20 ... Please retry in 20h11m15s"}}
    calls = fake(monkeypatch, _http_429(daily), GOOD)
    assert writer.write(BUSY).generator == "template" and len(calls) == 1
    assert 20 * 3600 < writer.gemini_paused_seconds() <= 20 * 3600 + 11 * 60 + 15
    assert writer.write(BUSY).generator == "template" and len(calls) == 1   # no call while paused


def test_short_rate_limit_waits_and_retries(monkeypatch, gemini_on):
    monkeypatch.setattr(writer, "_paused_until", 0.0)
    monkeypatch.setattr(writer.time, "sleep", lambda s: None)
    short = {"error": {"code": 429, "message": "slow down",
                       "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "7s"}]}}
    calls = fake(monkeypatch, _http_429(short), GOOD)
    assert writer.write(BUSY).generator == "gemini" and len(calls) == 2
    assert writer.gemini_paused_seconds() == 0


# ---------- Claude first, then Gemini, then the template ----------

def _api_error(code: int):
    import anthropic
    import httpx2
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    return anthropic.APIStatusError("error", response=httpx2.Response(code, request=request), body=None)


def _connection_error():
    import anthropic
    import httpx2
    return anthropic.APITimeoutError(request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))


def test_claude_writes_first_and_records_model(monkeypatch, claude_on, gemini_on):
    calls = fake_claude(monkeypatch, GOOD)
    gemini = fake(monkeypatch)                                 # must not be called
    w = writer.write(BUSY)
    assert (w.generator, w.model) == ("claude", "claude-sonnet-5-5")
    assert calls == [None] and gemini == [] and writer.problems(w.text, BUSY) == []


def test_claude_records_the_model_that_answered(monkeypatch, claude_on):
    fake_claude(monkeypatch, GOOD, model="claude-sonnet-5")     # server-side refusal fallback ran
    assert writer.write(BUSY).model == "claude-sonnet-5"


def test_claude_ungrounded_gets_one_retry_then_gemini(monkeypatch, claude_on, gemini_on):
    bad = {**GOOD, "risks": ["Heat index 112°F at 3 PM"]}
    calls = fake_claude(monkeypatch, bad, GOOD)
    w = writer.write(BUSY)
    assert w.generator == "claude" and "112" in calls[1]
    fake_claude(monkeypatch, bad, bad)
    fake(monkeypatch, GOOD)
    assert writer.write(BUSY).generator == "gemini"


def test_claude_failure_falls_to_gemini_then_template(monkeypatch, claude_on, gemini_on):
    for failure in (_api_error(401), _api_error(400), _api_error(529), _connection_error(),
                    writer.Refused("general_harms"), ValueError("bad JSON"), KeyError("risks")):
        calls = fake_claude(monkeypatch, failure)
        fake(monkeypatch, GOOD)
        assert writer.write(BUSY).generator == "gemini", failure
        assert len(calls) == 1          # the SDK already retried; no second Claude call
    fake_claude(monkeypatch, _api_error(401))
    fake(monkeypatch, TimeoutError(), TimeoutError())
    assert writer.write(BUSY).generator == "template"


def test_claude_request_and_response_shape(monkeypatch):
    from types import SimpleNamespace as NS
    sent = {}
    reply = NS(model="claude-sonnet-5-5", stop_reason="end_turn", stop_details=None,
               content=[NS(type="text", text=json.dumps(GOOD))])

    class Client:
        beta = NS(messages=NS(create=lambda **kw: sent.update(kw) or reply))
    monkeypatch.setattr(writer, "_claude_client", lambda key: Client)
    out, model = writer._call_claude(BUSY, "k", "claude-sonnet-5-5", "too long")
    assert out == GOOD and model == "claude-sonnet-5-5"
    assert sent["model"] == "claude-sonnet-5-5" and sent["system"] == writer.SYSTEM
    assert sent["output_config"]["format"] == {"type": "json_schema", "schema": writer.CLAUDE_SCHEMA}
    assert "temperature" not in sent and "thinking" not in sent     # Sonnet 5.5 rejects both forms
    assert sent["fallbacks"] == "default" and sent["betas"] == ["server-side-fallback-2026-07-01"]
    assert "too long" in sent["messages"][0]["content"]

    reply.stop_reason, reply.stop_details, reply.content = "refusal", NS(category="general_harms"), []
    with pytest.raises(writer.Refused):
        writer._call_claude(BUSY, "k", "claude-sonnet-5-5", None)


def test_each_briefing_gets_the_time_it_was_written(monkeypatch):
    """A 55-site batch takes minutes: generated_at is per briefing, not the batch start."""
    from contextlib import contextmanager
    from datetime import timedelta
    from app.config import get_settings
    from briefing import service
    monkeypatch.setattr(get_settings(), "briefing_concurrency", 1)
    batch_start = datetime(2026, 10, 16, 22, 0, tzinfo=timezone.utc)
    ticks = iter(batch_start + timedelta(seconds=10 * i) for i in range(1, 10))

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return next(ticks)
    stored = []

    class Pool:
        @contextmanager
        def connection(self):
            yield type("Conn", (), {"execute": lambda self, sql, params: stored.append(params)})()
    monkeypatch.setattr(service, "datetime", Clock)
    monkeypatch.setattr(service.briefing_inputs, "build_all",
                        lambda pool, ids, now: {"a": (BUSY, []), "b": (CALM, [])})
    monkeypatch.setattr(service, "write", writer.template)
    service.generate(Pool(), now=batch_start)
    times = [p["now"] for p in stored]
    assert len(times) == 2 and times[0] < times[1] and batch_start not in times



# ---------- second check: the reviewer ----------

GARBLED = {**GOOD, "actions": ["Finish before sunset at 6:41 AM is not needed; wrap up by 8:22 PM",
                               "Bring mats for vehicles"]}


def test_review_runs_after_the_checks_pass_with_the_haiku_model(monkeypatch, claude_on, reviews):
    fake_claude(monkeypatch, GOOD)
    w = writer.write(BUSY)
    assert w.generator == "claude"
    assert reviews["seen"] == [(w.text, "claude-haiku-5-5")]


def test_review_is_skipped_for_answers_that_fail_the_number_check(monkeypatch, claude_on, reviews):
    bad = {**GOOD, "risks": ["Heat index 112°F at 3 PM"]}
    fake_claude(monkeypatch, bad, GOOD)
    writer.write(BUSY)
    assert len(reviews["seen"]) == 1                    # only the grounded retry was reviewed


def test_flagged_answer_is_regenerated_once_with_the_problems(monkeypatch, claude_on, reviews):
    reviews["queue"].append(["'sunset at 6:41 AM': 6:41 AM is sunrise"])
    calls = fake_claude(monkeypatch, GARBLED, GOOD)
    w = writer.write(BUSY)
    assert w.generator == "claude" and w.actions == GOOD["actions"]
    assert "reviewer" in calls[1] and "sunset at 6:41 AM" in calls[1]


def test_flagged_twice_uses_the_template_not_gemini(monkeypatch, claude_on, gemini_on, reviews):
    reviews["queue"].extend([["garbled action"], ["still garbled"]])
    fake_claude(monkeypatch, GARBLED, GARBLED)
    gemini = fake(monkeypatch, GOOD)
    assert writer.write(BUSY).generator == "template" and gemini == []


def test_flagged_then_retry_fails_another_way_uses_the_template(monkeypatch, claude_on, gemini_on, reviews):
    reviews["queue"].append(["garbled action"])
    bad = {**GOOD, "risks": ["Heat index 112°F at 3 PM"]}
    for retry in (bad, _api_error(529)):
        fake_claude(monkeypatch, GARBLED, retry)
        gemini = fake(monkeypatch, GOOD)
        assert writer.write(BUSY).generator == "template" and gemini == [], retry
        reviews["queue"].append(["garbled action"])


def test_gemini_answers_are_reviewed_too(monkeypatch, gemini_on, reviews):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "anthropic_api_key", "test-key")
    fake_claude(monkeypatch, _api_error(529))
    reviews["queue"].extend([["garbled"], ["garbled"]])
    fake(monkeypatch, GARBLED, GARBLED)
    assert writer.write(BUSY).generator == "template"
    reviews["queue"].append(["garbled"])
    calls = fake(monkeypatch, GARBLED, GOOD)
    assert writer.write(BUSY).generator == "gemini" and "reviewer" in calls[1]


def test_review_failure_or_no_key_keeps_the_checked_briefing(monkeypatch, claude_on, reviews):
    reviews["queue"].append(_api_error(529))
    fake_claude(monkeypatch, GOOD)
    assert writer.write(BUSY).generator == "claude"
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "claude_review_model", "")
    fake_claude(monkeypatch, GARBLED)
    assert writer.write(BUSY).generator == "claude" and len(reviews["seen"]) == 1


def test_review_request_shape(monkeypatch):
    from types import SimpleNamespace as NS
    sent = {}
    reply = NS(stop_reason="end_turn", content=[NS(type="text", text=json.dumps({"problems": ["x is wrong", " "]}))])

    class Client:
        messages = NS(create=lambda **kw: sent.update(kw) or reply)
    monkeypatch.setattr(writer, "_claude_client", lambda key: Client)
    assert REAL_CALL_REVIEW(BUSY, "GO for Thursday: fine.", "k", "claude-haiku-5-5") == ["x is wrong"]
    assert sent["model"] == "claude-haiku-5-5" and sent["system"] == writer.REVIEW_SYSTEM
    assert sent["output_config"]["format"] == {"type": "json_schema", "schema": writer.REVIEW_SCHEMA}
    assert "temperature" not in sent and "thinking" not in sent and "fallbacks" not in sent
    content = sent["messages"][0]["content"]
    assert "GO for Thursday: fine." in content and '"peak_heat_index_f": 108' in content
    reply.stop_reason = "refusal"
    with pytest.raises(ValueError):
        REAL_CALL_REVIEW(BUSY, "text", "k", "claude-haiku-5-5")


# ---------- template: every risk line comes from a reading that crosses a threshold ----------

def final(inputs: dict) -> dict:
    """Inputs with hard_stops and go_status set by the real rules (briefing/inputs.py)."""
    from briefing.inputs import hard_stops
    i = copy.deepcopy(inputs)
    i["wildfire"] = {"nearest_detection_mi": None, **(i.get("wildfire") or {})}
    i["hard_stops"] = hard_stops(i)
    i["go_status"] = go_status(i)
    return i


FIRE_NO_GO = final({**copy.deepcopy(CALM), "hazard_index": 8.0, "top_hazard": "wildfire",
                    "top_factors": [{"hazard": "wildfire", "label": "Fire detected 4 mi away"},
                                    {"hazard": "heat", "label": "Heat index peak 80°F tomorrow"},
                                    {"hazard": "soil_saturation", "label": "Moist soil expected"}],
                    "soil": {"level": "moist", "moisture_pct": 19, "crew_note": "Moist ground: soft spots possible off pavement"},
                    "wildfire": {"detections_within_25_mi": 10, "nearest_detection_mi": 4.2,
                                 "confirmed_within_5_mi": True}})
MODEL_ONLY = final({**copy.deepcopy(CALM), "hazard_index": 5.6, "top_hazard": "storm",
                    "wind": {"max_gust_mph": 24, "peak_time": "2 PM"},
                    "top_factors": [{"hazard": "storm", "label": "Wind gusts to 24 mph"},
                                    {"hazard": "flood", "label": "0.0 in of rain forecast"},
                                    {"hazard": "storm", "label": "Area with frequent past severe-weather reports"}]})
# Oct 2026: 2.3 in of rain, almost all 6 PM-12 AM, used to make a NO-GO through the index.
EVENING_RAIN = final({**copy.deepcopy(CALM), "hazard_index": 7.6, "rain_total_in": 2.3, "rain_work_hours_in": 0.1,
                      "top_factors": [{"hazard": "flood", "label": "2.3 in of rain forecast tomorrow"},
                                      {"hazard": "heat", "label": "Heat index peak 94°F tomorrow"}],
                      "heat": {"peak_heat_index_f": 94, "peak_time": "1 PM", "osha_risk_band": "moderate",
                               "heat_index_91_or_higher": {"from": "11 AM", "until": "3 PM"},
                               "work_hours_peak_heat_index_f": 94, "work_hours_peak_time": "1 PM",
                               "work_hours_osha_risk_band": "moderate"},
                      "periods": [{**p, "rain_in": 2.2 if p["period"] == "evening" else 0.0,
                                   "rain_chance_pct": 80 if p["period"] == "evening" else 10} for p in CALM["periods"]]})
GUST_ACTION = "Stop aerial lift and bucket work if gusts exceed the equipment's rated limit; secure loose materials."


def _check(inputs):
    w = writer.template(inputs)
    assert writer.problems(w.text, inputs) == []                  # grounded, names any hard stop, < 150 words
    assert writer.template_audit(inputs) == []                    # every risk line has a reading behind it
    assert "hazard index" not in w.headline and "main factor" not in w.headline
    if inputs["go_status"] != "go":
        assert not any("Normal operations" in a for a in w.actions)
    return w


# ---------- NO-GO only for a named hard stop during work hours (7 AM-5 PM) ----------

@pytest.mark.parametrize("event", ["Hurricane Warning", "Tropical Storm Warning", "Tornado Warning", "Flood Warning",
                                   "Flash Flood Warning", "Excessive Heat Warning", "Extreme Heat Warning"])
def test_nws_warning_during_work_hours_is_a_named_no_go(event):
    i = final({**CALM, "nws_alerts": [{"event": event, "until": "Fri 3 PM", "work_hours": "7 AM-3 PM"}]})
    w = _check(i)
    assert i["go_status"] == "no_go" and w.headline.startswith(f"{event} 7 AM-3 PM")
    assert w.text.startswith(f"NO-GO for Thursday, Jul 16: {event} 7 AM-3 PM")
    after_work = final({**CALM, "nws_alerts": [{"event": event, "until": "Fri 11 PM", "work_hours": None}]})
    assert after_work["go_status"] == "caution"                    # warnings outside work hours plan, not stop


def test_red_flag_is_a_no_go_only_with_a_fire_within_10_mi():
    red_flag = [{"event": "Red Flag Warning", "until": "Fri 7 PM", "work_hours": "10 AM-5 PM"}]
    near = final({**CALM, "nws_alerts": red_flag, "wildfire": {"detections_within_25_mi": 2, "nearest_detection_mi": 8.0}})
    w = _check(near)
    assert near["go_status"] == "no_go" and w.headline.startswith("Red Flag Warning 10 AM-5 PM")
    far = final({**CALM, "nws_alerts": red_flag, "wildfire": {"detections_within_25_mi": 2, "nearest_detection_mi": 14.0}})
    assert far["go_status"] == "caution"
    assert final({**CALM, "nws_alerts": red_flag})["go_status"] == "caution"


def test_osha_very_high_heat_during_work_hours_is_a_no_go():
    hot = final({**CALM, "heat": {"peak_heat_index_f": 118, "peak_time": "2 PM", "osha_risk_band": "very high",
                                  "heat_index_91_or_higher": {"from": "9 AM", "until": "6 PM"},
                                  "work_hours_peak_heat_index_f": 118, "work_hours_peak_time": "2 PM",
                                  "work_hours_osha_risk_band": "very high"}})
    w = _check(hot)
    assert hot["go_status"] == "no_go" and w.headline.startswith("OSHA very high heat: heat index 118°F around 2 PM")
    assert w.actions[0].startswith("Start at 6:41 AM")
    high = final({**CALM, "heat": {**hot["heat"], "work_hours_osha_risk_band": "high", "osha_risk_band": "high"}})
    assert high["go_status"] == "go"                               # OSHA high is a heat risk, not a hard stop


def test_fire_within_5_mi_is_a_no_go_named_in_the_headline():
    w = _check(FIRE_NO_GO)
    assert FIRE_NO_GO["go_status"] == "no_go" and w.headline.startswith("Fire detected 4.2 mi away")
    assert w.risks[0].startswith("Fire detected 4.2 mi away") and "escape route" in w.actions[0]
    assert not any("Heat" in r for r in w.risks)                   # an OSHA "lower" heat factor is not a risk
    six = final({**FIRE_NO_GO, "wildfire": {"detections_within_25_mi": 10, "nearest_detection_mi": 6.0,
                                             "confirmed_within_5_mi": False}})
    assert six["go_status"] == "caution"                           # the index (8.0) gives at most CAUTION



def test_a_single_pass_fire_within_5_mi_is_caution_with_a_verify_action():
    one_pass = final({**copy.deepcopy(CALM), "hazard_index": 2.0,
                      "wildfire": {"detections_within_25_mi": 5, "nearest_detection_mi": 0.9, "confirmed_within_5_mi": False}})
    w = _check(one_pass)
    assert one_pass["go_status"] == "caution" and one_pass["hard_stops"] == []     # even with a low index
    assert w.headline.startswith("Fire detected 0.9 mi away")
    assert w.actions[0] == "Verify the fire report before staging; keep an exit route clear."


@pytest.mark.parametrize("work_rain, verdict_", [(3.0, "no_go"), (9.6, "no_go"), (2.9, "caution")])
def test_three_inches_of_rain_during_work_hours_is_a_named_no_go(work_rain, verdict_):
    wet = {**copy.deepcopy(CALM), "hazard_index": 5.0, "rain_total_in": 9.6, "rain_work_hours_in": work_rain,
           "work_hours": "7 AM-5 PM", "top_factors": [{"hazard": "flood", "label": "9.6 in of rain forecast"}],
           "periods": [{**p, "rain_in": 6.0 if p["period"] == "morning" else 1.8, "rain_chance_pct": 90}
                       for p in CALM["periods"]]}
    i = final(wet)
    w = _check(i)
    assert i["go_status"] == verdict_
    if verdict_ == "no_go":
        assert w.headline.startswith(f"Heavy rain: {work_rain} in expected 7 AM-5 PM")
        assert w.text.startswith(f"NO-GO for Thursday, Jul 16: Heavy rain: {work_rain} in expected 7 AM-5 PM")
        assert "flooded roads" in w.actions[0]


@pytest.mark.parametrize("category, what", [("Downed line", "a downed line"), ("Flooding or washout", "site flooding")])
def test_crew_report_of_a_downed_line_or_site_flooding_is_a_no_go(category, what):
    i = final({**CALM, "crew_reports_last_48_h_within_2_mi": [
        {"category": category, "reported": "2 h ago", "reported_at": "1 PM", "distance_mi": 0.4}]})
    w = _check(i)
    assert i["go_status"] == "no_go" and w.headline.startswith(f"Crew reported {what} 2 h ago")
    assert i["hard_stops"][0]["name"] in w.headline
    assert w.risks[0].startswith("Crew reported")


# ---------- a high index or hazards outside work hours: at most CAUTION, with a plan-ahead action ----------

def test_evening_only_rain_gives_caution_not_no_go():
    w = _check(EVENING_RAIN)
    assert EVENING_RAIN["go_status"] == "caution"
    assert w.headline == "Heat peaks at 94°F around 1 PM; 2.3 in of rain, mostly 6 PM-12 AM."
    assert writer.RAIN_PLAN_AHEAD in w.actions and not any("flooded roads" in a for a in w.actions)


def test_a_high_index_alone_is_caution_with_a_plan_ahead_action():
    i = final({**MODEL_ONLY, "hazard_index": 9.2})
    w = _check(i)
    assert i["go_status"] == "caution"
    assert w.headline.startswith("Higher than normal chance of severe weather")
    assert w.actions == ["Check radar before starting and be ready to stop work."]
    assert w.risks == ["No reading crosses a hazard threshold on its own."]
    assert "0.0 in of rain" not in w.text and "Wind gusts to 24" not in w.text
    assert w.text.count("frequent past severe-weather reports") == 1


def test_gusts_of_30_mph_or_more_are_a_storm_risk_with_the_equipment_action():
    windy = final({**MODEL_ONLY, "wind": {"max_gust_mph": 36, "peak_time": "2 PM"},
                   "top_factors": [{"hazard": "storm", "label": "Wind gusts to 36 mph"}]})
    w = _check(windy)
    assert w.headline == "Gusts to 36 mph around 2 PM." and w.actions[0] == GUST_ACTION
    calm_wind = final({**CALM, "wind": {"max_gust_mph": 29, "peak_time": "2 PM"}})
    assert not any("gust" in r.lower() for r in _check(calm_wind).risks)


def test_caution_from_the_index_leads_with_its_work_hours_driver():
    w = _check(final(BUSY))
    assert w.text.startswith("CAUTION") and w.headline.startswith("Heat peaks at 108°F around 3 PM")
    assert w.risks[0].startswith("Heat index peaks at 108°F") and "NWS Heat Advisory" in w.risks[0]
    assert w.actions[0].startswith("Start at 6:41 AM")


def test_caution_raised_by_storms_names_the_storms_and_plans_shelter():
    stormy = {**copy.deepcopy(CALM), "hazard_index": 2.5, "thunderstorms_likely_from": "2 PM",
              "thunderstorm_chance_work_hours_pct": 45}
    stormy["periods"][1]["thunderstorm_chance_pct"] = 45
    stormy = final(stormy)
    w = _check(stormy)
    assert stormy["go_status"] == "caution" and w.headline.startswith("Thunderstorms likely from 2 PM")
    assert w.actions[0] == writer.THUNDERSTORM_ACTION
    assert not any("stop work" in a.lower() for a in w.actions)


def test_caution_raised_by_an_nws_watch_names_the_watch():
    watched = final({**copy.deepcopy(CALM), "hazard_index": 2.0,
                     "nws_alerts": [{"event": "Flood Watch", "until": "Fri 8 AM", "work_hours": "7 AM-8 AM"}]})
    w = _check(watched)
    assert watched["go_status"] == "caution" and w.headline.startswith("NWS Flood Watch until Fri 8 AM")
    assert "flooded roads" in w.actions[0]


def test_go_says_normal_operations_only_when_nothing_needs_an_action():
    w = _check(final(CALM))
    assert w.text.startswith("GO") and w.headline == "Low risk, no significant hazards in the forecast."
    assert w.actions == ["Normal operations; hold the standard tailboard safety briefing."]
    moist = final({**copy.deepcopy(CALM), "soil": {"level": "moist", "moisture_pct": 18, "crew_note": "Moist ground"},
                   "top_factors": [{"hazard": "soil_saturation", "label": "Moist soil expected"}]})
    w = _check(moist)
    assert w.text.startswith("GO") and w.headline == "Soft, wet ground."
    assert any("mats" in a for a in w.actions)


def test_every_crew_report_gets_a_line_downed_lines_and_heat_illness_first():
    reports = [{"category": "Flooding or washout", "reported": "5 h ago", "reported_at": "9 AM", "distance_mi": 1.2},
               {"category": "Wildlife (Cottonmouth)", "reported": "3 h ago", "reported_at": "11 AM", "distance_mi": 0.8},
               {"category": "Downed line", "reported": "2 h ago", "reported_at": "1 PM", "distance_mi": 0.4},
               {"category": "Other", "reported": "1 h ago", "reported_at": "2 PM", "distance_mi": 1.9}]
    crowded = final({**copy.deepcopy(BUSY), "hazard_index": 9.0, "crew_reports_last_48_h_within_2_mi": reports})
    w = _check(crowded)
    assert crowded["go_status"] == "no_go"
    assert w.risks[0].startswith("Crew reported a downed line") and "energized" in w.actions[0]
    for what in ("flooding or washout", "wildlife (Cottonmouth)", "other"):
        assert any(r.startswith(f"Crew reported {what}") for r in w.risks), what


def test_template_never_lists_osha_lower_heat_or_rain_below_the_flood_threshold():
    mild = final({**copy.deepcopy(CALM), "hazard_index": 4.4, "rain_total_in": 0.2,
                  "heat": {"peak_heat_index_f": 84, "peak_time": "2 PM", "osha_risk_band": "lower", "heat_index_91_or_higher": None},
                  "top_factors": [{"hazard": "heat", "label": "Heat index peak 84°F tomorrow"},
                                  {"hazard": "flood", "label": "0.2 in of rain forecast"}]})
    mild["periods"][1]["rain_in"] = 0.2
    w = _check(mild)
    assert w.headline.startswith("Higher than normal chance of severe weather")
    assert not any(("Heat" in r) or ("rain" in r) for r in w.risks)


def test_claude_no_go_must_name_the_hard_stop(monkeypatch, claude_on):
    flood = final({**CALM, "nws_alerts": [{"event": "Flood Warning", "until": "Fri 3 PM", "work_hours": "7 AM-3 PM"}]})
    vague = {"headline": "A wet, risky day.", "risks": ["Flooding possible"], "actions": ["Stay off low ground"]}
    named = {"headline": "Flood Warning 7 AM-3 PM; stay off low ground.", "risks": ["Flooding possible"],
             "actions": ["Stay off low ground"]}
    calls = fake_claude(monkeypatch, vague, named)
    w = writer.write(flood)
    assert w.generator == "claude" and "Flood Warning" in calls[1]          # the retry was told which hard stop
    assert w.text.startswith("NO-GO for Thursday, Jul 16: Flood Warning 7 AM-3 PM")


def test_briefing_inputs_round_rain_and_keep_evening_rain_out_of_no_go():
    """End to end through briefing/inputs.site_inputs: 2.3 in of rain 6 PM-12 AM and a high model score."""
    from datetime import timedelta as td
    from briefing.inputs import site_inputs
    from hazards.scoring import Inputs
    from types import SimpleNamespace
    tz = ZoneInfo("America/New_York")
    site = {"id": "s", "name": "Test", "county": "Polk", "timezone": "America/New_York", "lat": 28.0, "lon": -82.0,
            "fema_flood_zone": "X", "fema_sfha": False, "near_river": False, "river_name": None}
    now = datetime(2026, 10, 17, 22, 0, tzinfo=timezone.utc)                     # 6 PM; tomorrow is Oct 18
    hours = [datetime(2026, 10, 17, 0, 0, tzinfo=tz) + td(hours=k) for k in range(72)]
    rain = [0.38 if h.date().day == 18 and 18 <= h.hour < 24 else 0.004 if h.date().day == 18 and 7 <= h.hour < 17 else 0.0
            for h in hours]
    forecast = {"hourly": {"time": [int(h.timestamp()) for h in hours], "temperature_2m": [82.0] * 72,
                           "relative_humidity_2m": [60.0] * 72, "precipitation": rain,
                           "precipitation_probability": [60] * 72, "wind_gusts_10m": [15.0] * 72},
                "daily": {"sunrise": [], "sunset": []}}
    ensemble = {"hourly": {"time": [int(h.timestamp()) for h in hours], "weather_code_member01": [3] * 72}}
    inp = Inputs(site=site, readings={}, now=now,
                 model={"2026-10-18": {"probability": 0.2, "score": 8.0,
                                       "factors": [{"factor": "rain_in", "hazard": "flood", "label": "2.3 in of rain forecast",
                                                    "weight": 1.0}]}})
    snap = SimpleNamespace(inputs={"s": inp}, species_counts={"s": {}})
    i, _ = site_inputs(site, forecast, ensemble, snap, now)
    assert i["hazard_index"] >= 7                                   # the index alone would have been NO-GO
    assert i["rain_total_in"] == 2.3 and i["rain_work_hours_in"] == 0.0
    assert all(round(p["rain_in"], 1) == p["rain_in"] for p in i["periods"])  # one decimal everywhere
    assert i["hard_stops"] == [] and i["go_status"] == "caution"
    assert i["work_hours"] == "7 AM-5 PM"
    w = writer.template(i)
    assert writer.problems(w.text, i) == [] and writer.RAIN_PLAN_AHEAD in w.actions
