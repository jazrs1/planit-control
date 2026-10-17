"""Protection for actions that change shared state or cost money.

- Admin token: POST /replay/start, POST /replay/stop and POST /briefing/send-now (one site or all)
  need the X-Admin-Token header to match ADMIN_TOKEN in backend/.env (the "demo code" the frontend asks
  for). Without ADMIN_TOKEN set, those actions are off (503). Read-only routes stay open.
- Rate limits (in-process, real time): send-now for all sites at most once per 15 minutes and
  never while a run is in progress; one site at most once per minute per site; new push
  subscriptions at most 100 per hour per client network (app/routers/push.py).
"""

import hmac
import ipaddress
import math
import time
from collections import deque

from fastapi import Header, HTTPException

from app.config import get_settings

ADMIN_HEADER = "X-Admin-Token"


def check_admin_token(token: str | None) -> None:
    """Raise 503 if no ADMIN_TOKEN is configured, 401 if `token` is missing or wrong."""
    expected = get_settings().admin_token
    if not expected:
        raise HTTPException(503, "This action is turned off: set ADMIN_TOKEN in backend/.env.")
    if not token or not hmac.compare_digest(token.encode(), expected.encode()):
        raise HTTPException(401, f"This action needs the demo code ({ADMIN_HEADER} header).",
                            headers={"WWW-Authenticate": ADMIN_HEADER})


def require_admin(x_admin_token: str | None = Header(None, alias=ADMIN_HEADER)) -> None:
    """Route dependency form of check_admin_token()."""
    check_admin_token(x_admin_token)


class RateLimit:
    """At most one call per key per `seconds`, counted from each allowed call (time.monotonic)."""

    def __init__(self, seconds: float) -> None:
        self.seconds = seconds
        self._last: dict[str, float] = {}

    def hit(self, key: str) -> None:
        """Record a call, or raise 429 with Retry-After if the last one was too recent."""
        now = time.monotonic()
        last = self._last.get(key)
        if last is not None and now - last < self.seconds:
            wait = math.ceil(self.seconds - (now - last))
            raise HTTPException(429, f"Too soon: try again in {_wait_text(wait)}.",
                                headers={"Retry-After": str(wait)})
        self._last[key] = now

    def reset(self) -> None:
        self._last.clear()


class WindowLimit:
    """At most `limit` counted events per key in any `seconds` window (in-process, time.monotonic).
    check() refuses with 429 once a key is full; add() counts an event that went ahead."""

    def __init__(self, limit: int, seconds: float) -> None:
        self.limit, self.seconds = limit, seconds
        self._events: dict[str, deque[float]] = {}

    def _recent(self, key: str, now: float) -> deque[float]:
        events = self._events.get(key, deque())
        while events and now - events[0] >= self.seconds:
            events.popleft()
        return events

    def check(self, key: str) -> None:
        now = time.monotonic()
        events = self._recent(key, now)
        if len(events) >= self.limit:
            wait = math.ceil(self.seconds - (now - events[0]))
            raise HTTPException(429, f"Too many new subscriptions from this network: try again in {_wait_text(wait)}.",
                                headers={"Retry-After": str(wait)})

    def add(self, key: str) -> None:
        now = time.monotonic()
        if len(self._events) > 10_000:   # forget keys whose window has passed, so memory stays small
            self._events = {k: v for k, v in self._events.items() if self._recent(k, now)}
        self._events[key] = self._recent(key, now)
        self._events[key].append(now)

    def reset(self) -> None:
        self._events.clear()


def client_key(host: str | None) -> str:
    """Who a request comes from, for per-client limits: the IPv4 address, or the IPv6 /64 (one home or
    phone network gets a whole /64, so per-address limits would be easy to dodge). Behind Caddy,
    uvicorn's --proxy-headers makes request.client the real client."""
    try:
        ip = ipaddress.ip_address(host or "")
    except ValueError:
        return host or "unknown"
    if ip.version == 6:
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        return str(ipaddress.ip_network(f"{ip}/64", strict=False))
    return str(ip)


def _wait_text(seconds: int) -> str:
    return f"{seconds} s" if seconds < 60 else f"{math.ceil(seconds / 60)} min"


send_all_limit = RateLimit(15 * 60)
send_site_limit = RateLimit(60)
