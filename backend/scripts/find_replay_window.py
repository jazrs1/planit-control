"""Find the stormiest August 2025 afternoon near our sites and download it for replay.

    cd backend && python -m scripts.find_replay_window
    python -m scripts.find_replay_window --dates 2025-08-05 2025-08-19 --window-minutes 90

1. For each date, sample one GLM file every --sample-minutes between 18:00 and 23:00 UTC
   (2-7 PM in Florida) and count flashes within 10 mi of any site. Sampling keeps this to
   ~20 files per date instead of ~900.
2. Pick the date with the most, then the --window-minutes stretch of it with the most.
3. Download every file in that stretch to data/replay/<date>_<HHMM>-<HHMM>/ (gitignored),
   ready for POST /replay/start.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from lightning import glm
from lightning.geo import count_near_sites
from lightning.replay import REPLAY_DIR

DEFAULT_DATES = ["2025-08-04", "2025-08-08", "2025-08-12", "2025-08-16", "2025-08-20", "2025-08-24"]
NEAR_MI = 10.0


def keys_between(start: datetime, end: datetime) -> list[str]:
    prefixes, hour = [], start.replace(minute=0, second=0, microsecond=0)
    while hour < end:
        prefixes.append(glm.hour_prefix(hour))
        hour += timedelta(hours=1)
    keys = [k for p in prefixes for k in glm.list_keys(p)]
    return sorted((k for k in keys if start <= glm.file_start(k) < end), key=glm.file_start)


def score(key: str) -> tuple[datetime, int, int, int]:
    """(file start, flashes within 10 mi of a site, Florida flashes, flashes in whole file)."""
    name = key.rsplit("/", 1)[1]
    total, flashes = glm.parse(glm.download(key), name)
    near = count_near_sites([f.lat for f in flashes], [f.lon for f in flashes], NEAR_MI)
    return glm.file_start(name), near, len(flashes), total


def best_window(samples: list[tuple], start: datetime, end: datetime, minutes: int) -> tuple[datetime, int]:
    width = timedelta(minutes=minutes)
    best = (start, -1)
    for t, *_ in samples:
        if t + width > end:
            break
        total = sum(near for s, near, *_ in samples if t <= s < t + width)
        if total > best[1]:
            best = (t, total)
    return best


def download_window(start: datetime, end: datetime) -> tuple[str, int]:
    window = f"{start:%Y-%m-%d_%H%M}-{end:%H%M}"
    dest = REPLAY_DIR / window
    dest.mkdir(parents=True, exist_ok=True)
    keys = keys_between(start, end)

    def fetch(key: str) -> None:
        path = dest / key.rsplit("/", 1)[1]
        if not path.exists():
            tmp = path.with_suffix(".part")
            tmp.write_bytes(glm.download(key))
            tmp.rename(path)

    with ThreadPoolExecutor(8) as pool:
        list(pool.map(fetch, keys))
    return window, len(keys)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dates", nargs="+", default=DEFAULT_DATES)
    parser.add_argument("--start-hour", type=int, default=18, help="UTC")
    parser.add_argument("--end-hour", type=int, default=23, help="UTC")
    parser.add_argument("--sample-minutes", type=int, default=15)
    parser.add_argument("--window-minutes", type=int, default=60)
    parser.add_argument("--no-download", action="store_true")
    args = parser.parse_args()

    print(f"Sampling every {args.sample_minutes} min, {args.start_hour}:00-{args.end_hour}:00 UTC, "
          f"counting flashes within {NEAR_MI:.0f} mi of a site\n")
    print(f"{'date':<12}{'files':>6}{'near sites':>12}{'Florida':>10}{'peak (UTC)':>12}")
    results = {}
    for date in args.dates:
        day = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        start, end = day + timedelta(hours=args.start_hour), day + timedelta(hours=args.end_hour)
        picks = [k for k in keys_between(start, end)
                 if glm.file_start(k).minute % args.sample_minutes == 0 and glm.file_start(k).second < 20]
        with ThreadPoolExecutor(8) as pool:
            samples = sorted(pool.map(score, picks))
        results[date] = (start, end, samples)
        near = sum(s[1] for s in samples)
        peak = max(samples, key=lambda s: s[1])[0] if samples else None
        print(f"{date:<12}{len(samples):>6}{near:>12}{sum(s[2] for s in samples):>10}"
              f"{peak.strftime('%H:%M') if peak else '-':>12}")

    best_date = max(results, key=lambda d: sum(s[1] for s in results[d][2]))
    start, end, samples = results[best_date]
    w_start, w_near = best_window(samples, start, end, args.window_minutes)
    w_end = w_start + timedelta(minutes=args.window_minutes)
    print(f"\nStormiest: {best_date}. Best {args.window_minutes}-min window: "
          f"{w_start:%H:%M}-{w_end:%H:%M} UTC ({w_near} near-site flashes in sampled files)")

    if args.no_download:
        return
    window, count = download_window(w_start, w_end)
    print(f"Downloaded {count} files to data/replay/{window}/")
    print('Replay it: curl -X POST localhost:8000/replay/start -H "content-type: application/json" '
          f"-d '{{\"window\": \"{window}\", \"speed\": 30}}'")


if __name__ == "__main__":
    main()
