"""Web push delivery: browser subscriptions, and sending one notification with pywebpush (VAPID).

A subscription is what the browser's PushManager.subscribe() returns (endpoint + keys). The endpoint
is a URL at the browser vendor's push service; we POST the encrypted notification there. Only known
push services are accepted, so a client can't make the server POST to an arbitrary URL. Endpoints
are bearer secrets (anyone holding one can push to that device): never log them.
"""

import json
import logging
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from urllib.parse import urlsplit

from psycopg import Connection
from psycopg.types.json import Jsonb
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

from app import clock
from app.config import get_settings

log = logging.getLogger(__name__)

# Chrome, Edge, Opera, Samsung and Brave use FCM; Firefox Mozilla autopush; Safari Apple; old Edge WNS.
PUSH_SERVICE_DOMAINS = ("googleapis.com", "mozilla.com", "push.apple.com", "notify.windows.com")
SEND_TIMEOUT_SECONDS = 10
GONE = (404, 410)   # the push service says the subscription no longer exists


@dataclass(frozen=True)
class Message:
    """One notification. `payload()` is PushNotification in shared/types.ts, read by the service worker."""
    kind: str                  # PushKind: stop_work, approaching, all_clear, flood, briefings, test
    title: str
    body: str
    url: str                   # page to open on click, relative to the frontend
    tag: str                   # same tag replaces the earlier notification (e.g. stop-work -> all clear)
    site_id: str | None = None
    replay: bool = False
    ttl_seconds: int = 1800    # how long the push service keeps trying an offline device
    urgency: str = "normal"    # RFC 8030: high wakes a sleeping phone right away

    def payload(self, sent_at: datetime) -> dict:
        return {"title": self.title, "body": self.body, "kind": self.kind, "site_id": self.site_id,
                "replay": self.replay, "url": self.url, "tag": self.tag, "sent_at": sent_at.isoformat()}


def endpoint_allowed(endpoint: str) -> bool:
    """https on a known push service's domain, default port."""
    try:
        parts = urlsplit(endpoint)
        host, port = (parts.hostname or "").lower(), parts.port
    except ValueError:
        return False
    return (parts.scheme == "https" and port in (None, 443) and not parts.username
            and any(host == d or host.endswith("." + d) for d in PUSH_SERVICE_DOMAINS))


@lru_cache(maxsize=2)
def _vapid(private_key: str) -> Vapid:
    return Vapid.from_string(private_key)


def send(sub: dict, message: Message) -> str:
    """Push one message to one subscription. Returns 'sent', 'gone' (404/410: delete it) or 'failed'.
    Never raises."""
    settings = get_settings()
    try:
        webpush(
            subscription_info={"endpoint": sub["endpoint"], "keys": sub["keys"]},
            data=json.dumps(message.payload(clock.real_now())),
            vapid_private_key=_vapid(settings.vapid_private_key),
            vapid_claims={"sub": settings.vapid_subject},   # a fresh dict: pywebpush adds aud/exp to it
            ttl=message.ttl_seconds,
            headers={"Urgency": message.urgency},
            timeout=SEND_TIMEOUT_SECONDS,
        )
        return "sent"
    except WebPushException as err:
        status = getattr(err.response, "status_code", None)
        if status in GONE:
            return "gone"
        log.warning("Push to %s failed: HTTP %s", sub.get("id"), status)
    except Exception as err:  # noqa: BLE001 - a push problem must never reach the caller
        log.warning("Push to %s failed: %s", sub.get("id"), type(err).__name__)
    return "failed"


# ---------- subscriptions ----------

SUB_COLUMNS = "id, site_ids, role, created_at, updated_at"


def upsert(conn: Connection, endpoint: str, keys: dict, site_ids: list[str] | None, role: str) -> dict:
    return conn.execute(
        f"""INSERT INTO push_subscriptions (endpoint, keys, site_ids, role) VALUES (%s, %s, %s, %s)
            ON CONFLICT (endpoint) DO UPDATE SET keys = EXCLUDED.keys, site_ids = EXCLUDED.site_ids,
                role = EXCLUDED.role, updated_at = now(), failures = 0
            RETURNING {SUB_COLUMNS}""",
        (endpoint, Jsonb(keys), site_ids, role)).fetchone()


def delete(conn: Connection, endpoint: str) -> bool:
    return conn.execute("DELETE FROM push_subscriptions WHERE endpoint = %s", (endpoint,)).rowcount > 0


def find(conn: Connection, endpoint: str) -> dict | None:
    return conn.execute("SELECT id, endpoint, keys, site_ids FROM push_subscriptions WHERE endpoint = %s",
                        (endpoint,)).fetchone()


def for_site(conn: Connection, site_id: str | None) -> list[dict]:
    """Subscriptions that want this site (all of them for site_id None)."""
    return conn.execute(
        """SELECT id, endpoint, keys, site_ids FROM push_subscriptions
           WHERE %(site)s::text IS NULL OR site_ids IS NULL OR %(site)s = ANY(site_ids)""",
        {"site": site_id}).fetchall()


def record(conn: Connection, outcomes: dict[str, str]) -> None:
    """Store send outcomes (subscription id -> 'sent' / 'gone' / 'failed'); 'gone' deletes the row."""
    by = {k: [i for i, o in outcomes.items() if o == k] for k in ("sent", "gone", "failed")}
    if by["gone"]:
        conn.execute("DELETE FROM push_subscriptions WHERE id = ANY(%s)", (by["gone"],))
        log.info("Removed %d expired push subscriptions", len(by["gone"]))
    if by["sent"]:
        conn.execute("UPDATE push_subscriptions SET last_sent_at = now(), failures = 0 WHERE id = ANY(%s)",
                     (by["sent"],))
    if by["failed"]:
        conn.execute("UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ANY(%s)", (by["failed"],))
