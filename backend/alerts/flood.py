"""Flood-risk alerts (alerts.type = 'flood'), re-evaluated after every weather and NWS poll.

A site gets a flood-risk alert when either:
  - heavy rain: 2+ inches fell in the past 12 hours AND the site is in a FEMA Special Flood
    Hazard Area or within 1 mile of a named river; or
  - NWS has an active Flood Warning or Flash Flood Warning covering the site.
all_clear_at is the NWS warning's end time when NWS drives it, else null (the alert clears once
neither condition holds). Changes are logged in alert_events like lightning alerts.
"""

import logging
from datetime import datetime

from psycopg_pool import ConnectionPool

log = logging.getLogger(__name__)

HEAVY_RAIN_12H_IN = 2.0
NWS_FLOOD_WARNINGS = ("Flood Warning", "Flash Flood Warning")


def flood_risk(rain_12h_in: float | None, in_sfha: bool | None, near_river: bool | None,
               nws_warning_ends: list[datetime]) -> tuple[bool, datetime | None]:
    """(should alert, all_clear_at). Pure function: the rule in one place."""
    heavy_rain = (rain_12h_in or 0) >= HEAVY_RAIN_12H_IN and bool(in_sfha or near_river)
    if nws_warning_ends:
        return True, max(nws_warning_ends)
    return heavy_rain, None


def evaluate(pool: ConnectionPool, now: datetime) -> dict[str, list[str]]:
    """Create, update, or clear flood-risk alerts for every site. Returns site ids by change."""
    with pool.connection() as conn:
        rows = conn.execute(
            """SELECT s.id, s.fema_sfha, s.near_river,
                      (SELECT value FROM conditions c WHERE c.site_id = s.id AND c.hazard = 'flood'
                         AND c.metric = 'rain_past_12h_in' AND c.ts > %(now)s - interval '2 hours'
                       ORDER BY c.ts DESC LIMIT 1) AS rain_12h,
                      (SELECT array_agg(a.ends_at) FROM site_nws_alerts sa JOIN nws_alerts a ON a.id = sa.alert_id
                        WHERE sa.site_id = s.id AND a.event = ANY(%(events)s)
                          AND (a.ends_at IS NULL OR a.ends_at > %(now)s)) AS warning_ends
               FROM sites s""",
            {"now": now, "events": list(NWS_FLOOD_WARNINGS)},
        ).fetchall()

        changes = {"created": [], "updated": [], "cleared": []}
        for r in rows:
            ends = [e for e in (r["warning_ends"] or []) if e is not None]
            should, all_clear_at = flood_risk(r["rain_12h"], r["fema_sfha"], r["near_river"], ends)
            active = conn.execute(
                "SELECT id, all_clear_at FROM alerts WHERE site_id = %s AND type = 'flood' AND NOT replay "
                "AND status = 'active' FOR UPDATE", (r["id"],)).fetchone()
            if should and active is None:
                conn.execute(
                    """WITH a AS (INSERT INTO alerts (site_id, type, status, started_at, all_clear_at, replay)
                                  VALUES (%(site)s, 'flood', 'active', %(now)s, %(clear)s, false) RETURNING id)
                       INSERT INTO alert_events (alert_id, event, at, recorded_at, all_clear_at)
                       SELECT id, 'created', %(now)s, %(now)s, %(clear)s FROM a""",
                    {"site": r["id"], "now": now, "clear": all_clear_at})
                changes["created"].append(r["id"])
            elif should and active["all_clear_at"] != all_clear_at:
                conn.execute(
                    """WITH a AS (UPDATE alerts SET all_clear_at = %(clear)s WHERE id = %(id)s RETURNING id)
                       INSERT INTO alert_events (alert_id, event, at, recorded_at, all_clear_at)
                       SELECT id, 'extended', %(now)s, %(now)s, %(clear)s FROM a""",
                    {"id": active["id"], "now": now, "clear": all_clear_at})
                changes["updated"].append(r["id"])
            elif not should and active is not None:
                conn.execute(
                    """WITH a AS (UPDATE alerts SET status = 'cleared' WHERE id = %(id)s RETURNING id, all_clear_at)
                       INSERT INTO alert_events (alert_id, event, at, recorded_at, all_clear_at)
                       SELECT id, 'cleared', %(now)s, %(now)s, all_clear_at FROM a""",
                    {"id": active["id"], "now": now})
                changes["cleared"].append(r["id"])
    if any(changes.values()):
        from app.cache import api_cache

        api_cache.invalidate()  # committed above: show the change on the next request
        log.info("Flood alerts: %s", changes)
    if changes["created"]:
        from push import notify

        notify.alerts_changed(now, replay=False)   # committed; queues the push and returns at once
    return changes
