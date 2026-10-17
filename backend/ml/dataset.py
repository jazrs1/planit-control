"""Join Open-Meteo features with Storm Events labels into site-day tables.

    cd backend && python -m ml.dataset

Run `python -m ml.labels` and `python -m ml.openmeteo` first. Writes:

- data/ml/dataset.csv.gz       every site-day with cached forecasts (2022-2025), features from archived short-lead
                               forecasts (what the "today" index sees)
- data/ml/dataset_day1.csv.gz  2025 only, target-day weather from the forecast issued ~24 h
                               earlier (what the "tomorrow" index sees); prior-day rain and
                               soil moisture come from the day before, as they would live
"""

import argparse
import gzip
import json

import pandas as pd

from ml import openmeteo
from ml.features import FEATURES, add_history, add_static, daily_weather, hourly_frame
from ml.labels import HAZARD_GROUPS, LABELS_PATH
from ml.paths import DATA_DIR, load_sites

DATASET_PATH = DATA_DIR / "dataset.csv.gz"
DAY1_PATH = DATA_DIR / "dataset_day1.csv.gz"
LABEL_COLS = ["hazard", *HAZARD_GROUPS, "event_types"]


def _read(path) -> dict:
    with gzip.open(path, "rt") as f:
        return json.load(f)


def site_hourly(site: dict) -> pd.DataFrame | None:
    paths = sorted((openmeteo.CACHE_DIR / "historical_forecast").glob(f"{site['id']}_*.json.gz"))
    if not paths:
        return None
    frames = [hourly_frame(_read(p)) for p in paths]
    hourly = pd.concat(frames).sort_index()
    return hourly[~hourly.index.duplicated(keep="last")]


def build(sites: list[dict], labels: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    today_rows, day1_rows = [], []
    for site in sites:
        hourly = site_hourly(site)
        if hourly is None:
            print(f"  no forecasts cached for {site['id']}, skipping")
            continue
        daily = daily_weather(hourly)
        feats = add_static(add_history(daily), site)[FEATURES]
        today_rows.append(feats.assign(site_id=site["id"]))

        day1_path = openmeteo.CACHE_DIR / "previous_day1" / f"{site['id']}_2025.json.gz"
        if day1_path.exists():
            target = daily_weather(hourly_frame(_read(day1_path), suffix="_previous_day1"))
            # Soil moisture isn't in the Previous Runs API: use the latest value known when the
            # day-ahead forecast is made (the day before), the same thing live scoring has.
            target["soil_moisture_pct"] = daily.soil_moisture_pct.shift(1).reindex(target.index)
            day1 = add_static(add_history(target, history_rain=daily.rain_in), site)[FEATURES]
            day1_rows.append(day1.assign(site_id=site["id"]))

    def finish(rows: list[pd.DataFrame]) -> pd.DataFrame:
        if not rows:
            return pd.DataFrame()
        df = pd.concat(rows).reset_index()
        df["date"] = df.date.dt.date.astype(str)
        df = df.merge(labels[["site_id", "date", *LABEL_COLS]], on=["site_id", "date"], how="inner")
        df.insert(2, "year", df.date.str[:4].astype(int))
        return df[["site_id", "date", "year", *FEATURES, *LABEL_COLS]]

    return finish(today_rows), finish(day1_rows)


def main() -> None:
    argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter).parse_args()
    labels = pd.read_csv(LABELS_PATH, keep_default_na=False, dtype={"date": str})
    today, day1 = build(load_sites(), labels)
    today.to_csv(DATASET_PATH, index=False)
    print(f"wrote {DATASET_PATH}: {len(today):,} rows, years {sorted(today.year.unique())}")
    if len(day1):
        day1.to_csv(DAY1_PATH, index=False)
        print(f"wrote {DAY1_PATH}: {len(day1):,} rows")
    print("missing values per feature:")
    print(today[FEATURES].isna().mean().map(lambda v: f"{v:.1%}").to_string())


if __name__ == "__main__":
    main()
