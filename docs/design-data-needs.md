# Design data needs

The Signal redesign (`john/design-system`) adds a replay timeline, timeline charts and a map layers panel to the dashboard. The frontend builds only what today's API can back. This file lists the data the rest needs. The frontend change does not touch the backend, `shared/types.ts` or `shared/mocks/`. Each item below is a contract change: update `shared/types.ts`, `backend/app/schemas.py` and the matching mock in one PR.

Until an item ships, its part of the UI is left out. It never shows invented values.

**Status (Oct 17):** items 1, 2, 3, 6 and the fires and wildlife layers from 5 shipped in #38 and are wired up in the dashboard. Still open: 4 (pause) and flood zones (5). Item 7 shipped in #36.

## What the frontend already gets from the API

| Feature | Source |
|---|---|
| Replay progress bar | `ReplayStatus.files_done / files_total` |
| Simulated time, speed, flash total | `ReplayStatus.simulated_now`, `speed`, `flashes_ingested` |
| Speed choice before a start | `StartReplayRequest.speed` |
| Real vs replay counts | `Alert.replay` (counts and the nav badge use real alerts only; the replay timeline shows replay counts) |
| Lightning, storm cells, sites, crew reports layers | `/lightning/recent`, `/lightning/cells`, `/sites`, `/reports` (lat/lon) |
| Live index vs forecast index on the crew view | `SiteDetail.hazard_index_today` (now) vs `Briefing.key_numbers.hazard_index` (last night's forecast) |

## 1. Replay window times (needed for time ticks on the timeline)

The timeline can show progress from `files_done / files_total`, but it can't put clock times under the bar, mark where the storm data ends and the quiet period starts, or place events in time.

Add to `ReplayStatus` (all ISO 8601, UTC offset, `null` when no replay has run):

| Field | Meaning |
|---|---|
| `window_start` | Simulated time of the first GLM file |
| `window_end` | Simulated time of the last GLM file (end of storm data) |
| `quiet_until` | `window_end` + the quiet period (31 min at 30×), when the replay stops by itself |

## 2. Replay events (markers on the timeline and the "Key events" list)

New endpoint `GET /replay/events` → `ReplayEvent[]`, oldest first, for the current or most recent replay run only (`replay = true` rows):

```ts
export type ReplayEventKind = "stop_work_start" | "approach_start" | "all_clear" | "flood_start";

export interface ReplayEvent {
  id: string;
  /** Simulated time of the event. */
  at: string;
  kind: ReplayEventKind;
  site_id: string;
  /** Strike distance for stop_work_start, leading-edge distance for approach_start; null otherwise. */
  distance_mi: number | null;
}
```

Sources: `alert_events` (stop-work start, all clear, flood start) and `lightning_advisories` (approach start), both filtered to the replay run. It must not include live events. Cache it like `/alerts` and invalidate on the same commits.

Replay-only for now. The same list for live alerts (last 24 h) would let the dashboard show a live "Key events" list too, but it isn't required.

## 3. Timeline charts

New endpoint `GET /replay/series` → `ReplaySeries`, for the current or most recent replay run:

```ts
export interface ReplaySeriesBin {
  /** Start of the 5-minute bin, simulated time. */
  start: string;
  /** Flashes ingested in the bin (Florida + 30 mi). */
  flashes: number;
  /** Sites in a replay stop-work at the end of the bin. */
  sites_in_stop_work: number;
}

export interface ReplaySeries {
  bin_minutes: 5;
  /** Bins from window_start up to simulated now; the frontend draws later bins as empty. */
  bins: ReplaySeriesBin[];
}
```

`/lightning/recent?minutes=180` can't stand in for this: it caps the flash count (`MAX_FLASHES`) and would send thousands of points every 3 seconds to draw 18 bars.

## 4. Pause (only if you want a pause button)

The replay can only start and stop. A pause button needs `POST /replay/pause`, `POST /replay/resume` (same demo code as start/stop) and `ReplayStatus.paused: boolean`, with the replay clock frozen while paused. Without it the timeline shows Start / Stop and the speed, and no pause.

## 5. Map layers that have no data yet

The layers panel shows these three as "Needs data" (disabled) until they exist:

| Layer | Needed |
|---|---|
| Fires | `GET /fires/recent` → `FireDetection[]`: `{ lat, lon, detected_at, confidence: "low" \| "nominal" \| "high", passes_24h: number }`, Florida, last 24 h, already excluding thermal-plant hot spots (`fl_thermal_plants.json`). |
| Wildlife | `GET /wildlife/recent` → sightings with coordinates: `{ lat, lon, species, seen_at, source: "inaturalist" \| "crew" }`, last 30 days. `WildlifeSighting` today only has `distance_mi` from one site. |
| Flood zones | Either FEMA flood-zone polygons near sites (`GET /flood-zones?bbox=` → GeoJSON with `zone`) or, cheaper, `fema_flood_zone` and `in_special_flood_hazard_area` on `Site` so the map can mark sites in a special flood hazard area. Today they're only on `SiteDetail.conditions.flood`. |

## 6. A `replay` flag on approach advisories

During a replay, `Site.lightning_approach` merges real and replay advisories (`hazards/snapshot.py`), and `LightningApproach` doesn't say which one it is. The dashboard needs that to keep replay advisories off real counts and to put them on the replay timeline. For now it guesses from `issued_at`: a replay advisory is issued on the replay clock, hours away from real time. Add `replay: boolean` to `LightningApproach`, the same as `Alert.replay`.

## 8. Real flashes during a replay

During a replay `/lightning/recent` runs on the simulated clock, so it returns only the replay's flashes. The dashboard draws those blue and counts them apart ("4,248 replay"), but it can't show or count the real flashes at the same time ("real not shown during a replay"). Needed: `GET /lightning/recent?minutes=15&clock=real` (real-time flashes, even during a replay), or a `replay: boolean` on each `LightningFlash` with both sets returned during a replay.

## 7. The new `storm` hazard type

When the backend adds `"storm"` to `HazardType`, `HAZARD_LABEL` in `frontend/lib/risk.ts` must get a `storm` entry in the same PR. It's a `Record<HazardType, string>`, so the frontend type check fails without it. Proposed label: `"Storm"`.
