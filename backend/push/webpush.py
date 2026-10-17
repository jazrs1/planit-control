"""Web push delivery: browser subscriptions, and sending one notification with pywebpush (VAPID).

A subscription is what the browser's PushManager.subscribe() returns (endpoint + keys). The endpoint
is a URL at the browser vendor's push service; we POST the encrypted notification there. Only known
push services are accepted, so a client can't make the server POST to an arbitrary URL. Endpoints
are bearer secrets (anyone holding one can push to that device): never log them.

Limits (docs/push-notifications.md):
  - at most MAX_SUBSCRIPTIONS rows in total; re-subscribing an existing endpoint never counts as new;
  - the same p256dh key under a second endpoint is refused (browsers make fresh keys per subscription);
  - MAX_FAILURES failed sends in a row, or STALE_AFTER without the browser showing up, deletes the row;
  - per-client limits on new subscriptions are in app/routers/push.py.
"""

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import lru_cache
from urllib.parse import urlsplit

import psycopg
from psycopg import Connection
from psycopg.types.json import Jsonb
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

from app import clock
from app.config import get_settings

log = logging.getLogger(__name__)

# Chrome, Edge, Opera, Samsung and Brave use FCM; Firefox Mozilla autopush; Safari Apple; old Edge WNS.
PUSH_SERVICE_DOMAINS = ("googleapis.com", "mozilla.com", "push.apple.com", "notify.windows.com")
# Per request to the push service (connect, then each read). notify.py also caps a whole fan-out.
SEND_TIMEOUT_SECONDS = 4
GONE = (404, 410)   # the push service says the subscription no longer exists
MAX_SUBSCRIPTIONS = 1000
MAX_FAILURES = 5                    # failed sends in a row (a success resets the count)
STALE_AFTER = timedelta(days=14)    # since the browser last subscribed, re-subscribed or sent a test


class SubscriptionLimitReached(Exception):
    pass


class DuplicateKeys(Exception):
    pass


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


def subscribe(conn: Connection, endpoint: str, keys: dict, site_ids: list[str] | None, role: str,
              now: datetime) -> tuple[dict, bool]:
    """Save a subscription: (row, created). An endpoint that's already there is updated in place
    (sites, role, keys) and marked seen: never a second row, and never counted as new.
    Raises SubscriptionLimitReached or DuplicateKeys for a new one that isn't allowed."""
    conn.execute("SELECT pg_advisory_xact_lock(hashtext('push-subscribe'))")   # so the count check can't race
    try:
        with conn.transaction():   # savepoint: a duplicate key mustn't abort the caller's transaction
            updated = conn.execute(
                f"""UPDATE push_subscriptions SET keys = %s, site_ids = %s, role = %s, updated_at = %s,
                           last_seen_at = %s, failures = 0
                    WHERE endpoint = %s RETURNING {SUB_COLUMNS}""",
                (Jsonb(keys), site_ids, role, now, now, endpoint)).fetchone()
            if updated is not None:
                return updated, False
            if conn.execute("SELECT count(*) AS n FROM push_subscriptions").fetchone()["n"] >= MAX_SUBSCRIPTIONS:
                raise SubscriptionLimitReached
            row = conn.execute(
                f"""INSERT INTO push_subscriptions (endpoint, keys, site_ids, role, created_at, updated_at, last_seen_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING {SUB_COLUMNS}""",
                (endpoint, Jsonb(keys), site_ids, role, now, now, now)).fetchone()
    except psycopg.errors.UniqueViolation:   # this p256dh key is already another endpoint's
        raise DuplicateKeys from None
    return row, True


def delete(conn: Connection, endpoint: str) -> bool:
    return conn.execute("DELETE FROM push_subscriptions WHERE endpoint = %s", (endpoint,)).rowcount > 0


def find(conn: Connection, endpoint: str) -> dict | None:
    return conn.execute("SELECT id, endpoint, keys, site_ids FROM push_subscriptions WHERE endpoint = %s",
                        (endpoint,)).fetchone()


def seen(conn: Connection, sub_id: str, now: datetime) -> None:
    conn.execute("UPDATE push_subscriptions SET last_seen_at = %s WHERE id = %s", (now, sub_id))


def for_site(conn: Connection, site_id: str | None, now: datetime | None = None) -> list[dict]:
    """Subscriptions that want this site (all of them for site_id None) and were seen in the last
    STALE_AFTER. Healthy ones first, so a failing subscription waits behind them, not in front."""
    return conn.execute(
        """SELECT id, endpoint, keys, site_ids FROM push_subscriptions
           WHERE (%(site)s::text IS NULL OR site_ids IS NULL OR %(site)s = ANY(site_ids))
             AND last_seen_at > %(stale)s
           ORDER BY failures, last_sent_at DESC NULLS LAST, id""",
        {"site": site_id, "stale": (now or clock.real_now()) - STALE_AFTER}).fetchall()


def record(conn: Connection, outcomes: dict[str, str]) -> None:
    """Store send outcomes (subscription id -> 'sent' / 'gone' / 'failed'). 'gone' deletes the row, and so
    does the MAX_FAILURES-th failure in a row."""
    by = {k: [i for i, o in outcomes.items() if o == k] for k in ("sent", "gone", "failed")}
    if by["sent"]:
        conn.execute("UPDATE push_subscriptions SET last_sent_at = now(), failures = 0 WHERE id = ANY(%s)",
                     (by["sent"],))
    if by["failed"]:
        conn.execute("UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ANY(%s)", (by["failed"],))
        by["gone"] += [r["id"] for r in conn.execute(
            "SELECT id FROM push_subscriptions WHERE id = ANY(%s) AND failures >= %s",
            (by["failed"], MAX_FAILURES)).fetchall()]
    if by["gone"]:
        conn.execute("DELETE FROM push_subscriptions WHERE id = ANY(%s)", (by["gone"],))
        log.info("Removed %d push subscriptions (expired, or %d failed sends in a row)", len(by["gone"]), MAX_FAILURES)


def prune(conn: Connection, now: datetime) -> int:
    """Delete subscriptions not seen for STALE_AFTER, or failing MAX_FAILURES times in a row."""
    n = conn.execute("DELETE FROM push_subscriptions WHERE last_seen_at <= %s OR failures >= %s",
                     (now - STALE_AFTER, MAX_FAILURES)).rowcount
    if n:
        log.info("Pruned %d push subscriptions (not seen for %d days, or failing)", n, STALE_AFTER.days)
    return n
