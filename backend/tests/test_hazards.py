"""Hazard rules: heat index, OSHA bands, flood-risk rule, soil wording, and the hybrid index's
lightning override. Pure functions, no database. More hybrid-index tests: tests/test_hybrid.py."""

from datetime import datetime, timedelta, timezone

import pytest

from alerts.flood import flood_risk
from hazards.heat import heat_index_f, osha_risk_band
from hazards.risk import predict
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
    scored = predict(inputs({("heat", "heat_index_f"): 85.0, ("heat", "tomorrow_peak_heat_index_f"): 95.0},
                            lightning_alert=alert, now=NOW), {})
    assert scored["hazard_index_today"] >= 9.0
    assert scored["top_hazard"] == "lightning"
    assert scored["top_factors"][0]["label"] == STOP_WORK_FACTOR
    assert scored["hazard_index_tomorrow"] == 5.0       # moderate heat tomorrow; no lightning override
    assert sum(f["weight"] for f in scored["top_factors"]) <= 1.0


def test_override_never_lowers_a_higher_index():
    alert = {"last_strike_distance_mi": 3.2, "last_strike_at": NOW, "all_clear_at": NOW + timedelta(minutes=30)}
    scored = predict(inputs({("heat", "heat_index_f"): 118.0}, lightning_alert=alert, now=NOW), {})
    assert scored["hazard_index_today"] == 9.5           # very-high heat beats the 9.0 floor
    assert scored["top_factors"][0]["label"] == STOP_WORK_FACTOR


def test_index_is_the_highest_part_and_flood_rules_feed_cards_not_the_index():
    scored = predict(inputs({("heat", "heat_index_f"): 105.0, ("flood", "rain_past_24h_in"): 2.5,
                             ("flood", "rain_past_12h_in"): 2.5, ("flood", "rain_next_24h_in"): 0.0}, now=NOW), {})
    assert scored["hazard_index_today"] == 7.5           # OSHA high heat; rain is the ML model's job
    assert scored["top_hazard"] == "heat"
    assert scored["cards"]["flood"]["hazard_status"] == "watch"   # the flood card still reacts to the rain


def test_missing_sources_say_so_instead_of_guessing():
    cards = score_site(inputs(firms_detail="skipped: FIRMS_MAP_KEY not set"), {})["cards"]
    assert cards["heat"]["reading"] == "No live heat data yet" and "hazard_status" not in cards["heat"]
    assert "no FIRMS key" in cards["wildfire"]["reading"] and "hazard_status" not in cards["wildfire"]


def test_firms_ignores_plant_hot_spots():
    from hazards.sources.firms import plant_hot_spots
    plant = {"id": "p", "lat": 30.0, "lon": -85.0}
    at_stack = {"lat": 30.0005, "lon": -85.0005}          # ~0.05 mi: the plant's own heat
    grass_fire = {"lat": 30.05, "lon": -85.0}             # ~3.5 mi away
    kept, ignored = plant_hot_spots([at_stack, grass_fire], [plant])
    assert kept == [grass_fire] and ignored == 1


def test_firms_ignores_hot_spots_at_other_florida_thermal_plants():
    from hazards.sources.firms import plant_hot_spots, thermal_plants
    plants = {p["name"]: p for p in thermal_plants()}
    hardee = plants["Hardee Power Station"]                   # gas plant next to Midulla, not one of our sites
    assert "Solar Photovoltaic" not in {p["technology"] for p in plants.values()}
    at_hardee = {"lat": hardee["lat"] + 0.003, "lon": hardee["lon"]}     # ~0.2 mi
    two_km_away = {"lat": hardee["lat"] + 0.018, "lon": hardee["lon"]}   # ~1.2 mi
    kept, ignored = plant_hot_spots([at_hardee, two_km_away], list(plants.values()))
    assert kept == [two_km_away] and ignored == 1
