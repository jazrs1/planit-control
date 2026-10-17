from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    database_url: str = ""
    gemini_api_key: str = ""
    firms_map_key: str = ""
    auth0_domain: str = ""
    auth0_audience: str = ""
    auth0_client_id: str = ""
    auth0_client_secret: str = ""
    cors_origins: str = "http://localhost:3000"
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
    gemini_model: str = "gemini-3.8-flash"
    gemini_min_interval_seconds: float = 4.0   # ~15 requests/minute
    # Contact info sent in the User-Agent to NWS, FEMA, iNaturalist, etc. (NWS requires one).
    nws_contact: str = "https://github.com/jazrs1/planit-control"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
