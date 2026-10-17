"""Open-Meteo client for the hazard model: archived forecasts for training, live forecasts for scoring.

Training and live scoring use the same model (`gfs_seamless`, which is HRRR over Florida for
the first ~48 h), the same hourly variables, and the same units, so the model sees the same
kind of input in both places.

    cd backend && python -m ml.openmeteo            # download everything training needs (resumable)
    python -m ml.openmeteo --years 2024 --previous-runs 2025
    python -m ml.openmeteo --budget                 # show the rolling 24 h spend and stop

Responses are cached as gzipped JSON under data/ml/openmeteo/ and never re-downloaded.

Rate limits. Open-Meteo's free tier allows 10,000 "calls" per day per IP, where one call is one
location x up to 14 days x up to 10 variables (so one site-year costs ~26 calls; fewer variables
don't make it cheaper). The live backend polls the same API from the same machine (55 sites,
hourly = ~1,320 calls/day), so this downloader keeps its own rolling-24 h budget of DAILY_BUDGET
calls in a ledger file and waits before it would go over, instead of starving the live poller.
"""

import argparse
import gzip
import http.client
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

from ml.paths import DATA_DIR, USER_AGENT, load_sites

MODEL = "gfs_seamless"
# Exactly what ml/features.py uses (7 <= 10, so each call is billed at the minimum).
HOURLY_VARS = [
    "temperature_2m",  # tmax_f, heat_index_max_f
    "relative_humidity_2m",  # heat_index_max_f
    "precipitation",  # rain_in, rain_rate_max_in, rain_prior3_in, rain_prior7_in
    "wind_gusts_10m",  # gust_max_mph
    "cape",  # cape_max
    "weather_code",  # thunder_hours
    "soil_moisture_0_to_10cm",  # soil_moisture_pct
]
# The Previous Runs API has no soil moisture for this model.
PREVIOUS_RUN_VARS = [v for v in HOURLY_VARS if not v.startswith("soil_moisture")]
UNITS = {"temperature_unit": "fahrenheit", "precipitation_unit": "inch", "wind_speed_unit": "mph"}

HISTORICAL_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
PREVIOUS_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

CACHE_DIR = DATA_DIR / "openmeteo"
LEDGER_PATH = CACHE_DIR / "ledger.jsonl"
# Train 2022-2023 (GFS soil moisture starts in 2022), validate 2024, test 2025.
YEARS = list(range(2022, 2026))
LEAD_IN_DAYS = 8  # extra days before the first Jan 1 so prior-7-day rain is defined from day one

FREE_TIER_PER_DAY = 10_000
LIVE_POLLER_PER_DAY = 1_320  # backend hazards poller: 55 sites x 24 polls
SAFETY_MARGIN = 900  # poller retries, ad-hoc requests, and error in our own accounting
DAILY_BUDGET = FREE_TIER_PER_DAY - LIVE_POLLER_PER_DAY - SAFETY_MARGIN  # 7,780, rolling 24 h
CALLS_PER_HOUR = 4000  # free tier is 5,000/hour; the poller needs ~55 of it
WINDOW_S = 24 * 3600


# ---------- budget ledger ----------

def _ledger() -> list[tuple[float, float]]:
    if not LEDGER_PATH.exists():
        return []
    return [(e["t"], e["calls"]) for e in map(json.loads, LEDGER_PATH.read_text().splitlines()) if e]


def spent_last_24h(now: float | None = None) -> float:
    now = time.time() if now is None else now
    return sum(c for t, c in _ledger() if t > now - WINDOW_S)


def _spend(weight: float, note: str) -> None:
    """Block until `weight` calls fit in the rolling budget, then record them (before sending:
    Open-Meteo bills a request whether or not it succeeds)."""
    while True:
        now = time.time()
        window = sorted((t, c) for t, c in _ledger() if t > now - WINDOW_S)
        over = sum(c for _, c in window) + weight - DAILY_BUDGET
        if over <= 0:
            break
        freed, until = 0.0, now
        for t, c in window:
            freed += c
            if freed >= over:
                until = t + WINDOW_S
                break
        wait = min(1800.0, max(60.0, until - now + 5))
        print(f"  budget: {sum(c for _, c in window):,.0f}/{DAILY_BUDGET:,} calls used in the last 24 h; "
              f"room for this request at {datetime.fromtimestamp(until):%a %H:%M}, sleeping {wait:.0f}s", flush=True)
        time.sleep(wait)
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER_PATH.open("a") as f:
        f.write(json.dumps({"t": round(time.time(), 1), "calls": round(weight, 2), "note": note}) + "\n")


# ---------- HTTP ----------

def _params(site: dict, hourly: list[str], **extra) -> dict:
    return {
        "latitude": site["lat"],
        "longitude": site["lon"],
        "hourly": ",".join(hourly),
        "models": MODEL,
        "timezone": site["timezone"],
        **UNITS,
        **extra,
    }


def call_weight(n_vars: int, start: date, end: date) -> float:
    days = (end - start).days + 1
    return max(1.0, n_vars / 10) * max(1.0, days / 14)


def get_json(url: str, params: dict, timeout: float = 60, weight: float | None = None, note: str = "") -> dict:
    """GET with retries. Waits out Open-Meteo rate limits instead of failing.

    With `weight`, every attempt is charged to the rolling budget first.
    """
    full = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(full, headers={"User-Agent": USER_AGENT})
    for attempt in range(50):
        if weight is not None:
            _spend(weight, note)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            if e.code == 429:
                wait = 1800 if "Daily" in body else 600 if "Hourly" in body else 65
                print(f"  rate limited ({body.strip()[:80]}); sleeping {wait}s", flush=True)
                time.sleep(wait)
                continue
            if e.code >= 500 and attempt < 5:
                time.sleep(10 * (attempt + 1))
                continue
            raise RuntimeError(f"Open-Meteo {e.code}: {body[:200]}") from e
        except (urllib.error.URLError, TimeoutError, http.client.HTTPException, json.JSONDecodeError):
            # Network errors and truncated bodies are transient.
            if attempt >= 5:
                raise
            time.sleep(10 * (attempt + 1))
    raise RuntimeError("Open-Meteo: gave up after repeated rate limiting")


def _cached(path, fetch):
    if path.exists():
        with gzip.open(path, "rt") as f:
            return json.load(f), False
    data = fetch()
    if "hourly" not in data:
        raise RuntimeError(f"Open-Meteo response without hourly data: {str(data)[:200]}")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wt") as f:
        json.dump({"hourly": data["hourly"], "hourly_units": data.get("hourly_units")}, f)
    tmp.rename(path)
    return data, True


# ---------- endpoints ----------

def year_range(year: int) -> tuple[date, date]:
    start = date(year, 1, 1)
    if year == YEARS[0]:
        start -= timedelta(days=LEAD_IN_DAYS)
    return start, date(year, 12, 31)


def historical_forecast(site: dict, year: int) -> tuple[dict, bool]:
    """Archived short-lead forecasts for one site-year. Returns (payload, downloaded_now)."""
    start, end = year_range(year)
    path = CACHE_DIR / "historical_forecast" / f"{site['id']}_{year}.json.gz"
    params = _params(site, HOURLY_VARS, start_date=start.isoformat(), end_date=end.isoformat())
    weight = call_weight(len(HOURLY_VARS), start, end)
    return _cached(path, lambda: get_json(HISTORICAL_URL, params, weight=weight, note=f"hf {site['id']} {year}"))


def previous_day1(site: dict, year: int) -> tuple[dict, bool]:
    """The forecast issued ~24 h earlier for each hour of the year (the 'tomorrow' forecast)."""
    path = CACHE_DIR / "previous_day1" / f"{site['id']}_{year}.json.gz"
    hourly = [f"{v}_previous_day1" for v in PREVIOUS_RUN_VARS]
    start, end = date(year, 1, 1), date(year, 12, 31)
    params = _params(site, hourly, start_date=start.isoformat(), end_date=end.isoformat())
    weight = call_weight(len(hourly), start, end)
    return _cached(path, lambda: get_json(PREVIOUS_RUNS_URL, params, weight=weight, note=f"day1 {site['id']} {year}"))


def historical_forecast_range(site: dict, start: date, end: date) -> dict:
    """Archived forecasts for an arbitrary date range, for scoring past days. Not cached."""
    params = _params(site, HOURLY_VARS, start_date=start.isoformat(), end_date=end.isoformat())
    weight = call_weight(len(HOURLY_VARS), start, end)
    return get_json(HISTORICAL_URL, params, timeout=30, weight=weight, note=f"score {site['id']} {start}")


def live_forecast(site: dict, past_days: int = LEAD_IN_DAYS, forecast_days: int = 3) -> dict:
    """Current forecast plus the last `past_days` days, for live scoring. Not cached."""
    params = _params(site, HOURLY_VARS, past_days=past_days, forecast_days=forecast_days)
    weight = max(1.0, (past_days + forecast_days) / 14)
    return get_json(FORECAST_URL, params, timeout=30, weight=weight, note=f"live {site['id']}")


# ---------- bulk download ----------

def plan(years: list[int], previous_runs_years: list[int]) -> list[tuple[str, dict, int, float]]:
    """Uncached downloads, in order: validation and training years first (newest first), then the
    day-ahead test forecasts, which only the 'tomorrow' evaluation needs."""
    sites = load_sites()
    jobs = []
    for year in sorted(years, reverse=True):
        for s in sites:
            if not (CACHE_DIR / "historical_forecast" / f"{s['id']}_{year}.json.gz").exists():
                jobs.append(("historical_forecast", s, year, call_weight(len(HOURLY_VARS), *year_range(year))))
    for year in previous_runs_years:
        for s in sites:
            if not (CACHE_DIR / "previous_day1" / f"{s['id']}_{year}.json.gz").exists():
                weight = call_weight(len(PREVIOUS_RUN_VARS), date(year, 1, 1), date(year, 12, 31))
                jobs.append(("previous_day1", s, year, weight))
    return jobs


def download(jobs: list[tuple[str, dict, int, float]]) -> None:
    total = sum(w for *_, w in jobs)
    print(f"{len(jobs)} downloads, ~{total:,.0f} calls; budget {DAILY_BUDGET:,}/24 h, "
          f"{spent_last_24h():,.0f} used in the last 24 h", flush=True)
    done = 0.0
    for i, (kind, site, year, weight) in enumerate(jobs, 1):
        fn = historical_forecast if kind == "historical_forecast" else previous_day1
        t0 = time.monotonic()
        fn(site, year)
        done += weight
        print(f"[{i}/{len(jobs)}] {kind} {site['id']} {year} ({done:,.0f}/{total:,.0f} calls, "
              f"{spent_last_24h():,.0f} in last 24 h)", flush=True)
        pause = weight * 3600 / CALLS_PER_HOUR - (time.monotonic() - t0)
        if pause > 0:
            time.sleep(pause)
    print("done", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--years", type=int, nargs="+", default=YEARS)
    parser.add_argument("--previous-runs", type=int, nargs="*", default=[2025],
                        help="years to fetch day-ahead forecasts for (default: the 2025 test year)")
    parser.add_argument("--budget", action="store_true", help="print the plan and rolling spend, download nothing")
    args = parser.parse_args()
    jobs = plan(args.years, args.previous_runs)
    if args.budget:
        print(f"rolling 24 h spend {spent_last_24h():,.0f}/{DAILY_BUDGET:,}; "
              f"{len(jobs)} downloads pending, ~{sum(w for *_, w in jobs):,.0f} calls")
        return
    download(jobs)


if __name__ == "__main__":
    main()
