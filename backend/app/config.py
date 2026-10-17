import re
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
    # Optional regex for extra allowed origins, e.g. Vercel preview URLs (empty: none).
    cors_origin_regex: str = ""
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
    # Where report photos are stored (empty: backend/uploads). The server uses a folder outside the checkout.
    uploads_dir: str = ""
    # Web push (push/): VAPID keys from `python -m scripts.generate_vapid_keys`. Never change them once
    # browsers have subscribed: their subscriptions are tied to the public key. Empty keys: push is off.
    vapid_private_key: str = ""
    vapid_public_key: str = ""
    # Contact sent to push services: mailto:name@host or an https origin WITHOUT a path (pywebpush rejects
    # paths). Set it to the frontend's origin once the domain exists, e.g. https://planit.example.com.
    vapid_subject: str = "https://jazrs1.github.io"
    # Send notifications for alert events and briefings. Only one machine (the server) should send.
    push_enabled: bool = True

    @property
    def cors_origin_list(self) -> list[str]:
        # Browsers send Origin without a trailing slash, so "https://x.vercel.app/" would never match.
        return [o.strip().rstrip("/") for o in self.cors_origins.split(",") if o.strip()]

    @property
    def push_configured(self) -> bool:
        return bool(self.vapid_private_key and self.vapid_public_key) and vapid_subject_ok(self.vapid_subject)

    @property
    def uploads_path(self) -> Path:
        return Path(self.uploads_dir).expanduser() if self.uploads_dir else BACKEND_DIR / "uploads"


def vapid_subject_ok(subject: str) -> bool:
    """What pywebpush (py_vapid) accepts, or stricter: mailto:name@host, or https://host with no path or port."""
    return bool(re.fullmatch(r"mailto:[^@\s]+@[\w-]+(\.[\w-]+)+|https://[\w-]+(\.[\w-]+)+", subject or ""))


@lru_cache
def get_settings() -> Settings:
    return Settings()
