"""Push subscription limits: per-client and total caps, duplicates, cleanup, and sends that can't
hold each other up. Database tests share tests/test_push.py's rolled-back transaction fixtures."""

import json
import threading
import time
from datetime import timedelta

import psycopg
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


def test_only_gone_deletes_failures_are_just_counted(conn):
    (flaky, _), (dead, _) = add(conn, "flaky"), add(conn, "dead")
    for _ in range(50):                                             # timeouts, 5xx, deadline cut-offs
        webpush.record(conn, {flaky["id"]: "failed"})
    webpush.record(conn, {dead["id"]: "gone"})                      # the push service said 404/410
    ids = {r["id"]: r["failures"] for r in conn.execute("SELECT id, failures FROM push_subscriptions").fetchall()}
    assert ids[flaky["id"]] == 50 and dead["id"] not in ids


def test_a_delivery_counts_as_seen_and_resets_failures(conn):
    now = clock.real_now()
    row, _ = add(conn, "phone", now=now - 30 * DAY)
    webpush.record(conn, {row["id"]: "failed"})
    webpush.record(conn, {row["id"]: "sent"}, now)
    got = conn.execute("SELECT failures, last_seen_at, last_sent_at FROM push_subscriptions WHERE id = %s",
                       (row["id"],)).fetchone()
    assert got["failures"] == 0 and got["last_seen_at"] == now and got["last_sent_at"] == now


def test_prune_drops_only_subscriptions_failing_for_7_days(conn):
    now = clock.real_now()
    (quiet, _), (failing, _), (recent, _) = (add(conn, "quiet", now=now - 60 * DAY),
                                             add(conn, "failing", now=now - 8 * DAY),
                                             add(conn, "recent-fail", now=now - 6 * DAY))
    webpush.record(conn, {failing["id"]: "failed", recent["id"]: "failed"}, now)
    targets = [s["id"] for s in webpush.for_site(conn, None)]
    assert {quiet["id"], failing["id"], recent["id"]} <= set(targets)    # nothing is skipped for age
    assert webpush.prune(conn, now) >= 1
    left = {r["id"] for r in conn.execute("SELECT id FROM push_subscriptions").fetchall()}
    assert quiet["id"] in left           # nothing to send for 60 days isn't a reason to delete
    assert recent["id"] in left          # failing, but worked 6 days ago
    assert failing["id"] not in left     # failing, nothing delivered for 8 days


def test_migration_010_keeps_the_newest_of_duplicate_keys(conn):
    """On a copy of the 009 table (a temp table, which shadows the real one in this transaction)."""
    from tests.push_schema import MIGRATIONS
    sql = (MIGRATIONS / "009_push_notifications.sql").read_text()
    start = sql.index("CREATE TABLE push_subscriptions")
    create = sql[start:sql.index(");", start) + 2].replace("CREATE TABLE", "CREATE TEMP TABLE", 1)
    conn.execute(create)
    now = clock.real_now()
    for name, key, age in (("old", "dup", 2), ("new", "dup", 1), ("other", "solo", 3)):
        conn.execute("""INSERT INTO pg_temp.push_subscriptions (endpoint, keys, role, updated_at)
                        VALUES (%s, %s, 'crew', %s)""",
                     (f"{FCM}{name}", json.dumps({"p256dh": key, "auth": "a"}), now - age * DAY))
    conn.execute((MIGRATIONS / "010_push_limits.sql").read_text())
    left = {r["endpoint"] for r in conn.execute("SELECT endpoint FROM pg_temp.push_subscriptions").fetchall()}
    assert left == {f"{FCM}new", f"{FCM}other"}
    with pytest.raises(psycopg.errors.UniqueViolation), conn.transaction():
        conn.execute("INSERT INTO pg_temp.push_subscriptions (endpoint, keys, role) VALUES (%s, %s, 'crew')",
                     (f"{FCM}copy", json.dumps({"p256dh": "dup", "auth": "a"})))


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
