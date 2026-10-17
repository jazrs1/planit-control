"""Web push: keys, messages, which events push, duplicates, failures, and the /push routes.

Database tests run inside one rolled-back transaction (skipped without DATABASE_URL). If migration
009 isn't applied yet, its tables are created inside that transaction. Lightning alerts use replay
mode and a 2031 clock, so they never meet real rows or the live alert engine's lock.
"""

import base64
import json
import math
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest
from cryptography.hazmat.primitives import serialization
from fastapi import FastAPI
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from py_vapid import Vapid
from pywebpush import WebPushException

from alerts import engine
from app.config import BACKEND_DIR, get_settings
from app.db import get_pool
from app.routers import push as push_route
from app.schemas import PushNotification
from lightning import alert_hook
from push import notify, webpush
from scripts import generate_vapid_keys as keygen

T0 = datetime(2031, 1, 6, 17, 0, tzinfo=timezone.utc)
MIN = timedelta(minutes=1)
SITE = {"id": "big-bend", "name": "Big Bend", "timezone": "America/New_York"}
FCM = "https://fcm.googleapis.com/fcm/send/"
PRIVATE, PUBLIC = keygen.generate()


@pytest.fixture
def push_on(monkeypatch):
    s = get_settings()
    for name, value in (("vapid_private_key", PRIVATE), ("vapid_public_key", PUBLIC), ("push_enabled", True),
                        ("vapid_subject", "https://jazrs1.github.io")):
        monkeypatch.setattr(s, name, value)
    if not s.database_url:
        monkeypatch.setattr(s, "database_url", "postgresql://unused")


# ---------- keys ----------

def test_generated_keys_work_with_pywebpush():
    vapid = Vapid.from_string(PRIVATE)
    public = vapid.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    assert keygen.b64url(public) == PUBLIC
    raw = base64.urlsafe_b64decode(PUBLIC + "=" * (-len(PUBLIC) % 4))
    assert len(raw) == 65 and raw[0] == 4   # what PushManager.subscribe() wants as applicationServerKey


def test_key_writer_fills_placeholders_keeps_the_rest_and_never_replaces_keys(tmp_path):
    env = tmp_path / ".env"
    env.write_text("DATABASE_URL=postgresql://x\nVAPID_PRIVATE_KEY=\nVAPID_PUBLIC_KEY=\nADMIN_TOKEN=abc\n")
    keygen.write_keys(env, "priv", "pub")
    text = env.read_text()
    assert "DATABASE_URL=postgresql://x\n" in text and "ADMIN_TOKEN=abc\n" in text
    assert text.count("VAPID_PRIVATE_KEY=") == 1 and "VAPID_PRIVATE_KEY=priv\n" in text
    assert "VAPID_PUBLIC_KEY=pub\n" in text and f"VAPID_SUBJECT={keygen.DEFAULT_SUBJECT}\n" in text
    assert env.stat().st_mode & 0o777 == 0o600
    with pytest.raises(FileExistsError):
        keygen.write_keys(env, "other", "other")
    assert "VAPID_PRIVATE_KEY=priv\n" in env.read_text()


def test_key_script_prints_only_the_public_key(tmp_path, capsys, monkeypatch):
    env = tmp_path / ".env"
    monkeypatch.setattr("sys.argv", ["generate_vapid_keys", "--env", str(env)])
    keygen.main()
    out = capsys.readouterr().out
    private = keygen._value(env.read_text(), "VAPID_PRIVATE_KEY")
    assert private and private not in out and keygen._value(env.read_text(), "VAPID_PUBLIC_KEY") in out


@pytest.mark.parametrize("subject", ["https://jazrs1.github.io", "https://planit.example.com", "mailto:ops@example.com",
                                     "https://github.com/jazrs1/planit-control", "http://example.com", "example.com",
                                     "https://example.com:8443", "mailto:nobody", ""])
def test_subject_check_never_accepts_what_pywebpush_rejects(subject):
    import py_vapid
    from app.config import vapid_subject_ok
    if vapid_subject_ok(subject):
        assert py_vapid._check_sub(subject)
    assert vapid_subject_ok(subject) is (subject in ("https://jazrs1.github.io", "https://planit.example.com",
                                                     "mailto:ops@example.com"))


def test_a_bad_subject_turns_push_off(monkeypatch, push_on):
    monkeypatch.setattr(get_settings(), "vapid_subject", "https://github.com/jazrs1/planit-control")
    assert not get_settings().push_configured


# ---------- endpoints we will POST to ----------

@pytest.mark.parametrize("endpoint,ok", [
    (FCM + "abc", True),
    ("https://updates.push.services.mozilla.com/wpush/v2/abc", True),
    ("https://web.push.apple.com/QGuK", True),
    ("https://wns2-bl2p.notify.windows.com/w/?token=abc", True),
    ("http://fcm.googleapis.com/fcm/send/abc", False),             # not https
    ("https://fcm.googleapis.com:8443/fcm/send/abc", False),        # odd port
    ("https://evilgoogleapis.com/x", False),
    ("https://googleapis.com.evil.example/x", False),
    ("https://user@fcm.googleapis.com/x", False),
    ("https://127.0.0.1/x", False),
    ("https://localhost:8000/sites", False),
    ("not a url", False),
])
def test_only_browser_push_services_are_accepted(endpoint, ok):
    assert webpush.endpoint_allowed(endpoint) is ok


# ---------- messages ----------

def test_stop_work_message():
    m = notify.stop_work_message(SITE, 3.24, datetime(2026, 10, 17, 20, 12, tzinfo=timezone.utc), replay=False)
    assert m.title == "STOP WORK: Big Bend, lightning 3.2 mi away"
    assert "4:12 PM EDT" in m.body and m.urgency == "high"
    assert (m.kind, m.url, m.tag, m.site_id) == ("stop_work", "/sites/big-bend", "lightning:big-bend", "big-bend")


def test_replay_messages_are_prefixed():
    for m in (notify.stop_work_message(SITE, 1.0, None, True), notify.all_clear_message(SITE, True),
              notify.approaching_message(SITE, 250, 18, True)):
        assert m.title.startswith("[REPLAY] ") and m.replay
    assert not notify.all_clear_message(SITE, False).title.startswith("[REPLAY]")


def test_approach_all_clear_and_flood_messages():
    assert notify.approaching_message(SITE, 250, 18.4, False).title == "Lightning possible within the hour at Big Bend"
    assert "WSW, moving about 18 mph" in notify.approaching_message(SITE, 250, 18.4, False).body
    assert "barely moving" in notify.approaching_message(SITE, 250, 0.5, False).body
    assert notify.all_clear_message(SITE, False).title == "All clear at Big Bend"
    nws = notify.flood_message(SITE, datetime(2026, 10, 18, 1, 0, tzinfo=timezone.utc), False)
    assert nws.title == "Flood alert: Big Bend" and "NWS flood warning until 9:00 PM EDT" in nws.body
    assert "2+ inches of rain" in notify.flood_message(SITE, None, False).body


def test_briefing_summaries():
    rows = [{"site_id": f"s{i}", "site_name": f"Site {i}", "go_status": g, "headline": "h"}
            for i, g in enumerate(["no_go", "caution", "caution", "go", "no_go", "no_go", "no_go"])]
    many = notify.briefing_summary(rows)
    assert many.title == "Tomorrow's safety briefings are ready" and many.url == "/briefings"
    assert many.body == "No-go: Site 0, Site 4, Site 5 +1 more. Caution: 2 sites. Go: 1 site."
    one = notify.briefing_summary([{"site_id": "big-bend", "site_name": "Big Bend", "go_status": "caution",
                                    "headline": "Heat index 104°F after 1 PM"}])
    assert (one.title, one.body, one.url) == ("Tomorrow at Big Bend: CAUTION", "Heat index 104°F after 1 PM",
                                              "/briefing/big-bend")


def test_payload_matches_the_shared_type():
    p = notify.stop_work_message(SITE, 3.2, None, True).payload(T0)
    assert PushNotification(**p).replay is True
    for mock in json.loads((BACKEND_DIR.parent / "shared/mocks/push_notifications.json").read_text()):
        PushNotification(**mock)


# ---------- which events push (pure) ----------

def event(i, kind, event_name, site="a", **extra):
    base = {"source": "alert", "id": i, "type": kind, "event": event_name, "site_id": site, "site_name": site.upper(),
            "timezone": "America/New_York", "recorded_at": T0, "strike_distance_mi": 2.0, "all_clear_at": T0 + 30 * MIN}
    return {**base, **extra}


def test_plan_skips_an_all_clear_immediately_followed_by_a_new_stop_work():
    rows = [event(1, "lightning", "cleared"), event(2, "lightning", "created"), event(3, "lightning", "cleared", site="b")]
    planned = notify.plan(rows, replay=False)
    assert [(p.key, p.kind, p.message is None) for p in planned] == [
        ("alert_event:1", "all_clear", True), ("alert_event:2", "stop_work", False), ("alert_event:3", "all_clear", False)]
    assert planned[0].skipped


def test_plan_flood_and_advisories():
    adv = {"source": "advisory", "id": "adv_1", "status": "active", "site_id": "a", "site_name": "A",
           "timezone": "America/New_York", "recorded_at": T0, "from_bearing_deg": 90.0, "speed_mph": 20.0}
    planned = notify.plan([event(5, "flood", "created", all_clear_at=None), adv, {**adv, "id": "adv_2", "status": "superseded"}],
                          replay=True)
    assert [(p.key, p.kind) for p in planned] == [("alert_event:5", "flood"), ("advisory:adv_1", "approaching"),
                                                 ("advisory:adv_2", "approaching")]
    assert planned[1].message.title == "[REPLAY] Lightning possible within the hour at A"
    assert planned[2].message is None and planned[2].skipped


# ---------- sending one push ----------

@pytest.fixture
def sent(monkeypatch, push_on):
    calls = []

    def fake_webpush(**kwargs):
        calls.append(kwargs)
        status = calls_status.pop(0) if calls_status else 201
        if isinstance(status, Exception):
            raise status
        if status >= 400:
            raise WebPushException("nope", response=type("R", (), {"status_code": status})())
        return type("R", (), {"status_code": status})()

    calls_status: list = []
    monkeypatch.setattr(webpush, "webpush", fake_webpush)
    return calls, calls_status


def test_send_builds_the_push(sent):
    calls, _ = sent
    sub = {"id": "sub_1", "endpoint": FCM + "x", "keys": {"p256dh": "k", "auth": "a"}}
    assert webpush.send(sub, notify.stop_work_message(SITE, 3.2, None, False)) == "sent"
    assert webpush.send(sub, notify.test_message()) == "sent"
    first, second = calls
    assert first["subscription_info"] == {"endpoint": FCM + "x", "keys": {"p256dh": "k", "auth": "a"}}
    assert json.loads(first["data"])["title"] == "STOP WORK: Big Bend, lightning 3.2 mi away"
    assert first["headers"] == {"Urgency": "high"} and first["ttl"] == 1800 and first["timeout"] == 10
    assert first["vapid_claims"] == {"sub": "https://jazrs1.github.io"}
    assert first["vapid_claims"] is not second["vapid_claims"]   # pywebpush writes aud/exp into it


def test_send_outcomes(sent):
    _, statuses = sent
    sub = {"id": "sub_1", "endpoint": FCM + "x", "keys": {"p256dh": "k", "auth": "a"}}
    statuses += [410, 404, 500, 429, ConnectionError("down")]
    assert [webpush.send(sub, notify.test_message()) for _ in range(5)] == ["gone", "gone", "failed", "failed", "failed"]


def test_real_encryption_and_vapid_signature(push_on, monkeypatch):
    """No stub for pywebpush here: a fake browser key pair, a captured HTTP request, then decrypt it."""
    import os

    import http_ece
    from cryptography.hazmat.primitives.asymmetric import ec

    browser = ec.generate_private_key(ec.SECP256R1())
    p256dh = keygen.b64url(browser.public_key().public_bytes(serialization.Encoding.X962,
                                                             serialization.PublicFormat.UncompressedPoint))
    auth = os.urandom(16)
    captured = {}

    class Session:
        def post(self, url, data=None, headers=None, timeout=None):
            captured.update(url=url, data=data, headers=headers)
            return type("R", (), {"status_code": 201, "text": "", "headers": {}})()

    real = webpush.webpush
    monkeypatch.setattr(webpush, "webpush", lambda **kw: real(**kw, requests_session=Session()))
    sub = {"id": "sub_x", "endpoint": FCM + "device", "keys": {"p256dh": p256dh, "auth": keygen.b64url(auth)}}
    assert webpush.send(sub, notify.stop_work_message(SITE, 3.2, None, False)) == "sent"
    assert captured["url"] == FCM + "device"
    assert captured["headers"]["Authorization"].startswith("vapid t=") and f"k={PUBLIC}" in captured["headers"]["Authorization"]
    plain = http_ece.decrypt(captured["data"], private_key=browser, auth_secret=auth, version="aes128gcm")
    assert json.loads(plain)["title"] == "STOP WORK: Big Bend, lightning 3.2 mi away"


# ---------- background queue: never raises, folds kicks together ----------

def test_alerts_changed_does_nothing_when_push_is_off(monkeypatch):
    monkeypatch.setattr(get_settings(), "vapid_private_key", "")
    monkeypatch.setattr(notify, "_worker", None)   # would raise if used
    notify.alerts_changed(T0, replay=False)


def test_alerts_changed_never_raises(monkeypatch, push_on):
    class Broken:
        def submit(self, *a):
            raise RuntimeError("executor gone")
    monkeypatch.setattr(notify, "_worker", Broken())
    notify.alerts_changed(T0, replay=False)
    notify.briefings_ready(["big-bend"], T0)


def test_a_failing_dispatch_is_logged_not_raised(monkeypatch, push_on, caplog):
    monkeypatch.setattr("app.db.get_pool", lambda: object())
    monkeypatch.setattr(notify, "dispatch_alerts", lambda *a: (_ for _ in ()).throw(RuntimeError("boom")))
    notify.alerts_changed(T0, replay=True)
    notify.wait_idle()
    assert "Push notifications failed" in caplog.text


def test_kicks_while_queued_use_the_newest_clock(monkeypatch, push_on):
    gate, seen = threading.Event(), []
    monkeypatch.setattr("app.db.get_pool", lambda: object())
    monkeypatch.setattr(notify, "dispatch_alerts", lambda pool, now, replay: seen.append(now))
    notify._worker.submit(gate.wait)        # hold the worker so the kicks queue up
    for i in range(5):
        notify.alerts_changed(T0 + i * MIN, replay=True)
    gate.set()
    notify.wait_idle()
    assert seen == [T0 + 4 * MIN]


def test_hook_pushes_only_when_stop_work_starts_or_clears(monkeypatch):
    kicks = []
    monkeypatch.setattr(notify, "alerts_changed", lambda now, replay: kicks.append((now, replay)))
    monkeypatch.setattr(alert_hook, "_forecast_busy", {False: threading.Lock(), True: threading.Lock()})
    monkeypatch.setattr(alert_hook, "_forecast_pool", type("P", (), {"submit": lambda self, *a: None})())
    for summary in (engine.CycleSummary(extended=["a"]), engine.CycleSummary(created=["a"]),
                    engine.CycleSummary(cleared=["b"])):
        monkeypatch.setattr(engine, "run", lambda flashes, now, replay, s=summary: s)
        alert_hook.on_new_flashes([], T0, replay=True)
    assert kicks == [(T0, True), (T0, True)]


def test_forecast_pushes_only_new_advisories(monkeypatch):
    kicks = []
    monkeypatch.setattr(notify, "alerts_changed", lambda now, replay: kicks.append(now))
    from alerts.approach import Action
    notify.forecast_cycle([Action("update", "a"), Action("clear", "b")], T0, replay=False)
    notify.forecast_cycle(None, T0, replay=False)
    notify.forecast_cycle(42, T0, replay=False)          # nonsense: logged, never raised
    notify.stop_work_cycle(None, T0, replay=False)
    notify.forecast_cycle([Action("update", "a"), Action("create", "c")], T0 + MIN, replay=False)
    assert kicks == [T0 + MIN]


# ---------- database ----------

MIGRATION = BACKEND_DIR / "db" / "migrations" / "009_push_notifications.sql"
MILES_PER_DEG_LAT = engine.EARTH_RADIUS_MI * math.pi / 180
TEST_SITES = [engine.Site("test-push-a", 25.0, -84.5), engine.Site("test-push-b", 25.5, -84.5)]


@dataclass(frozen=True)
class Flash:
    ts: datetime
    lat: float
    lon: float


class FakePool:
    def __init__(self, conn):
        self.conn = conn

    @contextmanager
    def connection(self, timeout=None):
        yield self.conn


@pytest.fixture
def conn():
    url = get_settings().database_url
    if not url:
        pytest.skip("DATABASE_URL not set")
    with psycopg.connect(url, row_factory=dict_row, connect_timeout=15) as conn:
        try:
            if conn.execute("SELECT to_regclass('push_subscriptions') AS t").fetchone()["t"] is None:
                # Tables only: the index on alert_events would lock that shared table for the whole test.
                sql = MIGRATION.read_text().split("CREATE INDEX alert_events_recorded_idx")[0]
                conn.execute(sql)
            for i, s in enumerate(TEST_SITES):
                conn.execute(
                    """INSERT INTO sites (plant_id, id, name, utility, county, lat, lon, technology, capacity_mw, timezone)
                       VALUES (%s, %s, %s, 'Test', 'Test', %s, %s, 'Test', 0, 'America/New_York')""",
                    (-910_000 - i, s.id, f"Test Push {'AB'[i]}", s.lat, s.lon))
            yield conn
        finally:
            conn.rollback()


@pytest.fixture
def outbox(monkeypatch, push_on):
    """Replace the network send: records (subscription id, title) and answers from `answers`."""
    got, answers = [], {}

    def fake_send(sub, message):
        got.append((sub["id"], message.title))
        return answers.get(sub["id"], "sent")
    monkeypatch.setattr(webpush, "send", fake_send)
    return got, answers


def subscribe(conn, name, site_ids=None):
    # Keys are unique per subscription, as a browser makes them (migration 010 enforces it).
    return webpush.upsert(conn, f"{FCM}{name}", {"p256dh": f"k-{name}", "auth": "a"}, site_ids, "crew")["id"]


@pytest.fixture
def others(conn):
    """Subscriptions that aren't the test's (real ones on a shared database look like these): one for
    every site, one for test site A. Tests must pass with them there, so they only check their own."""
    return {subscribe(conn, "someone-else-all"), subscribe(conn, "someone-else-a", ["test-push-a"])}


def ours(got, *ids):
    """The (subscription, title) sends to these subscriptions only."""
    return sorted((s, t) for s, t in got if s in ids)


def strike(site, miles, at):
    return Flash(at, site.lat - miles / MILES_PER_DEG_LAT, site.lon)


def alerts_snapshot(conn):
    return conn.execute("SELECT * FROM alerts WHERE site_id LIKE 'test-push-%' ORDER BY id").fetchall()


def test_stop_work_and_all_clear_push_once_to_the_right_subscriptions(conn, outbox, others):
    got, _ = outbox
    mine = subscribe(conn, "a", ["test-push-a"])
    other = subscribe(conn, "b", ["test-push-b"])
    everyone = subscribe(conn, "all")
    pool = FakePool(conn)

    engine.process(conn, [strike(TEST_SITES[0], 3.2, T0)], T0, TEST_SITES, replay=True)
    before = alerts_snapshot(conn)
    notify.dispatch_alerts(pool, T0, replay=True)
    title = "[REPLAY] STOP WORK: Test Push A, lightning 3.2 mi away"
    assert ours(got, mine, other, everyone) == sorted([(mine, title), (everyone, title)])
    assert others <= {s for s, _ in got}               # the other subscribers for site A got it too
    assert alerts_snapshot(conn) == before            # sending never touches alerts
    stop_sends = len(got)

    got.clear()
    notify.dispatch_alerts(pool, T0 + MIN, replay=True)
    assert got == []                                   # already claimed: no duplicate

    engine.process(conn, [], T0 + 31 * MIN, TEST_SITES, replay=True)
    notify.dispatch_alerts(pool, T0 + 31 * MIN, replay=True)
    assert [t for _, t in ours(got, mine, other, everyone)] == ["[REPLAY] All clear at Test Push A"] * 2
    sent = conn.execute("SELECT kind, sent FROM push_log WHERE site_id = 'test-push-a' ORDER BY claimed_at, kind").fetchall()
    # `sent` counts every subscription reached, ours and everyone else's.
    assert sorted((r["kind"], r["sent"]) for r in sent) == [("all_clear", len(got)), ("stop_work", stop_sends)]


def test_old_events_are_not_pushed(conn, outbox, others):
    got, _ = outbox
    subscribe(conn, "all")
    engine.process(conn, [strike(TEST_SITES[0], 2, T0)], T0, TEST_SITES, replay=True)
    notify.dispatch_alerts(FakePool(conn), T0 + notify.RECENT[True] + MIN, replay=True)
    assert got == []


def test_expired_subscriptions_are_removed_and_failures_counted(conn, outbox, others):
    got, answers = outbox
    gone, flaky = subscribe(conn, "gone"), subscribe(conn, "flaky")
    answers.update({gone: "gone", flaky: "failed"})
    engine.process(conn, [strike(TEST_SITES[1], 1, T0)], T0, TEST_SITES, replay=True)
    notify.dispatch_alerts(FakePool(conn), T0, replay=True)
    rows = {r["id"]: r["failures"] for r in conn.execute(
        "SELECT id, failures FROM push_subscriptions WHERE id = ANY(%s)", ([gone, flaky, *others],)).fetchall()}
    assert gone not in rows and rows[flaky] == 1
    assert all(rows[i] == 0 for i in others)           # everyone else's subscriptions are untouched


def test_a_crashing_send_leaves_alerts_alone(conn, monkeypatch, push_on, caplog):
    subscribe(conn, "all")
    monkeypatch.setattr(webpush, "send", lambda sub, m: (_ for _ in ()).throw(RuntimeError("network")))
    monkeypatch.setattr("app.db.get_pool", lambda: FakePool(conn))
    engine.process(conn, [strike(TEST_SITES[0], 4, T0)], T0, TEST_SITES, replay=True)
    before = alerts_snapshot(conn)
    notify._guard(notify.dispatch_alerts, T0, True)
    assert "Push notifications failed" in caplog.text and alerts_snapshot(conn) == before


def test_flood_alert_pushes_live(conn, outbox, others):
    got, _ = outbox
    everyone = subscribe(conn, "all")
    conn.execute(
        """WITH a AS (INSERT INTO alerts (site_id, type, status, started_at, all_clear_at, replay)
                      VALUES ('test-push-b', 'flood', 'active', %(t)s, NULL, false) RETURNING id)
           INSERT INTO alert_events (alert_id, event, at, recorded_at) SELECT id, 'created', %(t)s, %(t)s FROM a""",
        {"t": T0})
    notify.dispatch_alerts(FakePool(conn), T0, replay=False)
    assert ours(got, everyone) == [(everyone, "Flood alert: Test Push B")]


def test_approach_advisory_pushes_once(conn, outbox, others):
    if conn.execute("SELECT to_regclass('lightning_advisories') AS t").fetchone()["t"] is None:
        pytest.skip("migration 008 not applied")
    got, _ = outbox
    everyone = subscribe(conn, "all")
    for status in ("active", "superseded"):
        conn.execute(
            """INSERT INTO lightning_advisories (site_id, replay, status, started_at, updated_at, arrival_at, first_arrival_at,
                                                 from_bearing_deg, heading_deg, speed_mph, distance_mi, cell_flashes)
               VALUES (%s, true, %s, %s, %s, %s, %s, 250, 70, 18, 20, 40)""",
            ("test-push-a" if status == "active" else "test-push-b", status, T0, T0, T0 + 40 * MIN, T0 + 40 * MIN))
    notify.dispatch_alerts(FakePool(conn), T0, replay=True)
    notify.dispatch_alerts(FakePool(conn), T0 + MIN, replay=True)
    assert ours(got, everyone) == [(everyone, "[REPLAY] Lightning possible within the hour at Test Push A")]


def test_briefing_summary_per_subscription(conn, outbox, others):
    got, _ = outbox
    one, everyone = subscribe(conn, "one", ["test-push-a"]), subscribe(conn, "all")
    for site, go in (("test-push-a", "caution"), ("test-push-b", "go")):
        conn.execute("""INSERT INTO briefings (site_id, for_date, text, created_at, go_status, headline)
                        VALUES (%s, '2031-01-07', 'x', %s, %s, 'Heat index 101°F after noon')""", (site, T0 + MIN, go))
    pool = FakePool(conn)
    notify.dispatch_briefings(pool, ["test-push-a", "test-push-b"], T0)
    notify.dispatch_briefings(pool, ["test-push-a", "test-push-b"], T0)   # same briefings: no repeat
    by = dict(ours(got, one, everyone))
    assert len(ours(got, one, everyone)) == 2          # one each, and no repeat
    assert by[one] == "Tomorrow at Test Push A: CAUTION"
    assert by[everyone] == "Tomorrow's safety briefings are ready"


# ---------- routes ----------

@pytest.fixture
def client(conn, push_on, outbox):
    push_route.test_limit.reset()
    app = FastAPI()
    app.include_router(push_route.router)
    app.dependency_overrides[get_pool] = lambda: FakePool(conn)
    return TestClient(app)


def body(endpoint=FCM + "route", site_ids=None, role="supervisor"):
    return {"subscription": {"endpoint": endpoint, "expirationTime": None, "keys": {"p256dh": "k-route", "auth": "a"}},
            "site_ids": site_ids, "role": role}


def test_routes_round_trip(client):
    assert client.get("/push/public-key").json() == {"public_key": PUBLIC}
    first = client.post("/push/subscribe", json=body(site_ids=["big-bend", "big-bend"]))
    assert first.status_code == 201 and first.json()["site_ids"] == ["big-bend"]
    again = client.post("/push/subscribe", json=body(site_ids=None, role="crew")).json()
    assert again["id"] == first.json()["id"] and again["site_ids"] is None and again["role"] == "crew"
    assert client.post("/push/test", json={"endpoint": FCM + "route"}).json() == {"sent": True, "removed": False}
    assert client.post("/push/test", json={"endpoint": FCM + "route"}).status_code == 429
    assert client.post("/push/unsubscribe", json={"endpoint": FCM + "route"}).json() == {"removed": True}
    assert client.post("/push/unsubscribe", json={"endpoint": FCM + "route"}).json() == {"removed": False}
    assert client.post("/push/test", json={"endpoint": FCM + "route"}).status_code == 404


def test_test_push_to_an_expired_subscription_removes_it(client, outbox):
    _, answers = outbox
    sub_id = client.post("/push/subscribe", json=body()).json()["id"]
    answers[sub_id] = "gone"
    assert client.post("/push/test", json={"endpoint": FCM + "route"}).json() == {"sent": False, "removed": True}
    assert client.post("/push/test", json={"endpoint": FCM + "route"}).status_code == 404


@pytest.mark.parametrize("bad", [body(endpoint="https://example.com/hook"), body(site_ids=["nope"]), body(site_ids=[]),
                                 body(role="admin")])
def test_subscribe_rejects_bad_requests(client, bad):
    assert client.post("/push/subscribe", json=bad).status_code == 422


def test_routes_are_off_without_keys(monkeypatch):
    monkeypatch.setattr(get_settings(), "vapid_public_key", "")
    app = FastAPI()
    app.include_router(push_route.router)
    assert TestClient(app).get("/push/public-key").status_code == 503


def test_mocks_match_the_schemas():
    from app import schemas
    mocks = BACKEND_DIR.parent / "shared" / "mocks"
    load = lambda name: json.loads((mocks / name).read_text())   # noqa: E731
    schemas.PushPublicKey(**load("push_public_key.json"))
    schemas.PushSubscribeRequest(**load("push_subscribe_request.json"))
    schemas.PushSubscriptionInfo(**load("push_subscription.json"))
    schemas.PushTestResponse(**load("push_test.json"))
    assert Path(mocks / "push_notifications.json").exists()
