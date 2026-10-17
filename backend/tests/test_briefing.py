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
