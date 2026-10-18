# How the lightning stop-work alert engine works

Code: `backend/alerts/engine.py` · Tests: `backend/tests/test_alert_engine.py` · Called from: `backend/lightning/alert_hook.py`

## The rules

From the Sperry brief:

1. Any lightning flash within **10 miles** of a site triggers a **stop-work alert** for that site.
2. The alert's all-clear time is **the most recent qualifying strike + 30 minutes**.
3. **Every new qualifying strike resets** the 30-minute countdown.
4. When the current time passes the all-clear time, the alert is **cleared** and crews can go back to work.

That sounds like four lines of code. The hard part is that real data doesn't arrive neatly: satellite files can be late, out of order, or missing for a cycle, and we also want to replay old storms at 30x speed. The engine is built around two principles that make all of that work.

## The two principles

**1. Countdowns come from strike time, not processing time.**
Every number the engine stores (`started_at`, `last_strike_at`, `all_clear_at`) comes from *when the lightning actually happened* (the flash's `ts` from the satellite), never from when our server got around to reading it.

**2. "Now" is whatever the caller passes in, never the computer's clock.**
The engine never calls `datetime.now()`. The ingestion pipeline passes `now` into the hook, and the engine uses only that to decide whether a countdown has ended.

Why both matter is explained under [The tricky parts](#the-tricky-parts).

## Where the engine sits

```
GOES-19 satellite file (every 20 s)
   │
   ▼
lightning/glm.py  ingest_cycle()      download/read → parse → keep Florida → save to lightning_flashes
   │
   ▼
lightning/alert_hook.py  on_new_flashes(flashes, now)
   │
   ▼
alerts/engine.py  run(flashes, now, replay=...)
   │   one database transaction:
   │   1. find each site's qualifying strikes in this batch
   │   2. decide, per site: create / extend / restart / keep / ignore
   │   3. write those changes (+ a history row in alert_events)
   │   4. clear every alert whose countdown has ended
   ▼
alerts table  ──►  GET /alerts, GET /sites (top_hazard), GET /sites/{id} (lightning card)
```

The hook runs **once per ingestion cycle**: every ~20 seconds when live, and once per satellite file in replay. It runs **even when there are no new flashes**, because clearing alerts depends on time passing, not on lightning arriving.

## Function by function

### `miles_between(lat1, lon1, lat2, lon2)`: the distance check

The haversine formula: the distance between two points on a sphere (the Earth, radius 3,958.8 miles), following its curved surface. One degree of latitude comes out to 69.09 miles, which a test checks.

### `newest_qualifying_strikes(flashes, sites)`: what this batch means for each site

It loops over every flash and every site and keeps only pairs within 10 miles (`<=`, so exactly 10.0 counts). For each site that had at least one, it records a `SiteStrikes` summary:

- `newest_at` and `newest_distance_mi`: the latest strike. This drives the countdown.
- `earliest_at`: the first strike. If this creates the alert, it's when the alert started.
- `count`: how many qualifying flashes there were.

Two details:

- **One flash can qualify for several sites.** Sites like Intercession City and Cane Island are 1.3 miles apart, so one flash alerts both. The loop checks every site for every flash and never stops at the first match.
- **The batch can be in any order.** "Newest" means the largest strike time, not the last item in the list.

Cost: a busy 20-second file has ~120 Florida flashes × 55 sites ≈ 6,600 distance calculations, a few milliseconds in Python.

### `decide(alert, strikes, now)`: the whole rulebook in one pure function

Given the site's current active alert (or none), this batch's strikes, and `now`, it returns one of five answers. It doesn't touch the database, which makes it easy to read, test, and explain.

| Situation | Answer | What happens |
|---|---|---|
| No active alert, and `newest strike + 30 min` is still in the future | **create** | New alert. `started_at` = earliest strike, `all_clear_at` = newest strike + 30 min. |
| No active alert, but `newest strike + 30 min` is already in the past | **ignore** | The strike is so old its countdown is already over. Opening an alert that's instantly expired would be noise. |
| Alert exists, and the newest strike is **not newer** than the alert's last strike | **keep** | A late or repeated file. The countdown must never get shorter, so it stays put. (If the late strike happened *before* `started_at`, `started_at` moves back to it; see below.) |
| Alert exists, and these strikes all happened **after** its countdown had already ended | **restart** | The site was actually clear for a while; the engine just hadn't run yet. Close the old alert at its `all_clear_at` and open a new one. |
| Alert exists, and a newer strike arrived while it was still running | **extend** | Reset the countdown: `all_clear_at` = newest strike + 30 min. |

Because **extend** only happens when the newest strike is later than the alert's last strike, the new `all_clear_at` is always later than the old one. Shortening a countdown isn't just avoided; that code path can't produce it.

### The write functions

Each is one SQL statement that changes the `alerts` row and, in the same statement, appends a history row to `alert_events` (`created`, `extended`, or `cleared`). The `alerts` table only holds each alert's *current* state; `alert_events` is the full story, which is what the timelines below come from.

- `create_alert`: inserts the alert.
- `extend_alert`: moves `last_strike_at`, `last_strike_distance_mi`, `all_clear_at` forward. Also `started_at = LEAST(started_at, earliest strike)`, which is harmless when nothing is earlier.
- `backdate_alert`: the "keep" case where a late file proves the storm began earlier. It moves `started_at` back and leaves the countdown alone.
- `clear_alert`: closes one specific alert (used by **restart**).
- `clear_expired(now)`: closes **every** active alert whose `all_clear_at <= now`. The history row records it as cleared *at its `all_clear_at`* (when it actually became safe) and also stores `recorded_at = now` (when the engine noticed).

### `process(conn, flashes, now, sites, replay)`: one engine cycle

1. **Take a lock.** `pg_advisory_xact_lock` makes sure only one engine cycle runs at a time per mode, even if several copies of the API share the database (every teammate's laptop, for example). It's released automatically when the transaction ends.
2. **Find qualifying strikes** (pure Python, above).
3. **Load the active alerts** for just those sites, `FOR UPDATE` (row-locked until commit).
4. **Decide and write** for each site. Writes are sent in one network round trip using psycopg's pipeline mode, which matters because each round trip to the database is about 40 ms.
5. **Clear expired alerts.**

Everything happens in **one transaction**, so other readers see either the state before this cycle or after it, never half of it.

### `run(flashes, now, replay)`: the entry point

It opens a pooled connection, loads the sites from the `sites` table, calls `process`, commits, and logs a line when anything changed. The hook calls it with `replay=clock.is_simulated()`.

### `active_alerts(conn, now, replay)`: what the API shows

Returns alerts that are `status = 'active'` **and** `all_clear_at > now`. The second condition means an alert whose countdown ended between engine cycles disappears from the API at exactly the right moment, without waiting up to 20 seconds for the next cycle to mark it cleared. That holds for replay and flood alerts. A **real lightning** alert past its `all_clear_at` is different: it's still returned, with `held_reason: "lightning_data_delayed"`, until the engine closes or extends it. That covers both a stall (next section) and the up-to-20-second gap before the clearing cycle runs, so an open real stop-work never shows "00:00 All clear". Every row carries `held_reason` (`null` when not held).

## The tricky parts

### Why strike time beats processing time

Suppose the engine used "when we processed it" as the strike time. Then:

- **Network hiccup:** a file from 6:00:00 arrives at 6:02:30. Its strike would look 2.5 minutes newer than it was, so the all-clear lands 2.5 minutes late. That's safe, but wrong, and it varies with the network.
- **Backlog after a restart:** the server comes back after 10 minutes and processes all the missed files at once. Every strike would get *the same* timestamp, the moment of catch-up, and the countdowns would be meaningless.
- **Replay:** replaying an August 2025 storm would stamp every strike with today's date.

With strike time, the answer only depends on the lightning itself: the countdown ends 30 minutes after the last strike, regardless of when or in what order we learned about it. The same data always gives the same alerts.

In the Aug 4, 2025 replay, the history table shows both times for every event. "Strike at 22:00:09, engine saw it 10 s later." The countdown was computed from 22:00:09.

### Late and out-of-order files must never shorten a countdown

Satellite files usually arrive in order, but not always (a retried download, a file that took longer to fetch). Picture:

1. File B (strike at **6:10**) is processed first → all-clear **6:40**.
2. File A (strike at **6:05**) arrives late.

A naive "set all_clear = this strike + 30 min" would move the all-clear back to **6:35**, telling a crew it's safe five minutes early. **decide()** catches this: A's strike is not newer than the alert's last strike, so the answer is **keep**. The countdown stays at 6:40. File A did show the storm started earlier, so `started_at` moves back to 6:05, which is accurate history with no safety cost.

Test: `test_late_file_with_older_strike_does_not_shorten_timer`. Removing the "keep" rule from `decide()` makes exactly this test fail, so it really guards the rule.

### Clearing runs every cycle, even with no flashes

An alert clears because **time passes**, not because something happens. The quietest moment (no lightning at all) is exactly when crews are waiting for the all-clear. If the engine only ran when there were new flashes, a site would stay in stop-work forever after the storm passed. So the hook runs every cycle, empty or not, and `clear_expired` runs at the end of every cycle.

Replay does the same: after the last satellite file, it keeps cycling with no flashes for 31 simulated minutes so the final countdowns can finish.

### A stalled feed holds the all-clear

"No new flashes" only means "no lightning" if the satellite data is actually arriving. If NOAA's GLM files stop (or keep failing to download), a strike could be happening that we can't see, so the countdown must not end in an all-clear.

- **When it's held:** a live cycle holds when NOAA's newest file is more than 2 minutes old, when a file in the cycle failed, or when the previous cycles weren't current (`lightning/health.py`, the same check the beacon uses). The live poll marks the feed not current as soon as it sees a stale newest file (`glm.poll_latest`).
- **What held means:** `clear_expired` is skipped, so a real alert whose `all_clear_at` has passed stays `active`. No `cleared` event is written and no all-clear is pushed. `GET /alerts`, `/sites` and `/sites/{id}` keep showing it as a stop-work with `held_reason: "lightning_data_delayed"`, and the hazard index stays at 9 or more. The lightning card says "Stop work held: lightning data is delayed". The beacon stays on `stop` (red), with 0 seconds left.
- **Recovery:** the first good cycle looks back to the last successful cycle (at most 2 hours, `glm.BACKLOG_MAX`) and ingests any files NOAA published late. Their strikes extend or restart countdowns exactly as on any other cycle. That cycle still holds, because the cycles before it weren't current. Until the next cycle runs (20 s later), the API still shows the alert as held, the beacon stays on `stop` and nothing is pushed. That next cycle is current: anything still expired clears, and the all-clear is pushed then (push picks events by `recorded_at`).
- **Replay is never held.** It runs on its own clock and files.
- **Limits:** the first 2 minutes of a stall still look like a normal quiet feed (the same tolerance as the beacon). After a server restart, the first cycle looks back only the usual 3 minutes.

### Why strikes are applied *before* clearing

Suppose an alert's countdown ends at 6:30 and the 6:31 cycle carries a late strike from 6:29. If we cleared first, the alert would close at 6:30 and the 6:29 strike would then open a *new* alert, so the site's history would show "clear at 6:30, new alert from 6:29," which never really happened. Applying strikes first extends the original alert to 6:59, which is the truth: the site was never safe.

### Restart: the storm came back after the all-clear

If a site's countdown already ended at 6:30 and the next strike is at 6:31, those are two separate stop-work events: crews could legitimately have resumed work at 6:30. **restart** closes the old alert at 6:30 and opens a new one at 6:31, instead of stretching one alert across the gap.

This happened in the real replay: **Orange Cogeneration** had one strike at 22:19:40 UTC (9.5 mi), cleared at 22:49:40, then a new strike at 22:51:35 opened a second alert.

### Why the hook's `now` matters

There are three reasons the engine uses only the `now` it's handed:

1. **Replay.** During replay the whole system runs on a simulated clock (August 4, 2025, moving 30–60x faster). If the engine read the real clock (October 2026), every replayed strike would look more than a year old, so it would be **ignored**, and nothing would ever alert. Using the passed-in `now`, the engine behaves exactly as it would have that evening.
2. **Testing.** Tests can say "now is 22:29:59, still active; now is 22:30:00, cleared" and check the exact boundary without waiting 30 real minutes.
3. **Consistency.** One cycle uses one `now` everywhere, so it can't straddle a boundary halfway through.

### Live and replay never mix

Replay alerts are stored with `replay = true`. The "one active alert per site" rule is per mode, and the engine only touches alerts of its own mode, so a replayed August storm can't extend or clear a real alert at the same site. Each new replay starts by deleting old replay alerts.

Real alerts never disappear during a replay:
- **Live ingestion keeps running.** The live loop polls GOES-19 on real time while the replay plays, and each cycle tells the hook which mode it is (`ingest_cycle(..., replay=...)`), so the two never share a clock.
- **`GET /alerts` shows both.** Live alerts are checked against real time, replay alerts against the simulated time, and each carries `replay: true/false`. The frontend tags replay alerts **REPLAY** and counts real ones down on real time.
- **The beacon** (`GET /sites/{id}/beacon`) reports a real stop-work, on real time, even during a replay.

## What the rest of the app shows

- **`GET /alerts`**: active alerts from the database, same `Alert` shape as before.
- **`GET /sites`**: a site with an active lightning alert gets `top_hazard: "lightning"`. Without one, lightning is never the top hazard.
- **`GET /sites/{id}`**, lightning card (real data now):
  - `nearest_strike_mi` / `nearest_strike_at`: nearest flash in the last 30 minutes (searched within ~50 miles), from the raw flash table.
  - `strikes_last_30_min`: flashes within 10 miles, from the TimescaleDB 5-minute rollup `lightning_flashes_5m_by_site`. One small indexed read instead of measuring every flash in Florida against the site. Because it counts whole 5-minute buckets, it covers 30–35 minutes.

## A real run: August 4, 2025, 6–7 PM Florida time

Replayed at 60x through the same code path as live:

- 16,533 flashes over Florida in the hour; **21 of 55 sites** got stop-work alerts (22 alerts, since one site had two). All 22 cleared 30 minutes after their last strike.
- Busiest site: **Okeechobee Clean Energy Center**, alert created 22:00:09 UTC (strike 6.6 mi away), **reset 177 times**, cleared at 23:29:36, exactly 30 minutes after its final strike at 22:59:36. One continuous stop-work period of nearly 90 minutes.
- Every strike reached the engine within about half a minute of when it happened (the time for a 20-second file to complete, plus processing), the same as live.

Excerpt of that timeline (UTC):

```
created   22:00:09  strike 6.6 mi  all clear 22:30:09
extended  22:00:35  strike 5.9 mi  all clear 22:30:35
extended  22:01:12  strike 3.2 mi  all clear 22:31:12
   … 173 more resets …
extended  22:59:36  strike 7.6 mi  all clear 23:29:36
cleared   23:29:36                 all clear 23:29:36
```

## Tests

`cd backend && python -m pytest -v` runs the engine's real SQL against the database, inside a transaction that's always rolled back.

| Test | Rule |
|---|---|
| `test_first_strike_creates_alert` | A strike within 10 mi opens an alert ending 30 min later |
| `test_newer_strike_extends_all_clear` | A newer strike resets the countdown (same alert, not a second one) |
| `test_strike_at_10_5_miles_does_nothing` | The radius is 10 miles |
| `test_late_file_with_older_strike_does_not_shorten_timer` | Strike time, never shorten |
| `test_alert_clears_after_30_quiet_minutes` | Active at 29:59, cleared at 30:00, by a cycle with no flashes |
| `test_one_flash_near_two_sites_alerts_both` | One flash, two alerts |
| `test_strike_after_countdown_ran_out_starts_new_alert` | Restart |
| `test_very_late_strike_whose_countdown_is_over_is_ignored` | Ignore |
| `test_unordered_batch_uses_newest_strike` | Batch order doesn't matter |
| `test_replay_alerts_never_touch_live_alerts` | Mode isolation |
| `test_active_alerts_hides_expired_alert_between_cycles` | API is exact between cycles |
| `test_miles_between_one_degree_of_latitude` | Haversine sanity check |

## Known limitations

- **If the engine fails mid-cycle** (say the database drops for a moment), that cycle's flashes are already saved but never evaluated, and the next cycle won't see them again. A fix: each cycle, check the 5-minute rollup for sites with flashes within 10 miles in the last 30 minutes but no active alert, and evaluate those flashes.
- **Satellite locations are approximate.** GLM pixels are roughly 8–14 km across, so a flash reported at 9.8 miles could really be a bit farther or closer. A real deployment might add a safety margin.
- **The hazard index doesn't react to alerts yet.** It's still a placeholder (until the ML model exists), so a site can show a stop-work banner with a low index.
- **A held alert keeps its `all_clear_at`.** The countdown time is in the past while it's held; the frontend must show `held_reason` ("Waiting for lightning data"), never a countdown at 0 or "All clear".
- **Granularity.** Live data is checked every 20 seconds and satellite files cover 20 seconds, so a strike reaches the engine roughly 20–40 seconds after it happens.

## Talking points for judges

- "Our countdown is driven by **when the lightning struck**, not when we heard about it, so late or out-of-order satellite data can never end a stop-work early."
- "Clearing runs **every 20 seconds even when there's no lightning**, because the all-clear is triggered by silence."
- "The engine has **no clock of its own**. That's how we can replay a real August 2025 storm at 60x and get exactly the alerts crews would have seen."
- "Every reset is logged, so a safety manager can audit exactly why a crew was stopped and when they were cleared."
- "The 30-minute strike counts come from a **TimescaleDB continuous aggregate**, a per-site rollup the database keeps up to date for us."
