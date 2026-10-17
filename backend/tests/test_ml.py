"""Unit tests for the ML hazard index pieces that are easy to get subtly wrong."""

from datetime import date
from itertools import product

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("lightgbm")

from ml import labels, metrics  # noqa: E402
from ml.features import add_history, daily_weather, heat_index_f  # noqa: E402
from ml.model import hazard_index, top_factors  # noqa: E402


@pytest.mark.parametrize("t,rh,expected", [(96, 65, 121), (90, 50, 95), (100, 40, 109), (85, 90, 102), (70, 50, 69)])
def test_heat_index_matches_nws_table(t, rh, expected):
    assert heat_index_f(t, rh) == pytest.approx(expected, abs=1)


def test_segment_distance_uses_closest_point_on_path():
    # Site at origin; a path passing 0.1° of latitude (~6.9 mi) north of it, from west to east.
    d = labels.segment_distance_mi(28.0, -82.0, np.array([28.1]), np.array([-82.5]), np.array([28.1]), np.array([-81.5]))
    assert d[0] == pytest.approx(6.9, abs=0.05)
    # Same path, but only the western half: closest point is now its end.
    d = labels.segment_distance_mi(28.0, -82.0, np.array([28.1]), np.array([-82.5]), np.array([28.1]), np.array([-82.2]))
    assert d[0] > 12


def test_event_times_convert_from_standard_time_to_site_local_date():
    # 23:30 EST on Jul 4 is 00:30 EDT on Jul 5 in New York, but still Jul 4 (22:30 CDT) in the panhandle.
    utc = labels._to_utc(pd.Series([202507]), pd.Series([4]), pd.Series([2330]), pd.Series(["EST-5"]))[0]
    assert labels.local_dates(utc, utc, "America/New_York") == [date(2025, 7, 5)]
    assert labels.local_dates(utc, utc, "America/Chicago") == [date(2025, 7, 4)]


def test_zone_name_matching_survives_renumbering_and_typos():
    assert labels._normalize_name("Brevard") in labels._normalize_name("INLAND NORTHERN BREVARD")
    assert labels._normalize_name("Putnam") in labels._normalize_name("EASTERN PUTNUM")
    # Whole-word match only: "Lee" must not match "Leon".
    assert labels._normalize_name("Lee") not in labels._normalize_name("LEON")


def test_prior_rain_excludes_the_day_itself():
    hours = pd.date_range("2025-07-01", periods=24 * 10, freq="h")
    hourly = pd.DataFrame({
        "temperature_2m": 85.0, "relative_humidity_2m": 60.0, "precipitation": 0.0, "wind_gusts_10m": 10.0,
        "cape": 0.0, "weather_code": 0, "soil_moisture_0_to_10cm": 0.2,
    }, index=hours)
    hourly.loc["2025-07-09", "precipitation"] = 0.1  # 2.4 in on Jul 9 only
    daily = add_history(daily_weather(hourly))
    assert daily.loc["2025-07-09", "rain_in"] == pytest.approx(2.4)
    assert daily.loc["2025-07-09", "rain_prior3_in"] == 0
    assert daily.loc["2025-07-10", "rain_prior3_in"] == pytest.approx(2.4)
    assert np.isnan(daily.loc["2025-07-02", "rain_prior7_in"])  # not enough history yet


def _brute_force_auc(y, s):
    pos, neg = s[y == 1], s[y == 0]
    return np.mean([(p > n) + 0.5 * (p == n) for p, n in product(pos, neg)])


def test_roc_auc_and_average_precision():
    rng = np.random.default_rng(0)
    y = rng.integers(0, 2, 200)
    s = np.round(y * 0.3 + rng.random(200), 1)  # rounding creates ties
    assert metrics.roc_auc(y, s) == pytest.approx(_brute_force_auc(y, s))
    assert metrics.average_precision([1, 0, 1, 0], [0.9, 0.8, 0.7, 0.1]) == pytest.approx((1 + 2 / 3) / 2)
    assert metrics.average_precision(y, y) == 1.0


def test_platt_recovers_known_calibration():
    rng = np.random.default_rng(1)
    raw = rng.uniform(0.01, 0.99, 20000)
    logit = np.log(raw / (1 - raw))
    y = rng.random(20000) < 1 / (1 + np.exp(-(0.5 * logit - 2)))
    a, b = metrics.fit_platt(raw, y)
    assert a == pytest.approx(0.5, abs=0.05) and b == pytest.approx(-2, abs=0.1)


def test_isotonic_is_monotone():
    rng = np.random.default_rng(2)
    raw = rng.random(1000)
    y = rng.random(1000) < raw
    _, knots_y = metrics.fit_isotonic(raw, y)
    assert np.all(np.diff(knots_y) >= 0)


def test_hazard_index_hits_band_anchors():
    anchors = [0.0, 0.02, 0.08, 0.2, 0.4]
    assert list(hazard_index([0.0, 0.02, 0.08, 0.2, 0.4, 0.9], anchors)) == [0, 4, 7, 9, 10, 10]
    assert hazard_index([0.05], anchors)[0] == 5.5


def test_top_factors_groups_season_and_ranks_positive_pushes():
    contrib = pd.Series({"heat_index_max_f": 0.2, "rain_in": 0.6, "doy_sin": 0.3, "doy_cos": 0.1, "cape_max": -0.4,
                         "lat": 0.0, "lon": 0.0})
    row = pd.Series({"heat_index_max_f": 108.4, "rain_in": 3.14, "cape_max": 100.0})
    factors = top_factors(contrib, row, date(2025, 8, 4))
    assert [f["label"] for f in factors] == ["3.1 in of rain forecast", "Peak storm season (August)", "Heat index 108°F"]
    assert [f["hazard"] for f in factors] == ["flood", "flood", "heat"]  # season borrows the top weather hazard
    assert sum(f["weight"] for f in factors) <= 1.0001


def test_budget_ledger_waits_before_exceeding_rolling_24h(tmp_path, monkeypatch):
    import json
    import time

    from ml import openmeteo

    monkeypatch.setattr(openmeteo, "LEDGER_PATH", tmp_path / "ledger.jsonl")
    monkeypatch.setattr(openmeteo, "DAILY_BUDGET", 100)
    now = time.time()
    entries = [{"t": now - 25 * 3600, "calls": 500}, {"t": now - 3600, "calls": 60}]  # first one has aged out
    openmeteo.LEDGER_PATH.write_text("".join(json.dumps(e) + "\n" for e in entries))
    assert openmeteo.spent_last_24h() == 60

    openmeteo._spend(40, "fits exactly")
    assert openmeteo.spent_last_24h() == 100

    class Waited(Exception):
        pass

    def fake_sleep(seconds):
        raise Waited(seconds)

    monkeypatch.setattr(openmeteo.time, "sleep", fake_sleep)
    with pytest.raises(Waited):
        openmeteo._spend(1, "over budget")
    assert openmeteo.spent_last_24h() == 100  # nothing recorded for the blocked request


def test_location_factor_wording_and_fallback_hazard():
    contrib = pd.Series({"lat": 0.5, "lon": 0.2, "cape_max": -0.1, "doy_sin": 0.0, "doy_cos": 0.0})
    factors = top_factors(contrib, pd.Series({"cape_max": 100.0}), date(2025, 1, 4))
    assert factors == [{"factor": "location", "label": "Area with frequent past severe-weather reports",
                        "hazard": "storm", "weight": 1.0}]
