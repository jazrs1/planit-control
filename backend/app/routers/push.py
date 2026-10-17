"""Web push subscriptions. What gets sent when: push/notify.py and docs/push-notifications.md.

The frontend: GET /push/public-key, then PushManager.subscribe({userVisibleOnly: true,
applicationServerKey: <that key>}), then POST /push/subscribe with subscription.toJSON(), the sites
and the role. All routes answer 503 until VAPID keys are set and migration 009 is applied.
"""

from contextlib import contextmanager

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status
from psycopg_pool import ConnectionPool

from app import site_data
from app.admin import RateLimit
from app.config import get_settings
from app.db import get_pool
from app.schemas import (PushEndpointRequest, PushPublicKey, PushSubscribeRequest, PushSubscriptionInfo,
                         PushTestResponse, PushUnsubscribeResponse)
from push import notify, webpush

router = APIRouter(prefix="/push", tags=["push"])
test_limit = RateLimit(10)   # per subscription


def _require_configured() -> None:
    if not get_settings().push_configured:
        raise HTTPException(503, "Push notifications are off: set VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY "
                                 "(python -m scripts.generate_vapid_keys) and a VAPID_SUBJECT that is "
                                 "mailto:name@host or an https origin without a path.")


@contextmanager
def _connection(pool: ConnectionPool):
    _require_configured()
    with pool.connection() as conn:
        try:
            yield conn
        except psycopg.errors.UndefinedTable:
            raise HTTPException(503, "Push notifications need migration 009: python -m scripts.migrate")


@router.get("/public-key", response_model=PushPublicKey)
def public_key():
    """The VAPID public key, for PushManager.subscribe()'s applicationServerKey (base64url)."""
    _require_configured()
    return {"public_key": get_settings().vapid_public_key}


@router.post("/subscribe", response_model=PushSubscriptionInfo, status_code=status.HTTP_201_CREATED)
def subscribe(body: PushSubscribeRequest, pool: ConnectionPool = Depends(get_pool)):
    """Save this browser's subscription. site_ids null means every site. Subscribing the same
    endpoint again replaces its sites and role."""
    sub = body.subscription
    if not webpush.endpoint_allowed(sub.endpoint):
        raise HTTPException(422, "endpoint must be an https URL at a browser push service")
    site_ids = body.site_ids
    if site_ids is not None:
        site_ids = sorted(set(site_ids))
        unknown = [s for s in site_ids if site_data.known_site(s) is None]
        if unknown:
            raise HTTPException(422, f"Unknown site ids: {', '.join(unknown)}")
        if not site_ids:
            raise HTTPException(422, "site_ids is empty: pass null for all sites, or unsubscribe")
    with _connection(pool) as conn:
        return webpush.upsert(conn, sub.endpoint, sub.keys.model_dump(), site_ids, body.role)


@router.post("/unsubscribe", response_model=PushUnsubscribeResponse)
def unsubscribe(body: PushEndpointRequest, pool: ConnectionPool = Depends(get_pool)):
    with _connection(pool) as conn:
        return {"removed": webpush.delete(conn, body.endpoint)}


@router.post("/test", response_model=PushTestResponse)
def send_test(body: PushEndpointRequest, pool: ConnectionPool = Depends(get_pool)):
    """Send a test notification to one subscription (at most one every 10 s). removed: the push
    service said the subscription is gone, so it was deleted: subscribe again."""
    with _connection(pool) as conn:
        sub = webpush.find(conn, body.endpoint)
    if sub is None:
        raise HTTPException(404, "No such subscription: POST /push/subscribe first")
    test_limit.hit(sub["id"])
    outcome = webpush.send(sub, notify.test_message())
    with _connection(pool) as conn:
        webpush.record(conn, {sub["id"]: outcome})
    return {"sent": outcome == "sent", "removed": outcome == "gone"}
