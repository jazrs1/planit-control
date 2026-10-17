"""Briefing writer: grounding check, template, go/no-go rule, Gemini fallbacks, 6 PM timing."""

import copy
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
