"""How much warning would "lightning approaching" advisories have given in a replay window?

    cd backend && python -m scripts.evaluate_lightning_forecast                # newest window in data/replay/
    python -m scripts.evaluate_lightning_forecast --window 2025-08-04_2200-2300 --json
    python -m scripts.evaluate_lightning_forecast --db     # from the last app replay's stored rows

Runs the window exactly the way POST /replay/start does (one cycle per GLM file, `now` = the file's
start + 20 s, no history before the window), but in memory: stop-work alerts use the engine's own
rules (alerts/engine.py: newest_qualifying_strikes + decide) and advisories use alerts/approach.py's
plan(). Nothing is written to the database.

For each stop-work start: was there an advisory for that site in the hour before, and how many
minutes ahead? Also: how far off the first arrival estimate was, and how many advisories were
never followed by a stop-work (false alarms).
"""

import argparse
import json
import statistics
from dataclasses import dataclass
from datetime import datetime, timedelta

from alerts import approach, engine
from app.config import BACKEND_DIR
from lightning import cells as cellmod
from lightning import glm
from lightning.replay import REPLAY_DIR, available_windows

WARM_UP = timedelta(minutes=15)   # the tracker needs 3 five-minute windows of history


@dataclass
class OpenAdvisory:
    id: str
    site_id: str
    started_at: datetime
    updated_at: datetime
    arrival_at: datetime
    first_arrival_at: datetime


def load_sites() -> list[engine.Site]:
    sites = json.loads((BACKEND_DIR / "data" / "sites.json").read_text())["sites"]
    return [engine.Site(s["id"], s["lat"], s["lon"]) for s in sites]


def simulate(window: str) -> dict:
    files = sorted((REPLAY_DIR / window).glob("*.nc"), key=lambda p: glm.file_start(p.name))
    sites = load_sites()
    window_start = glm.file_start(files[0].name)
    buffer: list[glm.Flash] = []
    stops: dict[str, engine.ActiveAlert] = {}
    stop_starts: list[tuple[str, datetime]] = []
    advisories: dict[str, OpenAdvisory] = {}
    issued: list[OpenAdvisory] = []
    n = 0

    for path in files:
        now = glm.file_start(path.name) + timedelta(seconds=glm.FILE_SECONDS)
        _, new = glm.parse(path.read_bytes(), path.name)
        buffer = [f for f in buffer if f.ts > now - cellmod.HISTORY] + new

        # Stop-work, same decisions as alerts/engine.py, in memory.
        for site_id, st in engine.newest_qualifying_strikes(new, sites).items():
            alert = stops.get(site_id)
            action = engine.decide(alert, st, now)
            if action in ("create", "restart"):
                stops[site_id] = engine.ActiveAlert(f"a{len(stop_starts)}", site_id, st.earliest_at, st.newest_at,
                                                    st.newest_at + engine.ALL_CLEAR_AFTER)
                stop_starts.append((site_id, st.earliest_at))
            elif action == "extend":
                stops[site_id] = engine.ActiveAlert(alert.id, site_id, min(alert.started_at, st.earliest_at),
                                                    st.newest_at, st.newest_at + engine.ALL_CLEAR_AFTER)
        stops = {k: a for k, a in stops.items() if a.all_clear_at > now}

        # Advisories, same plan() as the live engine.
        found = cellmod.find_cells([f.ts for f in buffer], [f.lat for f in buffer], [f.lon for f in buffer], now)
        stop_now = set(stops)
        active = {k: approach.Advisory(a.id, a.site_id, a.started_at, a.updated_at, a.arrival_at, a.first_arrival_at)
                  for k, a in advisories.items()}
        for act in approach.plan(approach.arrivals_for(sites, found, stop_now, now), stop_now, active, now):
            if act.kind == "create":
                n += 1
                adv = OpenAdvisory(f"adv{n}", act.site_id, now, now, act.arrival.arrival_at, act.arrival.arrival_at)
                advisories[act.site_id] = adv
                issued.append(adv)
            elif act.kind == "update":
                adv = advisories[act.site_id]
                adv.updated_at, adv.arrival_at = now, act.arrival.arrival_at
            else:
                advisories.pop(act.site_id, None)

    rows = approach.lead_times(stop_starts, [(a.site_id, a.started_at) for a in issued])
    by_adv = {(a.site_id, a.started_at): a for a in issued}
    for r in rows:
        r["warm"] = r["stop_work_at"] - window_start >= WARM_UP
        adv = by_adv.get((r["site_id"], r["advisory_at"])) if r["advisory_at"] else None
        r["arrival_error_min"] = (round((adv.first_arrival_at - r["stop_work_at"]).total_seconds() / 60, 1)
                                  if adv else None)
    followed = [a for a in issued
                if any(s == a.site_id and a.started_at <= t < a.started_at + cellmod.HORIZON for s, t in stop_starts)]
    errors = [abs(r["arrival_error_min"]) for r in rows if r["arrival_error_min"] is not None]
    return {
        "window": window,
        "window_start": window_start.isoformat(),
        "all": approach.summarize(rows),
        "after_warm_up": approach.summarize([r for r in rows if r["warm"]]),
        "warm_up_min": WARM_UP.total_seconds() / 60,
        "median_abs_arrival_error_min": round(statistics.median(errors), 1) if errors else None,
        "advisories_issued": len(issued),
        "advisories_followed_by_stop_work": len(followed),
        "per_stop_work": rows,
    }


def print_report(r: dict) -> None:
    def line(name, s):
        lead = f"median lead {s['median_lead_min']} min" if s["median_lead_min"] is not None else "no leads"
        print(f"  {name:<34} {s['warned']}/{s['stop_works']} stop-works warned ({(s['warned_share'] or 0):.0%}), {lead}")
    print(f"Replay {r['window']} (starts {r['window_start']})")
    line("all stop-works", r["all"])
    line(f"starting {r['warm_up_min']:.0f}+ min into the window", r["after_warm_up"])
    print(f"  first arrival estimate, median |error|: {r['median_abs_arrival_error_min']} min")
    print(f"  advisories issued: {r['advisories_issued']}, followed by a stop-work within 60 min: "
          f"{r['advisories_followed_by_stop_work']}")
    for row in r["per_stop_work"]:
        lead = f"{row['lead_min']:>5} min ahead" if row["lead_min"] is not None else "   no warning"
        err = f" (arrival estimate off by {row['arrival_error_min']:+} min)" if row["arrival_error_min"] is not None else ""
        print(f"    {row['stop_work_at']:%H:%M:%S}  {row['site_id']:<40} {lead}{err}{'' if row['warm'] else '  [cold start]'}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--window", help="folder under data/replay/ (default: newest)")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--db", action="store_true", help="report on the last app replay's stored rows instead")
    args = parser.parse_args()
    if args.db:
        from app.db import close_pool, get_pool, open_pool
        open_pool()
        try:
            with get_pool().connection() as conn:
                print(json.dumps(approach.replay_report(conn), indent=1, default=str))
        finally:
            close_pool()
        return
    windows = available_windows()
    if not windows:
        raise SystemExit("no replay windows in data/replay/ (run python -m scripts.find_replay_window)")
    report = simulate(args.window or windows[-1])
    if args.json:
        print(json.dumps(report, indent=1, default=str))
    else:
        print_report(report)


if __name__ == "__main__":
    main()
