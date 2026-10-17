""""Lightning approaching" advisories: a heads-up before a stop-work, never a stop-work itself.

Every ingestion cycle (lightning/alert_hook.py, right after the stop-work engine):
  1. find storm cells in the last 20 minutes of flashes and their motion (lightning/cells.py);
  2. for every site NOT in stop-work, the earliest time a tracked cell's leading edge reaches the
     10-mile ring within the next 60 minutes;
  3. create, update or clear that site's advisory (plan() below decides; pure).

Safety rules:
  - Advisories are rows in lightning_advisories, never in alerts. This module only reads stop-work
    alerts; it has no code path that writes them, so it can't shorten, extend or clear one.
  - A site in stop-work gets no advisory; an open one is marked 'superseded' when the stop-work starts.
  - "Now" is the hook's `now` (simulated during replay); replay advisories are stored with replay = true.
  - Once raised, an advisory is held until HOLD after the later of the last cycle that supported it
    and its estimated arrival (unless a stop-work supersedes it). Storm tracks come and go as cells
    merge, split or weaken, and arrival estimates are rough, so a site must not flip to "clear" in the
    minutes before lightning actually arrives. In the Aug 4, 2025 replay a 2-minute grace left 6 sites
    "clear" for 1-18 min right before their stop-work; holding 15 min past the last valid cycle alone
    still left Vandolah clear for 5 min (scripts/evaluate_lightning_forecast.py reports these gaps).
Docs: docs/lightning-forecast.md.
"""

import logging
import math
from dataclasses import dataclass
from datetime import datetime, timedelta

import psycopg
from psycopg import Connection

from alerts import engine
from lightning import cells as cellmod

log = logging.getLogger(__name__)

HOLD = timedelta(minutes=15)   # keep an advisory this long after it was last valid and after its arrival
_warned_missing_table = False


@dataclass(frozen=True)
class Advisory:
    id: str
    site_id: str
    started_at: datetime
    updated_at: datetime
    arrival_at: datetime
    first_arrival_at: datetime


@dataclass(frozen=True)
class Action:
    kind: str                           # 'create' | 'update' | 'clear' | 'supersede'
    site_id: str
    arrival: cellmod.Arrival | None = None
    advisory_id: str | None = None


def plan(arrivals: dict[str, cellmod.Arrival | None], stop_work: set[str],
         active: dict[str, Advisory], now: datetime) -> list[Action]:
    """What to do with each site's advisory this cycle (pure: no database, no clock)."""
    actions = []
    for site_id, adv in sorted(active.items()):
        if site_id in stop_work:
            actions.append(Action("supersede", site_id, advisory_id=adv.id))
    for site_id, arr in sorted(arrivals.items()):
        if site_id in stop_work:
            continue
        adv = active.get(site_id)
        if arr is not None:
            actions.append(Action("update" if adv else "create", site_id, arr, adv.id if adv else None))
        elif adv is not None and now - max(adv.updated_at, adv.arrival_at) >= HOLD:
            actions.append(Action("clear", site_id, advisory_id=adv.id))
    return actions


def arrivals_for(sites: list[engine.Site], found: list[cellmod.Cell], stop_work: set[str],
                 now: datetime) -> dict[str, cellmod.Arrival | None]:
    return {s.id: cellmod.earliest_arrival(found, s.lat, s.lon, now) for s in sites if s.id not in stop_work}


# ---------- database ----------

def recent_flashes(conn: Connection, now: datetime) -> tuple[list, list, list]:
    rows = conn.execute("SELECT ts, lat, lon FROM lightning_flashes WHERE ts > %s AND ts <= %s",
                        (now - cellmod.HISTORY, now)).fetchall()
    return [r["ts"] for r in rows], [r["lat"] for r in rows], [r["lon"] for r in rows]


def current_cells(conn: Connection, now: datetime) -> list[cellmod.Cell]:
    return cellmod.find_cells(*recent_flashes(conn, now), now)


def stop_work_sites(conn: Connection, now: datetime, replay: bool) -> set[str]:
    return {a["site_id"] for a in engine.active_alerts(conn, now, replay) if a["type"] == engine.ALERT_TYPE}


def load_active(conn: Connection, replay: bool) -> dict[str, Advisory]:
    rows = conn.execute(
        """SELECT id, site_id, started_at, updated_at, arrival_at, first_arrival_at FROM lightning_advisories
           WHERE replay = %s AND status = 'active' FOR UPDATE""", (replay,)).fetchall()
    return {r["site_id"]: Advisory(**r) for r in rows}


def active_advisories(conn: Connection, replay: bool, site_id: str | None = None) -> list[dict]:
    """Open advisories for the API, newest first. Empty until migration 008 is applied."""
    try:
        with conn.transaction():  # savepoint, so a missing table can't abort the caller's transaction
            return _active_advisories(conn, replay, site_id)
    except psycopg.errors.UndefinedTable:
        return []


def _active_advisories(conn: Connection, replay: bool, site_id: str | None) -> list[dict]:
    return conn.execute(
        """SELECT id, site_id, started_at, updated_at, arrival_at, from_bearing_deg, heading_deg, speed_mph,
                  distance_mi, cell_flashes
           FROM lightning_advisories
           WHERE status = 'active' AND replay = %(replay)s AND (%(site)s::text IS NULL OR site_id = %(site)s)
           ORDER BY started_at DESC""",
        {"replay": replay, "site": site_id}).fetchall()


def apply(conn: Connection, actions: list[Action], now: datetime, replay: bool) -> None:
    for a in actions:
        if a.kind in ("clear", "supersede"):
            conn.execute(
                """UPDATE lightning_advisories SET status = %s, ended_at = %s WHERE id = %s AND status = 'active'""",
                ("cleared" if a.kind == "clear" else "superseded", now, a.advisory_id))
            continue
        arr = a.arrival
        values = {"site": a.site_id, "replay": replay, "now": now, "arrival": arr.arrival_at,
                  "from": arr.from_bearing_deg, "heading": arr.heading_deg, "speed": arr.speed_mph,
                  "dist": arr.distance_mi, "n": arr.cell_flashes, "id": a.advisory_id}
        if a.kind == "create":
            conn.execute(
                """INSERT INTO lightning_advisories (site_id, replay, started_at, updated_at, arrival_at, first_arrival_at,
                                                     from_bearing_deg, heading_deg, speed_mph, distance_mi, cell_flashes)
                   VALUES (%(site)s, %(replay)s, %(now)s, %(now)s, %(arrival)s, %(arrival)s,
                           %(from)s, %(heading)s, %(speed)s, %(dist)s, %(n)s)""", values)
        else:
            conn.execute(
                """UPDATE lightning_advisories SET updated_at = %(now)s, arrival_at = %(arrival)s,
                          from_bearing_deg = %(from)s, heading_deg = %(heading)s, speed_mph = %(speed)s,
                          distance_mi = %(dist)s, cell_flashes = %(n)s
                   WHERE id = %(id)s AND status = 'active'""", values)


def process(conn: Connection, now: datetime, replay: bool) -> list[Action]:
    """One cycle inside the caller's transaction. Reads stop-work alerts; writes only advisories."""
    conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"lightning-approach:{replay}",))
    found = current_cells(conn, now)
    stop = stop_work_sites(conn, now, replay)
    sites = engine.load_sites(conn)
    actions = plan(arrivals_for(sites, found, stop, now), stop, load_active(conn, replay), now)
    apply(conn, actions, now, replay)
    return actions


def run(now: datetime, *, replay: bool) -> list[Action]:
    """Entry point for the ingestion hook: one transaction per cycle."""
    global _warned_missing_table
    from app.db import get_pool

    try:
        with get_pool().connection() as conn:
            actions = process(conn, now, replay)
    except psycopg.errors.UndefinedTable:
        if not _warned_missing_table:
            log.warning("lightning_advisories doesn't exist: run `python -m scripts.migrate` (008)")
            _warned_missing_table = True
        return []
    changed = [a for a in actions if a.kind != "update"]
    if actions:
        from app.cache import api_cache

        api_cache.invalidate()  # committed: /sites, /sites/{id} and the beacon show it next request
    if changed:
        log.info("Lightning approaching at %s%s: %s", now.isoformat(timespec="seconds"), " (replay)" if replay else "",
                 ", ".join(f"{a.kind} {a.site_id}" for a in changed))
    return actions


def view(adv: dict | None, now: datetime) -> dict | None:
    """An open advisory as the API's LightningApproach (minutes counted from `now`)."""
    if adv is None:
        return None
    return {"arrival_at": adv["arrival_at"],
            "minutes_to_arrival": max(0, math.ceil((adv["arrival_at"] - now).total_seconds() / 60)),
            "from_direction": cellmod.compass(adv["from_bearing_deg"]), "from_bearing_deg": adv["from_bearing_deg"],
            "heading_deg": adv["heading_deg"], "speed_mph": adv["speed_mph"], "distance_mi": adv["distance_mi"],
            "issued_at": adv["started_at"], "updated_at": adv["updated_at"],
            "replay": bool(adv.get("replay", False))}


def beacon(site_id: str, alerts: list[dict], advisory: dict | None, now: datetime, current: bool = True) -> dict:
    """State for a hardware alarm, from the site's alerts in effect at `now` and its open advisory.
    Priority: stop (lightning stop-work) > unknown > approaching > flood (our flood-risk alert) > clear.
    `current`: lightning ingestion succeeded recently (lightning/health.py). When it hasn't, anything
    short of a stop-work is "unknown": no data must never read as clear."""
    stop = next((a for a in alerts if a["type"] == engine.ALERT_TYPE), None)
    if stop:
        return {"site_id": site_id, "state": "stop", "minutes_to_arrival": None, "as_of": now,
                "seconds_to_all_clear": max(0, math.ceil((stop["all_clear_at"] - now).total_seconds()))}
    if not current:
        return {"site_id": site_id, "state": "unknown", "seconds_to_all_clear": None, "minutes_to_arrival": None,
                "as_of": now}
    if advisory:
        return {"site_id": site_id, "state": "approaching", "seconds_to_all_clear": None, "as_of": now,
                "minutes_to_arrival": max(0, math.ceil((advisory["arrival_at"] - now).total_seconds() / 60))}
    state = "flood" if any(a["type"] == "flood" for a in alerts) else "clear"
    return {"site_id": site_id, "state": state, "seconds_to_all_clear": None, "minutes_to_arrival": None, "as_of": now}


def combine_beacons(beacons: list[dict]) -> dict:
    """The beacon to show from the real one and (during a replay) the replay's, each tagged `replay`.
    Real first: any real state other than clear (stop, unknown, approaching, flood) wins over every
    replay state, so a demo can never hide or outrank a real alert. The replay's state shows only when
    the real one is clear (or there is no real layer, e.g. live ingestion turned off); when both are
    clear the real one is shown, so `replay` is true only when the shown state came from the replay."""
    real = next((b for b in beacons if not b.get("replay")), None)
    replayed = next((b for b in beacons if b.get("replay")), None)
    if real is None:
        return replayed
    if real["state"] != "clear" or replayed is None or replayed["state"] == "clear":
        return real
    return replayed


# ---------- replay lead times ----------

def lead_times(stop_starts: list[tuple[str, datetime]], advisories: list[tuple[str, datetime]],
               window: timedelta = cellmod.HORIZON) -> list[dict]:
    """For each stop-work start (site, started_at): the earliest advisory for that site issued in the
    `window` before it. lead_min is None when there was no advisory (no warning)."""
    out = []
    for site_id, start in stop_starts:
        issued = [t for s, t in advisories if s == site_id and start - window <= t < start]
        first = min(issued) if issued else None
        out.append({"site_id": site_id, "stop_work_at": start, "advisory_at": first,
                    "lead_min": round((start - first).total_seconds() / 60, 1) if first else None})
    return out


def summarize(rows: list[dict]) -> dict:
    leads = sorted(r["lead_min"] for r in rows if r["lead_min"] is not None)
    n = len(rows)
    median = None
    if leads:
        mid = len(leads) // 2
        median = leads[mid] if len(leads) % 2 else round((leads[mid - 1] + leads[mid]) / 2, 1)
    return {"stop_works": n, "warned": len(leads), "warned_share": round(len(leads) / n, 3) if n else None,
            "median_lead_min": median}


def replay_approach_starts(conn: Connection) -> list[dict]:
    """GET /replay/events' approach_start events: every advisory the app stored during the replay
    (replay = true; replay start clears the previous run's). distance_mi is the leading-edge distance at
    the advisory's last update: the distance when it was issued isn't stored. [] before migration 008."""
    try:
        with conn.transaction():   # savepoint, so a missing table can't abort the caller's transaction
            rows = conn.execute(
                """SELECT id, started_at, site_id, distance_mi FROM lightning_advisories
                   WHERE replay ORDER BY started_at, id""").fetchall()
    except psycopg.errors.UndefinedTable:
        return []
    return [{"id": r["id"], "at": r["started_at"], "kind": "approach_start", "site_id": r["site_id"],
             "distance_mi": round(r["distance_mi"], 1)} for r in rows]


def replay_report(conn: Connection) -> dict:
    """Lead times from the last app replay's stored rows (replay alerts and advisories)."""
    stops = conn.execute("SELECT site_id, started_at FROM alerts WHERE replay AND type = %s ORDER BY started_at",
                         (engine.ALERT_TYPE,)).fetchall()
    advs = conn.execute("SELECT site_id, started_at FROM lightning_advisories WHERE replay").fetchall()
    rows = lead_times([(r["site_id"], r["started_at"]) for r in stops], [(r["site_id"], r["started_at"]) for r in advs])
    return {**summarize(rows), "per_stop_work": rows}
