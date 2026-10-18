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
    # Percentile cutoffs of GFS 0-10 cm soil moisture over 2022-2023 (60th: 0.16, 90th: 0.20).
    assert [soil_level(v) for v in (0.159, 0.16, 0.199, 0.20)] == ["dry", "moist", "moist", "saturated"]
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


def _fire(minutes_ago: int, satellite: str = "N", confidence: str = "nominal", miles_north: float = 1.0) -> dict:
    return {"ts": NOW - timedelta(minutes=minutes_ago), "lat": SITE["lat"] + miles_north / 69.09, "lon": SITE["lon"],
            "satellite": satellite, "confidence": confidence, "frp_mw": 5.0}


def test_satellite_passes_group_each_satellites_detections():
    from hazards.sources.firms import satellite_passes
    one_pass = [_fire(30), _fire(29), _fire(28)]                       # one overpass, a few scan lines
    assert satellite_passes(one_pass) == 1
    assert satellite_passes(one_pass + [_fire(25, satellite="N20")]) == 2   # a second satellite
    assert satellite_passes(one_pass + [_fire(12 * 60)]) == 2             # the same satellite, 12 h earlier
    assert satellite_passes([]) == 0


def _wildfire_card(fires: list[dict]):
    from hazards.sources.firms import site_readings
    readings = {(h, m): v for h, m, v in site_readings(SITE, fires)}
    return score_site(inputs(readings), {})


def test_a_fire_seen_on_one_pass_is_watch_not_danger():
    scored = _wildfire_card([_fire(30), _fire(29)])
    card = scored["cards"]["wildfire"]
    assert card["hazard_status"] == "watch" and "one satellite pass only" in card["reading"]
    from hazards.sources.firms import site_readings
    readings = {(h, m): v for h, m, v in site_readings(SITE, [_fire(30)])}
    assert predict(inputs(readings, now=NOW), {})["hazard_index_today"] < 7


@pytest.mark.parametrize("fires", [
    [_fire(30), _fire(6 * 60)],                         # two passes within 24 h
    [_fire(30), _fire(25, satellite="N21")],            # two satellites
    [_fire(30, confidence="high")],                      # one high-confidence detection
])
def test_a_confirmed_fire_within_5_mi_is_danger(fires):
    card = _wildfire_card(fires)["cards"]["wildfire"]
    assert card["hazard_status"] == "danger" and "one satellite pass" not in card["reading"]


def test_only_detections_within_5_mi_confirm_a_fire():
    # Two passes, but the second one is 8 mi away: the close fire is still one pass.
    card = _wildfire_card([_fire(30), _fire(6 * 60, miles_north=8)])["cards"]["wildfire"]
    assert card["hazard_status"] == "watch"


def test_readings_from_before_pass_counts_keep_the_old_rule():
    readings = {("wildfire", "nearest_detection_mi"): 1.0, ("wildfire", "nearest_detection_epoch"): NOW.timestamp(),
                ("wildfire", "nearest_confidence"): 1.0, ("wildfire", "detections_25mi"): 1.0}
    assert score_site(inputs(readings), {})["cards"]["wildfire"]["hazard_status"] == "danger"


def test_heat_reading_after_the_peak_leads_with_the_rest_of_today():
    peak_at = NOW - timedelta(hours=3)                    # 2 PM peak; it's 5 PM now (EDT)
    readings = {("heat", "heat_index_f"): 88.0, ("heat", "peak_heat_index_f"): 96.0,
                ("heat", "peak_at_epoch"): peak_at.timestamp(), ("heat", "rest_of_day_peak_heat_index_f"): 89.0}
    card = score_site(inputs(readings), {})["cards"]["heat"]
    assert card["reading"] == "Heat index 88°F now; up to 89°F for the rest of today (OSHA lower risk)"
    assert card["hazard_status"] == "ok" and card["risk_band"] == "moderate"    # band: today's whole-day peak
    readings[("heat", "peak_at_epoch")] = (NOW + timedelta(hours=2)).timestamp()
    readings[("heat", "rest_of_day_peak_heat_index_f")] = 96.0
    assert "today peaks at 96°F at 4:00 PM (OSHA moderate risk)" in score_site(inputs(readings), {})["cards"]["heat"]["reading"]


# ---------- rain forecasts in text: one rule for our model vs NWS ----------

def _rain(next24=8.0, tomorrow=6.5, nws=None, nws_age=timedelta(hours=1)):
    readings = {("flood", "rain_past_12h_in"): 0.2, ("flood", "rain_past_24h_in"): 0.4, ("flood", "rain_past_72h_in"): 0.4,
                ("flood", "rain_next_24h_in"): next24, ("flood", "rain_tomorrow_in"): tomorrow}
    inp = inputs(readings, now=NOW)
    if nws:
        for metric, value in nws.items():
            inp.readings[("flood", metric)] = (value, NOW - nws_age)
    return inp


def test_flood_card_says_forecasts_disagree_with_a_range():
    from hazards.scoring import flood
    card = flood(_rain(nws={"rain_next_24h_nws_in": 0.9})).card
    assert "0.9-8.0 in expected next 24 h (forecasts disagree)" in card["reading"]
    assert "8.0 in expected" not in card["reading"].replace("0.9-8.0 in expected", "")
    assert card["rain_next_24h_in"] == 8.0 and card["rain_next_24h_nws_in"] == 0.9     # raw numbers unchanged


def test_flood_card_keeps_our_value_when_forecasts_agree_or_nws_is_missing_or_old():
    from hazards.scoring import flood
    assert "8.0 in expected next 24 h." in flood(_rain(nws={"rain_next_24h_nws_in": 6.5})).card["reading"]   # within 2x
    assert "1.4 in expected next 24 h." in flood(_rain(next24=1.4, nws={"rain_next_24h_nws_in": 0.5})).card["reading"]  # < 1 in apart
    assert "8.0 in expected next 24 h." in flood(_rain()).card["reading"]                                        # no NWS
    old = _rain(nws={"rain_next_24h_nws_in": 0.9}, nws_age=timedelta(hours=7))                                    # stale window
    assert "8.0 in expected next 24 h." in flood(old).card["reading"]


def test_tomorrow_rain_label_uses_the_nws_value_for_the_same_day():
    from hazards.scoring import flood
    # Stored today (NOW) for tomorrow: applies to tomorrow's label.
    h = flood(_rain(nws={"rain_tomorrow_nws_in": 0.8}))
    assert h.label_tomorrow == "0.8-6.5 in of rain forecast tomorrow (forecasts disagree)"
    assert flood(_rain(nws={"rain_tomorrow_nws_in": 5.0})).label_tomorrow == "6.5 in of rain forecast tomorrow"
    # Stored yesterday for "tomorrow" is today's figure, not tomorrow's.
    assert flood(_rain(nws={"rain_tomorrow_nws_in": 0.8}, nws_age=timedelta(days=1))).label_tomorrow == \
        "6.5 in of rain forecast tomorrow"


def test_model_rain_factor_label_follows_the_same_rule():
    model = {"2026-07-15": {"probability": 0.2, "score": 7.5, "factors": [
        {"factor": "rain_in", "hazard": "flood", "label": "9.6 in of rain forecast", "weight": 0.6},
        {"factor": "gust_max_mph", "hazard": "storm", "label": "Wind gusts to 35 mph", "weight": 0.4}]}}
    inp = inputs(now=NOW, model=model)
    inp.readings[("flood", "rain_today_nws_in")] = (0.9, NOW)
    labels = [f["label"] for f in predict(inp, {})["top_factors"]]
    assert labels[0] == "0.9-9.6 in of rain forecast (forecasts disagree)" and "Wind gusts to 35 mph" in labels
    inp.readings[("flood", "rain_today_nws_in")] = (7.0, NOW)
    assert predict(inp, {})["top_factors"][0]["label"] == "9.6 in of rain forecast"


def test_held_stop_work_says_lightning_data_is_delayed_and_keeps_the_override():
    alert = {"last_strike_distance_mi": 3.2, "last_strike_at": NOW - timedelta(minutes=40),
             "all_clear_at": NOW - timedelta(minutes=10), "held_reason": "lightning_data_delayed"}
    scored = predict(inputs({}, lightning_alert=alert, now=NOW), {})
    assert scored["hazard_index_today"] >= 9.0
    card = score_site(inputs({}, lightning_alert=alert, now=NOW), {})["cards"]["lightning"]
    assert card["hazard_status"] == "danger"
    assert card["reading"].startswith("Stop work held: lightning data is delayed") and "all clear at" not in card["reading"]
