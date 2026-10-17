"""Re-anchor the hazard index without retraining: recompute the index anchors from the committed model's
2024 (validation) predictions, then update the index-dependent parts of the model metadata and report.

    cd backend && python -m ml.reanchor          # needs data/ml/dataset.csv.gz (and dataset_day1 for day-ahead)

The booster and calibration are unchanged, so probabilities are identical; only the probability -> 0-10
mapping moves (ml/model.py index_anchors: 4 = 2x the 2024 base rate, 7 = 5x, 9/10 = 99th/99.9th
percentile), and sets "factor_min" (the 2024 median of each weather feature: a factor at or below it
isn't shown as raising the risk). Updated: hazard_model.json "index" and "factor_min"; in hazard_report.json the meta, each split's "bands",
"model_at_red" and per-hazard "recall_at_red", and the replay-day summaries. The previous anchors and
bands are kept under "index_history" for comparison.
"""

import json

import numpy as np
import pandas as pd

from ml.model import META_PATH, HazardModel, factor_minimums, index_anchors
from ml.train import (DATASET_PATH, DAY1_PATH, REPORT_PATH, TEST_YEAR, VAL_YEAR, _json_default, band_table,
                      per_hazard, replay_day)


def _read(path) -> pd.DataFrame:
    df = pd.read_csv(path, keep_default_na=False, na_values=[""], dtype={"date": str, "event_types": str})
    df["event_types"] = df.event_types.fillna("")
    return df


def _index_parts(df: pd.DataFrame, model: HazardModel) -> tuple[dict, np.ndarray]:
    y = df.hazard.to_numpy()
    p = model.probability(df)
    idx = model.index(p)
    red_share = float(np.mean(idx >= 7))
    return {"bands": band_table(y, idx), "per_hazard": per_hazard(df, p, idx),
            "model_at_red": {"flagged_share": red_share, "precision": float(y[idx >= 7].mean()) if red_share else None,
                             "recall": float(y[idx >= 7].sum() / y.sum())}}, p


def main() -> None:
    meta = json.loads(META_PATH.read_text())
    report = json.loads(REPORT_PATH.read_text())
    model = HazardModel.load()
    df = _read(DATASET_PATH)
    splits = {"validation": df[df.year == VAL_YEAR], "test_today": df[df.year == TEST_YEAR]}
    if DAY1_PATH.exists():
        splits["test_tomorrow"] = _read(DAY1_PATH)

    val = splits["validation"]
    before = {"index": meta["index"], **{name: report[name]["bands"] for name in splits if name in report}}
    meta["index"] = index_anchors(model.probability(val), val.hazard.to_numpy(), VAL_YEAR)
    meta["factor_min"] = factor_minimums(val)
    model = HazardModel(model.booster, meta)

    for name, split in splits.items():
        parts, p = _index_parts(split, model)
        report.setdefault(name, {}).update({k: v for k, v in parts.items() if k != "per_hazard"})
        for group, stats in parts["per_hazard"].items():
            report[name].setdefault("per_hazard", {}).setdefault(group, {})["recall_at_red"] = stats["recall_at_red"]
        replay_key = {"test_today": "replay_day_today", "test_tomorrow": "replay_day_tomorrow"}.get(name)
        if replay_key:
            report[replay_key] = replay_day(split.reset_index(drop=True), model, p)
        print(f"{name}: " + "  ".join(f"{b['band']} {b['share_of_days']:.1%} of days, {b['event_rate']:.2%} events"
                                      for b in report[name]["bands"]))

    report["meta"]["index"] = meta["index"]
    report["meta"]["factor_min"] = meta["factor_min"]
    if before["index"].get("method") != "lift":   # keep the original anchors once, not every rerun
        report.setdefault("index_history", []).append(before)
    META_PATH.write_text(json.dumps(meta, indent=1) + "\n")
    REPORT_PATH.write_text(json.dumps(report, indent=1, default=_json_default) + "\n")
    a = meta["index"]
    print(f"anchors (base rate {a['base_rate']:.2%}): " + ", ".join(
        f"{v:g} at {p:.2%} (p{q * 100:.1f})" for v, p, q in zip(a["index_values"], a["probability_anchors"], a["percentiles"])))


if __name__ == "__main__":
    main()
