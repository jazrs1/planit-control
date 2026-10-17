"""The hybrid hazard index (hazards/risk.py), the weather poll's request, scoring from the poll's
forecasts, and stored scoring runs (hazards/model_scores.py)."""

from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from hazards import model_scores
from hazards.risk import combine, predict
from hazards.scoring import STOP_WORK_FACTOR, Inputs
from hazards.sources import open_meteo

pytest.importorskip("lightgbm")

NOW = datetime(2026, 7, 15, 18, 0, tzinfo=timezone.utc)   # 2 PM in New York, 1 PM in Chicago
SITE = {"id": "s", "name": "Test", "lat": 28.0, "lon": -82.0, "timezone": "America/New_York",
        "fema_flood_zone": "X", "fema_sfha": False, "near_river": False, "river_name": None}
MODEL_FACTORS = [{"factor": "cape_max", "hazard": "lightning", "label": "Unstable air for storms (CAPE 4,600 J/kg)", "weight": 0.5},
                 {"factor": "rain_in", "hazard": "flood", "label": "2.2 in of rain forecast", "weight": 0.3}]


def inputs(readings=None, model=None, **kwargs) -> Inputs:
    return Inputs(site=SITE, readings={k: (v, NOW) for k, v in (readings or {}).items()}, now=NOW,
                  model=model or {}, **kwargs)


def ml(score, factors=MODEL_FACTORS):
    return {"probability": 0.1, "score": score, "factors": factors}


# ---------- the hybrid ----------

def test_model_wins_on_a_stormy_day():
    scored = predict(inputs({("heat", "heat_index_f"): 95.0}, model={"2026-07-15": ml(7.2), "2026-07-16": ml(3.0)}), {})
    assert scored["hazard_index_today"] == 7.2
    assert scored["top_hazard"] == "lightning"
    assert [f["source"] for f in scored["top_factors"]] == ["model", "model", "rule"]
    assert scored["top_factors"][0]["label"].startswith("Unstable air")
    assert scored["top_factors"][2]["label"] == "Heat index up to 95°F (OSHA moderate)"  # 5.0: at watch, so listed
    assert scored["hazard_index_tomorrow"] == 3.0


def test_rule_wins_when_heat_is_worse_than_the_weather_score():
    scored = predict(inputs({("heat", "heat_index_f"): 110.0}, model={"2026-07-15": ml(2.0)}), {})
    assert scored["hazard_index_today"] == 7.5             # OSHA high beats the model's 2.0
    assert scored["top_hazard"] == "heat"
    assert scored["top_factors"] == [{"hazard": "heat", "label": "Heat index up to 110°F (OSHA high)",
                                      "weight": 1.0, "source": "rule"}]          # the model's 2.0 isn't elevated


def test_without_a_model_score_the_rules_still_work():
    scored = predict(inputs({("heat", "heat_index_f"): 98.0, ("heat", "tomorrow_peak_heat_index_f"): 104.0}), {})
    assert (scored["hazard_index_today"], scored["hazard_index_tomorrow"]) == (5.0, 7.5)
    assert scored["model_today"] is None and all(f["source"] == "rule" for f in scored["top_factors"])


def test_lightning_override_is_today_only_and_listed_first():
    alert = {"last_strike_distance_mi": 3.2, "last_strike_at": NOW, "all_clear_at": NOW + timedelta(minutes=30)}
    scored = predict(inputs(model={"2026-07-15": ml(6.0), "2026-07-16": ml(6.5)}, lightning_alert=alert), {})
    assert scored["hazard_index_today"] == 9.0
    assert scored["top_factors"][0] == {"hazard": "lightning", "label": STOP_WORK_FACTOR, "weight": 0.6, "source": "rule"}
    assert scored["hazard_index_tomorrow"] == 6.5 and scored["top_factors_tomorrow"][0]["source"] == "model"


def test_crew_reports_count_today():
    flood = {"id": "r1", "category": "flooding", "species": None, "created_at": NOW - timedelta(hours=1), "distance_mi": 0.4}
    scored = predict(inputs(crew_reports=[flood]), {})
    assert scored["hazard_index_today"] == 4.0
    assert scored["top_factors"] == [{"hazard": "flood", "label": "Crew report: Flooding or washout", "weight": 1.0,
                                      "source": "rule"}]
    assert scored["hazard_index_tomorrow"] == 0.0


def test_today_and_tomorrow_follow_the_site_timezone():
    # 04:30 UTC Jul 16 is 12:30 AM Jul 16 in New York but still 11:30 PM Jul 15 in Chicago.
    model = {"2026-07-15": ml(2.0), "2026-07-16": ml(6.0), "2026-07-17": ml(8.0)}
    chicago = {**SITE, "timezone": "America/Chicago"}
    late = datetime(2026, 7, 16, 4, 30, tzinfo=timezone.utc)
    ny = predict(Inputs(site=SITE, readings={}, now=late, model=model), {})
    ct = predict(Inputs(site=chicago, readings={}, now=late, model=model), {})
    assert (ny["hazard_index_today"], ny["hazard_index_tomorrow"]) == (6.0, 8.0)
    assert (ct["hazard_index_today"], ct["hazard_index_tomorrow"]) == (2.0, 6.0)


def test_weights_never_sum_past_one_and_at_most_four_factors():
    from hazards.risk import Component
    comps = [Component("model", "lightning", 7.7, [("lightning", "a", 0.34), ("flood", "b", 0.33), ("flood", "c", 0.33)]),
             Component("rule", "heat", 7.5, [("heat", "d", 1.0)]), Component("rule", "wildfire", 6.0, [("wildfire", "e", 1.0)])]
    index, top, factors = combine(comps, stop_work=True)
    assert index == 9.0 and top == "lightning" and len(factors) == 4
    assert sum(f["weight"] for f in factors) <= 1.0


# ---------- floors: official warnings, our flood alert, downed lines ----------

def nws(event, ends_in_h=2.5, onset_in_h=None):
    """An NWS alert for the site, ending `ends_in_h` hours after NOW (2 PM in New York)."""
    return {"event": event, "headline": event, "severity": "Severe",
            "onset": NOW + timedelta(hours=onset_in_h) if onset_in_h is not None else None,
            "ends_at": NOW + timedelta(hours=ends_in_h) if ends_in_h is not None else None}


@pytest.mark.parametrize("event, hazard", [
    ("Flood Warning", "flood"), ("Flash Flood Warning", "flood"), ("Severe Thunderstorm Warning", "storm"),
    ("Tornado Warning", "storm"), ("Excessive Heat Warning", "heat"), ("Extreme Heat Warning", "heat"),
    ("Red Flag Warning", "wildfire"),
])
def test_nws_warning_floors_today_at_7_and_names_the_alert(event, hazard):
    scored = predict(inputs(nws=[nws(event)]), {})
    assert scored["hazard_index_today"] == 7.0
    assert scored["top_hazard"] == hazard
    assert scored["top_factors"][0] == {"hazard": hazard, "label": f"NWS {event} until 4:30 PM", "weight": 1.0,
                                        "source": "rule"}


@pytest.mark.parametrize("event", ["Flood Watch", "Flash Flood Watch", "Severe Thunderstorm Watch", "Tornado Watch",
                                   "Excessive Heat Watch", "Fire Weather Watch", "Flood Advisory", "Heat Advisory"])
def test_nws_watch_or_advisory_floors_today_at_4(event):
    scored = predict(inputs(nws=[nws(event)]), {})
    assert scored["hazard_index_today"] == 4.0
    assert scored["top_factors"][0]["label"] == f"NWS {event} until 4:30 PM"


@pytest.mark.parametrize("event, floor", [
    ("Hurricane Warning", 9.0), ("Tropical Storm Warning", 7.0), ("Hurricane Watch", 4.0), ("Tropical Storm Watch", 4.0),
])
def test_tropical_floors(event, floor):
    scored = predict(inputs(nws=[nws(event, ends_in_h=30)]), {})        # through 8 PM tomorrow
    assert scored["hazard_index_today"] == floor
    assert scored["hazard_index_tomorrow"] == floor                       # watches and warnings carry into tomorrow
    assert scored["top_factors"][0] == {"hazard": "storm", "label": f"NWS {event} until Thu 8 PM",
                                        "weight": 1.0, "source": "rule"}


def test_hurricane_warning_does_not_hide_a_tornado_warning():
    scored = predict(inputs(nws=[nws("Hurricane Warning", ends_in_h=30), nws("Tornado Warning", ends_in_h=0.5),
                                 nws("Tropical Storm Warning", ends_in_h=30)]), {})
    assert scored["hazard_index_today"] == 9.0
    assert [f["label"] for f in scored["top_factors"]] == ["NWS Hurricane Warning until Thu 8 PM",
                                                         "NWS Tornado Warning until 2:30 PM"]


def test_hurricane_floor_and_stop_work_both_listed():
    alert = {"last_strike_distance_mi": 3.2, "last_strike_at": NOW, "all_clear_at": NOW + timedelta(minutes=30)}
    scored = predict(inputs(nws=[nws("Hurricane Warning", ends_in_h=30)], lightning_alert=alert), {})
    assert scored["hazard_index_today"] == 9.0
    assert [f["label"] for f in scored["top_factors"]] == [STOP_WORK_FACTOR, "NWS Hurricane Warning until Thu 8 PM"]


def test_unrelated_nws_alerts_add_no_floor():
    assert predict(inputs(nws=[nws("Rip Current Statement"), nws("Small Craft Advisory")]), {})["hazard_index_today"] == 0


RAIN = {("flood", "rain_past_12h_in"): 2.4, ("flood", "rain_past_24h_in"): 2.6, ("flood", "rain_next_24h_in"): 0.3}


def test_our_flood_risk_alert_floors_today_at_4():
    scored = predict(inputs(RAIN, flood_alert={"type": "flood", "site_id": "s"}), {})
    assert scored["hazard_index_today"] == 4.0
    assert scored["top_factors"][0]["label"] == "Flood-risk alert: heavy rain in flood-prone area"
    assert scored["hazard_index_tomorrow"] == 0.0     # our alert is about now, not tomorrow


def test_downed_line_floors_today_at_7_with_its_age():
    downed = {"id": "r2", "category": "downed_line", "species": None, "created_at": NOW - timedelta(hours=2),
              "distance_mi": 0.2}
    scored = predict(inputs({("heat", "heat_index_f"): 95.0}, crew_reports=[downed]), {})
    assert scored["hazard_index_today"] == 7.0
    # No HazardType fits an electrical hazard and the API can't point at the crew-hazards card: null.
    assert scored["top_factors"][0] == {"hazard": None, "label": "Crew report: downed line, 2 h ago",
                                        "weight": 0.58, "source": "rule"}
    assert scored["top_hazard"] == "heat"                 # top_hazard stays a HazardType: the next factor's
    assert scored["cards"]["crew_hazards"]["hazard_status"] == "danger"
    assert scored["hazard_index_tomorrow"] == 0.0         # the downed line is today's only


def test_downed_line_alone_still_gives_a_valid_top_hazard_and_response():
    from app.schemas import ContributingFactor, Site
    downed = {"id": "r2", "category": "downed_line", "species": None, "created_at": NOW, "distance_mi": 0.2}
    scored = predict(inputs(crew_reports=[downed]), {})
    assert scored["hazard_index_today"] == 7.0 and scored["top_hazard"] == "heat"   # contract default
    ContributingFactor.model_validate(scored["top_factors"][0])
    Site.model_validate({**SITE, "county": "Test", "hazard_index": 7.0, "hazard_index_live": 7.0,
                         "top_hazard": scored["top_hazard"]})


def test_floors_only_raise_the_index():
    hot = {("heat", "heat_index_f"): 118.0}       # OSHA very high: 9.5
    scored = predict(inputs(hot, model={"2026-07-15": ml(8.4)}, nws=[nws("Flood Watch"), nws("Tornado Warning")]), {})
    assert scored["hazard_index_today"] == 9.5
    labels = [f["label"] for f in scored["top_factors"]]
    assert labels[0] == "NWS Tornado Warning until 4:30 PM"   # warnings are listed even when they don't set the number
    assert "Heat index up to 118°F (OSHA very high)" in labels


def test_lightning_override_still_wins_over_floors():
    alert = {"last_strike_distance_mi": 3.2, "last_strike_at": NOW, "all_clear_at": NOW + timedelta(minutes=30)}
    downed = {"id": "r2", "category": "downed_line", "species": None, "created_at": NOW, "distance_mi": 0.2}
    scored = predict(inputs(nws=[nws("Severe Thunderstorm Warning")], crew_reports=[downed], lightning_alert=alert), {})
    assert scored["hazard_index_today"] == 9.0
    assert scored["top_hazard"] == "lightning"
    assert [f["label"] for f in scored["top_factors"]][:3] == [
        STOP_WORK_FACTOR, "NWS Severe Thunderstorm Warning until 4:30 PM", "Crew report: downed line, just now"]
    assert sum(f["weight"] for f in scored["top_factors"]) <= 1.0


def test_tomorrow_floors_come_only_from_watches_and_warnings_that_reach_tomorrow():
    # NOW is 2 PM Jul 15 in New York; tomorrow is Jul 16.
    ends_today = nws("Flood Warning", ends_in_h=6)                         # 8 PM tonight
    watch_overnight = nws("Flood Watch", ends_in_h=20)                     # 10 AM tomorrow
    advisory_overnight = nws("Heat Advisory", ends_in_h=30)                # advisories don't carry over
    scored = predict(inputs(nws=[ends_today, watch_overnight, advisory_overnight]), {})
    assert scored["hazard_index_today"] == 7.0
    assert scored["hazard_index_tomorrow"] == 4.0
    assert scored["top_factors_tomorrow"][0]["label"] == "NWS Flood Watch until 10 AM"

    warning_tomorrow = nws("Excessive Heat Warning", onset_in_h=22, ends_in_h=30)  # noon to 8 PM tomorrow
    scored = predict(inputs(nws=[warning_tomorrow]), {})
    assert scored["hazard_index_today"] == 0.0                             # not in effect today
    assert scored["hazard_index_tomorrow"] == 7.0
    assert scored["top_factors_tomorrow"][0]["label"] == "NWS Excessive Heat Warning until 8 PM"


def test_one_floor_per_hazard_family_the_most_severe():
    scored = predict(inputs(RAIN, nws=[nws("Flood Watch"), nws("Flash Flood Warning", ends_in_h=4)],
                            flood_alert={"type": "flood", "site_id": "s"}), {})
    assert scored["hazard_index_today"] == 7.0
    assert [f["label"] for f in scored["top_factors"]] == ["NWS Flash Flood Warning until 6 PM"]


def test_multi_day_alert_names_the_day_it_ends():
    scored = predict(inputs(nws=[nws("Flood Warning", ends_in_h=44)]), {})   # 10 AM the day after tomorrow
    assert scored["top_factors"][0]["label"] == "NWS Flood Warning until Fri 10 AM"
    assert scored["top_factors_tomorrow"][0]["label"] == "NWS Flood Warning until Fri 10 AM"


# ---------- the weather poll ----------

def test_poll_requests_exactly_what_the_model_was_trained_on_at_one_call_per_site(monkeypatch):
    from ml import openmeteo as trained
    seen = {}

    def fake_get_json(url, params, retries=0):
        seen.update(params)
        return [{"hourly": {}}] * len(params["latitude"].split(","))

    monkeypatch.setattr(open_meteo.http, "get_json", fake_get_json)
    open_meteo.fetch([SITE, SITE])
    assert seen["models"] == trained.MODEL
    assert seen["hourly"].split(",") == trained.HOURLY_VARS
    assert {k: seen[k] for k in trained.UNITS} == trained.UNITS
    assert seen["past_days"] >= 8   # prior-7-day rain for today
    # Open-Meteo bills one call per location for <= 10 variables and <= 14 days.
    assert len(seen["hourly"].split(",")) <= 10 and seen["past_days"] + seen["forecast_days"] <= 14

    open_meteo.fetch([SITE], extra_hourly=("precipitation_probability",), daily=("sunrise", "sunset"))  # the briefing
    assert len(seen["hourly"].split(",")) + len(seen["daily"].split(",")) <= 10


def hourly_payload(start_utc: datetime, days: int, tz: str | None = None, seed: int = 0) -> dict:
    """A plausible summer hourly series. tz=None: the poller's format (GMT unixtime); otherwise
    the training download's format (local time strings)."""
    rng = np.random.default_rng(seed)
    times = pd.date_range(start_utc, periods=24 * days, freq="h", tz="UTC")
    hour = times.hour.to_numpy()
    temp = 82 + 8 * np.sin((hour - 13) / 24 * 2 * np.pi) + rng.normal(0, 1, len(times))
    rain = np.where(rng.random(len(times)) < 0.05, rng.exponential(0.3, len(times)), 0.0)
    hourly = {
        "temperature_2m": temp.round(1).tolist(), "relative_humidity_2m": (75 - (temp - 82) * 2).round().tolist(),
        "precipitation": rain.round(2).tolist(), "wind_gusts_10m": (15 + 10 * rng.random(len(times))).round(1).tolist(),
        "cape": (1500 + 1500 * rng.random(len(times))).round().tolist(), "weather_code": [3] * len(times),
        "soil_moisture_0_to_10cm": [0.2] * len(times),
    }
    if tz is None:
        hourly["time"] = [int(t.timestamp()) for t in times]
    else:
        hourly["time"] = [t.tz_convert(tz).strftime("%Y-%m-%dT%H:%M") for t in times]
    return {"hourly": hourly}


def test_poller_payload_gives_the_same_features_as_training_data():
    from ml.features import hourly_frame, hourly_frame_unix, site_features
    start = datetime(2026, 7, 6, 4, 0, tzinfo=timezone.utc)   # local midnight in New York
    live = site_features(SITE, hourly_frame_unix(hourly_payload(start, 12), SITE["timezone"]))
    train = site_features(SITE, hourly_frame(hourly_payload(start, 12, tz=SITE["timezone"])))
    pd.testing.assert_frame_equal(live, train)


def test_components_score_today_and_tomorrow_from_the_poll():
    now = datetime(2026, 7, 15, 12, 0, tzinfo=timezone.utc)
    payload = hourly_payload(datetime(2026, 7, 7, tzinfo=timezone.utc), 12)
    comps = model_scores.components([SITE], [payload], now)["s"]
    assert set(comps) == {"2026-07-15", "2026-07-16"}
    for c in comps.values():
        assert 0 <= c["probability"] <= 1 and 0 <= c["score"] <= 10
        assert c["factors"] and all(f["hazard"] for f in c["factors"])


# ---------- stored scoring runs (database) ----------

def test_scoring_run_is_stored_and_read_back(conn):  # noqa: F811
    from app import site_data
    from tests.test_crew_reports import FakePool
    migration = Path(__file__).resolve().parents[1] / "db" / "migrations" / "007_hazard_scores_model.sql"
    if conn.execute("SELECT 1 FROM information_schema.columns WHERE table_name = 'hazard_scores' "
                    "AND column_name = 'model_score'").fetchone() is None:
        conn.execute(migration.read_text())   # rolled back with the test
    pool = FakePool(conn)
    site = conn.execute("SELECT id, lat, lon, timezone FROM sites WHERE id = 'sanford'").fetchone()
    now = datetime.now(timezone.utc).replace(microsecond=0)
    payload = hourly_payload((now - timedelta(days=8)).replace(hour=0, minute=0, second=0), 12)

    detail = model_scores.run(pool, [site], [payload], now)
    assert "failed" not in detail, detail

    points = model_scores.history(conn, site, now + timedelta(seconds=1))
    mine = [p for p in points if p["scored_at"] == now]
    assert {p["horizon"] for p in mine} == {"today", "tomorrow"}
    assert all(p["model_score"] is not None for p in mine)

    stored = model_scores.latest(conn, now)["sanford"]
    assert len(stored) >= 2
    other = model_scores.latest(conn, now).get("big-bend", {})
    assert all(v["score"] is not None for v in other.values())   # only sites with a fresh model score

    detail = site_data.get_site_detail(pool, "sanford")
    today = [p for p in mine if p["horizon"] == "today"][0]
    assert detail["hazard_index_today"] >= today["model_score"]   # the API recombines the stored model part


from tests.test_crew_reports import conn  # noqa: E402,F401 - the rolled-back DB fixture


# ---------- lift-based index anchors ----------

def test_index_anchors_are_lifts_over_the_reference_base_rate():
    from ml.model import INDEX_VALUES, index_anchors
    rng = np.random.default_rng(0)
    p = rng.beta(0.5, 20, 20_000)
    y = rng.random(20_000) < p
    a = index_anchors(p, y, 2024)
    base = float(np.mean(y))
    assert a["method"] == "lift" and a["index_values"] == INDEX_VALUES and a["reference_year"] == 2024
    probs = a["probability_anchors"]
    assert probs[1] == pytest.approx(2 * base, abs=1e-8) and probs[2] == pytest.approx(5 * base, abs=1e-8)
    assert probs[3] == pytest.approx(np.quantile(p, 0.99), abs=1e-8) and probs[4] == pytest.approx(np.quantile(p, 0.999), abs=1e-8)
    assert all(b > a_ for a_, b in zip(probs, probs[1:]))
    assert a["percentiles"][1] == pytest.approx(np.mean(p < probs[1]))


def test_committed_model_uses_the_lift_anchors():
    from ml.model import HazardModel
    m = HazardModel.load()
    idx = m.meta["index"]
    assert idx["method"] == "lift" and 0.02 < idx["base_rate"] < 0.04
    assert idx["probability_anchors"][1] == pytest.approx(2 * idx["base_rate"])
    assert idx["probability_anchors"][2] == pytest.approx(5 * idx["base_rate"])
    # An average 2024 day (the base rate) is green; 2x is where amber starts, 5x where red starts.
    assert m.index(np.array([idx["base_rate"], 2 * idx["base_rate"], 5 * idx["base_rate"]])).tolist() == [2.0, 4.0, 7.0]


def test_stored_scores_are_remapped_from_their_probability():
    from ml.model import HazardModel
    base = HazardModel.load().meta["index"]["base_rate"]
    assert model_scores.rescore(round(2 * base, 4), stored_score=6.0) == pytest.approx(4.0, abs=0.1)
    assert model_scores.rescore(0.0261, stored_score=5.1) < 4.0          # Anclote, Oct 17: amber under the old anchors
    assert model_scores.rescore(None, stored_score=5.1) == 5.1           # nothing to remap


# ---------- chronic rules can't color a site on their own ----------

def _fire(miles):
    return {("wildfire", "nearest_detection_mi"): miles, ("wildfire", "nearest_detection_epoch"): NOW.timestamp(),
            ("wildfire", "nearest_confidence"): 1.0, ("wildfire", "detections_25mi"): 2.0,
            ("wildfire", "passes_5mi"): 2.0, ("wildfire", "high_confidence_5mi"): 0.0}


def test_wildlife_sightings_count_at_most_3_but_are_listed():
    scored = predict(inputs({("wildlife", "observations_30d"): 6.0, ("wildlife", "venomous_30d"): 2.0}), {})
    assert scored["hazard_index_today"] == 3.0
    assert scored["cards"]["wildlife"]["hazard_status"] == "watch"            # the card still warns
    assert [f["hazard"] for f in scored["top_factors"]] == ["wildlife"]
    with_model = predict(inputs({("wildlife", "venomous_30d"): 1.0, ("wildlife", "observations_30d"): 1.0},
                                model={"2026-07-15": ml(2.5)}), {})
    assert with_model["hazard_index_today"] == 3.0
    assert {f["hazard"] for f in with_model["top_factors"]} >= {"wildlife"}   # listed even though below 4


@pytest.mark.parametrize("miles, index, status", [(20.0, 3.0, "watch"), (8.0, 6.0, "watch"), (3.0, 8.0, "danger")])
def test_fires_10_to_25_mi_count_at_most_3_closer_fires_unchanged(miles, index, status):
    scored = predict(inputs(_fire(miles)), {})
    assert scored["hazard_index_today"] == index
    assert scored["cards"]["wildfire"]["hazard_status"] == status
    assert scored["top_factors"][0]["hazard"] == "wildfire"


def test_crew_report_floor_heat_and_nws_floors_are_unchanged_by_the_caps():
    wildlife_report = {"id": "r1", "category": "wildlife", "species": "Cottonmouth", "created_at": NOW - timedelta(hours=2),
                       "distance_mi": 0.3}
    scored = predict(inputs({("wildlife", "venomous_30d"): 1.0, ("wildlife", "observations_30d"): 1.0},
                            crew_reports=[wildlife_report]), {})
    assert scored["hazard_index_today"] == 4.0                                  # the 48 h crew report still counts 4
    assert predict(inputs({("heat", "heat_index_f"): 98.0}), {})["hazard_index_today"] == 5.0


def test_factors_shown_only_when_their_reading_raises_the_risk():
    from datetime import date
    from ml.model import top_factors
    contrib = pd.Series({"rain_in": 0.30, "gust_max_mph": 0.20, "cape_max": -0.10, "lat": 0.05, "lon": 0.05})
    row = pd.Series({"rain_in": 0.02, "gust_max_mph": 34.0, "cape_max": 2500.0, "lat": 27.0, "lon": -82.0})
    floors = {"rain_in": 0.05, "gust_max_mph": 19.7, "cape_max": 1360.0}
    shown = top_factors(contrib, row, date(2026, 10, 17), factor_min=floors)
    assert [f["factor"] for f in shown] == ["gust_max_mph", "location"]           # 0.02 in of rain isn't a cause
    assert not any(f["label"].startswith("0.0 in") for f in shown)
    assert sum(f["weight"] for f in shown) == pytest.approx(1.0, abs=0.02)


# ---------- "lightning" means detected strikes; forecast storm potential is "storm" ----------

def test_forecast_storm_factors_are_storm_not_lightning():
    from ml.model import FACTOR_HAZARD
    assert {FACTOR_HAZARD[f] for f in ("gust_max_mph", "cape_max", "thunder_hours", "location")} == {"storm"}
    gusts = ml(5.0, [{"factor": "gust_max_mph", "hazard": "storm", "label": "Wind gusts to 36 mph", "weight": 0.6},
                     {"factor": "location", "hazard": "storm", "label": "Area with frequent past severe-weather reports",
                      "weight": 0.4}])
    scored = predict(inputs(model={"2026-07-15": gusts}), {})
    assert scored["top_hazard"] == "storm" and {f["hazard"] for f in scored["top_factors"]} == {"storm"}
    # A real stop-work is still lightning, and it comes first.
    alert = {"last_strike_distance_mi": 3.2, "last_strike_at": NOW, "all_clear_at": NOW + timedelta(minutes=30)}
    struck = predict(inputs(model={"2026-07-15": gusts}, lightning_alert=alert), {})
    assert struck["top_hazard"] == "lightning" and struck["top_factors"][1]["hazard"] == "storm"


def test_stored_factors_get_the_current_hazard_mapping():
    old = [{"factor": "gust_max_mph", "hazard": "lightning", "label": "Wind gusts to 36 mph", "weight": 0.4},
           {"factor": "rain_in", "hazard": "flood", "label": "0.4 in of rain forecast", "weight": 0.3},
           {"factor": "location", "hazard": "soil_saturation", "label": "Area with frequent past severe-weather reports",
            "weight": 0.2},
           {"factor": "season", "hazard": "lightning", "label": "Time of year (October)", "weight": 0.1}]
    assert [f["hazard"] for f in model_scores.current_hazards(old)] == ["storm", "flood", "storm", "storm"]
