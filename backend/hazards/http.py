"""HTTP for external hazard sources: one User-Agent (NWS requires contact info), timeouts, retries."""

import json
import time
import urllib.parse
import urllib.request

from app.config import get_settings

TIMEOUT = 60


def user_agent() -> str:
    return f"PlanIT-Control/0.1 (+{get_settings().nws_contact})"


def get(url: str, params: dict | None = None, *, accept: str = "application/json",
        retries: int = 1, backoff: float = 2.0) -> bytes:
    """GET with the project User-Agent. Retries `retries` extra times on any failure."""
    if params:
        url = f"{url}?{urllib.parse.urlencode(params, safe=',')}"
    request = urllib.request.Request(url, headers={"User-Agent": user_agent(), "Accept": accept})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as resp:
                return resp.read()
        except Exception:
            if attempt == retries:
                raise
            time.sleep(backoff * (attempt + 1))
    raise AssertionError("unreachable")


def get_json(url: str, params: dict | None = None, **kwargs):
    body = get(url, params, **kwargs)
    try:
        return json.loads(body)
    except json.JSONDecodeError as err:
        raise ValueError(f"Not JSON from {url[:80]}: {body[:120]!r}") from err
