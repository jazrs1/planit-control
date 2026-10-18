"""Lightning stop-work alert engine. Walkthrough: docs/alert-engine.md.

Rules (Sperry brief):
  - A flash within 10 miles of a site starts a stop-work alert for that site.
  - all_clear_at = time of the most recent qualifying strike + 30 minutes.
  - Every newer qualifying strike resets the countdown.
  - Once `now` passes all_clear_at, the alert is cleared, but only while the live lightning feed is
    current (lightning/health.py). While it isn't, a real alert whose countdown ran out is held: it stays
    active and no all clear is pushed. The first cycle after the feed recovers ingests the backlog
    (strikes extend or restart as usual) and still holds; the next one clears what's still expired.
    Until the engine closes or extends it, GET /alerts shows any open real alert past its all_clear_at
    with held_reason "lightning_data_delayed". Replay alerts are never held.

Two principles make this correct with late files, out-of-order files, and replay:
  - Countdowns come from strike times, never from when the engine happened to see them.
  - "Now" is always the `now` passed in by the caller, never the wall clock.

Called once per ingestion cycle from lightning/alert_hook.py via run(). Connections must
return rows as dicts (psycopg.rows.dict_row), as the app's pool does.
"""

import logging
import math
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from psycopg import Connection

log = logging.getLogger(__name__)

STOP_WORK_RADIUS_MI = 10.0
ALL_CLEAR_AFTER = timedelta(minutes=30)
ALERT_TYPE = "lightning"
HELD_DATA_DELAYED = "lightning_data_delayed"
EARTH_RADIUS_MI = 3958.8


@dataclass(frozen=True)
class Site:
    id: str
    lat: float
    lon: float


@dataclass(frozen=True)
class SiteStrikes:
    """The qualifying strikes (within the radius) at one site in one batch of flashes."""
    site_id: str
    newest_at: datetime
    newest_distance_mi: float
    earliest_at: datetime
    count: int


@dataclass(frozen=True)
class ActiveAlert:
    id: str
    site_id: str
    started_at: datetime
    last_strike_at: datetime
    all_clear_at: datetime


@dataclass
class CycleSummary:
    created: list[str] = field(default_factory=list)   # site ids
    extended: list[str] = field(default_factory=list)
    cleared: list[str] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.created or self.extended or self.cleared)


# ---------- 1. Distance ----------

def miles_between(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle (haversine) distance in miles between two lat/lon points."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat, dlon = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(math.sqrt(h))


# ---------- 2. Qualifying strikes per site ----------

def newest_qualifying_strikes(flashes: Iterable, sites: Iterable[Site],
                              radius_mi: float = STOP_WORK_RADIUS_MI) -> dict[str, SiteStrikes]:
    """For each site with at least one flash within `radius_mi`, its newest qualifying strike
    (time and distance), its earliest one, and how many there were.

    Flashes are judged by their own strike time (`flash.ts`), and a batch may be in any order.
    One flash can qualify for several sites.
    """
    found: dict[str, SiteStrikes] = {}
    sites = list(sites)
    for flash in flashes:
        for site in sites:
            distance = miles_between(site.lat, site.lon, flash.lat, flash.lon)
            if distance > radius_mi:
                continue
            prev = found.get(site.id)
            if prev is None:
                found[site.id] = SiteStrikes(site.id, flash.ts, distance, flash.ts, 1)
                continue
            newer = flash.ts > prev.newest_at
            found[site.id] = SiteStrikes(
                site_id=site.id,
                newest_at=flash.ts if newer else prev.newest_at,
                newest_distance_mi=distance if newer else prev.newest_distance_mi,
                earliest_at=min(prev.earliest_at, flash.ts),
                count=prev.count + 1,
            )
    return found


# ---------- 3. Decide what a batch of strikes does to a site's alert ----------

def decide(alert: ActiveAlert | None, strikes: SiteStrikes, now: datetime) -> str:
    """What these strikes do to the site's active alert (pure function, no database).

    'create'  - no alert yet, and the strike's 30-minute countdown hasn't already run out.
    'ignore'  - no alert, but the strike is so old its countdown is already over (very late file).
    'keep'    - the strikes are not newer than the alert's last strike (late or repeated file):
                the countdown must never get shorter, so nothing changes.
    'extend'  - a newer strike while the alert is running: reset the countdown from it.
    'restart' - the alert's countdown had already ended before these strikes happened (just not
                cleared yet): close it at its all_clear_at and start a new alert.
    """
    countdown_end = strikes.newest_at + ALL_CLEAR_AFTER
    if alert is None:
        return "create" if countdown_end > now else "ignore"
    if strikes.newest_at <= alert.last_strike_at:
        return "keep"
    if strikes.earliest_at >= alert.all_clear_at:
        return "restart" if countdown_end > now else "ignore"
    return "extend"


# ---------- 4. Writes (each one statement that also logs to alert_events) ----------

def create_alert(conn: Connection, strikes: SiteStrikes, now: datetime, replay: bool) -> None:
    """Open a stop-work alert that started at the earliest strike and ends 30 min after the newest."""
    conn.execute(
        """WITH a AS (
               INSERT INTO alerts (site_id, type, status, started_at, all_clear_at,
                                   last_strike_at, last_strike_distance_mi, replay)
               VALUES (%(site)s, %(type)s, 'active', %(earliest)s, %(clear)s, %(newest)s, %(dist)s, %(replay)s)
               RETURNING id)
           INSERT INTO alert_events (alert_id, event, at, recorded_at, strike_distance_mi, all_clear_at)
           SELECT id, 'created', %(earliest)s, %(now)s, %(dist)s, %(clear)s FROM a""",
        {"site": strikes.site_id, "type": ALERT_TYPE, "earliest": strikes.earliest_at,
         "newest": strikes.newest_at, "dist": round(strikes.newest_distance_mi, 2),
         "clear": strikes.newest_at + ALL_CLEAR_AFTER, "replay": replay, "now": now},
    )


def extend_alert(conn: Connection, alert: ActiveAlert, strikes: SiteStrikes, now: datetime) -> None:
    """Reset the countdown from a newer strike. Only called when that strike is newer than the
    alert's last strike, so the new all_clear_at is always later than the old one."""
    conn.execute(
        """WITH a AS (
               UPDATE alerts
               SET last_strike_at = %(newest)s, last_strike_distance_mi = %(dist)s,
                   all_clear_at = %(clear)s, started_at = LEAST(started_at, %(earliest)s)
               WHERE id = %(id)s
               RETURNING id)
           INSERT INTO alert_events (alert_id, event, at, recorded_at, strike_distance_mi, all_clear_at)
           SELECT id, 'extended', %(newest)s, %(now)s, %(dist)s, %(clear)s FROM a""",
        {"id": alert.id, "newest": strikes.newest_at, "earliest": strikes.earliest_at,
         "dist": round(strikes.newest_distance_mi, 2),
         "clear": strikes.newest_at + ALL_CLEAR_AFTER, "now": now},
    )


def backdate_alert(conn: Connection, alert: ActiveAlert, strikes: SiteStrikes) -> None:
    """A late file showed the storm started earlier than we thought: move started_at back.
    The countdown is untouched."""
    conn.execute("UPDATE alerts SET started_at = %s WHERE id = %s AND started_at > %s",
                 (strikes.earliest_at, alert.id, strikes.earliest_at))


def clear_alert(conn: Connection, alert_id: str, now: datetime) -> None:
    """Close one alert, recording that it cleared at its all_clear_at."""
    conn.execute(
        """WITH c AS (
               UPDATE alerts SET status = 'cleared' WHERE id = %(id)s AND status = 'active'
               RETURNING id, all_clear_at)
           INSERT INTO alert_events (alert_id, event, at, recorded_at, all_clear_at)
           SELECT id, 'cleared', all_clear_at, %(now)s, all_clear_at FROM c""",
        {"id": alert_id, "now": now},
    )


def clear_expired(conn: Connection, now: datetime, replay: bool) -> list[str]:
    """Clear every active lightning alert whose countdown ended at or before `now`.
    Runs every cycle, including cycles with no flashes. Returns the cleared site ids."""
    rows = conn.execute(
        """WITH c AS (
               UPDATE alerts SET status = 'cleared'
               WHERE type = %(type)s AND replay = %(replay)s AND status = 'active'
                 AND all_clear_at <= %(now)s
               RETURNING id, site_id, all_clear_at),
           e AS (
               INSERT INTO alert_events (alert_id, event, at, recorded_at, all_clear_at)
               SELECT id, 'cleared', all_clear_at, %(now)s, all_clear_at FROM c)
           SELECT site_id FROM c""",
        {"type": ALERT_TYPE, "replay": replay, "now": now},
    ).fetchall()
    return [r["site_id"] for r in rows]


# ---------- 5. Reads ----------

def load_sites(conn: Connection) -> list[Site]:
    return [Site(**r) for r in conn.execute("SELECT id, lat, lon FROM sites").fetchall()]


def load_active_alerts(conn: Connection, site_ids: list[str], replay: bool) -> dict[str, ActiveAlert]:
    """Active lightning alerts for these sites, locked until the cycle's transaction commits."""
    if not site_ids:
        return {}
    rows = conn.execute(
        """SELECT id, site_id, started_at, last_strike_at, all_clear_at FROM alerts
           WHERE type = %s AND replay = %s AND status = 'active' AND site_id = ANY(%s)
           FOR UPDATE""",
        (ALERT_TYPE, replay, site_ids),
    ).fetchall()
    return {r["site_id"]: ActiveAlert(**r) for r in rows}


def feed_current(now: datetime) -> bool:
    """The live lightning feed's last successful cycle is under 2 minutes old (the beacon's check)."""
    from lightning import health

    return health.is_current(now, replay=False)


def active_alerts(conn: Connection, now: datetime, replay: bool, site_id: str | None = None) -> list[dict]:
    """Alerts in effect at `now` (any type), newest first, each with held_reason. A replay alert or a
    flood alert whose all_clear_at has passed is hidden at once, without waiting for the next engine
    cycle. A real lightning alert past its all_clear_at stays until the engine closes or extends it,
    with held_reason "lightning_data_delayed": the engine is holding it (feed not current) or hasn't
    confirmed the all clear yet (the cycle that clears it runs at most 20 s later), so it never reads
    as all clear while still open."""
    held = None if replay else HELD_DATA_DELAYED
    return conn.execute(
        """SELECT id, site_id, type, started_at, all_clear_at, last_strike_at, last_strike_distance_mi, replay,
                  CASE WHEN type = %(type)s AND all_clear_at <= %(now)s THEN %(held)s::text END AS held_reason
           FROM alerts
           WHERE status = 'active' AND replay = %(replay)s
             AND (all_clear_at IS NULL OR all_clear_at > %(now)s
                  OR (type = %(type)s AND %(held)s::text IS NOT NULL))
             AND (%(site)s::text IS NULL OR site_id = %(site)s)
           ORDER BY started_at DESC""",
        {"replay": replay, "now": now, "site": site_id, "type": ALERT_TYPE, "held": held},
    ).fetchall()


def alerts_for_api(conn: Connection, real_now: datetime, replay_now: datetime | None,
                   site_id: str | None = None) -> list[dict]:
    """What GET /alerts shows: live alerts in effect at real time, plus, while a replay runs
    (`replay_now` is its simulated time), replay alerts in effect at that time. Each row has
    `replay`, so the frontend can label them. Real alerts never disappear during a replay.
    Replay alerts first, then live; newest first within each."""
    rows = active_alerts(conn, replay_now, replay=True, site_id=site_id) if replay_now else []
    return rows + active_alerts(conn, real_now, replay=False, site_id=site_id)


# ---------- 6. One engine cycle ----------

def process(conn: Connection, flashes: Iterable, now: datetime, sites: Iterable[Site],
            replay: bool = False, hold_clears: bool = False) -> CycleSummary:
    """Apply one batch of flashes, then clear expired alerts, inside the caller's transaction.
    hold_clears: the lightning feed isn't current, so expired alerts stay active (held) this cycle.

    Order matters: strikes are applied before clearing, so a late-arriving strike that keeps an
    alert alive extends it instead of letting it clear and immediately reopen.
    """
    # One engine at a time per mode (several API processes may share the database).
    conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"alert-engine:{ALERT_TYPE}:{replay}",))
    summary = CycleSummary()
    strikes = newest_qualifying_strikes(flashes, sites)
    alerts = load_active_alerts(conn, sorted(strikes), replay)

    with conn.pipeline():  # send all writes in one round trip
        for site_id, site_strikes in sorted(strikes.items()):
            alert = alerts.get(site_id)
            action = decide(alert, site_strikes, now)
            if action == "create":
                create_alert(conn, site_strikes, now, replay)
                summary.created.append(site_id)
            elif action == "extend":
                extend_alert(conn, alert, site_strikes, now)
                summary.extended.append(site_id)
            elif action == "restart":
                clear_alert(conn, alert.id, now)
                create_alert(conn, site_strikes, now, replay)
                summary.cleared.append(site_id)
                summary.created.append(site_id)
            elif action == "keep" and site_strikes.earliest_at < alert.started_at:
                backdate_alert(conn, alert, site_strikes)
    if not hold_clears:
        summary.cleared += clear_expired(conn, now, replay)
    return summary


def run(flashes: list, now: datetime, *, replay: bool, feed_ok: bool = True) -> CycleSummary:
    """Entry point for the ingestion hook: one transaction per cycle. feed_ok: this live cycle's own
    check passed (every file ingested, NOAA's newest file under 2 minutes old). Live alerts are cleared
    only when that holds and the previous cycles were current too (lightning/health.py)."""
    from app.db import get_pool

    hold = not replay and not (feed_ok and feed_current(now))
    with get_pool().connection() as conn:
        summary = process(conn, flashes, now, load_sites(conn), replay=replay, hold_clears=hold)
    if summary.changed:
        from app.cache import api_cache

        api_cache.invalidate()  # committed: let /alerts and /sites show it on the next request
        log.info("Alerts at %s%s: created %s, extended %s, cleared %s", now.isoformat(timespec="seconds"),
                 " (replay)" if replay else "", summary.created, summary.extended, summary.cleared)
    return summary
