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

# Index anchors: the calmest 65% of reference days score < 4 (green), the next 25% score
# 4 to < 7 (amber), and the riskiest 10% score >= 7 (red). 9 = top 1%, 10 = top 0.1%.
INDEX_PERCENTILES = [0.0, 0.65, 0.90, 0.99, 0.999]
INDEX_VALUES = [0.0, 4.0, 7.0, 9.0, 10.0]

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
            Prediction(float(p[i]), float(idx[i]), top_factors(contrib.iloc[i], X.iloc[i], dates[i], top))
            for i in range(len(X))
        ]


def hazard_index(p, prob_anchors, index_values=INDEX_VALUES) -> np.ndarray:
    """Calibrated probability -> 0-10, piecewise linear between the anchors, capped at 10, 1 decimal."""
    out = np.interp(np.asarray(p, dtype=float), prob_anchors, index_values, right=index_values[-1])
    return np.round(out, 1)


def top_factors(contrib: pd.Series, row: pd.Series, day: date, top: int = 3) -> list[dict]:
    """Largest positive contributors, grouped, in plain language. weight = share of the positive push.

    Every factor gets a HazardType (the API requires one): season and location borrow the hazard of
    the weather factor that pushed risk up the most."""
    grouped = contrib.groupby(lambda f: FACTOR_GROUPS.get(f, f)).sum()
    positive = grouped[grouped > 0].sort_values(ascending=False)
    total = positive.sum()
    weather = [f for f in positive.index if FACTOR_HAZARD[f]]
    fallback = FACTOR_HAZARD[weather[0]] if weather else DEFAULT_HAZARD
    return [
        {"factor": f, "label": factor_label(f, row, day), "hazard": FACTOR_HAZARD[f] or fallback,
         "weight": round(float(v / total), 2)}
        for f, v in positive.head(top).items()
    ]
