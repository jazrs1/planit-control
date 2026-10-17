# Demo run sheet (judging table)

**The storm:** Aug 4, 2025, 6–7 PM Eastern. It's replayed at 30× on the production server, through the same code as live: `https://www.stormsafecrews.us` (frontend) and `https://api.stormsafecrews.us` (API). The beacon watches **Vandolah Power Station** first, then Okeechobee Clean Energy Center (hold its button 2 s to switch).

| Real time after **Replay storm** | Simulated | What happens |
|---|---|---|
| 0:00 | 6:00 PM | **Okeechobee** goes to stop-work (strike 6.6 mi away) |
| ≈ 0:21 | 6:10 PM | **Vandolah: lightning possible.** Beacon **yellow**, `REPLAY Vandolah` / `STORM NEARBY`, 3 beeps |
| ≈ 1:09 | 6:34 PM | **Vandolah: stop-work.** Beacon **red**, `REPLAY Vandolah` / `STOP WORK 30:00` counting down at 30×, 3 beeps |
| 2:00 | 7:00 PM | Last satellite file. Quiet period; countdowns finish |
| ≈ 2:49 | 7:24 PM | Vandolah all clear: beacon **green**, `Vandolah Power S` / `ALL CLEAR` |
| ≈ 2:59 | 7:29:36 PM | **Okeechobee clears**, exactly 30 min after its last strike |
| ≈ 3:02 | 7:31 PM | Replay ends; the app is back on live data by itself |

**What's on screen.** Replay alerts are **blue with a REPLAY tag**, never the red of a real alert:
- **Map:** a dashed blue ring.
- **Site row:** a blue **Stop work** chip.
- **Counts:** **High risk**, **Stop work** and the nav badge count real alerts only. The replay's counts are on the dark replay panel.
- **Index:** the score shown is the live one (`hazard_index_live`). A replay-raised score gets a dashed blue outline, never a real red.

**Replay alerts are blue on screen and labeled REPLAY on the beacon; only the beacon's LEDs go yellow then red.** On the beacon, a replay stop-work or approach puts `REPLAY` before the site name on line 1 (`REPLAY Vandolah`); a real alert shows the plain site name. **Any real alert always beats a replay on the beacon:** a real stop-work, storm warning, flood alert or unknown always shows over the replay. The replay's state shows only when the real state is clear.

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
  - Open `https://stormsafecrews.us/crew` and set **Your site** to **Vandolah Power Station** (it's remembered), the same site as the beacon.
  - Leave **Read alerts aloud** off: it's off after every page load, and you turn it on in the demo. Turn the phone's volume up.
  - Allow the camera for the report.
- [ ] **Deploy freeze:** from 30 minutes before judging until after, no merges to `main` (Vercel builds the site from it) and no `deploy/update.sh` on the server. A restart only pauses the API for a few seconds: Caddy retries for up to 10 s instead of showing an error. But a restarted server rebuilds the replay's event list (about 30 s) and forgets the last replay.

## 2. The 4-minute demo

Press **Replay storm** about **5 seconds in**; after that the replay runs on its own while you talk. The talk times below assume that: talk time = replay time + 0:05. If you press later, every replay moment moves by the same amount.

| Talk | Replay | Moment |
|---|---|---|
| 0:05 | 0:00 | Replay starts; Okeechobee is in stop-work at once |
| 0:26 | 0:21 | **Vandolah yellow**: beacon `REPLAY Vandolah` / `STORM NEARBY` |
| 1:14 | 1:09 | **Vandolah red**: beacon `REPLAY Vandolah` / `STOP WORK 30:00` |
| 2:05 | 2:00 | Storm data ends; countdowns keep running |
| 2:54 | 2:49 | **Vandolah all clear**: beacon green; the phone says it aloud |
| 3:04 | 2:59 | Okeechobee clears |
| 3:07 | 3:02 | Replay ends; the app is back on live data |

**0:00–0:30. The problem, and start the replay.**
- **Say:** "Crews decide every day whether it's safe to work. The data exists: lightning, heat, floods, fires, gators. But it's scattered. PlanIT puts it on one screen for 55 Florida power plants."
- **Click** (about 0:05): **Replay storm**. Enter the demo code if asked.
- **Say:** "This is a real storm, August 4, 2025, replayed through our live system at 30 times speed."

**0:30–1:15. The dashboard; Vandolah warns, then stops.**
- **Show:** the map and **Sites by risk**.
- **Say:** "Every site gets a 0-to-10 hazard index, ranked by risk."
- **≈ 0:26:** the beacon turns **yellow** and beeps. On screen, Vandolah's row shows **REPLAY · Lightning possible**.
- **Say:** "Our forecast tracks storm cells. It warned Vandolah about 24 storm minutes ahead. We don't show a countdown: arrival estimates run late."
- **≈ 1:14:** the beacon turns **red**, `STOP WORK 30:00`. Press its button to silence it.
- **Say:** "Lightning within 10 miles. Stop work."

**1:15–2:00. The stop-work rule, Okeechobee's resets, REPLAY labels.**
- **Show:** Okeechobee's row in **Sites by risk**, with its countdown jumping back up.
- **Say:** "The rule: a strike within 10 miles stops work. All clear is 30 minutes after the last strike, and every new strike resets it. Okeechobee reset 177 times in this storm."
- **Say:** "It runs on strike time, so a late satellite file can never cut a countdown short."
- **Show:** the blue chips and REPLAY tags, and the dark replay panel's **Key events**.
- **Say:** "Replay alerts are blue and labeled REPLAY, on screen and on the beacon. A real alert always wins."

**2:00–2:45. The crew view on a phone, a hazard report, read-aloud.**
- **Show:** the phone: **Your site** is Vandolah, in **STOP WORK** with a REPLAY tag and countdown.
- **Tap:** **Read alerts aloud** on. The phone says "Read aloud on for Vandolah Power Station."
- **Say:** "This is the foreman's view: one site, big and clear. It can speak alerts, hands-free."
- **Tap:** **Report hazard**:
  1. Take a photo.
  2. **What did you see?** **Other**.
  3. Site **Away from a site / unknown**.
  4. **Use my location**.
  5. **Submit hazard report**.
- **Say:** "Crews report hazards with a photo and a map pin. A report near a site raises that site's card."

**2:45–3:30. Briefings, the model, the honest limits.**
- **≈ 2:54:** the beacon turns **green**, and the phone says "Replay: All clear at Vandolah Power Station. Stop work has ended." Pause and point at both.
- **Show:** the **Briefings** tab, and open one.
- **Say:** "Every evening at 6, Claude writes a briefing for each site. Code checks every number against the data, and the go or no-go call is made in code, never by the model."
- **Say:** "The index is a LightGBM model on archived forecasts. On a year it never saw, it ranks risky days three to four times better than the baselines."
- **Say:** "But 58% of hazard days still looked green. So the index plans the day, and the stop-work engine protects the crew."

**3:30–4:00. Florida first, and the close.**
- **Say:** "We started with Florida. The lightning satellite covers the Americas, so a new region needs its sites and a retrained model."
- **Say:** "And PlanIT never says all clear without data. When it doesn't know, it says unknown. Thank you."
- The replay ended at about 3:07 on its own; the app is back on live data.

### The 60-second version

Press **Replay storm** as you start talking (talk time = replay time).
- **0:00.** "PlanIT puts lightning, heat, flood, fire and wildlife risk on one screen, for 55 Florida power plants. This is a real storm, replayed at 30 times speed."
- **0:10.** "A strike within 10 miles stops work. All clear is 30 minutes after the last strike, and every strike resets it: Okeechobee here reset 177 times."
- **≈ 0:21:** the beacon turns yellow. "And the beacon just turned yellow: our forecast saw this storm heading for Vandolah about 24 minutes ahead."
- **0:35.** Show the phone. "The crew sees it on a phone, can hear it read aloud, and can report a hazard with a photo."
- **0:45.** "Every evening, Claude writes a fact-checked briefing for each site. And when we're missing data, we say unknown, never all clear."
- **If they stay:** Vandolah turns red at 1:09.

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
