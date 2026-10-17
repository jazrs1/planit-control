from datetime import timedelta

from fastapi import APIRouter, Depends, Query, Response
from psycopg_pool import ConnectionPool
from pydantic import TypeAdapter

from alerts import approach
from app import clock
from app.cache import api_cache
from app.db import get_pool
from app.schemas import LightningCell, LightningFlash, LightningRecentCounts
from lightning import cells as cellmod

router = APIRouter(prefix="/lightning", tags=["lightning"])

MAX_FLASHES = 10_000
_flashes = TypeAdapter(list[LightningFlash])
_cells = TypeAdapter(list[LightningCell])
_counts = TypeAdapter(LightningRecentCounts)


def _windows(minutes: int) -> list[tuple[bool, object, object]]:
    """(replay, start, end) for each layer to show: real lightning on real time, always, plus while a
    replay runs the replay's lightning on the replay clock. Replayed flashes are stored with their own
    (historical) strike times, so the two windows never overlap."""
    real_now = clock.real_now()
    windows = [(False, real_now - timedelta(minutes=minutes), real_now)]
    if clock.is_simulated():
        sim_now = clock.now()
        windows.append((True, sim_now - timedelta(minutes=minutes), sim_now))
    return windows


@router.get("/recent", response_model=list[LightningFlash])
def recent_flashes(minutes: int = Query(15, ge=1, le=180), pool: ConnectionPool = Depends(get_pool)):
    """Flashes over Florida (+30 mi) in the last `minutes`, each with `replay`. Real flashes (last
    `minutes` of real time) are always included, newest first, so real lightning never disappears from the
    map; while a replay runs, its flashes (last `minutes` of simulated time, replay: true) follow, newest
    first. Each layer is capped at MAX_FLASHES; GET /lightning/recent/counts has the uncapped counts.
    Cached for API_CACHE_SECONDS, separately for live and replay; replay start/stop clears it (app/cache.py)."""
    def compute() -> bytes:
        rows = []
        with pool.connection() as conn:
            for replay, start, end in _windows(minutes):
                rows += [{**r, "replay": replay} for r in conn.execute(
                    "SELECT ts, lat, lon FROM lightning_flashes WHERE ts > %s AND ts <= %s "
                    "ORDER BY ts DESC LIMIT %s", (start, end, MAX_FLASHES)).fetchall()]
        return _flashes.dump_json(_flashes.validate_python(rows))

    return Response(api_cache.get_or_compute(("lightning", minutes, clock.is_simulated()), compute),
                    media_type="application/json")


@router.get("/recent/counts", response_model=LightningRecentCounts)
def recent_flash_counts(minutes: int = Query(15, ge=1, le=180), pool: ConnectionPool = Depends(get_pool)):
    """How many flashes GET /lightning/recent covers, split real / replay, without its MAX_FLASHES cap.
    replay is 0 when no replay runs. Cached like /lightning/recent."""
    def compute() -> bytes:
        counts = {"minutes": minutes, "real": 0, "replay": 0}
        with pool.connection() as conn:
            for replay, start, end in _windows(minutes):
                counts["replay" if replay else "real"] = conn.execute(
                    "SELECT count(*) AS n FROM lightning_flashes WHERE ts > %s AND ts <= %s", (start, end)).fetchone()["n"]
        return _counts.dump_json(_counts.validate_python(counts))

    return Response(api_cache.get_or_compute(("lightning-counts", minutes, clock.is_simulated()), compute),
                    media_type="application/json")


@router.get("/cells", response_model=list[LightningCell])
def storm_cells(pool: ConnectionPool = Depends(get_pool)):
    """Storm cells from the last 20 minutes of flashes, each with `replay`: real cells (real time) always,
    largest first, then while a replay runs the replay's cells (replay clock), largest first. Center,
    size, flash counts and, when tracked, motion: the same cells the "approaching" forecast uses
    (lightning/cells.py). Ids are per response; replay ones start with "replay-" so the two never clash.
    Cached like /lightning/recent."""
    def compute() -> bytes:
        rows = []
        with pool.connection() as conn:
            for replay, _start, now in _windows(int(cellmod.HISTORY.total_seconds() // 60)):
                rows += [{**c.__dict__, "id": f"replay-{c.id}" if replay else c.id, "replay": replay,
                          "moving_toward": cellmod.compass(c.heading_deg) if c.heading_deg is not None else None}
                         for c in approach.current_cells(conn, now)]
        return _cells.dump_json(_cells.validate_python(rows))

    return Response(api_cache.get_or_compute(("lightning-cells", clock.is_simulated()), compute),
                    media_type="application/json")
