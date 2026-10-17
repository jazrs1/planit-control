# Replay timeline data

Code: `backend/lightning/timeline.py` · Routes: `backend/app/routers/replay.py` · Tests: `backend/tests/test_replay_timeline.py`

The redesigned dashboard's replay timeline needs three things from the API:
- **When the window starts and ends** (`ReplayStatus.window_start`, `window_end`, `quiet_until`).
- **The storm's events** (`GET /replay/events`).
- **5-minute charts** (`GET /replay/series`).

## How it works

A replay window's files never change, and the stop-work engine and the forecast are deterministic. So `timeline.py` plays the whole window once, in memory, through the same functions the app uses:
- **The same cycles:** one per GLM file, then every 20 s through the 31-minute quiet tail.
- **The same rules:** `engine.newest_qualifying_strikes` + `engine.decide` for stop-work, and `approach.plan` for advisories.

It records every stop-work start, all clear and approach start, plus flashes per minute and when each stop-work was showing.

**What's served from it, and what isn't:**
- **Stop-work starts and all clears** come from it. They come from strike times and match a stored replay exactly.
- **Approach starts don't.** `/replay/events` takes them from the advisories the app actually stored during the run (`lightning_advisories`, `replay = true`; `approach.replay_approach_starts`). The app's forecast can skip a cycle under load, so a precomputed advisory might never have appeared. The precomputed ones stay in `timeline.json` only for checks like the one below.

**Cost and storage.** That takes about 30 s of CPU. The result is saved as `data/replay/<window>/timeline.json` and rebuilt only when the window's files or the rule code change (it keeps a fingerprint of both). The API builds missing timelines on a background thread at startup, and again when a replay starts. Until one is ready, both routes answer **503 with `Retry-After: 5`**.

**Why precompute.** It means `/replay/events` can list the **whole storm's stop-work starts and all clears the moment a replay starts**. The frontend shows only events at or before `ReplayStatus.simulated_now`. Approach starts appear as the app issues them. `/replay/series` never shows anything past simulated now: the bin still in progress counts only up to now.

## Endpoints

| Path | Returns |
|---|---|
| `GET /replay/status` | `ReplayStatus`, now with `window_start`, `window_end`, `quiet_until` (null before any replay) |
| `GET /replay/events` | `ReplayEvent[]` (`id`, `at`, `kind`, `site_id`, `distance_mi`), oldest first, for the current or most recent run. `[]` before any replay. Replay only: never live events. |
| `GET /replay/series` | `ReplaySeries` `{bin_minutes: 5, bins: [{start, flashes, sites_in_stop_work}]}` from `window_start` through simulated now (or where the last run ended) |

**What each `at` means:**
- `stop_work_start`: the first strike, the same as `Alert.started_at`.
- `all_clear`: the all-clear time.
- `approach_start`: the cycle the advisory was issued. Its `distance_mi` is the leading edge's distance at the advisory's last update, because the distance when it was issued isn't stored.

`flood_start` is in the type for later; flood alerts are live-only, so a replay has none.

**Series values:**
- `flashes` counts every Florida + 30 mi flash by its strike time.
- `sites_in_stop_work` is measured at the end of each bin, from the cycle that opened each stop-work until its all clear.

All three are cached like `/alerts` (`app/cache.py`), and every alert change clears the cache.

## Checked against a real replay (staging, Aug 4 2025 window, 60× requested)

I replayed the window on the staging database (lightning ingest, pollers and push off) and compared what the app stored with the precomputed timeline:

| | Precomputed | The app stored | Match |
|---|---|---|---|
| Stop-work starts | 22 | 22 | all 22 exact (site and strike time) |
| All clears | 22 | 22 | all 22 exact |
| Approach starts | 19 | 18 | 18 within 24 s (15 to the cycle); 1 precomputed one never happened in the app |
| Flashes in the window | 16,533 | 16,533 | exact |

**Why approach starts can differ.** The app runs the forecast on a background thread and skips a cycle while the previous one is still running (`lightning/alert_hook.py`). So under load an advisory can start a cycle later, or (rarely) not at all. This run was slowed by building the timeline at the same time.

**What that means for the UI.** This is why approach starts are served from the stored advisories: the timeline marks only advisories that actually appeared, at the time they appeared. On this run, that's 18 approach starts with no Shady Hills. Stop-work and all-clear markers are precomputed and exact.
