"""Storm cells from recent lightning, their motion, and when they'll reach a site. Pure functions.

  1. Cluster: DBSCAN on the last 20 minutes of flashes (miles on a local flat projection).
     A cell needs MIN_CELL_FLASHES; scattered flashes are noise.
  2. Track: split each cell's flashes into four 5-minute windows, take each window's centroid,
     and fit a straight line through them (weighted by flash count) -> velocity. A cell is
     "tracked" only with flashes in at least 3 windows, including the latest one, a small fit
     residual, and a plausible speed. Splits and merges show up as big residuals and are dropped.
  3. Arrive: the cell's leading edge (center + the radius of its last 5 minutes of flashes) moving
     at that velocity; when does it first come within the 10-mile stop-work ring of a site?

Docs: docs/lightning-forecast.md. Used by alerts/approach.py (every ingestion cycle), GET
/lightning/cells, and scripts/evaluate_lightning_forecast.py (replay lead times).
"""

import math
from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np

HISTORY = timedelta(minutes=20)
WINDOW = timedelta(minutes=5)
EPS_MI = 3.0                # DBSCAN neighborhood radius
MIN_SAMPLES = 5             # flashes within EPS_MI for a core point
MIN_CELL_FLASHES = 20       # in the last 20 minutes
MIN_WINDOW_FLASHES = 3      # for a 5-minute window's centroid to count
MIN_TRACK_WINDOWS = 3
MAX_RESIDUAL_MI = 2.5       # weighted RMS distance of the window centroids from the fitted line
MAX_SPEED_MPH = 60.0        # Florida storms rarely move faster; faster "motion" is a split or merge
MIN_SPEED_MPH = 2.0         # slower than this counts as stationary
MIN_RADIUS_MI = 1.0
RING_MI = 10.0              # the stop-work radius (alerts/engine.py)
LEADING_EDGE = "earliest"   # see arrival()
HORIZON = timedelta(minutes=60)
MI_PER_DEG_LAT = 69.0
COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


@dataclass(frozen=True)
class Cell:
    id: str
    lat: float                 # center now (fitted position when tracked, else the latest centroid)
    lon: float
    flash_count: int           # last 20 minutes
    recent_flashes: int        # last 5 minutes
    radius_mi: float           # 90th percentile distance of the last 5 minutes' flashes from the center
    last_flash_at: datetime
    tracked: bool
    speed_mph: float | None    # None when not tracked
    heading_deg: float | None  # direction of motion, degrees clockwise from north
    residual_mi: float | None
    edge: tuple[tuple[float, float], ...] = ()   # (lat, lon) of the last 5 minutes' flashes: the cell's extent


@dataclass(frozen=True)
class Arrival:
    cell_id: str
    arrival_at: datetime
    minutes: float
    from_bearing_deg: float    # where the storm is, seen from the site
    distance_mi: float         # leading edge to the site, now
    speed_mph: float
    heading_deg: float
    cell_flashes: int


# ---------- geometry ----------

def _xy(lat, lon, lat0: float, lon0: float) -> tuple[np.ndarray, np.ndarray]:
    """Miles east/north of (lat0, lon0) on a flat projection (fine within ~100 mi)."""
    lat, lon = np.asarray(lat, dtype=float), np.asarray(lon, dtype=float)
    return (lon - lon0) * MI_PER_DEG_LAT * math.cos(math.radians(lat0)), (lat - lat0) * MI_PER_DEG_LAT


def _latlon(x: float, y: float, lat0: float, lon0: float) -> tuple[float, float]:
    return lat0 + y / MI_PER_DEG_LAT, lon0 + x / (MI_PER_DEG_LAT * math.cos(math.radians(lat0)))


def compass(bearing_deg: float) -> str:
    return COMPASS[int((bearing_deg % 360) / 22.5 + 0.5) % 16]


def bearing(dx: float, dy: float) -> float:
    """Compass bearing (0 = north, 90 = east) of the vector (dx east, dy north)."""
    return math.degrees(math.atan2(dx, dy)) % 360


# ---------- 1. clustering ----------

def dbscan(x: np.ndarray, y: np.ndarray, eps: float = EPS_MI, min_samples: int = MIN_SAMPLES) -> np.ndarray:
    """Cluster labels (0..k-1; -1 = noise). Grid-bucketed neighbor search, so it scales to the
    tens of thousands of flashes a busy Florida afternoon produces."""
    n = len(x)
    labels = np.full(n, -1)
    if n == 0:
        return labels
    gx, gy = np.floor(x / eps).astype(int), np.floor(y / eps).astype(int)
    buckets: dict[tuple[int, int], list[int]] = {}
    for i, key in enumerate(zip(gx.tolist(), gy.tolist())):
        buckets.setdefault(key, []).append(i)
    eps2 = eps * eps

    def neighbors(i: int) -> np.ndarray:
        cand = np.array([j for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                         for j in buckets.get((gx[i] + dx, gy[i] + dy), ())])
        d2 = (x[cand] - x[i]) ** 2 + (y[cand] - y[i]) ** 2
        return cand[d2 <= eps2]

    visited = np.zeros(n, dtype=bool)
    cluster = 0
    for i in range(n):
        if visited[i]:
            continue
        visited[i] = True
        seeds = neighbors(i)
        if len(seeds) < min_samples:
            continue
        labels[i] = cluster
        queue = list(seeds)
        while queue:
            j = queue.pop()
            if labels[j] == -1:
                labels[j] = cluster
            if visited[j]:
                continue
            visited[j] = True
            nbrs = neighbors(j)
            if len(nbrs) >= min_samples:
                queue.extend(k for k in nbrs.tolist() if not visited[k] or labels[k] == -1)
        cluster += 1
    return labels


# ---------- 2. tracking ----------

def _track(t_min: np.ndarray, x: np.ndarray, y: np.ndarray) -> tuple[float, float, float, float, float, int] | None:
    """Fit position(t) through the 5-minute window centroids. t_min = minutes before now (<= 0).
    Returns (x_now, y_now, vx, vy in mi/min, weighted RMS residual, windows used) or None."""
    n_windows = int(HISTORY / WINDOW)
    idx = np.clip(((t_min + HISTORY.total_seconds() / 60) // (WINDOW.total_seconds() / 60)).astype(int), 0, n_windows - 1)
    cents, counts, mids = [], [], []
    for w in range(n_windows):
        m = idx == w
        if m.sum() >= MIN_WINDOW_FLASHES:
            cents.append((x[m].mean(), y[m].mean()))
            counts.append(m.sum())
            mids.append(t_min[m].mean())
    latest_ok = (idx == n_windows - 1).sum() >= MIN_WINDOW_FLASHES   # still active in the last 5 minutes
    if len(cents) < MIN_TRACK_WINDOWS or not latest_ok:
        return None
    c, wts, tm = np.array(cents), np.array(counts, dtype=float), np.array(mids)
    A = np.column_stack([np.ones_like(tm), tm]) * np.sqrt(wts)[:, None]
    (x0, vx), *_ = np.linalg.lstsq(A, c[:, 0] * np.sqrt(wts), rcond=None)
    (y0, vy), *_ = np.linalg.lstsq(A, c[:, 1] * np.sqrt(wts), rcond=None)
    res = np.hypot(c[:, 0] - (x0 + vx * tm), c[:, 1] - (y0 + vy * tm))
    rms = float(np.sqrt(np.sum(wts * res ** 2) / wts.sum()))
    return float(x0), float(y0), float(vx), float(vy), rms, len(cents)


def find_cells(ts: list[datetime] | np.ndarray, lats, lons, now: datetime) -> list[Cell]:
    """Storm cells from flashes in the 20 minutes up to `now` (later flashes are ignored)."""
    ts = np.asarray(ts)
    lats, lons = np.asarray(lats, dtype=float), np.asarray(lons, dtype=float)
    if len(ts) == 0:
        return []
    age_min = np.array([(t - now).total_seconds() / 60 for t in ts])
    keep = (age_min > -HISTORY.total_seconds() / 60) & (age_min <= 0)
    ts, lats, lons, age_min = ts[keep], lats[keep], lons[keep], age_min[keep]
    if len(ts) < MIN_CELL_FLASHES:
        return []
    lat0, lon0 = float(lats.mean()), float(lons.mean())
    x, y = _xy(lats, lons, lat0, lon0)
    labels = dbscan(x, y)
    cells = []
    for k in range(labels.max() + 1):
        m = labels == k
        if m.sum() < MIN_CELL_FLASHES:
            continue
        recent = m & (age_min > -WINDOW.total_seconds() / 60)
        fit = _track(age_min[m], x[m], y[m])
        speed = heading = residual = None
        tracked = False
        if fit:
            fx, fy, vx, vy, rms, _ = fit
            mph = math.hypot(vx, vy) * 60
            if rms <= MAX_RESIDUAL_MI and mph <= MAX_SPEED_MPH:
                tracked, residual = True, rms
                speed, heading = (mph, bearing(vx, vy)) if mph >= MIN_SPEED_MPH else (0.0, None)
                cx, cy = fx, fy
        if not tracked:
            src = recent if recent.sum() else m
            cx, cy = float(x[src].mean()), float(y[src].mean())
        src = recent if recent.sum() else m
        radius = float(np.percentile(np.hypot(x[src] - cx, y[src] - cy), 90)) if src.sum() else MIN_RADIUS_MI
        clat, clon = _latlon(cx, cy, lat0, lon0)
        cells.append(Cell(id="", lat=round(clat, 4), lon=round(clon, 4), flash_count=int(m.sum()),
                          recent_flashes=int(recent.sum()), radius_mi=round(max(radius, MIN_RADIUS_MI), 2),
                          last_flash_at=max(ts[m]), tracked=tracked,
                          speed_mph=None if speed is None else round(speed, 1),
                          heading_deg=None if heading is None else round(heading, 1),
                          residual_mi=None if residual is None else round(residual, 2),
                          edge=tuple(zip(lats[src].tolist(), lons[src].tolist()))))
    cells.sort(key=lambda c: -c.flash_count)
    return [Cell(**{**c.__dict__, "id": f"cell-{i + 1}"}) for i, c in enumerate(cells)]


# ---------- 3. arrival ----------

def arrival(cell: Cell, site_lat: float, site_lon: float, now: datetime,
            ring_mi: float = RING_MI, horizon: timedelta = HORIZON, edge: str | None = None) -> Arrival | None:
    """When the cell's leading edge first comes within `ring_mi` of the site, if within `horizon`.

    Leading edge (`edge`, default LEADING_EDGE):
      "nearest_flash": the cell's flash from the last 5 minutes nearest the site, moving with the cell;
      "radius":        the center plus the 90th-percentile radius of those flashes;
      "earliest":      whichever of the two reaches the ring first (when unsure, warn earlier).
    Untracked cells are never projected; a stationary tracked cell only counts if it's already there."""
    if not cell.tracked:
        return None
    edge = edge or LEADING_EDGE
    if edge == "earliest":
        found = [a for e in ("nearest_flash", "radius") if (a := arrival(cell, site_lat, site_lon, now, ring_mi, horizon, e))]
        return min(found, key=lambda a: a.arrival_at) if found else None
    cx, cy = (float(v) for v in _xy(cell.lat, cell.lon, site_lat, site_lon))  # center relative to the site
    if edge == "nearest_flash" and cell.edge:
        ex, ey = _xy([p[0] for p in cell.edge], [p[1] for p in cell.edge], site_lat, site_lon)
        i = int(np.argmin(np.hypot(ex, ey)))
        dx, dy, reach = float(ex[i]), float(ey[i]), ring_mi
    else:
        dx, dy, reach = cx, cy, ring_mi + cell.radius_mi
    dist2 = dx * dx + dy * dy
    speed = cell.speed_mph or 0.0
    if dist2 <= reach * reach:
        minutes = 0.0
    elif speed <= 0 or cell.heading_deg is None:
        return None
    else:
        v = speed / 60  # mi/min
        vx, vy = v * math.sin(math.radians(cell.heading_deg)), v * math.cos(math.radians(cell.heading_deg))
        b = dx * vx + dy * vy            # < 0 when closing
        disc = b * b - v * v * (dist2 - reach * reach)
        if b >= 0 or disc < 0:
            return None                  # moving away, or passes by without reaching the ring
        minutes = (-b - math.sqrt(disc)) / (v * v)
        if minutes > horizon.total_seconds() / 60:
            return None
    return Arrival(cell_id=cell.id, arrival_at=now + timedelta(minutes=minutes), minutes=round(minutes, 1),
                   from_bearing_deg=round(bearing(cx, cy), 1),
                   distance_mi=round(max(0.0, math.sqrt(dist2) - (reach - ring_mi)), 1),
                   speed_mph=speed, heading_deg=cell.heading_deg if cell.heading_deg is not None else 0.0,
                   cell_flashes=cell.flash_count)


def earliest_arrival(cells: list[Cell], site_lat: float, site_lon: float, now: datetime,
                     edge: str | None = None) -> Arrival | None:
    found = [a for c in cells if (a := arrival(c, site_lat, site_lon, now, edge=edge))]
    return min(found, key=lambda a: a.arrival_at) if found else None
