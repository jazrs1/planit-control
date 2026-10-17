from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response
from psycopg_pool import ConnectionPool
from pydantic import TypeAdapter

from alerts import approach, engine
from app import clock, site_data
from app.cache import api_cache
from app.config import get_settings
from app.db import get_pool, get_pool_optional
from app.schemas import Beacon, ScoreHistory, Site, SiteDetail
from hazards import model_scores
from lightning import health

router = APIRouter(prefix="/sites", tags=["sites"])

_sites = TypeAdapter(list[Site])
_detail = TypeAdapter(SiteDetail)
_beacon = TypeAdapter(Beacon)


def _json(adapter: TypeAdapter, data) -> bytes:
    # Same as FastAPI's response_model handling (validate, which drops extra keys, then dump),
    # done once per cache window instead of once per request.
    return adapter.dump_json(adapter.validate_python(data))


@router.get("", response_model=list[Site])
def list_sites(pool: ConnectionPool | None = Depends(get_pool_optional)):
    body = api_cache.get_or_compute(("sites", clock.is_simulated()),
                                    lambda: _json(_sites, site_data.list_sites(pool)))
    return Response(body, media_type="application/json")


@router.get("/{site_id}", response_model=SiteDetail)
def get_site(site_id: str, pool: ConnectionPool | None = Depends(get_pool_optional)):
    def compute() -> bytes | None:
        detail = site_data.get_site_detail(pool, site_id)
        return None if detail is None else _json(_detail, detail)

    body = api_cache.get_or_compute(("site", site_id, clock.is_simulated()), compute)
    if body is None:
        raise HTTPException(status_code=404, detail=f"Site '{site_id}' not found")
    return Response(body, media_type="application/json")


@router.get("/{site_id}/score-history", response_model=ScoreHistory)
def score_history(site_id: str, pool: ConnectionPool | None = Depends(get_pool_optional)):
    """Today's and tomorrow's hazard index at every hourly scoring run in the last 7 days (sparkline)."""
    site = site_data.known_site(site_id)
    if site is None:
        raise HTTPException(status_code=404, detail=f"Site '{site_id}' not found")
    if pool is None:
        return {"site_id": site_id, "points": []}
    with pool.connection() as conn:
        # Scores are stored on real time (pollers ignore the replay clock), so history uses it too.
        points = model_scores.history(conn, site, datetime.now(timezone.utc))
    return {"site_id": site_id, "points": points}


@router.get("/{site_id}/beacon", response_model=Beacon)
def site_beacon(site_id: str, pool: ConnectionPool = Depends(get_pool)):
    """Tiny state for a hardware alarm: stop > unknown > approaching > flood > clear, with seconds to
    the lightning all-clear or minutes until the storm arrives. The real state is worked out on real
    time; during a replay the replay's state is worked out on the replay clock too, and the real one
    wins unless it's clear (approach.combine_beacons): a real stop-work, unknown, advisory or flood alert
    is never hidden or outranked by a replay. `replay` is true only when the shown state is the replay's. "unknown" when lightning ingestion hasn't succeeded in the last 2 minutes on
    that clock (lightning/health.py). A backend with live ingestion turned off (LIGHTNING_INGEST_ENABLED)
    has no real lightning layer to report during a replay, so only a real stop-work counts there.
    Cached like /alerts; alert and advisory changes clear the cache."""
    if site_data.known_site(site_id) is None:
        raise HTTPException(status_code=404, detail=f"Site '{site_id}' not found")

    def compute() -> bytes:
        with pool.connection() as conn:
            real = _mode_beacon(conn, site_id, clock.real_now(), replay=False)
            states = [real]
            if clock.is_simulated():
                # Ingestion off here means "no live data by design", not a stalled feed: its real "unknown"
                # mustn't hide the replay. A real stop-work (written by another backend) still counts.
                if not get_settings().lightning_ingest_enabled and real["state"] != "stop":
                    states = []
                states.append(_mode_beacon(conn, site_id, clock.now(), replay=True))
        return _json(_beacon, approach.combine_beacons(states))

    return Response(api_cache.get_or_compute(("beacon", site_id, clock.is_simulated()), compute),
                    media_type="application/json")


def _mode_beacon(conn, site_id: str, now, *, replay: bool) -> dict:
    """The beacon from one mode's alerts and advisory (real or replay), on that mode's clock."""
    alerts = engine.active_alerts(conn, now, replay, site_id=site_id)
    advisories = approach.active_advisories(conn, replay, site_id=site_id)
    state = approach.beacon(site_id, alerts, advisories[0] if advisories else None, now,
                            health.is_current(now, replay=replay))
    return {**state, "replay": replay}
