# Overnight QA report (Oct 17, 2026)

Branch `overnight-qa`, from `main` at `2f85ead` (after PRs #9, #10 and #16 were merged). Nothing was merged into `main`, and no teammate branch was touched.

## Summary

- **Tests and build:** all pass. 86 backend tests, 27 frontend tests, `tsc --noEmit` and `next build` all pass. Nothing needed fixing.
- **Browser pass:**
  - 15 pages at desktop (1440×900) and phone (390×844), live and during the Aug 4, 2025 replay.
  - No console errors, no failed requests and no sideways scrolling.
  - All 65 internal links work.
  - All 26 on-screen numbers I compared match the API.
- **Fixed:** 2 small frontend bugs, one commit each (see **What I fixed**).
- **Needs your decision:** 9 items (see the last section).

## What I tested

### 1. Test suites and build

| Check | Result |
|---|---|
| `cd backend && python -m pytest` | 86 passed |
| `cd frontend && node --test tests/*.test.cjs` | 27 passed |
| `npx tsc --noEmit` | passes |
| `npm run build` (production) | passes; 13 routes |

### 2. Every page, in a real browser

The browser was headless Chrome driven over the DevTools protocol, with true phone emulation (390 px, touch, DPR 2), against the production build (`next start`) and the backend with all live pollers on. On every page I recorded:
- console errors and exceptions;
- failed or 4xx/5xx requests;
- sideways overflow, and any element sticking out past the screen;
- the title and h1;
- a screenshot.

The pages were:
- `/` (dashboard);
- five site pages: Sanford, Polk (live flood alert), Big Bend, Gulf Clean Energy Center (Central time) and Midulla;
- `/alerts`, `/crew`, `/report`, `/reports`, `/briefings`, `/briefing/sanford`, `/how-it-works`, `/about`;
- a made-up URL, to check the 404 page.

Results:
- **Live, both widths:** no console errors, no failed requests and no overflow. Every page has its own title (e.g. "Crew view · PlanIT Control"), and the 404 page shows "Page not found".
- **Links:** I collected every internal link on every page (65) and fetched each one. All return 200.

### 3. Numbers on screen vs. the API (live)

Each screen value was compared with the API value read at the same moment:

| Where | What | Result |
|---|---|---|
| Nav | badge vs `/alerts` | match |
| Dashboard | Sites, High risk, Alerts, Stop work, Flood risk | match |
| Dashboard | map legend flash count vs `/lightning/recent?minutes=15` | match |
| Dashboard | first 5 cards: names, indexes and order (stop-work first, then highest) | match |
| Site pages | today / tomorrow index for 5 sites vs `/sites/{id}` | match |
| `/briefings` | card count vs `/briefings` (55) | match |
| `/reports` | count vs `/reports` | match |
| `/crew` | hazard index vs `/sites/{id}` | match |

The one order difference was between sites tied at 6.5. Their order doesn't matter.

### 4. During the Aug 4, 2025 replay

I pressed **⚡ Replay storm** in the browser, the same button a demo uses. I checked the dashboard every 12 s, then visited the busiest site (Okeechobee Clean Energy Center), `/alerts`, `/briefings`, the dashboard, and `/crew` with Okeechobee selected, at both widths.

- **Alert counts:** stop-work alerts rose 7 → 9 → 11 → 13 → 15 → 18 → 20. The badge, dashboard stats and `/alerts` agreed. A few times the screen trailed the API by one, because the page polls every 3 s.
- **Okeechobee:**
  - The site page shows STOP WORK with today's index 9.0.
  - Crew view shows the large STOP WORK card with a countdown that says "New strike — timer reset" when it resets.
  - The map shows stop-work rings.
- **Errors:** none, and no overflow, at either width.
- **End of replay:** 16,533 flashes in total, the same as `docs/alert-engine.md`. The app returned to live by itself, with the badge back to the 1 real alert and no reload. The whole replay is 91 simulated minutes (60 of files plus the 31-minute quiet tail), about 3 minutes at 30×.

## What I fixed

Each fix is its own commit on this branch:

1. **Site page stop-work banner showed an unrounded distance** (`b13be54`).
   - It said "Last strike 8.64 mi away", while the lightning card on the same page, crew view and `/alerts` say "8.6 mi".
   - It now uses `formatStrikeDistance()` like every other page. That helper rounds *down*, so a strike inside 10 mi can never read as 10.0.
2. **Dashboard map legend was cut off on phones** (`2796e8a`).
   - The legend had a left margin but no right limit, so at 390 px it ran to the screen edge (right edge at 390 of 390) and lost its border and rounded corners.
   - It now keeps 12 px on both sides. The desktop layout is unchanged.

## Found but not fixed: needs your decision

1. **A replay hides real live alerts.**
   - When the replay started there was a real stop-work at Port Everglades (strike 7.95 mi away). During the replay it disappeared from the badge, dashboard and `/alerts`, because replay alerts and live alerts never mix.
   - That's fine for a demo, but anyone watching the app during a demo can't see a real stop-work.
   - Options: show live alerts alongside the replay, or put a "live alerts hidden during replay" line in the replay bar.
2. **Dashboard stat colours don't depend on the count.** "Stop work 0" is red and "Flood risk 0" is amber. A zero could be shown neutral.
3. **Midulla is NO-GO tomorrow because of one fire detection 1 mi away.**
   - Five VIIRS detections came from a single afternoon pass on Oct 16. They're 1.7–3.1 km from Hardee Power Station and haven't been seen on any other day, so it's probably a real one-time burn, not plant heat.
   - PR #13 (ignore hot spots at all 112 Florida plants that burn fuel or make steam) doesn't change it. Two decisions: should a single detection be able to make a site NO-GO, and should it count once it is more than 24 h old? The "Orange Cogeneration Facility 8.5, top hazard Wildfire" on the dashboard comes from the same detections.
4. **My briefing PRs aren't on main yet.** `main` still has the first Claude writer, which calls the API with plain HTTP rather than the SDK and doesn't have the tighter prompt.
   - #11: SDK and tighter prompt.
   - #12: "Written by Claude" label.
   - #13: plant hot spots.
   - #15: per-briefing timestamps.
   - Until #12 is merged, briefings written by Claude show no writer label.
5. **"Send briefings now" on `/briefings` needs no sign-in.** It writes all 55 briefings with Claude (55 paid API calls). For judging, consider hiding it or asking for confirmation.
6. **Port Everglades rain figures disagree.**
   - Its briefing input says `rain_total_in: 3.3`, but its top factor says "3.6 in of rain forecast tomorrow". They come from different windows: work-hours periods vs the whole calendar day.
   - The briefing grounding checks pass because both numbers are in the input, but a reader sees two figures. Pick one window.
7. **Heat card wording just after midnight.**
   - Sanford at 1:47 AM said "today peaked at 79°F at 12:00 AM". That's correct for the new calendar day but reads oddly.
   - Relatedly, crew view can show a green heat card with "OSHA: Moderate": the colour uses the rest of today, while the band shows today's peak, which may already have passed.
8. **Phone on the venue Wi-Fi isn't wired up.** The browser calls the backend at `NEXT_PUBLIC_API_URL`, which defaults to `http://localhost:8000`. A real phone loading the laptop's site would call *itself*. Using a real phone needs `NEXT_PUBLIC_API_URL=http://<laptop-ip>:8000` at build time, and the phone's origin in `CORS_ORIGINS`. Not tested; the demo checklist uses a narrow browser window instead.
9. **Not exercised:** submitting a crew report (it would write into the live database and raise hazard cards for 48 h), and "Send briefings now" (paid calls). Both worked in earlier testing. Say if you want them run against the database, with cleanup afterwards.
