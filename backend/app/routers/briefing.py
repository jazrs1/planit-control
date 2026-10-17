import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from psycopg_pool import ConnectionPool

from app import mocks, site_data
from app.db import get_pool, get_pool_optional
from app.schemas import Briefing, SendBriefingRequest, SendBriefingResponse
from briefing import service

router = APIRouter(prefix="/briefing", tags=["briefing"])
log = logging.getLogger(__name__)


@router.get("/{site_id}", response_model=Briefing)
def get_briefing(site_id: str, pool: ConnectionPool | None = Depends(get_pool_optional)):
    """The latest next-day briefing for the site, with its key numbers."""
    if site_id not in site_data._real_sites():
        raise HTTPException(404, f"Site '{site_id}' not found")
    if pool is None:  # no database: sample briefings (shared/mocks)
        briefing = mocks.load("briefings").get(site_id)
    else:
        row = service.latest(pool, site_id)
        briefing = service.to_response(row) if row else None
    if briefing is None:
        raise HTTPException(404, f"No briefing yet for '{site_id}'. They are generated at 6 PM site time; "
                                 "POST /briefing/send-now to make one now.")
    return briefing


@router.post("/send-now", response_model=SendBriefingResponse)
async def send_now(body: SendBriefingRequest | None = None, pool: ConnectionPool = Depends(get_pool)):
    """Generate tomorrow's briefing now: one site (returned right away) or all sites (in the
    background; 202). Replaces any briefing already stored for that day."""
    body = body or SendBriefingRequest()
    if body.site_id and body.site_id not in site_data._real_sites():
        raise HTTPException(404, f"Site '{body.site_id}' not found")
    if body.site_id:
        done = await asyncio.to_thread(service.generate, pool, [body.site_id])
        if not done:
            raise HTTPException(404, f"Site '{body.site_id}' not found")
        return {"generated": [service.to_response(service.latest(pool, body.site_id))], "queued": 0}

    with pool.connection() as conn:
        count = conn.execute("SELECT count(*) AS n FROM sites").fetchone()["n"]

    async def run_all():
        try:
            await asyncio.to_thread(service.generate, pool, None)
        except Exception:  # noqa: BLE001 - background; logged
            log.exception("send-now for all sites failed")

    asyncio.get_running_loop().create_task(run_all())
    return JSONResponse({"generated": [], "queued": count}, status_code=status.HTTP_202_ACCEPTED)
