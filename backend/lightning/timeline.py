"""The whole replay storm, worked out ahead of time: events and 5-minute series for the replay timeline.

A replay window's files never change, and the stop-work engine and the forecast are deterministic, so
the events a replay will produce can be computed before it plays: same files, same cycles (one per GLM
file at the file's start + 20 s, then one every 20 s through the 31-minute quiet tail), same rules
(alerts/engine.py newest_qualifying_strikes + decide, alerts/approach.py plan). That is what lets
GET /replay/events list the whole storm's stop-work starts and all clears as soon as a replay starts (the
frontend shows only the events at or before ReplayStatus.simulated_now). Approach starts are not served
from here: the route reads the advisories the app stored (see PRECOMPUTED_KINDS).

It is computed in memory (nothing is written to the database), takes ~30 s of CPU per window, and is
saved as data/replay/<window>/timeline.json, tagged with a fingerprint of the files and of the rule
code, so a rule change rebuilds it. The API builds missing timelines in the background at startup.

Known difference from a live replay run: the app runs the forecast on a background thread and skips a
cycle while the previous one is still running (lightning/alert_hook.py), so at high speeds an approach
advisory can start a cycle or two later in the app, or (rarely) not at all. That's why only stop-work
starts and all clears (from strike times, an exact match) are served from here. docs/replay-timeline.md
has the staging check.
"""

import hashlib
import json
import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from alerts import approach, engine
from app.config import BACKEND_DIR
from lightning import cells as cellmod
from lightning import glm

log = logging.getLogger(__name__)

REPLAY_DIR = BACKEND_DIR / "data" / "replay"
QUIET_TAIL = timedelta(minutes=31)      # lightning/replay.py runs this long after the last file
CYCLE = timedelta(seconds=glm.FILE_SECONDS)
BIN = timedelta(minutes=5)
VERSION = 1
_RULE_CODE = [BACKEND_DIR / "alerts" / "engine.py", BACKEND_DIR / "alerts" / "approach.py",
              BACKEND_DIR / "lightning" / "cells.py", Path(__file__)]

_cache: dict[str, dict] = {}
_building: set[str] = set()
_lock = threading.Lock()


@dataclass
class _Stop:
    id: int
    site_id: str
    started_at: datetime       # earliest strike (Alert.started_at; moved earlier by late files)
    issued_at: datetime        # the cycle that opened it
    distance_mi: float         # newest strike's distance when it opened
    all_clear_at: datetime     # 30 min after its last strike; final once it's over


def files_for(window: str) -> list[Path]:
    return sorted((REPLAY_DIR / window).glob("*.nc"), key=lambda p: glm.file_start(p.name))


def window_times(window: str) -> dict:
    """window_start (first file's start), window_end (last file's end) and quiet_until."""
    files = files_for(window)
    start = glm.file_start(files[0].name)
    end = glm.file_start(files[-1].name) + CYCLE
    return {"window_start": start, "window_end": end, "quiet_until": end + QUIET_TAIL}


def _fingerprint(files: list[Path]) -> str:
    h = hashlib.sha256(f"v{VERSION}".encode())
    for f in files:
        h.update(f"{f.name}:{f.stat().st_size};".encode())
    for f in _RULE_CODE:
        h.update(f.read_bytes())
    return h.hexdigest()[:16]


def _sites() -> list[engine.Site]:
    sites = json.loads((BACKEND_DIR / "data" / "sites.json").read_text())["sites"]
    return [engine.Site(s["id"], s["lat"], s["lon"]) for s in sites]


def simulate(window: str) -> dict:
    """Play the window in memory. Returns the timeline dict (JSON-ready: times are ISO strings)."""
    files = files_for(window)
    times = window_times(window)
    sites = _sites()
    buffer: list[glm.Flash] = []
    stops: dict[str, _Stop] = {}
    all_stops: list[_Stop] = []
    advisories: dict[str, approach.Advisory] = {}
    approach_starts: list[tuple[str, datetime, float]] = []
    flashes_per_minute: dict[str, int] = {}

    cycles = [(glm.file_start(p.name) + CYCLE, p) for p in files]
    t = times["window_end"]
    while t < times["quiet_until"]:
        t = min(t + CYCLE, times["quiet_until"])
        cycles.append((t, None))

    for now, path in cycles:
        new = glm.parse(path.read_bytes(), path.name)[1] if path else []
        for f in new:
            minute = f.ts.replace(second=0, microsecond=0).isoformat()
            flashes_per_minute[minute] = flashes_per_minute.get(minute, 0) + 1
        buffer = [f for f in buffer if f.ts > now - cellmod.HISTORY] + new

        # Stop-work: alerts/engine.py's decisions.
        for site_id, st in engine.newest_qualifying_strikes(new, sites).items():
            stop = stops.get(site_id)
            alert = (engine.ActiveAlert(str(stop.id), site_id, stop.started_at, stop.all_clear_at - engine.ALL_CLEAR_AFTER,
                                        stop.all_clear_at) if stop else None)
            action = engine.decide(alert, st, now)
            if action in ("create", "restart"):
                stop = _Stop(len(all_stops), site_id, st.earliest_at, now, st.newest_distance_mi,
                             st.newest_at + engine.ALL_CLEAR_AFTER)
                stops[site_id] = stop
                all_stops.append(stop)
            elif action == "extend":
                stop.started_at = min(stop.started_at, st.earliest_at)
                stop.all_clear_at = st.newest_at + engine.ALL_CLEAR_AFTER
            elif action == "keep" and st.earliest_at < stop.started_at:
                stop.started_at = st.earliest_at
        stops = {k: s for k, s in stops.items() if s.all_clear_at > now}

        # Advisories: alerts/approach.py's plan().
        found = cellmod.find_cells([f.ts for f in buffer], [f.lat for f in buffer], [f.lon for f in buffer], now)
        in_stop = set(stops)
        for act in approach.plan(approach.arrivals_for(sites, found, in_stop, now), in_stop, advisories, now):
            if act.kind == "create":
                advisories[act.site_id] = approach.Advisory(f"adv{len(approach_starts)}", act.site_id, now, now,
                                                            act.arrival.arrival_at, act.arrival.arrival_at)
                approach_starts.append((act.site_id, now, act.arrival.distance_mi))
            elif act.kind == "update":
                a = advisories[act.site_id]
                advisories[act.site_id] = approach.Advisory(a.id, a.site_id, a.started_at, now,
                                                            act.arrival.arrival_at, a.first_arrival_at)
            else:
                advisories.pop(act.site_id, None)

    events = ([("stop_work_start", s.started_at, s.site_id, round(s.distance_mi, 2)) for s in all_stops]
              + [("all_clear", s.all_clear_at, s.site_id, None) for s in all_stops]
              + [("approach_start", at, site, round(d, 1)) for site, at, d in approach_starts])
    events.sort(key=lambda e: (e[1], e[0], e[2]))
    return {
        "window": window,
        "fingerprint": _fingerprint(files),
        **{k: v.isoformat() for k, v in times.items()},
        "events": [{"id": f"{window}:{i}", "at": at.isoformat(), "kind": kind, "site_id": site, "distance_mi": dist}
                   for i, (kind, at, site, dist) in enumerate(events)],
        "flashes_per_minute": flashes_per_minute,
        # When each stop-work was showing in the app: from the cycle that opened it until its all clear.
        "stop_work_spans": [[s.site_id, s.issued_at.isoformat(), s.all_clear_at.isoformat()] for s in all_stops],
    }


def _path(window: str) -> Path:
    return REPLAY_DIR / window / "timeline.json"


def get(window: str) -> dict | None:
    """The window's timeline if it's built and current, else None (call build() or ensure())."""
    with _lock:
        cached = _cache.get(window)
    files = files_for(window)
    if not files:
        return None
    fingerprint = _fingerprint(files)
    if cached and cached["fingerprint"] == fingerprint:
        return cached
    try:
        stored = json.loads(_path(window).read_text())
    except (OSError, ValueError):
        return None
    if stored.get("fingerprint") != fingerprint:
        return None
    with _lock:
        _cache[window] = stored
    return stored


def build(window: str) -> dict:
    """Simulate and save (blocking, ~30 s)."""
    timeline = simulate(window)
    tmp = _path(window).with_suffix(".tmp")
    tmp.write_text(json.dumps(timeline))
    tmp.replace(_path(window))
    with _lock:
        _cache[window] = timeline
    log.info("Replay timeline for %s: %d events", window, len(timeline["events"]))
    return timeline


def ensure(window: str) -> None:
    """Build the timeline on a background thread if it's missing or stale (returns at once)."""
    with _lock:
        if window in _building:
            return
        _building.add(window)

    def run() -> None:
        try:
            if get(window) is None:
                build(window)
        except Exception:  # noqa: BLE001 - a timeline problem must never affect the replay
            log.exception("Couldn't build the replay timeline for %s", window)
        finally:
            with _lock:
                _building.discard(window)
    threading.Thread(target=run, name=f"replay-timeline-{window}", daemon=True).start()


def building(window: str) -> bool:
    with _lock:
        return window in _building


# ---------- what the API serves ----------

# Served from the precomputed timeline: they come from strike times and matched a stored replay exactly.
# Approach starts are not: GET /replay/events takes them from the advisories the app stored, because the
# app's forecast can skip a cycle under load and the precomputed list would then show an advisory that
# never appeared.
PRECOMPUTED_KINDS = ("stop_work_start", "all_clear")


def events(timeline: dict) -> list[dict]:
    """The precomputed stop-work starts and all clears (approach starts stay in the file for checks)."""
    return [e for e in timeline["events"] if e["kind"] in PRECOMPUTED_KINDS]


def series(timeline: dict, until: datetime) -> list[dict]:
    """5-minute bins from window_start through the bin holding `until` (the replay's simulated now, or
    where it ended). Counts never include anything after `until`, so an in-progress bin is partial."""
    start = datetime.fromisoformat(timeline["window_start"])
    stop = min(until, datetime.fromisoformat(timeline["quiet_until"]))
    # A flash can start a moment before the first file's scan (21:59:59 in a 22:00 file): count it in the first bin.
    per_minute: dict[datetime, int] = {}
    for k, n in timeline["flashes_per_minute"].items():
        m = max(datetime.fromisoformat(k), start)
        per_minute[m] = per_minute.get(m, 0) + n
    spans = [(site, datetime.fromisoformat(a), datetime.fromisoformat(b)) for site, a, b in timeline["stop_work_spans"]]
    bins = []
    b = start
    while b <= stop and b < datetime.fromisoformat(timeline["quiet_until"]):
        end = b + BIN
        cut = min(end, stop)
        flashes = sum(n for m, n in per_minute.items() if b <= m and m + timedelta(minutes=1) <= cut)
        at = min(end, stop)   # "at the end of the bin", or now for the bin still in progress
        in_stop = {site for site, s, e in spans if s <= at < e}
        bins.append({"start": b, "flashes": flashes, "sites_in_stop_work": len(in_stop)})
        b = end
    return bins
