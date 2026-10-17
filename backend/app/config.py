from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    database_url: str = ""
    anthropic_api_key: str = ""
    gemini_api_key: str = ""
    firms_map_key: str = ""
    auth0_domain: str = ""
    auth0_audience: str = ""
    auth0_client_id: str = ""
    auth0_client_secret: str = ""
    cors_origins: str = "http://localhost:3000"
    # The "demo code": X-Admin-Token for replay start/stop and send-now for all sites (app/admin.py).
    # Empty turns those actions off.
    admin_token: str = ""
    lightning_ingest_enabled: bool = True
    lightning_poll_seconds: float = 20.0
    hazard_polling_enabled: bool = True
    # Open-Meteo models update at most hourly; polling faster only re-fetches the same forecast.
    weather_poll_minutes: int = 60
    # Seconds to cache GET /sites, /sites/{id}, /alerts (0 disables). Alert changes bypass it.
    api_cache_seconds: float = 2.5
    # Evening briefings: generated at BRIEFING_HOUR site-local time for the next day.
    briefing_enabled: bool = True
    briefing_hour: int = 18
    # Briefing writers, in order: Claude, then Gemini, then the template (briefing/writer.py).
    claude_model: str = "claude-sonnet-5-5"
    # Rereads each model-written briefing against its input JSON (empty: no review).
    claude_review_model: str = "claude-haiku-5-5"
    gemini_model: str = "gemini-3.8-flash"
    gemini_min_interval_seconds: float = 4.0   # ~15 requests/minute
    briefing_concurrency: int = 4              # briefings written at once (model calls are slow)
    # Contact info sent in the User-Agent to NWS, FEMA, iNaturalist, etc. (NWS requires one).
    nws_contact: str = "https://github.com/jazrs1/planit-control"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
