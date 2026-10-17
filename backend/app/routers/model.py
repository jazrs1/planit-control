"""GET /model/info and /model/calibration.svg: the hazard model, for the How it works page.

Everything comes from the committed training artifacts (ml/models/), plus the time of the last
hourly scoring run when there is a database.
"""

import json
from functools import lru_cache

from fastapi import APIRouter, Depends, Response
from psycopg_pool import ConnectionPool

from app.db import get_pool_optional
from app.schemas import ModelInfo
from hazards import model_scores
from ml.model import META_PATH
from ml.paths import MODELS_DIR, load_sites
from ml.plots import MIN_BIN

router = APIRouter(prefix="/model", tags=["model"])

REPORT_PATH = MODELS_DIR / "hazard_report.json"
CALIBRATION_SVG = MODELS_DIR / "calibration.svg"

HYBRID = ("The hazard index is the highest of: the ML weather score (the model's calibrated probability "
          "mapped to 0-10), the OSHA heat-index band, and the wildfire, wildlife and crew-report rules. "
          "While a site has an active lightning stop-work, today's index is at least 9. Every factor says "
          "whether it came from the model or a rule.")
FEATURE_LABELS = {
    "cape_max": "Storm energy (CAPE)", "location": "Site location (past report frequency)",
    "season": "Time of year", "soil_moisture_pct": "Soil moisture", "rain_in": "Rain that day",
    "gust_max_mph": "Wind gusts", "tmax_f": "High temperature", "heat_index_max_f": "Heat index",
    "rain_rate_max_in": "Heaviest hour of rain", "rain_prior3_in": "Rain over the past 3 days",
    "rain_prior7_in": "Rain over the past 7 days", "thunder_hours": "Thunderstorm hours",
}
LIMITATIONS = [
    "The label is \"NOAA logged a hazardous-weather event\", not \"it happened\": rural sites and nights "
    "are under-reported, and lightning is logged only when it causes damage or injury.",
    "Location is partly reporting bias: areas near people get more reports, so the model rates them "
    "riskier. That's why \"Area with frequent past severe-weather reports\" can be a top factor.",
    "Heat isn't learned (NOAA logged Florida heat only in 2022-2023), so heat comes from the OSHA rule.",
    "Wildfire is barely predicted by weather alone, so fires come from the satellite-detection rule.",
    "Two training years, one calibration year (2024, with three hurricanes) and one test year: very "
    "high probabilities (above ~20%) run over-confident in ordinary years.",
    "Much better at ranking days than at exact probabilities: 4% Brier skill over monthly averages today, "
    "not significant a day ahead.",
]


def _metrics(m: dict) -> dict:
    return {"pr_auc": round(m["pr_auc"], 4), "roc_auc": round(m["roc_auc"], 4), "brier": round(m["brier"], 5)}


@lru_cache(maxsize=1)
def static_info() -> dict:
    meta = json.loads(META_PATH.read_text())
    report = json.loads(REPORT_PATH.read_text())
    today, ahead = report["test_today"], report.get("test_tomorrow")
    rule = meta["baselines"]["rule"]

    def result(key: str, name: str, description: str) -> dict:
        return {"name": name, "description": description, "same_day": _metrics(today[key]),
                "day_ahead": _metrics(ahead[key]) if ahead else None}

    index = meta["index"]
    return {
        "version": meta["trained_at"],
        "trained_at": meta["trained_at"],
        "label": meta["label"],
        "weather_source": meta["weather_source"],
        "hybrid": HYBRID,
        "training": {"train_years": meta["split"]["train"], "validation_year": meta["split"]["validation"],
                     "test_year": meta["split"]["test"], "sites": len(load_sites()),
                     "train_site_days": report["data"]["train"]["rows"], "train_events": report["data"]["train"]["events"]},
        "test": {"site_days": today["rows"], "events": today["events"], "base_rate": round(today["model"]["base_rate"], 4)},
        "results": [
            result("model", "Hazard model (LightGBM)", "Calibrated probability from the weather forecast, season and site."),
            result("climatology", "Climatology", "The training years' hazardous-day rate for that calendar month."),
            result("rule", "Simple rule",
                   f"Flag the day if forecast rain is at least {rule['rain_in_at_least']:g} in or the heat index "
                   f"reaches {rule['heat_index_f_at_least']:g}°F."),
        ],
        "bands": [{**b, "event_rate": round(b["event_rate"], 4), "share_of_days": round(b["share_of_days"], 4),
                   "share_of_events": round(b["share_of_events"], 4)} for b in today["bands"]],
        "index_anchors": [{"index": i, "percentile": q, "probability": round(p, 4)}
                          for i, q, p in zip(index["index_values"], index["percentiles"], index["probability_anchors"])],
        "calibration": {"plot_url": "/model/calibration.svg",
                        "bins": [{"mean_predicted": round(b["mean_pred"], 4), "observed": round(b["observed"], 4),
                                  "site_days": b["n"]} for b in today["reliability"]["model"] if b["n"] >= MIN_BIN]},
        "top_features": [{"label": FEATURE_LABELS.get(k, k), "importance": v}
                         for k, v in report["importance_test"].items() if v > 0],
        "limitations": LIMITATIONS,
    }


@router.get("/info", response_model=ModelInfo)
def model_info(pool: ConnectionPool | None = Depends(get_pool_optional)):
    last = None
    if pool is not None:
        try:
            with pool.connection(timeout=5) as conn:
                last = model_scores.last_run(conn)
        except Exception:  # noqa: BLE001 - the model facts don't need the database
            last = None
    return {**static_info(), "last_scored_at": last}


@router.get("/calibration.svg", response_class=Response)
def calibration_plot():
    return Response(CALIBRATION_SVG.read_bytes(), media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=3600"})
