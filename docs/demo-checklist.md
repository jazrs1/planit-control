# 3-minute demo checklist

The demo is built around one real storm: **Aug 4, 2025, 6–7 PM Eastern**, replayed at 30× through the live pipeline. Pressing **⚡ Replay storm** starts a clock that runs about 3 minutes:

| Real time after pressing | Simulated time | What happens |
|---|---|---|
| 0:00 | 6:00 PM | Okeechobee Clean Energy Center goes to STOP WORK (strike 6.6 mi away) |
| 0:10–2:00 | 6:05–7:00 PM | Stop-work alerts climb to about 20 sites; Okeechobee's countdown keeps resetting |
| 2:00 | 7:00 PM | Last satellite file; no new strikes from here |
| **≈ 3:00** | **7:29:36 PM** | **Okeechobee clears, exactly 30 min after its last strike (6:59:36 PM)** |
| ≈ 3:02 | 7:31 PM | Replay ends; the app returns to live data by itself |

## Before judging (30 minutes ahead)

1. **Code.** `git pull` on `main`. Use the production build, not `npm run dev`, which shows Next's "N" badge.
2. **Keys.** Check that `backend/.env` has these keys (count only, never print them): `grep -c '^ANTHROPIC_API_KEY=..*\|^DATABASE_URL=..*\|^FIRMS_MAP_KEY=..*\|^ADMIN_TOKEN=..*' backend/.env` should print `4`. `ADMIN_TOKEN` is the **demo code**: without it, Replay storm and Send briefings now are turned off.
3. **Replay files.** `ls backend/data/replay/2025-08-04_2200-2300 | wc -l` should print `180`. They're gitignored; on a new laptop run `cd backend && python -m scripts.find_replay_window` (about 150 MB).
4. **Backend.**
   ```bash
   cd backend && source .venv/bin/activate
   python -m scripts.migrate
   uvicorn app.main:app --port 8000
   ```
   `curl localhost:8000/health` should say `"database":"ok"`.
5. **Frontend.**
   ```bash
   cd frontend && npm run build && npm run start
   ```
6. **Fresh data.** Wait about a minute for the first polls, then open any site page:
   - the header says "Updated … (just now)";
   - the wildfire card does *not* say "no FIRMS key".
7. **No replay left running.** `curl localhost:8000/replay/status` should show `"running":false`. If it's true, press **Stop replay** on the dashboard.
8. **Briefings.** `/briefings` shows 55 briefings, labeled "Written by Claude" (or Gemini / Template). Each Claude briefing passed the number and word checks and a second read by Claude Haiku against its data. The 6 PM run makes tomorrow's; before 6 PM, last night's briefings are current, so crew view labels the card "Today's briefing". **Don't press "Send briefings now"** during the demo: it makes 55 paid Claude calls (it needs the demo code and runs at most once per 15 minutes).
9. **Demo code and real alerts.** On the desktop window press **⚡ Replay storm**, enter the demo code when asked (it's remembered on that browser), then press **Stop replay**. Real alerts stay on screen during a replay; replay ones are tagged **REPLAY**.
10. **Desktop window.** Chrome at 1440 px wide, zoom 100%, on `http://localhost:3000/`.
11. **Phone window.** A second Chrome window with DevTools device mode set to iPhone 12/13 (390×844) on `http://localhost:3000/crew`.
    - In **Your site**, choose **Okeechobee Clean Energy Center**; it's remembered.
   - Also open a desktop tab on `http://localhost:3000/sites/okeechobee-clean-energy-center` for the 0:40 step.
    - A real phone on venue Wi-Fi does **not** work without extra setup (QA report item 8), so use the emulated window.
12. **Laptop.** Plugged in, sleep and notifications off, on a reliable network.
    - The database (Tiger Data) and the map tiles need the internet; have a phone hotspot as backup.
    - If the backend can't be reached at all, the app says so. **Show demo data** gives a clearly labeled sample, but no replay.

## The 3 minutes

**0:00. Dashboard (desktop).** "Live hazards for 55 real Florida power plants: lightning, heat, flooding, soil, wildfire and wildlife, scored 0–10." Then press **⚡ Replay storm** (top right) right away.

**0:10. Watch the storm come in.** Replay alerts carry a **REPLAY** tag; any real alert stays on screen without one.
- The replay bar shows **REPLAY RUNNING · Aug 4, 6:0x PM EDT simulated · 30×**.
- Yellow flashes fill the map, red rings mark stop-work sites, and **Stop work** and the **Alerts** badge climb.
- "This is a real satellite record of a real storm, going through the same code as live."

**0:40. Open Okeechobee Clean Energy Center.** It's in the stop-work group at the top of the list, but sites scoring 10.0 sort above its 9.0, so it may be a few cards down. Fastest: a pre-opened tab on `http://localhost:3000/sites/okeechobee-clean-energy-center`, or its red ring about 30 mi north of Lake Okeechobee, then **Site details →**.
- **⚡ STOP WORK: lightning** with the last strike's distance.
- The **All-clear countdown** jumps back toward 30:00 whenever a new strike lands within 10 mi.
- Today's index is at least 9.0 during a stop-work. The other hazard cards are live data with "as of" times.

**1:20. Phone window (crew view).**
- A big **STOP WORK** card with the countdown ("New strike — timer reset"), today's key readings, and a big **Report hazard** button with the site already filled in.
- "This is what the foreman sees."

**1:50. Briefings** (`/briefings`, desktop).
- Go / Caution / No-go counts.
- Open one briefing: "Written by Claude from the site's live data. Every number is checked against that data and it stays under 150 words; otherwise we fall back to a template."

**2:30. Back to the dashboard.** The storm is over (last file at 2:00), but countdowns are still running. "Each site clears exactly 30 minutes after *its* last strike, never earlier, even if satellite data arrives late."

**≈ 3:00. Okeechobee clears.** Its card drops its STOP WORK, the count falls, and the replay ends at about 3:02. The app is back on live data with no reload.

If there's time for questions, `/how-it-works` (desktop nav) has the data sources, the stop-work rule, how the index is scored, and honest limits.
