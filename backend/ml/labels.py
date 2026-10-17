"""Site-day hazard labels from NOAA Storm Events (NCEI bulk CSVs).

    cd backend && python -m ml.labels           # download (cached), match, write data/ml/labels.csv.gz

A site-day is hazardous when at least one crew-relevant Storm Events entry touches the site on
that local date:

- Point/path events (county-type rows with lat/lon: thunderstorm wind, hail, tornado, lightning,
  flash flood, flood, heavy rain): the event's begin-end segment passes within 15 mi of the site.
- Zone events (heat, tropical storm, hurricane, coastal flood, wildfire): the event's NWS zone is
  the site's current forecast/fire-weather zone, or the zone's name contains the site's county
  (zones were renumbered several times in 2018-2025, e.g. Brevard 47 -> 247/347/.../747 in 2022).

Event times are local standard time (CZ_TIMEZONE, e.g. EST-5); they're converted to the site's
own timezone before taking the date. Multi-day events label every date they cover.
"""

import argparse
import json
import re
import time
import urllib.request
from datetime import date, timedelta
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from ml.paths import DATA_DIR, USER_AGENT, load_sites

YEARS = list(range(2018, 2026))
NCEI_DIR = "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/"
STORM_DIR = DATA_DIR / "storm_events"
POINTS_PATH = DATA_DIR / "nws_points.json"
LABELS_PATH = DATA_DIR / "labels.csv.gz"
MATCHES_PATH = DATA_DIR / "label_events.csv.gz"

RADIUS_MI = 15.0
HAZARD_GROUPS = {
    "storm": ["Thunderstorm Wind", "Lightning", "Hail", "Tornado", "Tropical Storm", "Hurricane (Typhoon)"],
    "flood": ["Flash Flood", "Flood", "Heavy Rain", "Coastal Flood"],
    # NWS renamed Excessive Heat to Extreme Heat in March 2025.
    "heat": ["Heat", "Excessive Heat", "Extreme Heat"],
    "fire": ["Wildfire"],
}
EVENT_GROUP = {t: g for g, types in HAZARD_GROUPS.items() for t in types}
# Misspellings that appear in CZ_NAME.
ZONE_NAME_FIXES = {"PUTNUM": "PUTNAM", "INALND": "INLAND"}


# ---------- downloads ----------

def storm_event_files() -> dict[int, str]:
    """Newest detail file name per year from the NCEI directory listing."""
    listing = urllib.request.urlopen(urllib.request.Request(NCEI_DIR, headers={"User-Agent": USER_AGENT})).read().decode()
    names = sorted(set(re.findall(r"StormEvents_details-ftp_v1\.0_d(\d{4})_c(\d{8})\.csv\.gz", listing)))
    latest: dict[int, str] = {}
    for year, created in names:
        latest[int(year)] = f"StormEvents_details-ftp_v1.0_d{year}_c{created}.csv.gz"
    return latest


def download_storm_events(years: list[int]) -> list:
    STORM_DIR.mkdir(parents=True, exist_ok=True)
    files = storm_event_files()
    paths = []
    for year in years:
        name = files[year]
        path = STORM_DIR / name
        stale = [p for p in STORM_DIR.glob(f"StormEvents_details-ftp_v1.0_d{year}_c*.csv.gz") if p != path]
        if not path.exists():
            print(f"downloading {name}", flush=True)
            urllib.request.urlretrieve(NCEI_DIR + name, path)
        for p in stale:
            p.unlink()
        paths.append(path)
    return paths


def nws_points(sites: list[dict]) -> dict[str, dict]:
    """Forecast zone, county, and fire-weather zone per site from api.weather.gov (cached)."""
    cached = json.loads(POINTS_PATH.read_text()) if POINTS_PATH.exists() else {}
    for site in sites:
        if site["id"] in cached:
            continue
        p = _get_nws(f"https://api.weather.gov/points/{site['lat']:.4f},{site['lon']:.4f}")["properties"]
        zone_id = p["forecastZone"].rsplit("/", 1)[1]
        cached[site["id"]] = {
            "cwa": p["cwa"],
            "forecast_zone": zone_id,
            "forecast_zone_name": _get_nws(p["forecastZone"])["properties"]["name"],
            "county_zone": p["county"].rsplit("/", 1)[1],
            "fire_zone": p["fireWeatherZone"].rsplit("/", 1)[1],
        }
        print(f"nws {site['id']}: {cached[site['id']]}", flush=True)
        time.sleep(0.5)
    POINTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    POINTS_PATH.write_text(json.dumps(cached, indent=1, sort_keys=True))
    return cached


def _get_nws(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/geo+json"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp)
        except Exception:
            if attempt == 4:
                raise
            time.sleep(3 * (attempt + 1))
    raise AssertionError


# ---------- event parsing ----------

def load_events(paths: list) -> pd.DataFrame:
    """Florida rows of the crew-relevant event types, with UTC begin/end times."""
    cols = ["EVENT_ID", "EPISODE_ID", "EVENT_TYPE", "CZ_TYPE", "CZ_FIPS", "CZ_NAME", "CZ_TIMEZONE", "STATE",
            "BEGIN_YEARMONTH", "BEGIN_DAY", "BEGIN_TIME", "END_YEARMONTH", "END_DAY", "END_TIME",
            "BEGIN_LAT", "BEGIN_LON", "END_LAT", "END_LON", "MAGNITUDE"]
    df = pd.concat([pd.read_csv(p, usecols=cols, low_memory=False) for p in paths], ignore_index=True)
    df = df[(df.STATE == "FLORIDA") & df.EVENT_TYPE.isin(EVENT_GROUP.keys())].copy()
    df["group"] = df.EVENT_TYPE.map(EVENT_GROUP)
    df["begin_utc"] = _to_utc(df.BEGIN_YEARMONTH, df.BEGIN_DAY, df.BEGIN_TIME, df.CZ_TIMEZONE)
    df["end_utc"] = _to_utc(df.END_YEARMONTH, df.END_DAY, df.END_TIME, df.CZ_TIMEZONE)
    df["end_utc"] = df[["begin_utc", "end_utc"]].max(axis=1)
    df["zone_name"] = df.CZ_NAME.map(_normalize_name)
    return df.reset_index(drop=True)


def _to_utc(yearmonth: pd.Series, day: pd.Series, hhmm: pd.Series, tz: pd.Series) -> pd.Series:
    """Storm Events local times use a fixed offset given in CZ_TIMEZONE ('EST-5', 'CST-6', 'EDT-4')."""
    offset_h = tz.str.extract(r"([+-]\d+)$")[0].astype(int)
    local = pd.to_datetime(
        dict(year=yearmonth // 100, month=yearmonth % 100, day=day, hour=hhmm // 100, minute=hhmm % 100)
    )
    return (local - pd.to_timedelta(offset_h, unit="h")).dt.tz_localize("UTC")


def _normalize_name(name: str) -> str:
    words = re.sub(r"[^A-Z. ]", " ", str(name).upper().replace("-", " ")).split()
    return " " + " ".join(ZONE_NAME_FIXES.get(w, w) for w in words) + " "


# ---------- matching ----------

def segment_distance_mi(site_lat: float, site_lon: float, lat1, lon1, lat2, lon2) -> np.ndarray:
    """Distance from a site to each begin->end segment, on a local flat projection (fine at <50 mi)."""
    kx = 69.172 * np.cos(np.radians(site_lat))
    ky = 69.0
    ax, ay = (lon1 - site_lon) * kx, (lat1 - site_lat) * ky
    bx, by = (lon2 - site_lon) * kx, (lat2 - site_lat) * ky
    dx, dy = bx - ax, by - ay
    seg2 = dx * dx + dy * dy
    t = np.where(seg2 > 0, np.clip(-(ax * dx + ay * dy) / np.where(seg2 > 0, seg2, 1), 0, 1), 0)
    return np.hypot(ax + t * dx, ay + t * dy)


def match_site(site: dict, nws: dict, events: pd.DataFrame) -> pd.DataFrame:
    """Events that touch one site, with how they matched."""
    has_point = (events.CZ_TYPE == "C") & events.BEGIN_LAT.notna()
    pts = events[has_point]
    lat2 = pts.END_LAT.fillna(pts.BEGIN_LAT).to_numpy()
    lon2 = pts.END_LON.fillna(pts.BEGIN_LON).to_numpy()
    dist = segment_distance_mi(site["lat"], site["lon"], pts.BEGIN_LAT.to_numpy(), pts.BEGIN_LON.to_numpy(), lat2, lon2)
    near = pts[dist <= RADIUS_MI].assign(match="radius", distance_mi=dist[dist <= RADIUS_MI])

    county_fips = int(nws["county_zone"][3:])
    county_only = events[(events.CZ_TYPE == "C") & events.BEGIN_LAT.isna() & (events.CZ_FIPS == county_fips)]
    county_only = county_only.assign(match="county", distance_mi=np.nan)

    zone_ids = {int(nws["forecast_zone"][3:]), int(nws["fire_zone"][3:])}
    county_name = _normalize_name(site["county"])
    zones = events[events.CZ_TYPE == "Z"]
    in_zone = zones.CZ_FIPS.isin(zone_ids) | zones.zone_name.str.contains(county_name, regex=False)
    zoned = zones[in_zone].assign(match="zone", distance_mi=np.nan)
    return pd.concat([near, county_only, zoned])


def local_dates(begin_utc: pd.Timestamp, end_utc: pd.Timestamp, tz: str) -> list[date]:
    zone = ZoneInfo(tz)
    first = begin_utc.to_pydatetime().astimezone(zone).date()
    last = end_utc.to_pydatetime().astimezone(zone).date()
    return [first + timedelta(days=i) for i in range((last - first).days + 1)]


def build_labels(sites: list[dict], points: dict[str, dict], events: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    rows = []
    for site in sites:
        matched = match_site(site, points[site["id"]], events)
        for ev in matched.itertuples():
            for d in local_dates(ev.begin_utc, ev.end_utc, site["timezone"]):
                rows.append((site["id"], d, ev.EVENT_ID, ev.EVENT_TYPE, ev.group, ev.match, ev.distance_mi))
    matches = pd.DataFrame(rows, columns=["site_id", "date", "event_id", "event_type", "group", "match", "distance_mi"])
    matches = matches[(matches.date >= date(YEARS[0], 1, 1)) & (matches.date <= date(YEARS[-1], 12, 31))]

    grid = pd.MultiIndex.from_product(
        [[s["id"] for s in sites], pd.date_range(f"{YEARS[0]}-01-01", f"{YEARS[-1]}-12-31").date],
        names=["site_id", "date"],
    )
    labels = pd.DataFrame(index=grid)
    for group in HAZARD_GROUPS:
        hit = matches[matches.group == group].groupby(["site_id", "date"]).size()
        labels[group] = labels.index.isin(hit.index).astype(int)
    labels["hazard"] = labels[list(HAZARD_GROUPS)].max(axis=1)
    per_day = matches.groupby(["site_id", "date"])
    labels["n_events"] = per_day.event_id.nunique().reindex(grid).fillna(0).astype(int)
    labels["event_types"] = per_day.event_type.agg(lambda s: ";".join(sorted(set(s)))).reindex(grid).fillna("")
    return labels.reset_index(), matches


def summarize(labels: pd.DataFrame) -> None:
    year = pd.to_datetime(labels.date).dt.year
    print(f"\n{len(labels):,} site-days, base rate {labels.hazard.mean():.2%}")
    print("base rate by year (any / storm / flood / heat / fire):")
    print(labels.groupby(year)[["hazard", *HAZARD_GROUPS]].mean().map(lambda v: f"{v:.2%}").to_string())


def main() -> None:
    argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter).parse_args()
    sites = load_sites()
    paths = download_storm_events(YEARS)
    points = nws_points(sites)
    events = load_events(paths)
    print(f"{len(events):,} crew-relevant Florida events 2018-2025")
    labels, matches = build_labels(sites, points, events)
    labels.to_csv(LABELS_PATH, index=False)
    matches.to_csv(MATCHES_PATH, index=False)
    print(f"wrote {LABELS_PATH} and {MATCHES_PATH}")
    summarize(labels)


if __name__ == "__main__":
    main()
