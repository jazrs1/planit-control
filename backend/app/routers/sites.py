from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response
from psycopg_pool import ConnectionPool
from pydantic import TypeAdapter

from alerts import approach, engine
from app import clock, site_data
from app.cache import api_cache
from app.db import get_pool, get_pool_optional
from app.schemas import Beacon, ScoreHistory, Site, SiteDetail
from hazards import model_scores

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
    """Tiny state for a hardware alarm: stop > approaching > flood > clear, with seconds to the
    lightning all-clear or minutes until the storm arrives. App clock (simulated during replay).
    Cached like /alerts; alert and advisory changes clear the cache."""
    if site_data.known_site(site_id) is None:
        raise HTTPException(status_code=404, detail=f"Site '{site_id}' not found")

    def compute() -> bytes:
        now, replay = clock.now(), clock.is_simulated()
        with pool.connection() as conn:
            alerts = engine.active_alerts(conn, now, replay, site_id=site_id)
            advisories = approach.active_advisories(conn, replay, site_id=site_id)
        return _json(_beacon, approach.beacon(site_id, alerts, advisories[0] if advisories else None, now))

    return Response(api_cache.get_or_compute(("beacon", site_id, clock.is_simulated()), compute),
                    media_type="application/json")
