"""Hazard rules: heat index, OSHA bands, flood-risk rule, soil wording, and the TEMPORARY index
with its lightning override. Pure functions, no database."""

from datetime import datetime, timedelta, timezone

import pytest

from alerts.flood import flood_risk
from hazards.heat import heat_index_f, osha_risk_band
from hazards.scoring import STOP_WORK_FACTOR, Inputs, score_site, soil_level, status_for

NOW = datetime(2026, 7, 15, 18, 0, tzinfo=timezone.utc)
SITE = {"id": "s", "name": "Test", "lat": 28.0, "lon": -82.0, "timezone": "America/New_York",
        "fema_flood_zone": "X", "fema_sfha": False, "near_river": False, "river_name": None}


def inputs(readings: dict | None = None, **kwargs) -> Inputs:
    return Inputs(site=SITE, readings={k: (v, NOW) for k, v in (readings or {}).items()}, **kwargs)


@pytest.mark.parametrize("temp, rh, chart", [(90, 70, 106), (96, 65, 121), (100, 50, 118), (86, 90, 105), (104, 10, 98)])
def test_heat_index_matches_nws_chart(temp, rh, chart):
    assert round(heat_index_f(temp, rh)) == chart


@pytest.mark.parametrize("hi, band", [(90.9, "lower"), (91, "moderate"), (102.9, "moderate"), (103, "high"),
                                      (115, "high"), (115.1, "very_high")])
def test_osha_bands(hi, band):
    assert osha_risk_band(hi) == band


def test_status_follows_risk_bands():
    assert [status_for(s) for s in (3.9, 4, 6.9, 7)] == ["ok", "watch", "watch", "danger"]


def test_flood_risk_rule():
    ends = NOW + timedelta(hours=6)
    assert flood_risk(2.0, True, False, []) == (True, None)          # heavy rain in a flood zone
    assert flood_risk(2.3, False, True, []) == (True, None)          # heavy rain near a river
    assert flood_risk(2.0, False, False, []) == (False, None)        # heavy rain, neither
    assert flood_risk(1.9, True, True, []) == (False, None)          # not heavy enough
    assert flood_risk(0.0, False, False, [ends]) == (True, ends)     # NWS flood warning alone


def test_soil_levels_and_crew_wording():
    assert [soil_level(v) for v in (0.14, 0.15, 0.29, 0.30)] == ["dry", "moist", "moist", "saturated"]
    card = score_site(inputs({("soil", "vwc_surface"): 0.36}), {})["cards"]["soil_saturation"]
    assert card["level"] == "saturated" and "vehicles may get stuck" in card["reading"]


def test_lightning_stop_work_overrides_today_only():
    alert = {"last_strike_distance_mi": 3.2, "last_strike_at": NOW, "all_clear_at": NOW + timedelta(minutes=30)}
    scored = score_site(inputs({("heat", "heat_index_f"): 85.0, ("heat", "tomorrow_peak_heat_index_f"): 95.0},
                               lightning_alert=alert), {})
    assert scored["hazard_index_today"] >= 9.0
    assert scored["top_hazard"] == "lightning"
    assert scored["top_factors"][0]["label"] == STOP_WORK_FACTOR
    assert scored["hazard_index_tomorrow"] == 5.0       # moderate heat tomorrow; no lightning override
    assert sum(f["weight"] for f in scored["top_factors"]) <= 1.0


def test_override_never_lowers_a_higher_index():
    alert = {"last_strike_distance_mi": 3.2, "last_strike_at": NOW, "all_clear_at": NOW + timedelta(minutes=30)}
    scored = score_site(inputs({("heat", "heat_index_f"): 118.0}, lightning_alert=alert), {})
    assert scored["hazard_index_today"] == 10.0          # 9.5 very-high heat + 0.5 for lightning
    assert scored["top_factors"][0]["label"] == STOP_WORK_FACTOR


def test_index_adds_half_point_per_other_elevated_hazard():
    scored = score_site(inputs({("heat", "heat_index_f"): 105.0, ("flood", "rain_past_24h_in"): 2.5,
                                ("flood", "rain_past_12h_in"): 2.5, ("flood", "rain_next_24h_in"): 0.0}), {})
    assert scored["hazard_index_today"] == 8.0           # heat high 7.5 + 0.5 (flood 6 is elevated)
    assert scored["top_hazard"] == "heat"


def test_missing_sources_say_so_instead_of_guessing():
    cards = score_site(inputs(firms_detail="skipped: FIRMS_MAP_KEY not set"), {})["cards"]
    assert cards["heat"]["reading"] == "No live heat data yet" and "hazard_status" not in cards["heat"]
    assert "no FIRMS key" in cards["wildfire"]["reading"] and "hazard_status" not in cards["wildfire"]
