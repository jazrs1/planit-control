from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app import db
from app.config import get_settings
from app.routers import alerts, briefing, reports, sites, uploads


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.open_pool()
    yield
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
