"""Push subscription limits: per-client and total caps, duplicates, cleanup, and sends that can't
hold each other up. Database tests share tests/test_push.py's rolled-back transaction fixtures."""

import threading
import time
from datetime import timedelta

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import admin, clock
from app.db import get_pool
from app.routers import push as push_route
from push import notify, webpush
from push.webpush import Message
from tests.test_push import FCM, FakePool, conn, outbox, push_on  # noqa: F401 - fixtures

DAY = timedelta(days=1)
MSG = Message("test", "t", "b", "/", "test")


# ---------- per-client window ----------

def test_window_limit_counts_per_key_and_frees_up(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(admin.time, "monotonic", lambda: now[0])
    limit = admin.WindowLimit(3, 3600)
    for _ in range(3):
        limit.check("a")
        limit.add("a")
    with pytest.raises(HTTPException) as err:
        limit.check("a")
    assert err.value.status_code == 429 and err.value.headers["Retry-After"] == "3600"
    limit.check("b")                     # other clients aren't affected
    now[0] += 1800
    with pytest.raises(HTTPException) as err:
        limit.check("a")
    assert err.value.headers["Retry-After"] == "1800"
    now[0] += 1800
    limit.check("a")                     # the first three are an hour old


@pytest.mark.parametrize("a,b,same", [
    ("203.0.113.9", "203.0.113.9", True),
    ("203.0.113.9", "203.0.113.10", False),
    ("2001:db8:1:2::1", "2001:db8:1:2:ffff::9", True),     # same /64: one home or phone network
    ("2001:db8:1:2::1", "2001:db8:1:3::1", False),
    ("::ffff:203.0.113.9", "203.0.113.9", True),           # IPv4 seen through an IPv6 socket
])
def test_client_key(a, b, same):
    assert (admin.client_key(a) == admin.client_key(b)) is same


def test_client_key_without_an_address():
    assert admin.client_key("testclient") == "testclient" and admin.client_key(None) == "unknown"


# ---------- sending: parallel, and a slow one can't hold up the rest ----------

def subs(n):
    return [{"id": f"sub_{i}", "endpoint": f"{FCM}{i}", "keys": {}} for i in range(n)]


def test_sends_run_in_parallel(monkeypatch):
    monkeypatch.setattr(webpush, "send", lambda sub, m: time.sleep(0.2) or "sent")
    start = time.monotonic()
    out = notify._send_all([(s, MSG) for s in subs(20)])
    assert set(out.values()) == {"sent"} and len(out) == 20
    assert time.monotonic() - start < 1.0          # one after another would take 4 s


def test_a_slow_subscription_cant_delay_the_others(monkeypatch):
    release = threading.Event()

    def send(sub, m):
        if sub["id"] == "sub_0":
            release.wait(10)                        # a push service that never answers
            return "sent"
        return "sent"
    monkeypatch.setattr(webpush, "send", send)
    monkeypatch.setattr(notify, "DELIVERY_DEADLINE_SECONDS", 0.5)
    start = time.monotonic()
    try:
        out = notify._send_all([(s, MSG) for s in subs(5)])
    finally:
        release.set()
    assert time.monotonic() - start < 1.5
    assert out == {"sub_0": "failed", "sub_1": "sent", "sub_2": "sent", "sub_3": "sent", "sub_4": "sent"}


def test_each_request_has_a_short_timeout():
    assert webpush.SEND_TIMEOUT_SECONDS <= 5 and notify.DELIVERY_DEADLINE_SECONDS <= 30


# ---------- database ----------

KEYS = {"p256dh": "k-1", "auth": "a"}


def add(conn, name, keys=None, now=None, site_ids=None):
    return webpush.subscribe(conn, f"{FCM}{name}", keys or {"p256dh": f"k-{name}", "auth": "a"}, site_ids, "crew",
                             now or clock.real_now())


def test_same_endpoint_is_an_update_never_a_second_row(conn):
    first, created = add(conn, "one", site_ids=["big-bend"])
    again, created_again = add(conn, "one")
    assert created and not created_again and again["id"] == first["id"] and again["site_ids"] is None
    n = conn.execute("SELECT count(*) AS n FROM push_subscriptions WHERE endpoint = %s", (f"{FCM}one",)).fetchone()
    assert n["n"] == 1


def test_another_endpoints_keys_are_refused(conn):
    add(conn, "one", keys=KEYS)
    with pytest.raises(webpush.DuplicateKeys):
        add(conn, "two", keys=KEYS)
    assert conn.execute("SELECT 1 AS ok").fetchone()["ok"] == 1    # the transaction is still usable
    with pytest.raises(webpush.DuplicateKeys):                      # nor can an update take them
        add(conn, "three")
        add(conn, "three", keys=KEYS)


def test_total_cap(conn, monkeypatch):
    existing = conn.execute("SELECT count(*) AS n FROM push_subscriptions").fetchone()["n"]
    monkeypatch.setattr(webpush, "MAX_SUBSCRIPTIONS", existing + 2)
    add(conn, "a")
    add(conn, "b")
    with pytest.raises(webpush.SubscriptionLimitReached):
        add(conn, "c")
    _, created = add(conn, "a", site_ids=["big-bend"])              # updates still work when full
    assert not created


def test_repeated_failures_delete_and_a_success_resets(conn):
    (row, _), (other, _) = add(conn, "flaky"), add(conn, "steady")
    for _ in range(webpush.MAX_FAILURES - 1):
        webpush.record(conn, {row["id"]: "failed", other["id"]: "failed"})
    webpush.record(conn, {other["id"]: "sent"})                     # back to 0
    webpush.record(conn, {row["id"]: "failed", other["id"]: "failed"})
    ids = {r["id"]: r["failures"] for r in conn.execute("SELECT id, failures FROM push_subscriptions").fetchall()}
    assert row["id"] not in ids and ids[other["id"]] == 1


def test_stale_subscriptions_get_nothing_and_are_pruned(conn):
    now = clock.real_now()
    (old, _), (fresh, _), (failing, _) = add(conn, "old", now=now - 15 * DAY), add(conn, "fresh"), add(conn, "failing")
    conn.execute("UPDATE push_subscriptions SET failures = %s WHERE id = %s", (webpush.MAX_FAILURES, failing["id"]))
    targets = [s["id"] for s in webpush.for_site(conn, None, now)]
    assert old["id"] not in targets and fresh["id"] in targets
    assert webpush.prune(conn, now) >= 2
    left = {r["id"] for r in conn.execute("SELECT id FROM push_subscriptions").fetchall()}
    assert fresh["id"] in left and old["id"] not in left and failing["id"] not in left


def test_failing_subscriptions_are_sent_to_last(conn):
    (bad, _), (good, _) = add(conn, "bad"), add(conn, "good")
    webpush.record(conn, {bad["id"]: "failed"})
    order = [s["id"] for s in webpush.for_site(conn, None)]
    assert order.index(good["id"]) < order.index(bad["id"])


# ---------- routes ----------

def client_from(conn, host):
    app = FastAPI()
    app.include_router(push_route.router)
    app.dependency_overrides[get_pool] = lambda: FakePool(conn)
    return TestClient(app, client=(host, 50000))


def body(name, sites=None):
    return {"subscription": {"endpoint": f"{FCM}{name}", "keys": {"p256dh": f"k-{name}", "auth": "a"}},
            "site_ids": sites, "role": "crew"}


@pytest.fixture
def clients(conn, push_on, outbox):  # noqa: F811
    push_route.new_per_client.reset()
    push_route.test_limit.reset()
    yield lambda host: client_from(conn, host)
    push_route.new_per_client.reset()


def test_new_subscriptions_per_client_per_hour(clients):
    phone, other = clients("203.0.113.9"), clients("198.51.100.4")
    for i in range(push_route.NEW_PER_CLIENT):
        assert phone.post("/push/subscribe", json=body(f"p{i}")).status_code == 201
    refused = phone.post("/push/subscribe", json=body("one-too-many"))
    assert refused.status_code == 429 and int(refused.headers["Retry-After"]) > 3500
    assert phone.post("/push/subscribe", json=body("p0", ["big-bend"])).status_code == 200   # re-subscribe: fine
    assert other.post("/push/subscribe", json=body("o0")).status_code == 201


def test_route_duplicate_keys_and_full(clients, monkeypatch, conn):  # noqa: F811
    c = clients("203.0.113.9")
    assert c.post("/push/subscribe", json=body("x")).status_code == 201
    stolen = body("y")
    stolen["subscription"]["keys"]["p256dh"] = "k-x"
    assert c.post("/push/subscribe", json=stolen).status_code == 409
    n = conn.execute("SELECT count(*) AS n FROM push_subscriptions").fetchone()["n"]
    monkeypatch.setattr(webpush, "MAX_SUBSCRIPTIONS", n)
    full = c.post("/push/subscribe", json=body("z"))
    assert full.status_code == 503 and "full" in full.json()["detail"]


def test_a_test_push_counts_as_seen(clients, conn):  # noqa: F811
    c = clients("203.0.113.9")
    sub_id = c.post("/push/subscribe", json=body("seen")).json()["id"]
    conn.execute("UPDATE push_subscriptions SET last_seen_at = now() - interval '13 days' WHERE id = %s", (sub_id,))
    assert c.post("/push/test", json={"endpoint": f"{FCM}seen"}).json()["sent"] is True
    age = conn.execute("SELECT %s - last_seen_at AS age FROM push_subscriptions WHERE id = %s",
                       (clock.real_now(), sub_id)).fetchone()["age"]
    assert age < timedelta(minutes=1)


def test_before_migration_010_sends_warn_once(monkeypatch, push_on, caplog):  # noqa: F811
    import psycopg
    monkeypatch.setattr(notify, "_warned_missing", False)
    monkeypatch.setattr("app.db.get_pool", lambda: object())

    def old_schema(pool):
        raise psycopg.errors.UndefinedColumn("column last_seen_at does not exist")
    for _ in range(3):
        notify._guard(old_schema)
    assert caplog.text.count("run `python -m scripts.migrate` (009-010)") == 1
    assert "Push notifications failed" not in caplog.text
