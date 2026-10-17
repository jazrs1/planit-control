"""The trained hazard model at runtime: calibrated probability, 0-10 index, and top factors.

Artifacts (written by `python -m ml.train`):
- models/hazard_lgbm.txt   LightGBM booster
- models/hazard_model.json features, calibration, index anchors, and test metrics
"""

import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

from ml.metrics import apply_platt
from ml.paths import MODELS_DIR

BOOSTER_PATH = MODELS_DIR / "hazard_lgbm.txt"
META_PATH = MODELS_DIR / "hazard_model.json"

# Index anchors by lift over the reference year's base rate (the share of 2024 site-days with a logged
# event): 4 (amber starts) = 2x that rate, 7 (red starts) = 5x. 9 and 10 stay at the reference year's
# 99th and 99.9th percentiles. Piecewise-linear between anchors (hazard_index below).
INDEX_VALUES = [0.0, 4.0, 7.0, 9.0, 10.0]
INDEX_LIFTS = {4.0: 2.0, 7.0: 5.0}
TOP_PERCENTILES = {9.0: 0.99, 10.0: 0.999}


# The smallest reading a factor label can show as non-zero (labels round rain to 0.1 in).
LABEL_MIN = {"rain_in": 0.05, "rain_rate_max_in": 0.05, "rain_prior3_in": 0.05, "rain_prior7_in": 0.05,
             "thunder_hours": 0.5}


def factor_minimums(X_ref: pd.DataFrame) -> dict[str, float]:
    """meta["factor_min"]: per weather feature, the reference year's median or the smallest reading its
    label can show, whichever is higher. Factors at or below it aren't shown as raising the risk."""
    return {f: max(float(X_ref[f].median()), LABEL_MIN.get(f, 0.0)) for f in FACTOR_HAZARD if f in X_ref.columns}


def index_anchors(p_ref, y_ref, reference_year: int) -> dict:
    """The meta["index"] block: probability anchors for INDEX_VALUES from the reference year's
    calibrated probabilities `p_ref` and outcomes `y_ref`, plus each anchor's percentile in that year."""
    p_ref, base = np.asarray(p_ref, dtype=float), float(np.mean(y_ref))
    probs = [0.0, INDEX_LIFTS[4.0] * base, INDEX_LIFTS[7.0] * base,
             float(np.quantile(p_ref, TOP_PERCENTILES[9.0])), float(np.quantile(p_ref, TOP_PERCENTILES[10.0]))]
    probs = list(np.maximum.accumulate(np.asarray(probs) + np.arange(len(probs)) * 1e-9))  # strictly increasing
    return {"reference_year": reference_year, "method": "lift", "base_rate": base,
            "lifts": {str(k): v for k, v in INDEX_LIFTS.items()},
            "percentiles": [float(np.mean(p_ref < x)) for x in probs],   # where each anchor falls that year
            "probability_anchors": [float(x) for x in probs], "index_values": INDEX_VALUES}

# Features that explain together (two coordinates of one idea).
FACTOR_GROUPS = {"doy_sin": "season", "doy_cos": "season", "lat": "location", "lon": "location"}
FACTOR_HAZARD = {
    "heat_index_max_f": "heat",
    "tmax_f": "heat",
    "rain_in": "flood",
    "rain_rate_max_in": "flood",
    "rain_prior3_in": "flood",
    "rain_prior7_in": "flood",
    "soil_moisture_pct": "soil_saturation",
    # The contract has no generic "storm" hazard; lightning is the crew-facing storm hazard.
    "gust_max_mph": "lightning",
    "cape_max": "lightning",
    "thunder_hours": "lightning",
    # No hazard of their own: they take the hazard of the strongest weather factor (see top_factors).
    "season": None,
    "location": None,
}
DEFAULT_HAZARD = "lightning"  # storms are most of the labels
STORM_MONTHS = {5, 6, 7, 8, 9}


def factor_label(factor: str, row: pd.Series, day: date) -> str:
    v = row.get(factor)
    match factor:
        case "heat_index_max_f":
            return f"Heat index {v:.0f}°F"
        case "tmax_f":
            return f"High of {v:.0f}°F"
        case "rain_in":
            return f"{v:.1f} in of rain forecast"
        case "rain_rate_max_in":
            # HRRR grid points sometimes put a whole storm's rain in one hour; don't quote those literally.
            return "Extreme downpours forecast (3+ in/hr)" if v >= 3 else f"Downpours up to {v:.1f} in/hr forecast"
        case "rain_prior3_in":
            return f"{v:.1f} in of rain in the past 3 days"
        case "rain_prior7_in":
            return f"{v:.1f} in of rain in the past 7 days"
        case "gust_max_mph":
            return f"Wind gusts to {v:.0f} mph"
        case "cape_max":
            return f"Unstable air for storms (CAPE {v:,.0f} J/kg)"
        case "thunder_hours":
            return f"Thunderstorms forecast for {v:.0f} h"
        case "soil_moisture_pct":
            return f"Wet ground ({v:.0f}% soil moisture)"
        case "season":
            month = day.strftime("%B")
            return f"Peak storm season ({month})" if day.month in STORM_MONTHS else f"Time of year ({month})"
        case "location":
            # Partly real climate, partly where NOAA receives reports (see docs/ml-model.md, limitations).
            return "Area with frequent past severe-weather reports"
    raise ValueError(factor)


@dataclass
class Prediction:
    probability: float
    hazard_index: float
    factors: list[dict]  # {factor, label, hazard, weight}


class HazardModel:
    def __init__(self, booster: lgb.Booster, meta: dict):
        self.booster = booster
        self.meta = meta
        self.features: list[str] = meta["features"]
        cal = meta["calibration"]
        self.platt = (cal["a"], cal["b"])
        self.prob_anchors = np.asarray(meta["index"]["probability_anchors"], dtype=float)
        self.index_anchors = np.asarray(meta["index"]["index_values"], dtype=float)

    @classmethod
    def load(cls, booster_path: Path = BOOSTER_PATH, meta_path: Path = META_PATH) -> "HazardModel":
        return cls(lgb.Booster(model_file=str(booster_path)), json.loads(meta_path.read_text()))

    def raw_probability(self, X: pd.DataFrame) -> np.ndarray:
        return self.booster.predict(X[self.features])

    def probability(self, X: pd.DataFrame) -> np.ndarray:
        return apply_platt(self.raw_probability(X), *self.platt)

    def index(self, p) -> np.ndarray:
        return hazard_index(p, self.prob_anchors, self.index_anchors)

    def contributions(self, X: pd.DataFrame) -> pd.DataFrame:
        """Per-feature SHAP contributions in log-odds (LightGBM's built-in TreeSHAP)."""
        c = self.booster.predict(X[self.features], pred_contrib=True)
        return pd.DataFrame(c[:, :-1], columns=self.features, index=X.index)

    def predict(self, X: pd.DataFrame, dates: list[date], top: int = 3) -> list[Prediction]:
        p = self.probability(X)
        idx = self.index(p)
        contrib = self.contributions(X)
        return [
            Prediction(float(p[i]), float(idx[i]),
                       top_factors(contrib.iloc[i], X.iloc[i], dates[i], top, self.meta.get("factor_min") or {}))
            for i in range(len(X))
        ]


def hazard_index(p, prob_anchors, index_values=INDEX_VALUES) -> np.ndarray:
    """Calibrated probability -> 0-10, piecewise linear between the anchors, capped at 10, 1 decimal."""
    out = np.interp(np.asarray(p, dtype=float), prob_anchors, index_values, right=index_values[-1])
    return np.round(out, 1)


def top_factors(contrib: pd.Series, row: pd.Series, day: date, top: int = 3,
                factor_min: dict[str, float] | None = None) -> list[dict]:
    """Largest positive contributors, grouped, in plain language. weight = share of the positive push.

    Only factors that raise the risk: a positive contribution AND, for weather features, a reading above
    `factor_min` (the reference year's median, meta["factor_min"]). Every weather feature is "more is
    riskier", so a reading at or below an ordinary day's (e.g. "0.0 in of rain forecast") isn't shown even
    when the model's interactions give it a small positive contribution.

    Every factor gets a HazardType (the API requires one): season and location borrow the hazard of
    the weather factor that pushed risk up the most."""
    grouped = contrib.groupby(lambda f: FACTOR_GROUPS.get(f, f)).sum()
    floors = factor_min or {}
    raises = [f for f in grouped.index if f not in floors or float(row[f]) >= floors[f]]
    grouped = grouped[raises]
    positive = grouped[grouped > 0].sort_values(ascending=False)
    total = positive.sum()
    weather = [f for f in positive.index if FACTOR_HAZARD[f]]
    fallback = FACTOR_HAZARD[weather[0]] if weather else DEFAULT_HAZARD
    return [
        {"factor": f, "label": factor_label(f, row, day), "hazard": FACTOR_HAZARD[f] or fallback,
         "weight": round(float(v / total), 2)}
        for f, v in positive.head(top).items()
    ]
