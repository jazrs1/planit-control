import asyncio
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from fastapi.responses import JSONResponse
from psycopg_pool import ConnectionPool
from pydantic import TypeAdapter

from app import mocks, site_data
from app.admin import ADMIN_HEADER, check_admin_token, send_all_limit, send_site_limit
from app.cache import api_cache
from app.db import get_pool, get_pool_optional
from app.schemas import Briefing, SendBriefingRequest, SendBriefingResponse
from briefing import service

router = APIRouter(prefix="/briefing", tags=["briefing"])
list_router = APIRouter(tags=["briefing"])
log = logging.getLogger(__name__)
_briefings = TypeAdapter(list[Briefing])
_all_running = False   # a send-now for all sites is writing briefings in the background


@list_router.get("/briefings", response_model=list[Briefing])
def list_briefings(pool: ConnectionPool = Depends(get_pool)):
    """The latest briefing for every site in one response (largest plant first). Cached for
    API_CACHE_SECONDS; generating briefings clears the cache. 503 without a database: briefings
    are never shown from samples."""
    def compute() -> bytes:
        rows = [service.to_response(r) for r in service.latest_all(pool)]
        return _briefings.dump_json(_briefings.validate_python(rows))

    return Response(api_cache.get_or_compute(("briefings",), compute), media_type="application/json")


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
async def send_now(body: SendBriefingRequest | None = None, pool: ConnectionPool = Depends(get_pool),
                   x_admin_token: str | None = Header(None, alias=ADMIN_HEADER)):
    """Generate tomorrow's briefing now: one site (returned right away; at most once a minute per
    site) or all sites (in the background, 202; needs the X-Admin-Token demo code, at most once per
    15 minutes and not while a run is in progress). Replaces any briefing already stored for that day."""
    global _all_running
    body = body or SendBriefingRequest()
    if body.site_id and body.site_id not in site_data._real_sites():
        raise HTTPException(404, f"Site '{body.site_id}' not found")
    if body.site_id:
        send_site_limit.hit(body.site_id)
        done = await asyncio.to_thread(service.generate, pool, [body.site_id])
        if not done:
            raise HTTPException(404, f"Site '{body.site_id}' not found")
        return {"generated": [service.to_response(service.latest(pool, body.site_id))], "queued": 0}

    check_admin_token(x_admin_token)   # before the limit, so a bad request can't use up the window
    if _all_running:
        raise HTTPException(409, "Briefings for all sites are already being written.")
    send_all_limit.hit("all")
    with pool.connection() as conn:
        count = conn.execute("SELECT count(*) AS n FROM sites").fetchone()["n"]

    async def run_all():
        global _all_running
        try:
            await asyncio.to_thread(service.generate, pool, None)
        except Exception:  # noqa: BLE001 - background; logged
            log.exception("send-now for all sites failed")
        finally:
            _all_running = False

    _all_running = True
    asyncio.get_running_loop().create_task(run_all())
    return JSONResponse({"generated": [], "queued": count}, status_code=status.HTTP_202_ACCEPTED)
