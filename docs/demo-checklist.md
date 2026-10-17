# Demo run sheet (judging table)

**The storm:** Aug 4, 2025, 6–7 PM Eastern. It's replayed at 30× on the production server, through the same code as live: `https://www.stormsafecrews.us` (frontend) and `https://api.stormsafecrews.us` (API). The beacon watches **Vandolah Power Station** first, then Okeechobee Clean Energy Center (hold its button 2 s to switch).

| Real time after **Replay storm** | Simulated | What happens |
|---|---|---|
| 0:00 | 6:00 PM | **Okeechobee** goes to stop-work (strike 6.6 mi away) |
| ≈ 0:21 | 6:10 PM | **Vandolah: lightning possible.** Beacon **yellow**, `STORM NEARBY`, 3 beeps |
| ≈ 1:09 | 6:34 PM | **Vandolah: stop-work.** Beacon **red**, `STOP WORK 30:00` counting down at 30×, 3 beeps |
| 2:00 | 7:00 PM | Last satellite file. Quiet period; countdowns finish |
| ≈ 2:49 | 7:24 PM | Vandolah all clear: beacon **green** |
| ≈ 2:59 | 7:29:36 PM | **Okeechobee clears**, exactly 30 min after its last strike |
| ≈ 3:02 | 7:31 PM | Replay ends; the app is back on live data by itself |

**What's on screen.** Replay alerts are **blue with a REPLAY tag**, never the red of a real alert:
- **Map:** a dashed blue ring.
- **Site row:** a blue **Stop work** chip.
- **Counts:** **High risk**, **Stop work** and the nav badge count real alerts only. The replay's counts are on the dark replay panel.
- **Index:** the score shown is the live one (`hazard_index_live`). A replay-raised score gets a dashed blue outline, never a real red.

The beacon's yellow, red and green are the only ones that change color for the replay: it shows the site's combined state, and a real stop-work always wins.

## 1. Preflight (15 minutes before)

- [ ] **API healthy:** `https://api.stormsafecrews.us/health` shows `{"status":"ok","database":"ok"}`.
- [ ] **No replay running:** `https://api.stormsafecrews.us/replay/status` shows `"running":false`. If it's `true`, someone is rehearsing: press **Stop replay** on the dashboard.
- [ ] **Site loads:** `https://stormsafecrews.us` opens the map and **Sites by risk**, and the nav badge isn't `Offline`. Use Chrome on the laptop, about 1440 px wide, zoom 100%. Open a second tab on `/briefings`.
- [ ] **Hotspot** on, with the laptop, phone and Pi able to reach it.
- [ ] **Pi beacon powered:**
  - It boots in about 40 s (allow up to a minute).
  - Self-test: `PlanIT Control`, red, yellow, green, one beep.
  - Then it blinks yellow `NO DATA` until the API answers, and settles on the live state for **Vandolah** (line 1 `Vandolah Power S`). That's green `ALL CLEAR` unless there's a real storm.
- [ ] **Demo code** at hand (it isn't written here). On the laptop browser, press **Replay storm** once, enter the code (the browser remembers it), then press **Stop replay**. The real demo then starts with one click.
- [ ] **Phone and power bank** charged:
  - Open `https://stormsafecrews.us/crew` and set **Your site** to **Okeechobee Clean Energy Center** (it's remembered).
  - Allow the camera for the report.
- [ ] **Deploy freeze:** from 30 minutes before judging until after, no merges to `main` (Vercel builds the site from it) and no `deploy/update.sh` on the server. A restart only pauses the API for a few seconds: Caddy retries for up to 10 s instead of showing an error. But a restarted server rebuilds the replay's event list (about 30 s) and forgets the last replay.

## 2. The 3-minute demo

**0:00. Dashboard.**
- **Say:** "Live hazards for 55 real Florida power plants: lightning, heat, flooding, soil, wildfire and wildlife, scored 0–10. The map shows where, and the list ranks sites by risk."
- **Click:** **Replay storm** on the replay panel. If asked, enter the demo code.

**0:05. The storm comes in.**
- **Watch:** flashes fill the map, and Okeechobee is already in stop-work.
- **Say:** "This is the real satellite record of a real storm, going through the same code as live. Replay alerts are blue and tagged so nobody mistakes them for a real one."

**≈ 0:21. Vandolah: yellow.**
- **Beacon:** yellow, `STORM NEARBY`, three beeps.
- **Screen:** Vandolah's row shows **REPLAY · LIGHTNING POSSIBLE WITHIN THE HOUR**.
- **Say:** "Our storm-cell forecast tracked this cell about 24 simulated minutes before it arrived. We don't show minutes, because arrival estimates ran late."

**≈ 1:09. Vandolah: red.**
- **Beacon:** red, `STOP WORK 30:00`, counting down.
- **Screen:** Vandolah gets a blue **Stop work** chip with a countdown, and a dashed blue ring on the map.
- **Say:** "A strike within 10 miles stops work. All clear is 30 minutes after the last strike."
- Press the beacon button to silence the beeps.

**1:20. Okeechobee's countdown.** Click its row in **Sites by risk** (replay stop-work sites sort right after any real ones). Optionally, hold the beacon button 2 s to switch it to Okeechobee.
- **Say:** "Every new strike within 10 miles resets the 30 minutes. Okeechobee reset 177 times in this storm, and it clears exactly 30 minutes after its final strike, even if satellite files arrive late."

**1:40. Replay panel.**
- **Show:**
  - The timeline from **Storm start** to **Storm end**.
  - **Flashes per 5 min** and **Replay sites in stop-work**.
  - **Key events**, newest first: Stop work, Lightning possible, All clear.
- **Say:** "Every stop-work, warning and all-clear, as it happened."

**2:00. Phone: crew view.**
- **Show:** **Your site** shows Okeechobee's **STOP WORK** with its REPLAY tag and countdown.
- **Say:** "This is what the foreman sees."

**2:15. Phone: crew hazard report.** Tap **Report hazard**, then:
1. Take a photo.
2. **What did you see?** **Other**.
3. Site **Away from a site / unknown**.
4. **Use my location**.
5. **Submit hazard report**.

It's a real report: it appears on the dashboard map with its age. Reports within 2 miles of a site raise that site's card, which is why it's away from a site here.

**2:35. Briefings tab.**
- **Show:** Go / Caution / No-go counts, then open one ("Written by Claude").
- **Say:** "Every number in it is checked against the site's data, it stays under 150 words, and Claude Haiku rereads it. If a check fails, it falls back to Gemini, then a template. The go / no-go call is made in code, never by the model."

**2:50. The model, in one line.**
- **Say:** "The index comes from a LightGBM model trained on archived forecasts against NOAA storm reports. It ranks risky days 3–4 times better than the baselines. But 58% of logged hazard days still looked green, so the index plans the day, and the live stop-work engine protects the crew."

**≈ 3:00. Okeechobee clears; ≈ 3:02 the replay ends.** The app is back on live data with no reload, and the beacon is green again (with no real storm).

## 3. Likely judge questions

**How fast does an alert reach a crew?**
- On our production server, real stop-work alerts were saved a median of **35 seconds** after the lightning strike (worst 49 s, over five stop-works).
- Nearly all of that is the GOES-19 satellite's own delivery time; our engine adds about one second.
- The beacon shows a stored stop-work within about 5 s more: the 2.5 s API cache plus its 3 s poll.
- It's a small sample from one afternoon of storms over southeast Florida.

**How good is the hazard model? Is it calibrated?**
- **Ranking:** on 2025, a year it never saw, PR-AUC is **0.128**, against **0.032** for monthly climatology and **0.040** for a rain/heat rule. The 95% confidence intervals exclude zero.
- **Calibration:** Platt scaling on 2024. Up to about 20% it tracks reality and runs slightly low, mostly because of 2025's wildfire days. Above 20% it's over-confident: it learned those from 2024's hurricanes, and 2025 had none.
- **Bottom line:** the probability is only modestly sharper than "it's August" (a 4% Brier skill score). The ranking is the strength.

**How much does it catch?**
- **Hazard days:** red days (about 2% of site-days) had a logged event about 1 in 5 times, against 1 in 68 green days. Amber and red days held **42%** of 2025's logged events, and **58% fell on green days**: many Florida storms form with little warning.
- **Lightning forecast:** it warned **8 of 13** stop-works after a 15-minute warm-up, a median of **10.8 minutes** ahead. That's one storm, and we tuned on it. 11 of 19 advisories weren't followed by a stop-work, and it can't warn about storms that form overhead.
- **Stop-work itself:** it isn't a prediction. Any detected strike within 10 miles triggers it.

**Does it scale beyond Florida?**
- **Already broader:** GOES-19's lightning mapper covers the Americas; we filter to Florida + 30 mi. Sites come from the EIA-860M inventory, and FIRMS, Open-Meteo and iNaturalist are global. NWS alerts and FEMA flood zones are US-wide.
- **What changes:** a new region needs its sites loaded and the model retrained on that region's NOAA Storm Events.
- **Cost:** 55 sites polled hourly use 1,320 of Open-Meteo's 10,000 free calls a day.

**What happens when data is missing?**
- **Never "clear" by default:**
  - A card with no data says **No data**.
  - A failed poll keeps the last good reading with its "as of" time.
  - After a connection drop, the last data stays greyed with "?" and countdowns say **Not confirmed**.
  - After 2 minutes, every page says **Status unknown** and not to treat any site as clear.
- **Beacon:** it blinks yellow `NO DATA`, and it turns green only when the server says clear. If a countdown reaches 00:00 before the server confirms, it stays red.
- **Stalled satellite feed:** that counts as unknown, not clear.

**Is the briefing just an LLM?** No. The facts and the go / caution / no-go call come from code; Claude only words them, and every number and hazard word is checked against the data before it's shown.

## 4. Recovery

**The replay doesn't start.**
- **It asks for the demo code again:** the code was wrong; re-enter it.
- **It says a replay is already running:** press **Stop replay**, then **Replay storm**.
- **Key events says "Loading the storm's events…":** the server restarted recently and is rebuilding the event list (about 30 s). The replay itself runs; keep talking.
- **Nothing works:** demo the live dashboard and the beacon's live state, and walk through the timing table above. **Show demo data** gives a labeled sample, but no replay.

**The API is slow or unreachable.**
- **Check:** `https://api.stormsafecrews.us/health` from the phone.
- **A short pause:** the page keeps its last data greyed and catches up by itself; a restart is covered by Caddy's 10 s retry.
- **If it stays down:** say so; the "unknown, never clear" behavior is part of the story. Use the timing table, and **Show demo data** for the screens.

**The beacon shows `NO DATA`** (blinking yellow: no good answer for 15 s).
1. Check the hotspot.
2. Check `/health`.
3. If both are fine, unplug the Pi and plug it back in. It's back in about 40 s (allow a minute), starting on Vandolah.
4. If a laptop can reach the Pi: `ssh planit@planit-beacon.local systemctl status planit-beacon`.

It's the safe state: it never shows green without the server saying clear.

**The hotspot drops.**
- **During it:** the screens keep their last data greyed and "Not confirmed", and the beacon goes to `NO DATA` after 15 s. The replay keeps running on the server.
- **After it:** reconnect the laptop, phone and Pi; everything catches up by itself. Key events and the charts show what happened while you were offline.
