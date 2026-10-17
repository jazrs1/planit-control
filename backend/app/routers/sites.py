from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response
from psycopg_pool import ConnectionPool
from pydantic import TypeAdapter

from app import clock, site_data
from app.cache import api_cache
from app.db import get_pool_optional
from app.schemas import ScoreHistory, Site, SiteDetail
from hazards import model_scores

router = APIRouter(prefix="/sites", tags=["sites"])

_sites = TypeAdapter(list[Site])
_detail = TypeAdapter(SiteDetail)


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
