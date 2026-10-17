import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app import db
from app.config import get_settings
from app.routers import alerts, briefing, lightning, replay, reports, sites, uploads
from hazards import scheduler as hazard_scheduler
from lightning import live
from lightning import replay as replay_runner

logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.open_pool()
    settings = get_settings()
    tasks = []
    if settings.lightning_ingest_enabled and settings.database_url:
        tasks.append(asyncio.create_task(live.run_live_loop(db.get_pool(), settings.lightning_poll_seconds)))
    if settings.hazard_polling_enabled and settings.database_url:
        tasks += hazard_scheduler.start(db.get_pool())
    yield
    await replay_runner.runner.stop()
    for task in tasks:
        task.cancel()
    db.close_pool()


app = FastAPI(title="PlanIT Control API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origin_list,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sites.router)
app.include_router(alerts.router)
app.include_router(reports.router)
app.include_router(briefing.router)
app.include_router(uploads.router)
app.include_router(lightning.router)
app.include_router(replay.router)

uploads.UPLOADS_DIR.mkdir(exist_ok=True)
app.mount("/uploads", StaticFiles(directory=uploads.UPLOADS_DIR), name="uploads")


@app.get("/health", tags=["meta"])
def health():
    database = db.ping()
    healthy = database == "ok"
    return JSONResponse(
        status_code=200 if healthy else 503,
        content={"status": "ok" if healthy else "degraded", "database": database},
    )
