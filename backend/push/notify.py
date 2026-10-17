"""Which events become push notifications, what they say, and the background sender.

Notifications (replay ones are prefixed "[REPLAY]" so a demo replay pushes too):
  - stop_work    a lightning stop-work starts          "STOP WORK: <site>, lightning 3.2 mi away"
  - approaching  a "lightning approaching" advisory starts  "Lightning possible within the hour at <site>"
  - all_clear    a lightning stop-work clears          "All clear at <site>"
  - flood        a flood-risk alert starts             "Flood alert: <site>"
  - briefings    after the 6 PM briefings              one summary per subscription, for its sites

How it stays out of the way of alerts:
  - The alert code only calls alerts_changed() / briefings_ready() AFTER its transaction commits. Both
    just queue work on one background thread and never raise or block.
  - The sender reads alert_events and lightning_advisories (it never writes alerts) and works in its
    own transactions.
How it avoids duplicates: every event has a key ('alert_event:<id>', 'advisory:<id>',
'briefing:<site>:<date>') that is claimed in push_log before sending; a key already there is never
sent again, across retries, restarts and API processes. A failed send isn't retried.
A sweep every minute catches events whose call was lost (e.g. a restart right after a commit). Only
events from the last RECENT are considered, so a server that was down doesn't push stale alerts.
"""

import asyncio
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import psycopg
from psycopg import Connection

from app import clock
from app.config import get_settings
from lightning.cells import compass
from push import webpush
from push.webpush import Message

log = logging.getLogger(__name__)

REPLAY_PREFIX = "[REPLAY] "
# Live: real minutes. Replay: simulated minutes (a 30x replay covers 60 of them in 2 real minutes).
RECENT = {False: timedelta(minutes=10), True: timedelta(minutes=60)}
SWEEP_SECONDS = 60
SEND_WORKERS = 8
GO_LABELS = {"go": "GO", "caution": "CAUTION", "no_go": "NO-GO"}


# ---------- what the notifications say (pure) ----------

def local_time(ts: datetime, tz: str) -> str:
    t = ts.astimezone(ZoneInfo(tz))
    return f"{t:%I:%M %p}".lstrip("0") + f" {t:%Z}"


def _title(text: str, replay: bool) -> str:
    return REPLAY_PREFIX + text if replay else text


def stop_work_message(site: dict, distance_mi: float | None, all_clear_at: datetime | None, replay: bool) -> Message:
    where = f"lightning {distance_mi:.1f} mi away" if distance_mi is not None else "lightning within 10 mi"
    until = f"no earlier than {local_time(all_clear_at, site['timezone'])}" if all_clear_at else "30 min after the last strike"
    return Message("stop_work", _title(f"STOP WORK: {site['name']}, {where}", replay),
                   f"Shelter now. All clear {until}; every new strike within 10 mi resets the countdown.",
                   f"/sites/{site['id']}", f"lightning:{site['id']}", site["id"], replay, urgency="high")


def all_clear_message(site: dict, replay: bool) -> Message:
    return Message("all_clear", _title(f"All clear at {site['name']}", replay),
                   "No lightning within 10 mi for 30 minutes. The stop-work is lifted.",
                   f"/sites/{site['id']}", f"lightning:{site['id']}", site["id"], replay, urgency="high")


def approaching_message(site: dict, from_bearing_deg: float, speed_mph: float, replay: bool) -> Message:
    motion = "barely moving" if speed_mph < 2 else f"moving about {speed_mph:.0f} mph"
    return Message("approaching", _title(f"Lightning possible within the hour at {site['name']}", replay),
                   f"Storm to the {compass(from_bearing_deg)}, {motion}. A heads-up, not a stop-work order.",
                   f"/sites/{site['id']}", f"lightning:{site['id']}", site["id"], replay, urgency="high")


def flood_message(site: dict, all_clear_at: datetime | None, replay: bool) -> Message:
    # flood.py sets all_clear_at only when an NWS warning drives the alert.
    why = (f"NWS flood warning until {local_time(all_clear_at, site['timezone'])}." if all_clear_at
           else "2+ inches of rain in 12 hours at a flood-prone site.")
    return Message("flood", _title(f"Flood alert: {site['name']}", replay),
                   f"{why} Stay off low ground and flooded roads.",
                   f"/sites/{site['id']}", f"flood:{site['id']}", site["id"], replay,
                   ttl_seconds=6 * 3600, urgency="high")


def briefing_summary(rows: list[dict]) -> Message:
    """One subscription's summary of the briefings just written for its sites."""
    rows = sorted(rows, key=lambda r: r["site_name"])
    ttl = 12 * 3600
    if len(rows) == 1:
        r = rows[0]
        label = GO_LABELS.get(r["go_status"], "briefing ready")
        return Message("briefings", f"Tomorrow at {r['site_name']}: {label}",
                       r["headline"] or "Tomorrow's safety briefing is ready.",
                       f"/briefing/{r['site_id']}", "briefings", r["site_id"], ttl_seconds=ttl)
    parts = []
    no_go = [r["site_name"] for r in rows if r["go_status"] == "no_go"]
    if no_go:
        parts.append("No-go: " + ", ".join(no_go[:3]) + (f" +{len(no_go) - 3} more" if len(no_go) > 3 else "") + ".")
    for status, label in (("caution", "Caution"), ("go", "Go")):
        n = sum(r["go_status"] == status for r in rows)
        if n:
            parts.append(f"{label}: {n} site{'s' if n != 1 else ''}.")
    return Message("briefings", "Tomorrow's safety briefings are ready",
                   " ".join(parts) or f"{len(rows)} briefings ready.", "/briefings", "briefings", ttl_seconds=ttl)


def test_message() -> Message:
    return Message("test", "PlanIT Control test notification", "Push notifications work on this device.",
                   "/", "test", ttl_seconds=300)


@dataclass(frozen=True)
class Planned:
    key: str
    kind: str
    site_id: str | None
    message: Message | None
    skipped: str | None = None


def plan(rows: list[dict], replay: bool) -> list[Planned]:
    """Notifications for pending events (alert events and advisories), oldest first. Pure."""
    out = []
    for i, r in enumerate(rows):
        site = {"id": r["site_id"], "name": r["site_name"], "timezone": r["timezone"]}
        if r["source"] == "advisory":
            key = f"advisory:{r['id']}"
            if r["status"] != "active":
                out.append(Planned(key, "approaching", site["id"], None, "advisory ended before it was sent"))
            else:
                out.append(Planned(key, "approaching", site["id"],
                                   approaching_message(site, r["from_bearing_deg"], r["speed_mph"], replay)))
            continue
        key = f"alert_event:{r['id']}"
        if r["type"] == "flood":
            out.append(Planned(key, "flood", site["id"], flood_message(site, r["all_clear_at"], replay)))
        elif r["event"] == "created":
            out.append(Planned(key, "stop_work", site["id"],
                               stop_work_message(site, r["strike_distance_mi"], r["all_clear_at"], replay)))
        elif any(later["source"] == "alert" and later["type"] == "lightning" and later["event"] == "created"
                 and later["site_id"] == r["site_id"] for later in rows[i + 1:]):
            # The engine closed an expired countdown and opened a new stop-work in one go ("restart").
            out.append(Planned(key, "all_clear", site["id"], None, "a new stop-work started right after"))
        else:
            out.append(Planned(key, "all_clear", site["id"], all_clear_message(site, replay)))
    return out


# ---------- database ----------

ALERT_EVENTS_SQL = """
    SELECT 'alert' AS source, e.id, e.event, e.recorded_at, e.strike_distance_mi, e.all_clear_at,
           a.type, a.site_id, s.name AS site_name, s.timezone
    FROM alert_events e JOIN alerts a ON a.id = e.alert_id JOIN sites s ON s.id = a.site_id
    WHERE a.replay = %(replay)s AND e.recorded_at > %(since)s AND e.recorded_at <= %(now)s
      AND ((a.type = 'lightning' AND e.event IN ('created', 'cleared')) OR (a.type = 'flood' AND e.event = 'created'))
      AND NOT EXISTS (SELECT 1 FROM push_log p WHERE p.event_key = 'alert_event:' || e.id)
    ORDER BY e.recorded_at, e.id"""

ADVISORIES_SQL = """
    SELECT 'advisory' AS source, v.id, v.status, v.started_at AS recorded_at, v.from_bearing_deg, v.speed_mph,
           v.site_id, s.name AS site_name, s.timezone
    FROM lightning_advisories v JOIN sites s ON s.id = v.site_id
    WHERE v.replay = %(replay)s AND v.started_at > %(since)s AND v.started_at <= %(now)s
      AND NOT EXISTS (SELECT 1 FROM push_log p WHERE p.event_key = 'advisory:' || v.id)
    ORDER BY v.started_at, v.id"""


def pending(conn: Connection, now: datetime, replay: bool) -> list[dict]:
    """Alert events and advisories from the last RECENT (engine clock) that haven't been claimed."""
    params = {"replay": replay, "since": now - RECENT[replay], "now": now}
    rows = conn.execute(ALERT_EVENTS_SQL, params).fetchall()
    try:
        with conn.transaction():   # savepoint: lightning_advisories needs migration 008
            rows += conn.execute(ADVISORIES_SQL, params).fetchall()
    except psycopg.errors.UndefinedTable:
        pass
    return sorted(rows, key=lambda r: r["recorded_at"])   # stable: alert events stay in id order


def claim(conn: Connection, key: str, kind: str, site_id: str | None, replay: bool, skipped: str | None = None) -> bool:
    """True if this call claimed the event (nobody sent it before)."""
    return conn.execute(
        """INSERT INTO push_log (event_key, kind, site_id, replay, skipped, sent)
           VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (event_key) DO NOTHING RETURNING event_key""",
        (key, kind, site_id, replay, skipped, 0 if skipped else None)).fetchone() is not None


def _send_all(pairs: list[tuple[dict, Message]]) -> dict[str, str]:
    if not pairs:
        return {}
    with ThreadPoolExecutor(max_workers=min(SEND_WORKERS, len(pairs)), thread_name_prefix="push-send") as senders:
        outcomes = list(senders.map(lambda p: webpush.send(*p), pairs))
    return {sub["id"]: o for (sub, _), o in zip(pairs, outcomes)}


def deliver(pool, message: Message, site_id: str | None) -> int:
    """Send to every subscription that wants this site. Returns how many it reached."""
    with pool.connection() as conn:
        subs = webpush.for_site(conn, site_id)
    outcomes = _send_all([(s, message) for s in subs])
    with pool.connection() as conn:
        webpush.record(conn, outcomes)
    return sum(o == "sent" for o in outcomes.values())


def dispatch_alerts(pool, now: datetime, replay: bool) -> list[Planned]:
    """Push every unclaimed recent alert event / advisory. Returns what this call sent."""
    with pool.connection() as conn:
        planned = plan(pending(conn, now, replay), replay)
    sent = []
    for p in planned:
        with pool.connection() as conn:
            if not claim(conn, p.key, p.kind, p.site_id, replay, p.skipped):
                continue   # another process or an earlier run has it
        if p.message is None:
            continue
        n = deliver(pool, p.message, p.site_id)
        with pool.connection() as conn:
            conn.execute("UPDATE push_log SET sent = %s WHERE event_key = %s", (n, p.key))
        log.info("Push %s at %s%s: %d subscriptions", p.kind, p.site_id, " (replay)" if replay else "", n)
        sent.append(p)
    return sent


def dispatch_briefings(pool, site_ids: list[str], since: datetime) -> int:
    """One summary per subscription for the briefings written since `since` at these sites."""
    with pool.connection() as conn:
        rows = conn.execute(
            """SELECT b.site_id, s.name AS site_name, b.for_date, b.go_status, b.headline
               FROM briefings b JOIN sites s ON s.id = b.site_id
               WHERE b.site_id = ANY(%s) AND b.created_at >= %s""", (site_ids, since)).fetchall()
        claimed = [r for r in rows if claim(conn, f"briefing:{r['site_id']}:{r['for_date']}", "briefings",
                                            r["site_id"], False)]
        subs = webpush.for_site(conn, None) if claimed else []
    pairs, included = [], {}
    for sub in subs:
        mine = [r for r in claimed if sub["site_ids"] is None or r["site_id"] in sub["site_ids"]]
        if mine:
            pairs.append((sub, briefing_summary(mine)))
            included[sub["id"]] = mine
    outcomes = _send_all(pairs)
    with pool.connection() as conn:
        webpush.record(conn, outcomes)
        for r in claimed:
            n = sum(o == "sent" and r in included[i] for i, o in outcomes.items())
            conn.execute("UPDATE push_log SET sent = %s WHERE event_key = %s",
                         (n, f"briefing:{r['site_id']}:{r['for_date']}"))
    sent = sum(o == "sent" for o in outcomes.values())
    if claimed:
        log.info("Push briefings summary for %d sites: %d subscriptions", len(claimed), sent)
    return sent


# ---------- background sender ----------

_worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="push")
_state = threading.Lock()
_queued = {False: False, True: False}       # per mode: a dispatch is queued and hasn't started
_latest_now: dict[bool, datetime] = {}      # per mode: the newest engine clock it should use
_warned_missing = False


def _active() -> bool:
    settings = get_settings()
    return settings.push_enabled and settings.push_configured and bool(settings.database_url)


def alerts_changed(now: datetime, *, replay: bool) -> None:
    """Alert events or advisories may have been committed at engine time `now`: push them soon.
    Returns at once and never raises; kicks while a dispatch is queued are folded into it."""
    try:
        if not _active():
            return
        with _state:
            # Keep the latest kick folded into this dispatch: the flood rule and the forecast thread can
            # report an older `now` than the engine.
            _latest_now[replay] = max(now, _latest_now.get(replay, now))
            if _queued[replay]:
                return
            _queued[replay] = True
        _worker.submit(_run_alerts, replay)
    except Exception:  # noqa: BLE001 - never disturb the caller (the alert engine)
        log.exception("Couldn't queue push notifications (alerts are unaffected)")


def stop_work_cycle(summary, now: datetime, *, replay: bool) -> None:
    """After a stop-work engine cycle (engine.CycleSummary) committed: push if a stop-work started or cleared.
    Never raises."""
    try:
        if getattr(summary, "created", None) or getattr(summary, "cleared", None):
            alerts_changed(now, replay=replay)
    except Exception:  # noqa: BLE001
        log.exception("Couldn't queue push notifications (alerts are unaffected)")


def forecast_cycle(actions, now: datetime, *, replay: bool) -> None:
    """After a forecast cycle (approach.Action list) committed: push if an advisory was created. Never raises."""
    try:
        if any(getattr(a, "kind", None) == "create" for a in actions or ()):
            alerts_changed(now, replay=replay)
    except Exception:  # noqa: BLE001
        log.exception("Couldn't queue push notifications (advisories are unaffected)")


def briefings_ready(site_ids: list[str], since: datetime) -> None:
    """The scheduled briefings for these sites were written at or after `since`. Never raises."""
    try:
        if _active() and site_ids:
            _worker.submit(_guard, dispatch_briefings, list(site_ids), since)
    except Exception:  # noqa: BLE001
        log.exception("Couldn't queue the briefings push")


def _run_alerts(replay: bool) -> None:
    with _state:
        _queued[replay] = False   # from here on, a new kick queues another run
        now = _latest_now.pop(replay)   # the max is per dispatch: a new replay restarts its clock earlier
    _guard(dispatch_alerts, now, replay)


def _guard(fn, *args) -> None:
    global _warned_missing
    from app.db import get_pool

    try:
        fn(get_pool(), *args)
    except psycopg.errors.UndefinedTable:
        if not _warned_missing:
            log.warning("push_subscriptions doesn't exist: run `python -m scripts.migrate` (009)")
            _warned_missing = True
    except Exception:  # noqa: BLE001 - a push failure must never surface anywhere else
        log.exception("Push notifications failed (alerts are unaffected)")


async def run_sweep_loop() -> None:
    """Every minute: catch recent events nobody pushed (live, and the replay while one runs)."""
    while True:
        alerts_changed(clock.real_now(), replay=False)
        if clock.is_simulated():
            alerts_changed(clock.now(), replay=True)
        await asyncio.sleep(SWEEP_SECONDS)


def wait_idle() -> None:
    """Block until queued push work has run (for tests)."""
    _worker.submit(lambda: None).result()
