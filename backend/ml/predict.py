"""Score sites for today and tomorrow with the trained hazard model. Not wired into the API yet.

    cd backend && python -m ml.predict                    # all sites, live forecast
    python -m ml.predict --site big-bend --json
    python -m ml.predict --date 2025-08-04                # a past day, from archived forecasts

"Today" and "tomorrow" are the site's local dates. For a live day, features come from Open-Meteo's
forecast API (last 8 days + next 3). For a past day (e.g. the lightning replay), they come from
the Historical Forecast API, the same source the model was trained on.
"""

import argparse
import json
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pandas as pd

from ml import openmeteo
from ml.features import hourly_frame, site_features
from ml.model import HazardModel
from ml.paths import load_sites

LIVE_LOOKBACK_DAYS = 2  # older "today" dates use the archive instead of the live forecast


def fetch_hourly(site: dict, today: date, real_today: date) -> pd.DataFrame:
    if today >= real_today - timedelta(days=LIVE_LOOKBACK_DAYS):
        return hourly_frame(openmeteo.live_forecast(site))
    start = today - timedelta(days=openmeteo.LEAD_IN_DAYS)
    return hourly_frame(openmeteo.historical_forecast_range(site, start, today + timedelta(days=1)))


def score_site(model: HazardModel, site: dict, now: datetime, hourly: pd.DataFrame | None = None) -> dict:
    """Hazard index for the site's local today and tomorrow, with the top 3 factors for each."""
    today = now.astimezone(ZoneInfo(site["timezone"])).date()
    tomorrow = today + timedelta(days=1)
    if hourly is None:
        hourly = fetch_hourly(site, today, datetime.now(timezone.utc).astimezone(ZoneInfo(site["timezone"])).date())
    feats = site_features(site, hourly)
    # Tomorrow's soil moisture is taken as today's, as in the day-ahead evaluation.
    feats.loc[pd.Timestamp(tomorrow), "soil_moisture_pct"] = feats.loc[pd.Timestamp(today), "soil_moisture_pct"]
    rows = feats.loc[[pd.Timestamp(today), pd.Timestamp(tomorrow)]]
    p_today, p_tomorrow = model.predict(rows, [today, tomorrow])
    return {
        "site_id": site["id"],
        "today": {"date": today.isoformat(), **_as_dict(p_today)},
        "tomorrow": {"date": tomorrow.isoformat(), **_as_dict(p_tomorrow)},
    }


def _as_dict(pred) -> dict:
    return {"probability": round(pred.probability, 4), "hazard_index": pred.hazard_index, "top_factors": pred.factors}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--site", help="site id (default: all sites)")
    parser.add_argument("--date", type=date.fromisoformat, help="score this local date as 'today' (default: now)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    model = HazardModel.load()
    sites = [s for s in load_sites() if args.site in (None, s["id"])]
    if not sites:
        raise SystemExit(f"unknown site {args.site!r}")
    if args.date:
        now = datetime.combine(args.date, datetime.min.time().replace(hour=12), tzinfo=ZoneInfo("America/New_York"))
    else:
        from app import clock  # real time normally, simulated during lightning replay
        now = clock.now()
    results = [score_site(model, s, now) for s in sites]
    if args.json:
        print(json.dumps(results, indent=1))
        return
    results.sort(key=lambda r: -r["today"]["hazard_index"])
    for r in results:
        t, m = r["today"], r["tomorrow"]
        factors = "; ".join(f["label"] for f in t["top_factors"])
        print(f"{r['site_id']:<45} today {t['hazard_index']:>4.1f}  tomorrow {m['hazard_index']:>4.1f}  {factors}")


if __name__ == "__main__":
    main()
