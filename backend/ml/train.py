"""Train, calibrate, and evaluate the hazard model, then write the artifacts and report.

    cd backend && python -m ml.train

Split by time, never shuffled: train 2022-2023, validate (calibrate + set index anchors) 2024,
test 2025. Hyperparameters are picked on an inner split inside the training years (fit 2022,
early-stop and score on 2023), so 2024 and 2025 are never used for tuning. Training starts in 2022
because that's where the archived GFS soil moisture starts, and because of the Open-Meteo call
budget (see ml/openmeteo.py); labels exist back to 2018 if more years are downloaded later.

Writes models/hazard_lgbm.txt, models/hazard_model.json (runtime metadata), models/hazard_report.json
(every number in docs/ml-model.md), and the calibration plot (docs/img/ml-calibration.svg and
models/calibration.svg, which the API serves).
"""

import argparse
import json
import math
from datetime import date, datetime, timezone

import lightgbm as lgb
import numpy as np
import pandas as pd

from ml import plots
from ml.dataset import DATASET_PATH, DAY1_PATH
from ml.features import FEATURES, SITE_FEATURES
from ml.labels import HAZARD_GROUPS, LABELS_PATH, RADIUS_MI
from ml.metrics import (apply_platt, average_precision, block_bootstrap, brier, fit_isotonic, fit_platt,
                        log_loss, reliability, roc_auc)
from ml.model import BOOSTER_PATH, FACTOR_GROUPS, META_PATH, HazardModel, factor_minimums, index_anchors
from ml.paths import DOCS_DIR, MODELS_DIR

TRAIN_YEARS = [2022, 2023]
INNER_VAL_YEAR = 2023
VAL_YEAR = 2024
TEST_YEAR = 2025
REPLAY_DAY = "2025-08-04"
REPORT_PATH = MODELS_DIR / "hazard_report.json"
CALIBRATION_SVG = DOCS_DIR / "img" / "ml-calibration.svg"

# Simple-rule baseline: the two thresholds a safety officer might use without a model.
RULE_RAIN_IN = 1.0  # heavy-rain day
RULE_HEAT_INDEX_F = 108.0  # NWS heat advisory criterion used by most Florida offices

# Risk can only go up as these go up. Keeps the model and its explanations physically sensible.
MONOTONE_UP = {"tmax_f", "heat_index_max_f", "rain_in", "rain_rate_max_in", "rain_prior3_in", "rain_prior7_in",
               "gust_max_mph", "cape_max", "thunder_hours", "soil_moisture_pct"}
BASE_PARAMS = {
    "objective": "binary",
    "metric": "average_precision",
    "learning_rate": 0.03,
    "min_child_samples": 100,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "lambda_l2": 1.0,
    "seed": 7,
    "deterministic": True,
    "force_row_wise": True,
    "verbose": -1,
}
MONOTONE_TOLERANCE = 0.005  # prefer a monotone model unless it costs more than this much inner-val PR-AUC
REL_EDGES = [0, 0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 1.0]


# ---------- fitting ----------

def lgb_params(features: list[str], num_leaves: int, pos_weight: float, monotone: bool) -> dict:
    params = {**BASE_PARAMS, "num_leaves": num_leaves, "scale_pos_weight": pos_weight}
    if monotone:
        params["monotone_constraints"] = [1 if f in MONOTONE_UP else 0 for f in features]
        params["monotone_constraints_method"] = "advanced"
    return params


def fit(train: pd.DataFrame, features: list[str], params: dict, rounds: int | None = None,
        valid: pd.DataFrame | None = None) -> lgb.Booster:
    dtrain = lgb.Dataset(train[features], train.hazard, free_raw_data=False)
    if valid is None:
        return lgb.train(params, dtrain, num_boost_round=rounds)
    dvalid = lgb.Dataset(valid[features], valid.hazard, reference=dtrain)
    return lgb.train(params, dtrain, num_boost_round=3000, valid_sets=[dvalid],
                     callbacks=[lgb.early_stopping(200, verbose=False)])


def tune(train: pd.DataFrame, features: list[str]) -> tuple[dict, list[dict]]:
    """Small grid on the inner split. Returns the chosen config and every result."""
    inner_train = train[train.year < INNER_VAL_YEAR]
    inner_val = train[train.year == INNER_VAL_YEAR]
    ratio = (1 - inner_train.hazard.mean()) / inner_train.hazard.mean()
    results = []
    for num_leaves in (7, 15, 31):
        for pos_weight in (1.0, round(math.sqrt(ratio), 1), round(ratio, 1)):
            for monotone in (True, False):
                params = lgb_params(features, num_leaves, pos_weight, monotone)
                booster = fit(inner_train, features, params, valid=inner_val)
                p = booster.predict(inner_val[features], num_iteration=booster.best_iteration)
                results.append({"num_leaves": num_leaves, "pos_weight": pos_weight, "monotone": monotone,
                                "rounds": booster.best_iteration, "inner_val_pr_auc": average_precision(inner_val.hazard, p)})
                print(f"  leaves={num_leaves:<3} pos_weight={pos_weight:<5} monotone={monotone!s:<5} "
                      f"rounds={booster.best_iteration:<5} PR-AUC(2023)={results[-1]['inner_val_pr_auc']:.4f}", flush=True)
    best = max(results, key=lambda r: r["inner_val_pr_auc"])
    best_mono = max((r for r in results if r["monotone"]), key=lambda r: r["inner_val_pr_auc"])
    if best_mono["inner_val_pr_auc"] >= best["inner_val_pr_auc"] - MONOTONE_TOLERANCE:
        best = best_mono
    return best, results


# ---------- evaluation ----------

def scores(y, p) -> dict:
    return {"pr_auc": average_precision(y, p), "roc_auc": roc_auc(y, p), "brier": brier(y, p),
            "log_loss": log_loss(y, p), "mean_pred": float(np.mean(p)), "base_rate": float(np.mean(y))}


def at_alert_rate(y, p, flagged_share: float) -> dict:
    """Precision/recall when flagging the top `flagged_share` of site-days."""
    k = max(1, int(round(flagged_share * len(y))))
    top = np.argsort(-np.asarray(p), kind="mergesort")[:k]
    hits = np.asarray(y)[top].sum()
    return {"flagged_share": k / len(y), "precision": float(hits / k), "recall": float(hits / max(1, np.sum(y)))}


def bootstrap_diffs(df: pd.DataFrame, p_model, baselines: dict[str, np.ndarray]) -> dict:
    """95% CIs (resampling whole dates) for model minus baseline in PR-AUC and Brier."""
    y = df.hazard.to_numpy()
    out = {}
    for name, p_base in baselines.items():
        def diff(ix, p_base=p_base):
            return (average_precision(y[ix], p_model[ix]) - average_precision(y[ix], p_base[ix]),
                    brier(y[ix], p_model[ix]) - brier(y[ix], p_base[ix]))
        d = block_bootstrap(df.date.to_numpy(), diff, n=1000)
        out[name] = {
            "pr_auc_diff": float(average_precision(y, p_model) - average_precision(y, p_base)),
            "pr_auc_diff_ci95": [float(np.percentile(d[:, 0], 2.5)), float(np.percentile(d[:, 0], 97.5))],
            "brier_diff": float(brier(y, p_model) - brier(y, p_base)),
            "brier_diff_ci95": [float(np.percentile(d[:, 1], 2.5)), float(np.percentile(d[:, 1], 97.5))],
            "share_of_resamples_model_better_pr_auc": float(np.mean(d[:, 0] > 0)),
        }
    return out


def band(index) -> np.ndarray:
    index = np.asarray(index)
    return np.where(index >= 7, "red", np.where(index >= 4, "amber", "green"))


def band_table(y, index) -> list[dict]:
    b = band(index)
    y = np.asarray(y)
    return [{"band": name, "share_of_days": float(np.mean(b == name)),
             "event_rate": float(y[b == name].mean()) if (b == name).any() else None,
             "share_of_events": float(y[b == name].sum() / max(1, y.sum()))} for name in ("green", "amber", "red")]


def per_hazard(df: pd.DataFrame, p, index) -> dict:
    red = np.asarray(index) >= 7
    out = {}
    for group in HAZARD_GROUPS:
        y = df[group].to_numpy()
        out[group] = {"positives": int(y.sum()), "pr_auc": average_precision(y, p), "roc_auc": roc_auc(y, p),
                      "recall_at_red": float(y[red].sum() / y.sum()) if y.sum() else None}
    return out


def evaluate_split(name: str, df: pd.DataFrame, model: HazardModel, clim: pd.Series, rule_prob: dict,
                   isotonic: tuple) -> tuple[dict, np.ndarray]:
    y = df.hazard.to_numpy()
    raw = model.raw_probability(df)
    p = apply_platt(raw, *model.platt)
    p_iso = np.interp(raw, *isotonic)
    idx = model.index(p)
    p_clim = df.date.str[5:7].astype(int).map(clim).to_numpy()
    fires = rule_fires(df)
    p_rule = np.where(fires, rule_prob["fires"], rule_prob["quiet"])
    red_share = float(np.mean(idx >= 7))
    result = {
        "rows": len(df), "dates": int(df.date.nunique()), "events": int(y.sum()),
        "model": scores(y, p),
        "model_uncalibrated": scores(y, raw),
        "model_isotonic": scores(y, p_iso),
        "climatology": scores(y, p_clim),
        "rule": {**scores(y, p_rule), "fires_share": float(fires.mean()),
                 "precision": float(y[fires].mean()) if fires.any() else None,
                 "recall": float(y[fires].sum() / y.sum())},
        "model_at_rule_alert_rate": at_alert_rate(y, p, float(fires.mean())),
        "model_at_red": {"flagged_share": red_share, "precision": float(y[idx >= 7].mean()) if red_share else None,
                         "recall": float(y[idx >= 7].sum() / y.sum())},
        "bootstrap_vs_baselines": bootstrap_diffs(df, p, {"climatology": p_clim, "rule": p_rule}),
        "bands": band_table(y, idx),
        "per_hazard": per_hazard(df, p, idx),
        "reliability": {"model": reliability(y, p, REL_EDGES), "climatology": reliability(y, p_clim, REL_EDGES),
                        "uncalibrated": reliability(y, raw, REL_EDGES)},
    }
    m, c, r = result["model"], result["climatology"], result["rule"]
    print(f"\n[{name}] {result['rows']:,} site-days, {result['events']} hazardous ({m['base_rate']:.2%})")
    for label, s in (("model", m), ("climatology", c), ("rule", r), ("uncalibrated", result["model_uncalibrated"]),
                     ("isotonic", result["model_isotonic"])):
        print(f"  {label:<13} PR-AUC {s['pr_auc']:.4f}  ROC-AUC {s['roc_auc']:.4f}  Brier {s['brier']:.5f}  mean p {s['mean_pred']:.4f}")
    for base, d in result["bootstrap_vs_baselines"].items():
        print(f"  vs {base}: PR-AUC +{d['pr_auc_diff']:.4f} (95% CI {d['pr_auc_diff_ci95'][0]:+.4f} to "
              f"{d['pr_auc_diff_ci95'][1]:+.4f}), Brier {d['brier_diff']:+.5f}")
    print("  bands:", ", ".join(f"{b['band']} {b['share_of_days']:.0%} of days / {b['event_rate'] or 0:.1%} event rate / "
                                f"{b['share_of_events']:.0%} of events" for b in result["bands"]))
    return result, p


def rule_fires(df: pd.DataFrame) -> np.ndarray:
    return ((df.rain_in >= RULE_RAIN_IN) | (df.heat_index_max_f >= RULE_HEAT_INDEX_F)).to_numpy()


def replay_day(df: pd.DataFrame, model: HazardModel, p: np.ndarray) -> dict:
    """How the model saw the replay storm day, per site, plus how unusual the day was for the year."""
    day_mask = (df.date == REPLAY_DAY).to_numpy()
    day = df[day_mask]
    preds = model.predict(day, [date.fromisoformat(REPLAY_DAY)] * len(day))
    idx_all = model.index(p)
    by_date = pd.Series(idx_all).groupby(df.date.to_numpy()).mean().sort_values(ascending=False)
    sites = []
    for (_, row), pred in zip(day.iterrows(), preds):
        sites.append({"site_id": row.site_id, "hazard": int(row.hazard), "event_types": row.event_types,
                      "probability": round(pred.probability, 4), "hazard_index": pred.hazard_index,
                      "factors": [f["label"] for f in pred.factors]})
    sites.sort(key=lambda s: -s["hazard_index"])
    y = day.hazard.to_numpy()
    idx = np.array([s["hazard_index"] for s in sites])
    hazard_sorted = np.array([s["hazard"] for s in sites])
    return {
        "date": REPLAY_DAY, "sites": len(sites), "hazardous_sites": int(y.sum()),
        "mean_index": float(idx.mean()), "red_sites": int((idx >= 7).sum()), "amber_sites": int(((idx >= 4) & (idx < 7)).sum()),
        "hazardous_sites_red": int(((idx >= 7) & (hazard_sorted == 1)).sum()),
        "rank_of_day_by_mean_index": int(list(by_date.index).index(REPLAY_DAY) + 1), "days_in_year": len(by_date),
        "per_site": sites,
    }


def importance(model: HazardModel, df: pd.DataFrame) -> dict:
    contrib = model.contributions(df).abs().mean()
    grouped = contrib.groupby(lambda f: FACTOR_GROUPS.get(f, f)).sum().sort_values(ascending=False)
    return {k: round(float(v), 4) for k, v in grouped.items()}


# ---------- main ----------

def scaled_rounds(inner_rounds: int, train: pd.DataFrame) -> int:
    """Early-stopped rounds from the inner split, scaled up for the larger final training set."""
    return int(round(inner_rounds * len(train) / (train.year < INNER_VAL_YEAR).sum()))


def label_base_rates() -> dict:
    """Base rates for every labeled year (2018-2025), including years we have no weather for."""
    labels = pd.read_csv(LABELS_PATH, usecols=["date", "hazard", *HAZARD_GROUPS])
    return labels.groupby(labels.date.str[:4].astype(int))[["hazard", *HAZARD_GROUPS]].mean().round(5).to_dict(orient="index")


def main() -> None:
    argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter).parse_args()
    df = pd.read_csv(DATASET_PATH, keep_default_na=False, na_values=[""], dtype={"date": str, "event_types": str})
    df["event_types"] = df.event_types.fillna("")
    missing = sorted(set(TRAIN_YEARS + [VAL_YEAR, TEST_YEAR]) - set(df.year))
    if missing:
        raise SystemExit(f"dataset is missing years {missing}; finish `python -m ml.openmeteo` and rebuild the dataset")
    train, val, test = df[df.year.isin(TRAIN_YEARS)], df[df.year == VAL_YEAR], df[df.year == TEST_YEAR]
    print(f"train {len(train):,} ({train.hazard.mean():.2%} hazardous), val {len(val):,} ({val.hazard.mean():.2%}), "
          f"test {len(test):,} ({test.hazard.mean():.2%})")

    print(f"\ntuning on inner split (fit {TRAIN_YEARS[0]}-{INNER_VAL_YEAR - 1}, score {INNER_VAL_YEAR}):")
    best, grid = tune(train, FEATURES)
    print(f"chosen: {best}")
    rounds = scaled_rounds(best["rounds"], train)
    params = lgb_params(FEATURES, best["num_leaves"], best["pos_weight"], best["monotone"])
    booster = fit(train, FEATURES, params, rounds=rounds)

    # Calibrate on the validation year, then anchor the index on its calibrated distribution.
    raw_val = booster.predict(val[FEATURES])
    a, b = fit_platt(raw_val, val.hazard.to_numpy())
    isotonic = fit_isotonic(raw_val, val.hazard.to_numpy())
    p_val = apply_platt(raw_val, a, b)
    index = index_anchors(p_val, val.hazard.to_numpy(), VAL_YEAR)

    clim = train.groupby(train.date.str[5:7].astype(int)).hazard.mean()
    fires = rule_fires(train)
    rule_prob = {"fires": float(train.hazard[fires].mean()), "quiet": float(train.hazard[~fires].mean())}

    meta = {
        "version": 1,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "features": FEATURES,
        "lightgbm_params": params,
        "num_boost_round": rounds,
        "label": f"NOAA Storm Events crew-relevant event within {RADIUS_MI:.0f} mi or in the site's NWS zone/county, by site-local date",
        "weather_source": "Open-Meteo gfs_seamless (HRRR over Florida); training on the Historical Forecast API",
        "split": {"train": TRAIN_YEARS, "validation": VAL_YEAR, "test": TEST_YEAR},
        "calibration": {"method": "platt", "fit_on": VAL_YEAR, "a": a, "b": b},
        "index": index,
        "factor_min": factor_minimums(val),
        "baselines": {"climatology_by_month": {int(k): float(v) for k, v in clim.items()},
                      "rule": {"rain_in_at_least": RULE_RAIN_IN, "heat_index_f_at_least": RULE_HEAT_INDEX_F, **rule_prob}},
    }
    model = HazardModel(booster, meta)

    report = {"meta": meta, "tuning": {"chosen": best, "grid": grid},
              "data": {split: {"rows": len(d), "events": int(d.hazard.sum()), "base_rate": float(d.hazard.mean()),
                               **{f"{g}_rate": float(d[g].mean()) for g in HAZARD_GROUPS}}
                       for split, d in (("train", train), ("validation", val), ("test", test))},
             "base_rate_by_year": label_base_rates(),
             "base_rate_by_month_train": {int(k): float(v) for k, v in clim.items()}}
    report["validation"], _ = evaluate_split("validation 2024 (calibration year, in-sample for calibration)", val,
                                             model, clim, rule_prob, isotonic)
    report["test_today"], p_test = evaluate_split("TEST 2025, same-day forecasts", test, model, clim, rule_prob, isotonic)
    report["replay_day_today"] = replay_day(test.reset_index(drop=True), model, p_test)

    if DAY1_PATH.exists():
        day1 = pd.read_csv(DAY1_PATH, keep_default_na=False, na_values=[""], dtype={"date": str, "event_types": str})
        day1["event_types"] = day1.event_types.fillna("")
        report["test_tomorrow"], p_day1 = evaluate_split("TEST 2025, day-ahead forecasts", day1, model, clim, rule_prob, isotonic)
        report["replay_day_tomorrow"] = replay_day(day1.reset_index(drop=True), model, p_day1)

    report["importance_test"] = importance(model, test)
    report["ablations"] = ablations(train, test, best)

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    booster.save_model(str(BOOSTER_PATH))
    META_PATH.write_text(json.dumps(meta, indent=1) + "\n")
    REPORT_PATH.write_text(json.dumps(report, indent=1, default=_json_default) + "\n")
    CALIBRATION_SVG.parent.mkdir(parents=True, exist_ok=True)
    CALIBRATION_SVG.write_text(plots.calibration_svg(report))
    (MODELS_DIR / "calibration.svg").write_text(plots.calibration_svg(report))  # served by GET /model/calibration.svg
    print(f"\nwrote {BOOSTER_PATH} ({BOOSTER_PATH.stat().st_size / 1e6:.2f} MB), {META_PATH}, {REPORT_PATH}, {CALIBRATION_SVG}")
    rd = report["replay_day_today"]
    print(f"{REPLAY_DAY}: {rd['hazardous_sites']}/{rd['sites']} sites hazardous, {rd['red_sites']} red, "
          f"mean index {rd['mean_index']:.1f}, day rank {rd['rank_of_day_by_mean_index']}/{rd['days_in_year']}")
    print("importance (mean |SHAP|, test):", report["importance_test"])


def ablations(train: pd.DataFrame, test: pd.DataFrame, best: dict) -> dict:
    """Same config without soil moisture or without site lat/lon, to show what each adds."""
    inner_train, inner_val = train[train.year < INNER_VAL_YEAR], train[train.year == INNER_VAL_YEAR]
    out = {}
    for name, drop in (("all_features", []), ("no_soil_moisture", ["soil_moisture_pct"]), ("no_site_location", SITE_FEATURES)):
        feats = [f for f in FEATURES if f not in drop]
        params = lgb_params(feats, best["num_leaves"], best["pos_weight"], best["monotone"])
        inner = fit(inner_train, feats, params, valid=inner_val)
        full = fit(train, feats, params, rounds=scaled_rounds(inner.best_iteration, train))
        out[name] = {
            "inner_val_pr_auc": average_precision(inner_val.hazard, inner.predict(inner_val[feats], num_iteration=inner.best_iteration)),
            "test_pr_auc_uncalibrated": average_precision(test.hazard, full.predict(test[feats])),
        }
        print(f"  ablation {name:<18} inner-val PR-AUC {out[name]['inner_val_pr_auc']:.4f}  "
              f"test PR-AUC {out[name]['test_pr_auc_uncalibrated']:.4f}")
    return out


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, np.bool_):
        return bool(o)
    raise TypeError(type(o))


if __name__ == "__main__":
    main()
