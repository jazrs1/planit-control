"""Everything /sites and /sites/{id} need, for all sites, in a handful of queries.

Both routes score from the same snapshot, so a site's hazard_index is identical in the list
and in its detail view.
"""

import math
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone

from psycopg_pool import ConnectionPool

from alerts import approach, engine
from app import clock
from hazards import model_scores
from hazards.scoring import Inputs

WILDLIFE_RADIUS_MI = 5 / 1.609344   # iNaturalist query radius: 5 km
CREW_REPORT_RADIUS_MI = 2.0
WILDLIFE_DAYS = 30
CREW_RECENT = timedelta(hours=48)   # crew reports that change a site's hazard cards


def miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 3958.8 * math.asin(math.sqrt(h))


@dataclass
class Snapshot:
    sites: list[dict]
    inputs: dict[str, Inputs]
    species_counts: dict[str, dict[str, int]]                       # site -> {species: n}
    sightings: dict[str, list[dict]] = field(default_factory=dict)  # site -> WildlifeSighting dicts
    # site -> open lightning advisory, with "view_now": the clock its minutes count on (real or replay)
    approaching: dict[str, dict] = field(default_factory=dict)
    # site -> its inputs with real alerts only, for sites whose stop-work or flood alert is a replay one:
    # scoring these gives hazard_index_live, the index the site would have with no replay running.
    live_inputs: dict[str, Inputs] = field(default_factory=dict)


def _merge(real: list[dict], replayed: list[dict]) -> dict[str, dict]:
    """site -> alert or advisory: the real one when a site has both (each row keeps its `replay` flag)."""
    out = {a["site_id"]: a for a in replayed}
    out.update({a["site_id"]: a for a in real})
    return out


def load(pool: ConnectionPool, replay: bool | None = None) -> Snapshot:
    """`replay`: also use replay alerts and advisories (default: while a replay runs). Real alerts are
    always loaded, on real time, so a real stop-work or flood alert still sets a site's cards and index
    during a replay; a site with both uses the real one. replay=False: real only (stored history)."""
    real_now = datetime.now(timezone.utc)   # live sources
    replay = clock.is_simulated() if replay is None else replay
    sim_now = clock.now() if replay else None   # the replay clock
    since = real_now - timedelta(days=WILDLIFE_DAYS)
    with pool.connection() as conn:
        sites = conn.execute(
            """SELECT id, name, lat, lon, county, timezone, fema_flood_zone, fema_sfha, near_river, river_name
               FROM sites ORDER BY capacity_mw DESC, id""").fetchall()
        readings = conn.execute(
            """SELECT DISTINCT ON (site_id, hazard, metric) site_id, hazard, metric, value, ts
               FROM conditions WHERE ts > %s ORDER BY site_id, hazard, metric, ts DESC""",
            (real_now - timedelta(days=7),)).fetchall()
        nws = conn.execute(
            """SELECT sa.site_id, a.event, a.headline, a.severity, a.onset, a.ends_at
               FROM site_nws_alerts sa JOIN nws_alerts a ON a.id = sa.alert_id
               WHERE a.ends_at IS NULL OR a.ends_at > %s""", (real_now,)).fetchall()
        real_alerts = engine.active_alerts(conn, real_now, replay=False)
        replay_alerts = engine.active_alerts(conn, sim_now, replay=True) if replay else []
        real_lightning = _merge([a for a in real_alerts if a["type"] == engine.ALERT_TYPE], [])
        real_flood = _merge([a for a in real_alerts if a["type"] == "flood"], [])
        lightning = _merge([a for a in real_alerts if a["type"] == engine.ALERT_TYPE],
                           [a for a in replay_alerts if a["type"] == engine.ALERT_TYPE])
        flood_alerts = _merge([a for a in real_alerts if a["type"] == "flood"],
                              [a for a in replay_alerts if a["type"] == "flood"])
        approaching = _merge(
            [{**a, "replay": False, "view_now": real_now} for a in approach.active_advisories(conn, replay=False)],
            [{**a, "replay": True, "view_now": sim_now} for a in approach.active_advisories(conn, replay=True)]
            if replay else [])
        # A real stop-work drops the site's advisory (real or replay): the stop-work is the bigger news. A
        # replay stop-work never drops a real advisory; it drops only a replay one (its own storm's stop-work
        # superseded it).
        approaching = {k: v for k, v in approaching.items()
                       if k not in real_lightning and not (v["replay"] and k in lightning)}
        firms = conn.execute("SELECT detail FROM data_sources WHERE name = 'firms'").fetchone()
        reports = conn.execute(
            """SELECT id, lat, lon, created_at, category, species, reporter_role FROM reports
               WHERE created_at > %s""", (since,)).fetchall()
        observations = conn.execute(
            """SELECT species, venomous, observed_at, lat, lon, quality_grade FROM wildlife_observations
               WHERE observed_at > %s ORDER BY observed_at DESC""", (since,)).fetchall()
        model = model_scores.latest(conn, real_now)

    by_site: dict[str, dict] = {s["id"]: {} for s in sites}
    for r in readings:
        if r["site_id"] in by_site:
            by_site[r["site_id"]][(r["hazard"], r["metric"])] = (r["value"], r["ts"])

    snap = Snapshot(sites=sites, inputs={}, species_counts={}, approaching=approaching)
    for s in sites:
        near_obs = [(miles(s["lat"], s["lon"], o["lat"], o["lon"]), o) for o in observations]
        near_obs = [(d, o) for d, o in near_obs if d <= WILDLIFE_RADIUS_MI]
        near_all = [(miles(s["lat"], s["lon"], r["lat"], r["lon"]), r) for r in reports]
        near_all = [(d, r) for d, r in near_all if d <= CREW_REPORT_RADIUS_MI]
        near_reports = [(d, r) for d, r in near_all if r["category"] == "wildlife"]   # wildlife: 30 days
        crew_recent = sorted(
            [{"id": r["id"], "category": r["category"], "species": r["species"], "created_at": r["created_at"],
              "distance_mi": round(d, 1)} for d, r in near_all if r["created_at"] > real_now - CREW_RECENT],
            key=lambda r: r["created_at"], reverse=True)
        counts: dict[str, int] = {}
        for _, o in near_obs:
            counts[o["species"]] = counts.get(o["species"], 0) + 1
        snap.species_counts[s["id"]] = counts
        snap.sightings[s["id"]] = sorted(
            [{"species": o["species"], "distance_mi": round(d, 1), "seen_at": o["observed_at"],
              "source": "iNaturalist (research grade)" if o["quality_grade"] == "research" else "iNaturalist (needs ID)"}
             for d, o in near_obs]
            + [{"species": f"{r['species']} (crew report)" if r["species"] else "Wildlife (crew report)",
                "distance_mi": round(d, 1), "seen_at": r["created_at"], "source": "Crew report"} for d, r in near_reports],
            key=lambda x: x["seen_at"], reverse=True)[:10]
        snap.inputs[s["id"]] = Inputs(
            site=s, readings=by_site[s["id"]],
            nws=[a for a in nws if a["site_id"] == s["id"]],
            lightning_alert=lightning.get(s["id"]), flood_alert=flood_alerts.get(s["id"]),
            crew_wildlife_reports=len(near_reports), firms_detail=firms["detail"] if firms else None,
            crew_reports=crew_recent, now=real_now, model=model.get(s["id"], {}),
        )
        if (lightning.get(s["id"]) or {}).get("replay") or (flood_alerts.get(s["id"]) or {}).get("replay"):
            snap.live_inputs[s["id"]] = replace(snap.inputs[s["id"]], lightning_alert=real_lightning.get(s["id"]),
                                                flood_alert=real_flood.get(s["id"]))
    return snap
