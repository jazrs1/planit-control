# Lightning arrival forecast ("lightning approaching")

Code: `backend/lightning/cells.py` (storm cells, motion, arrival), `backend/alerts/approach.py` (advisories, beacon) · Tests: `backend/tests/test_lightning_forecast.py` · Evaluation: `backend/scripts/evaluate_lightning_forecast.py`

## What it does, in one paragraph

Stop-work alerts (`docs/alert-engine.md`) react to lightning that is *already* within 10 miles. This forecast tries to give crews a heads-up *before* that. Every ingestion cycle (every 20 seconds, live or replay), it groups recent lightning into storm cells, works out which way and how fast each cell is moving, and checks whether a cell's front edge will reach a site's 10-mile ring in the next hour. If so, the site gets a **"lightning approaching" advisory** with an estimated arrival time, the direction the storm is coming from, and its speed. An advisory is **never a stop-work order**: it can't start, shorten, extend or clear one.

## How it works

**1. Storm cells.** Take every flash from the last 20 minutes and cluster them with DBSCAN:
- Flashes within 3 miles of each other chain into one cell, and a flash needs 5 neighbors to anchor a cell.
- A cell needs at least 20 flashes.
- Scattered flashes are ignored.

**2. Motion.** Split each cell's flashes into four 5-minute windows and take the center of each window's flashes. A cell's motion counts as reliable (it is "tracked") only if all of these hold:
- It flashed in at least 3 of the 4 windows, including the last 5 minutes. A storm that went quiet isn't projected.
- A straight line fits the window centers within 2.5 miles. Cells that split or merge make the center jump, and they fail this.
- The speed is 60 mph or less, since faster "motion" is almost always a split or merge.
- Below 2 mph, the cell counts as stationary.

The fit gives speed and direction.

**3. Arrival.** For every site not already in stop-work, project each tracked cell forward in a straight line. The **leading edge** is whichever of these reaches the ring first:
- the cell's flash from the last 5 minutes nearest the site, moving with the cell;
- the cell's center plus the radius of its last 5 minutes of flashes (90th percentile).

The arrival time is when that edge first comes within 10 miles of the site, if it does within 60 minutes. The earliest cell wins.

**4. The advisory.** Each cycle the advisory is created, updated (new arrival estimate, direction, speed), or cleared:
- Once raised, it is held until 15 minutes after the later of (a) the last cycle in which a cell projected an arrival and (b) its estimated arrival time. Tracks come and go as cells merge, split or weaken, and a site must never flip to "clear" in the minutes before lightning arrives. The cost: an advisory for a storm that fades can stay up to about 75 minutes (a 60-minute estimate plus 15).
- When a stop-work starts at the site, its advisory is closed as "superseded".

### Safety rules

- **Advisories can't touch stop-work alerts.** They live in their own table (`lightning_advisories`, migration 008), not in `alerts`. The forecast code only *reads* stop-work alerts, and a test checks it contains no statement that writes them. The DB tests show stop-work rows are identical before and after the forecast runs.
- **It runs after the stop-work engine, in its own transaction and its own `try`.** A forecast crash is logged and stop-work keeps working.
- **Ingestion never waits for it.** It runs on a background worker; if the previous forecast is still running, that cycle's is skipped. Live cycles are 20 s apart, so live gets one every cycle. A 30× replay cycles every 0.67 s while a forecast takes 0.3–0.45 s, so during a replay it runs every cycle or two instead of slowing the replay down.
- **Same clock as stop-work.** It uses the hook's `now` (simulated during replay). Replay advisories are stored with `replay = true` and never mix with live ones. Replay start clears old replay advisories.

## Where you see it

| Endpoint | What |
|---|---|
| `GET /sites`, `GET /sites/{id}` | `lightning_approach` on each site: `arrival_at`, `minutes_to_arrival`, `from_direction` (e.g. "WSW"), `speed_mph`, `heading_deg`, `distance_mi`, `issued_at`, `updated_at`. `null` when nothing is approaching or the site is already in stop-work. |
| `GET /lightning/cells` | Current storm cells, largest first: center, `radius_mi`, `flash_count` (20 min), `recent_flashes` (5 min), `tracked`, `speed_mph`, `heading_deg`, `moving_toward`. Ids are per response, not stable. |
| `GET /sites/{id}/beacon` | Tiny JSON for a hardware alarm: `state` is `stop` > `unknown` > `approaching` > `flood` > `clear`, with `seconds_to_all_clear` (stop) or `minutes_to_arrival` (approaching), and `replay` (whose clock the countdown is on). Cached like `/alerts`; every alert or advisory change clears the cache. |

- **`unknown`**: lightning ingestion hasn't succeeded in the last 2 minutes on that clock (`lightning/health.py`): no data never reads as clear. An active stop-work still shows `stop`.
- **During a replay** the real state (real time) and the replay's state (replay clock) are both worked out and the higher one wins, so a real stop-work, advisory or flood alert (`alerts/flood.py`, live-only) is never hidden by a replay. Two stop-works: the real one wins, with its real-time countdown and `replay: false`.
- **Live ingestion turned off** (`LIGHTNING_INGEST_ENABLED=false`, e.g. a laptop after the server cutover): there is no real lightning layer, so during a replay only a real stop-work from the shared database counts and the replay's approaching / flood / clear show normally. Ingestion turned **on** but stalled is different: the real `unknown` stays above the replay's approaching and clear.

## How well it worked on the Aug 4, 2025 replay

The test: `python -m scripts.evaluate_lightning_forecast` replays `2025-08-04_2200-2300` (6–7 PM Eastern, 16,533 Florida flashes) the same way the app's **Replay storm** button does. It runs one cycle per 20-second satellite file, with no lightning history before the window. Stop-work alerts are worked out with the engine's own rules. Nothing is written to the database. Lead time is how many minutes before a stop-work started (its first strike within 10 miles) the site's first advisory in the preceding hour was issued.

| | Result |
|---|---|
| Stop-works in the hour | 22 at 21 sites |
| **Warned, stop-works starting 15+ min into the window** | **8 of 13 (62%)** |
| Warned, all stop-works | 8 of 22 (36%) |
| **Median lead time** (when warned) | **10.8 min** (range 3–26) |
| First arrival estimate vs the actual stop-work | **late in 7 of 8**, median off by 30 min |
| Advisories issued / followed by a stop-work within 60 min | 19 / 8 |
| **Green gaps**: an advisory cleared, then a stop-work at that site within the hour | **0** (6 with the original 2-minute grace, 1 with a plain 15-minute hold) |

Per stop-work, after warm-up:

| Stop-work (UTC) | Site | Warning |
|---|---|---|
| 22:18 | Cape Canaveral | none |
| 22:19 | Orange Cogeneration | none |
| 22:20 | West County | 8 min |
| 22:23 | Fort Myers | none |
| 22:26 | Osceola | 16 min |
| 22:27 | Deerhaven | 13 min |
| 22:34 | Vandolah | 24 min |
| 22:37 | Northside | 26 min |
| 22:37 | Martin | 9 min |
| 22:44 | Stanton | 7 min |
| 22:51 | Orange Cogeneration (2nd) | none |
| 22:54 | J.D. Kennedy | none |
| 22:57 | Sanford | 3 min |

The first 9 stop-works (21:59–22:06) started before the forecast had enough history to track anything. Seven were already under lightning when the window opens. In live use, the forecast always has history.

**Choosing the leading edge.** This was tuned on the same hour it is tested on (there is only one replay hour), so treat it as a judgment call, not a measured result. With the first version (center + radius), arrival estimates ran even later. All three definitions, on this hour (measured with the original 2-minute grace, so the advisory counts differ from the table above):

| Leading edge | Warned (after warm-up) | Median lead | Median arrival error | Advisories / followed |
|---|---|---|---|---|
| Center + 90th-percentile radius | 7/13 | 13.2 min | 33 min | 21 / 8 |
| Nearest recent flash | 6/13 | 10.1 min | 18 min | 19 / 7 |
| **Earliest of the two (used)** | **8/13** | **10.8 min** | **31 min** | **24 / 10** |

"Earliest of the two" warns the most stop-works and can only make estimates earlier, which is the safe direction.

## Honest limits

- **One hour of test data.** The parameters (3-mile clustering, 20 flashes, 2.5-mile track fit, leading edge) were set by hand and the edge was chosen on the same hour. 13 stop-works are far too few to trust the percentages. It needs testing on more storm days before anyone relies on it.
- **Arrival times are too optimistic.** In 7 of 8 warned stop-works, the first lightning within 10 miles came *before* the estimate, by a median of 30 minutes. Crews should treat `minutes_to_arrival` as "lightning could arrive any time in the next N minutes", **not as a countdown**, and the UI shouldn't present it as one. Part of the reason: a stop-work starts on a *single* flash within 10 miles, and outlying flashes from a storm's edge or anvil come well ahead of its core.
- **It misses storms that form overhead.** New cells that pop up near a site have no track yet, which is typical of Florida's afternoon sea-breeze storms. Five of the 13 warmed-up stop-works got no warning, and the forecast can't help in those cases.
- **False alarms.** 11 of 19 advisories weren't followed by a stop-work within the hour, and the hold keeps each one up for at least 15 minutes. Some of those were storms that weakened or turned, and some arrive after the end of the one-hour data, so they can't be checked. Expect advisories that don't pan out; they cost a heads-up, not work time.
- **Straight lines only.** Cells are assumed to keep their speed and direction for up to an hour. Real storms curve, speed up, split and die.
- **Satellite position error.** GLM locates flashes to within a few miles (and records in-cloud flashes too), which is the same data stop-work uses, so the two are consistent with each other.
- **Cold start.** After a restart or at the start of a replay, nothing is tracked for about 15 minutes.

## Running it

```bash
cd backend
python -m scripts.migrate                          # migration 008 (lightning_advisories), once
python -m scripts.evaluate_lightning_forecast      # the replay report above, in memory
python -m scripts.evaluate_lightning_forecast --db # the same report from the last in-app replay's stored rows
python -m pytest tests/test_lightning_forecast.py
```

Until migration 008 is applied, the forecast logs one warning and does nothing, `lightning_approach` is `null`, and the beacon never says `approaching`. Stop-work alerts and replay work as before.
