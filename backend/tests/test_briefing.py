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
    assert any("2 PM" in r for r in w.risks + w.actions)                      # lightning stops after 2 PM
    assert any("Start at 6:41 AM" in a and "before 10 AM" in a for a in w.actions)
    assert any("mats" in a for a in w.actions)


def test_go_status_rules():
    assert go_status(2.0, 0, []) == "go"
    assert go_status(2.0, 30, []) == "caution"                     # likely storms raise go
    assert go_status(2.0, 0, ["Flood Watch"]) == "caution"
    assert go_status(2.0, 0, ["Rip Current Statement"]) == "go"
    assert go_status(5.0, 0, []) == "caution" and go_status(7.0, 0, []) == "no_go"


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


# ---------- template: verdict, main factor, risks and actions agree ----------

# Orange Cogeneration's input on Oct 17, 2026 (trimmed): NO-GO from a fire 4 mi away. The old template
# listed only moist ground and "Normal operations".
FIRE_NO_GO = {**copy.deepcopy(CALM), "go_status": "no_go", "hazard_index": 8.0, "top_hazard": "wildfire",
              "top_factors": [{"hazard": "wildfire", "label": "Fire detected 4 mi away"},
                              {"hazard": "heat", "label": "Heat index peak 80°F tomorrow"},
                              {"hazard": "soil_saturation", "label": "Moist soil expected"}],
              "soil": {"level": "moist", "moisture_pct": 19, "crew_note": "Moist ground: soft spots possible off pavement"},
              "wildfire": {"detections_within_25_mi": 10}}


def _check_consistent(inputs):
    w = writer.template(inputs)
    assert writer.problems(w.text, inputs) == []                  # grounded, no invented hazards, < 150 words
    if inputs["go_status"] != "go":
        assert not any("Normal operations" in a for a in w.actions)
    return w


def test_template_no_go_names_the_fire_that_caused_it():
    w = _check_consistent(FIRE_NO_GO)
    assert w.text.startswith("NO-GO") and "main factor: Fire detected 4 mi away" in w.headline
    assert w.risks[0].startswith("Fire detected 4 mi away") and "10 fire detection" in w.risks[0]
    assert "fire" in w.actions[0] and "escape route" in w.actions[0]


def test_template_no_go_from_a_model_factor_leads_with_it():
    gusts = {**copy.deepcopy(CALM), "go_status": "no_go", "hazard_index": 7.4, "top_hazard": "lightning",
             "top_factors": [{"hazard": "lightning", "label": "Wind gusts to 36 mph"},
                             {"hazard": "flood", "label": "0.1 in of rain forecast"}]}
    w = _check_consistent(gusts)
    assert "main factor: Wind gusts to 36 mph" in w.headline and w.risks[0] == "Wind gusts to 36 mph."
    assert "stop work for strikes within 10 mi" in w.actions[0]


def test_template_caution_from_the_index_leads_with_its_top_factor():
    w = _check_consistent(BUSY)
    assert w.text.startswith("CAUTION") and "main factor: Heat index peak 108°F tomorrow" in w.headline
    assert w.risks[0].startswith("Heat index peaks at 108°F") and "NWS Heat Advisory" in w.risks[0]
    assert w.actions[0].startswith("Start at 6:41 AM")


def test_template_caution_raised_by_storms_names_the_storms_not_the_index():
    stormy = {**copy.deepcopy(CALM), "go_status": "caution", "hazard_index": 2.5,
              "thunderstorms_likely_from": "2 PM", "thunderstorm_chance_work_hours_pct": 45,
              "top_factors": [{"hazard": "heat", "label": "Heat index peak 88°F tomorrow"}]}
    stormy["periods"][1]["thunderstorm_chance_pct"] = 45
    w = _check_consistent(stormy)
    assert "main factor: thunderstorms likely from 2 PM" in w.headline
    assert w.risks[0].startswith("Thunderstorms likely from 2 PM") and "Expect lightning stops after 2 PM" in w.actions[0]


def test_template_caution_raised_by_an_nws_watch_names_the_watch():
    watched = {**copy.deepcopy(CALM), "go_status": "caution", "hazard_index": 2.0,
               "nws_alerts": [{"event": "Flood Watch", "until": "Fri 8 AM"}]}
    w = _check_consistent(watched)
    assert "main factor: NWS Flood Watch until Fri 8 AM" in w.headline
    assert "Flood Watch" in w.risks[0] and "flooded roads" in w.actions[0]


def test_template_go_says_normal_operations_only_when_nothing_needs_an_action():
    w = _check_consistent(CALM)
    assert w.text.startswith("GO") and "low overall risk" in w.headline
    assert w.actions == ["Normal operations; hold the standard tailboard safety briefing."]
    moist = {**copy.deepcopy(CALM), "soil": {"level": "moist", "moisture_pct": 18, "crew_note": "Moist ground"},
             "top_factors": [{"hazard": "soil_saturation", "label": "Moist soil expected"}]}
    w = _check_consistent(moist)
    assert w.text.startswith("GO") and "main factor: Moist soil expected" in w.headline
    assert w.risks[0].startswith("Moist ground") and any("mats" in a for a in w.actions)
    assert not any("Normal operations" in a for a in w.actions)


def test_template_stays_short_and_grounded_on_a_crowded_day():
    crowded = {**copy.deepcopy(BUSY), "go_status": "no_go", "hazard_index": 9.0,
               "nws_alerts": [{"event": "Excessive Heat Warning", "until": "Thu 8 PM"},
                              {"event": "Flood Watch", "until": "Fri 8 AM"}],
               "wildfire": {"detections_within_25_mi": 3},
               "crew_reports_last_48_h_within_2_mi": [
                   {"category": "Downed line", "reported": "2 h ago", "reported_at": "1 PM", "distance_mi": 0.4}]}
    w = _check_consistent(crowded)
    assert w.risks[0].startswith("Crew reported a downed line") and "energized" in w.actions[0]
    assert len(w.risks) == 3 and len(w.actions) <= 3


def test_template_soil_cause_names_expected_saturation_and_todays_reading():
    wet = {**copy.deepcopy(CALM), "go_status": "caution", "hazard_index": 6.0, "rain_total_in": 1.96,
           "soil": {"level": "moist", "moisture_pct": 22, "crew_note": "Moist ground: soft spots possible off pavement"},
           "top_factors": [{"hazard": "soil_saturation", "label": "Saturated soil expected"},
                           {"hazard": "flood", "label": "2.0 in of rain forecast tomorrow"}]}
    wet["periods"][0]["rain_in"] = 1.96
    w = _check_consistent(wet)
    assert w.risks[0].startswith("Saturated soil expected; moist ground") and "mats" in w.actions[0]
    # The check accepts "saturated" here only because the index's own factor says so.
    assert writer.unsupported_claims("Saturated soil", {**wet, "top_factors": []})
