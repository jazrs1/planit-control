"""GOES-East (GOES-19) GLM lightning ingestion into lightning_flashes.

One file:  download -> parse with xarray -> absolute UTC flash times -> keep Florida + ~30 mi
           -> insert (once per file, race-safe) -> refresh the 5-minute per-site rollup.
One cycle: ingest_cycle() runs that for a batch of files, then passes the new flashes to
           lightning.alert_hook.on_new_flashes(). Live polling (live.py) and replay (replay.py)
           both call ingest_cycle(); only where the bytes come from and the clock differ.

Data: s3://noaa-goes19/GLM-L2-LCFA/YYYY/DDD/HH/, public, read anonymously over HTTPS.
"""

import io
import logging
import math
import re
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import numpy as np
import xarray as xr
from psycopg_pool import ConnectionPool

log = logging.getLogger(__name__)

BUCKET_URL = "https://noaa-goes19.s3.amazonaws.com"
PRODUCT = "GLM-L2-LCFA"
FILE_SECONDS = 20
HTTP_TIMEOUT = 30
J2000 = datetime(2000, 1, 1, 12, tzinfo=timezone.utc)  # epoch of GLM product_time

# Florida's extent plus a ~30 mile buffer (1° lat ~ 69 mi; 1° lon ~ 59 mi at 31°N, the widest pad).
_FL_LAT, _FL_LON, _BUFFER_MI = (24.40, 31.00), (-87.63, -79.97), 30
_LAT_PAD = _BUFFER_MI / 69.0
_LON_PAD = _BUFFER_MI / (69.17 * math.cos(math.radians(31.0)))
FL_BBOX = {"lat": (_FL_LAT[0] - _LAT_PAD, _FL_LAT[1] + _LAT_PAD),
           "lon": (_FL_LON[0] - _LON_PAD, _FL_LON[1] + _LON_PAD)}

ROLLUP = "lightning_flashes_5m_by_site"
ROLLUP_BUCKET = timedelta(minutes=5)

_S3_NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
_START_RE = re.compile(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)_")


@dataclass(frozen=True)
class Flash:
    ts: datetime
    lat: float
    lon: float
    energy: float | None  # joules
    source_file: str


@dataclass
class CycleResult:
    files_ingested: int = 0
    files_skipped: int = 0
    files_failed: int = 0
    disk_flashes: int = 0  # all flashes in the files (whole GOES-East view)
    new_flashes: list[Flash] = field(default_factory=list)  # Florida flashes inserted this cycle


# ---------- S3 ----------

def file_start(name: str) -> datetime:
    """Scan start time from a GLM file name (…_s20252381800000_…: year, day of year, HHMMSS, tenths)."""
    m = _START_RE.search(name)
    if not m:
        raise ValueError(f"Not a GLM file name: {name}")
    year, doy, hh, mm, ss, tenths = (int(g) for g in m.groups())
    return (datetime(year, 1, 1, tzinfo=timezone.utc)
            + timedelta(days=doy - 1, hours=hh, minutes=mm, seconds=ss, milliseconds=100 * tenths))


def hour_prefix(moment: datetime) -> str:
    return f"{PRODUCT}/{moment:%Y}/{moment:%j}/{moment:%H}/"


def list_keys(prefix: str) -> list[str]:
    keys, token = [], None
    while True:
        params = {"list-type": "2", "prefix": prefix}
        if token:
            params["continuation-token"] = token
        with urllib.request.urlopen(f"{BUCKET_URL}/?{urllib.parse.urlencode(params)}",
                                    timeout=HTTP_TIMEOUT) as resp:
            root = ET.fromstring(resp.read())
        keys += [c.findtext("s3:Key", namespaces=_S3_NS) for c in root.findall("s3:Contents", _S3_NS)]
        if root.findtext("s3:IsTruncated", namespaces=_S3_NS) != "true":
            return keys
        token = root.findtext("s3:NextContinuationToken", namespaces=_S3_NS)


def newest_keys(now: datetime, lookback: timedelta) -> list[str]:
    """Keys of files that started within `lookback` of `now`, oldest first."""
    since = now - lookback
    prefixes = sorted({hour_prefix(since), hour_prefix(now)})
    keys = [k for p in prefixes for k in list_keys(p)]
    return sorted((k for k in keys if since <= file_start(k) <= now), key=file_start)


def download(key: str) -> bytes:
    with urllib.request.urlopen(f"{BUCKET_URL}/{key}", timeout=HTTP_TIMEOUT) as resp:
        return resp.read()


# ---------- Parse ----------

def parse(data: bytes, source_file: str) -> tuple[int, list[Flash]]:
    """(flashes in the whole file, Florida flashes). Times are computed explicitly:
    product_time (seconds since J2000) + flash_time_offset_of_first_event (seconds, may be < 0)."""
    with xr.open_dataset(io.BytesIO(data), engine="h5netcdf", decode_times=False) as ds:
        total = int(ds.sizes.get("number_of_flashes", 0))
        if total == 0:
            return 0, []
        product_time = J2000 + timedelta(seconds=float(ds["product_time"].values))
        offsets = ds["flash_time_offset_of_first_event"].values.astype(float)
        lat = ds["flash_lat"].values.astype(float)
        lon = ds["flash_lon"].values.astype(float)
        energy = ds["flash_energy"].values.astype(float)  # NaN where missing

    # All quality flags are kept: "degraded" flashes are still real lightning, and missing
    # one is worse than an extra one for stop-work alerts.
    keep = ((lat >= FL_BBOX["lat"][0]) & (lat <= FL_BBOX["lat"][1])
            & (lon >= FL_BBOX["lon"][0]) & (lon <= FL_BBOX["lon"][1]) & np.isfinite(offsets))
    flashes = [
        Flash(ts=product_time + timedelta(seconds=o), lat=round(la, 5), lon=round(lo, 5),
              energy=None if math.isnan(e) else e, source_file=source_file)
        for o, la, lo, e in zip(offsets[keep], lat[keep], lon[keep], energy[keep])
    ]
    return total, flashes


# ---------- Database ----------

# Files that had no Florida flashes leave no row in lightning_flashes, so remember them here
# (per process) to avoid re-downloading them every cycle. Files with flashes are tracked by
# source_file in the database, which is the durable record.
_empty_files: dict[str, float] = {}
_empty_lock = threading.Lock()
_EMPTY_TTL_SECONDS = 2 * 3600


def _remember_empty(name: str) -> None:
    with _empty_lock:
        cutoff = time.monotonic() - _EMPTY_TTL_SECONDS
        for old in [n for n, t in _empty_files.items() if t < cutoff]:
            del _empty_files[old]
        _empty_files[name] = time.monotonic()


def forget(names: Iterable[str]) -> None:
    """Make files eligible for ingestion again (replay calls this after resetting its window)."""
    with _empty_lock:
        for n in names:
            _empty_files.pop(n, None)


def processed_files(pool: ConnectionPool, names: list[str]) -> set[str]:
    """Which of these files are already ingested (in lightning_flashes, or known to be empty)."""
    if not names:
        return set()
    with _empty_lock:
        done = {n for n in names if n in _empty_files}
    # Flash times are >= file start - a few seconds; the time bound lets Timescale skip old chunks.
    earliest = min(file_start(n) for n in names) - timedelta(minutes=1)
    with pool.connection() as conn:
        rows = conn.execute(
            "SELECT DISTINCT source_file FROM lightning_flashes WHERE ts >= %s AND source_file = ANY(%s)",
            (earliest, names),
        ).fetchall()
    return done | {r["source_file"] for r in rows}


def _insert_once(pool: ConnectionPool, source_file: str, flashes: list[Flash]) -> bool:
    """Insert a file's flashes unless that file is already in the table. False if it was.
    The advisory lock makes concurrent ingesters (several API processes, live + replay) safe."""
    with pool.connection() as conn, conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (source_file,))
        exists = conn.execute(
            "SELECT 1 FROM lightning_flashes WHERE ts >= %s AND source_file = %s LIMIT 1",
            (file_start(source_file) - timedelta(minutes=1), source_file),
        ).fetchone()
        if exists:
            return False
        with conn.cursor() as cur, cur.copy(
            "COPY lightning_flashes (ts, lat, lon, energy, source_file) FROM STDIN"
        ) as copy:
            for f in flashes:
                copy.write_row((f.ts, f.lat, f.lon, f.energy, f.source_file))
    return True


def refresh_rollup(pool: ConnectionPool, start: datetime, end: datetime) -> None:
    """Materialize the 5-minute per-site rollup for buckets touching [start, end].

    Real-time aggregation already covers brand-new live data; this keeps the rollup right for
    flashes older than its watermark (late files, replay, replay resets).
    """
    epoch = datetime(2000, 1, 1, tzinfo=timezone.utc)
    lo = start - (start - epoch) % ROLLUP_BUCKET
    hi = end - (end - epoch) % ROLLUP_BUCKET + ROLLUP_BUCKET
    with pool.connection() as conn:
        conn.autocommit = True  # CALL refresh_continuous_aggregate can't run inside a transaction
        try:
            conn.execute(f"CALL refresh_continuous_aggregate('{ROLLUP}', %s, %s)", (lo, hi))
        finally:
            conn.autocommit = False


# ---------- Ingest ----------

def ingest_file(pool: ConnectionPool, source_file: str, data: bytes) -> tuple[int, list[Flash] | None]:
    """(flashes in file, Florida flashes inserted). None instead of a list if already ingested."""
    total, flashes = parse(data, source_file)
    if not flashes:
        _remember_empty(source_file)
        return total, []
    if not _insert_once(pool, source_file, flashes):
        return total, None
    try:
        refresh_rollup(pool, min(f.ts for f in flashes), max(f.ts for f in flashes))
    except Exception as err:  # noqa: BLE001 - flashes are committed; the policy job will catch up
        log.warning("Rollup refresh failed for %s: %s", source_file, err)
    return total, flashes


Loader = Callable[[], bytes]


def ingest_cycle(pool: ConnectionPool, files: Iterable[tuple[str, Loader]], now: datetime) -> CycleResult:
    """Ingest a batch of files in order, then hand the new flashes to the alert hook.

    `files` is (source_file name, function returning the file's bytes). A file that fails to
    load or parse is logged and skipped; it is not marked processed, so the next cycle retries it.
    """
    from lightning import alert_hook

    result = CycleResult()
    for name, load in files:
        try:
            total, flashes = ingest_file(pool, name, load())
        except Exception as err:  # noqa: BLE001 - one bad file must not stop the cycle
            result.files_failed += 1
            log.warning("GLM file %s failed: %s: %s", name, type(err).__name__, err)
            continue
        result.disk_flashes += total
        if flashes is None:
            result.files_skipped += 1
        else:
            result.files_ingested += 1
            result.new_flashes += flashes

    try:
        alert_hook.on_new_flashes(result.new_flashes, now)
    except Exception:  # noqa: BLE001 - the alert engine must not break ingestion
        log.exception("Alert hook failed")
    return result


def poll_latest(pool: ConnectionPool, now: datetime, lookback: timedelta = timedelta(minutes=3)) -> CycleResult:
    """One live cycle: ingest every recent GLM file not processed yet."""
    keys = newest_keys(now, lookback)
    done = processed_files(pool, [k.rsplit("/", 1)[1] for k in keys])
    todo = [(k.rsplit("/", 1)[1], lambda k=k: download(k)) for k in keys if k.rsplit("/", 1)[1] not in done]
    return ingest_cycle(pool, todo, now)
