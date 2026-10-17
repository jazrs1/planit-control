from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.routers import alerts, briefing, reports, sites

app = FastAPI(title="PlanIT Control API", version="0.1.0")

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


@app.get("/health", tags=["meta"])
def health():
    return {"status": "ok"}
