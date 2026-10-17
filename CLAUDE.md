# PlanIT Control

Real-time job-site safety platform for utility field crews. Built for the Sperry Tech challenge at SwampHacks XII.

> CLAUDE.md, AGENTS.md, and GEMINI.md are identical. Edit CLAUDE.md, then copy it over the other two in the same commit.

## What it does

- Tracks 55 real Florida power plant sites from the EIA-860M generator inventory (`backend/data/sites.json`).
- Pulls per-site hazard data: heat, lightning, flooding, soil saturation, wildfire (NASA FIRMS), and wildlife.
- Lightning stop-work alerts with a 30-minute all-clear countdown that **resets on every new strike**.
- Scores each site with a 0–10 **hazard index** from an ML model, for today and tomorrow.
- Crews report hazards with a photo pinned to a map.
- Sends a next-day safety briefing at **6 PM site-local time**.

## Repo layout and ownership

| Folder | Owner | Contents |
|---|---|---|
| `frontend/` | Frontend teammates | Next.js (App Router), TypeScript, Tailwind v4, MapLibre GL |
| `backend/` | John Azer | Python 3.11, FastAPI, uvicorn. Config from `backend/.env`. `data/sites.json` + `scripts/load_sites.py` |
| `shared/` | John Azer | `types.ts` (the API contract) and `mocks/` (sample JSON for every endpoint: contract examples, backend placeholders without a database, and the frontend's labeled demo mode) |

Only change files in folders you own. If you need something in another folder (a new field, a new endpoint, a bug fix), ask the owner or open an issue.

## API contract

`shared/types.ts` is the single source of truth. `backend/app/schemas.py` mirrors it in Pydantic. Each endpoint has sample JSON in `shared/mocks/`.

| Method | Path | Response type | Mock |
|---|---|---|---|
| GET | `/sites` | `Site[]` | `sites.json` |
| GET | `/sites/{id}` | `SiteDetail` | `site_details.json` (keyed by id) |
| GET | `/alerts` | `Alert[]` (active only, from the alert engine) | `alerts.json` |
| GET | `/reports` | `HazardReport[]` (newest first) | `reports.json` |
| POST | `/reports` | body `CreateReportRequest`, returns `HazardReport` (201) | `create_report_request.json` |
| POST | `/uploads` | raw image body (`Content-Type: image/*`), returns `UploadResponse` (201) | — |
| GET | `/lightning/recent?minutes=15` | `LightningFlash[]` (newest first) | `lightning_recent.json` |
| POST | `/replay/start` | body `StartReplayRequest` (optional), returns `ReplayStatus` (202) | `replay_status.json` |
| POST | `/replay/stop`, GET `/replay/status` | `ReplayStatus` | `replay_status.json` |
| GET | `/briefing/{site_id}` | `Briefing` | `briefings.json` (keyed by site id) |

Changing the contract: update `shared/types.ts`, `backend/app/schemas.py`, and the matching mock in **one PR**. Don't rename or remove fields the frontend already uses without telling the frontend team.

## Rules

1. **The frontend uses only shapes from `shared/types.ts`.** Import them with `import type { Site } from "@shared/types"`. Don't define API response types in the frontend.
2. **Risk bands for the hazard index (0–10) are fixed:** green 0–3, amber 4–6, red 7–10. Scores can be decimals, so the cutoffs are green `< 4`, amber `4` to `< 7`, red `>= 7`. In the frontend, always use `riskLevel()` from `frontend/lib/risk.ts`.
3. **No new libraries without approval.** The approved stack is everything already in `backend/requirements.txt`, `backend/scripts/requirements.txt` (offline data scripts only), and `frontend/package.json`. Ask before adding to any of them. Backend pins must install on Python 3.11 (e.g. numpy stays on 2.4.x; 2.5+ needs 3.12).
4. **Small PRs from personal branches.** Branch as `<name>/<short-topic>` (e.g. `maria/site-map`), keep each PR to one change, and never push directly to `main`.
5. **Never commit secrets.** Real values go in `backend/.env` / `frontend/.env.local` (both gitignored). Add new keys to the matching `.env.example` with an empty or placeholder value. Never print, log, or paste `DATABASE_URL`.

## Conventions

- **Timestamps:** ISO 8601 with a UTC offset (`2026-10-16T16:38:00-04:00`). Store and compare in UTC. Show times in the **site's** `timezone`, not the viewer's. Panhandle sites (e.g. Crist, Escambia County) use `America/Chicago`; the rest use `America/New_York`.
- **Units:** miles, °F, inches of rain, percent. Put the unit in the field name (`distance_mi`, `heat_index_f`, `moisture_pct`).
- **JSON fields** are `snake_case` everywhere, frontend included. Don't convert them to camelCase.
- **Site ids** are lowercase slugs of the EIA plant name (`big-bend`, `gulf-clean-energy-center`). Once assigned, an id never changes, even if EIA renames the plant (the loader keeps existing ids by `plant_id`).
- **Lightning:** a strike within 10 mi of a site starts a stop-work alert. `all_clear_at` = latest strike + 30 min and moves later with every new strike.
- **Nullable fields** use `null`, never a missing key.
- **Frontend styling:** use the tokens in `frontend/styles/tokens.css` through their Tailwind names (`bg-surface`, `text-muted`, `bg-risk-red-bg`, `rounded-card`, ...). No raw hex colors in components. `frontend/components/SiteCard.tsx` is the reference component: copy its structure.
- **Frontend data:** fetch through `frontend/lib/api.ts`; its requests throw when the backend is unreachable or returns an error. The frontend **never falls back to mocks** when the backend is down. Unknown safety data must look unknown: the nav badge shows "—" / "Offline", the dashboard says "Can't reach the server", and after a connection drop the last real data stays visible but greyed with "?" and countdowns say "Not confirmed", never "All clear". `shared/mocks` appear only in the explicit **Demo data** mode (`DEMO_DATA` in `lib/api.ts`, turned on with "Show demo data"), and anything showing them must carry the "Demo data" label.
- **Frontend state and time:** read alerts and replay state from `AlertsProvider` via `useAlertsState()` so the nav badge, dashboard and `/alerts` always agree (the dashboard's "Alerts" count equals the badge; "Stop work" is lightning only). Any countdown or age-based display uses `useServerNow()`: the backend clock, simulated during replay and a demo clock in demo mode. Poll with `lib/usePolling.ts`; refresh speeds up to every 3 seconds while a replay runs.
- **Next.js 16:** APIs have changed from older versions. Check `frontend/node_modules/next/dist/docs/` before using a Next API you're unsure of.
- **Backend:** one router per resource in `backend/app/routers/`. Read config only through `get_settings()` in `backend/app/config.py`. Keep each route's response model the same when you swap in real data.
- **Real vs placeholder data:** every hazard card is real when the backend has a database: lightning (GOES-19), heat, rain and soil (Open-Meteo), NWS alerts, FEMA flood zones, nearby rivers (USGS NHD), fires (NASA FIRMS, needs `FIRMS_MAP_KEY`), wildlife (iNaturalist + crew reports). `hazard_index` / `top_factors` are a **temporary rule-based score** (`backend/hazards/scoring.py`) until the ML model exists; while a site has an active lightning stop-work, today's index is at least 9.0. Report photos are saved to `backend/uploads/` (gitignored) and served at `/uploads/<file>`. Briefings are still mocked and only cover the 6 mock sites.
- **Hazard sources:** one module per source in `backend/hazards/sources/`, polled by `backend/hazards/scheduler.py` (weather 15 min, NWS 5 min, FIRMS 30 min, iNaturalist 6 h; FEMA/river/NWS-zone lookups once per site). Numeric readings go in the `conditions` hypertable; a failed poll is logged in `data_sources` and the last good readings keep being served with their `as_of` time. Pollers use real time, not the replay clock. External requests go through `backend/hazards/http.py`, which sends the `NWS_CONTACT` User-Agent.
- **Hazard cards:** every card has optional `hazard_status` (`ok` / `watch` / `danger`, same bands as the risk colors), `reading` (one plain-language line for crews), and `as_of`. Use `hazard_status` for the card color; `FloodConditions.status` is the separate NWS-style level. The wildlife card is `conditions.wildlife_summary` (`conditions.wildlife` is the list of sightings). A missing `hazard_status` means the source has no data yet.
- **Database (Tiger Data / TimescaleDB):** schema changes are numbered SQL files in `backend/db/migrations/`, applied with `python -m scripts.migrate`. Never edit an applied migration; add the next number. Routes get connections from the pool with `Depends(get_pool)` (`backend/app/db.py`) and write SQL with `%s` / `%(name)s` parameters, never string formatting of values. Other tables reference sites by the API slug `sites.id`, not `plant_id`.
- **Time:** in the backend, get the current time from `app.clock.now()`, never `datetime.now()`. During lightning replay it returns the simulated time, which is what makes replay behave like live.
- **Lightning:** `backend/lightning/glm.py` ingests GOES-19 GLM files into `lightning_flashes` (Florida + 30 mi). Live polling (`live.py`, every 20 s, `LIGHTNING_INGEST_ENABLED`) and replay (`replay.py`) both go through `glm.ingest_cycle()`. The hook `lightning/alert_hook.py` runs the stop-work alert engine (`backend/alerts/engine.py`, explained in `docs/alert-engine.md`) every cycle. Alert changes are logged in `alert_events`; replay alerts are stored with `replay = true` and never mix with live ones.
- **Tests:** `cd backend && pip install -r requirements-dev.txt && python -m pytest`. Database tests run inside a rolled-back transaction and are skipped without `DATABASE_URL`.
- **Data downloads** (EIA workbooks, FIRMS CSVs, rasters, etc.) go in a `data/` folder, which is gitignored. Exception: `backend/data/sites.json` is committed so the app never downloads at runtime. Rebuild it with `cd backend && python -m scripts.load_sites`.

## Running locally

See `README.md`. Short version: backend runs on `http://localhost:8000` (API docs at `/docs`), frontend runs on `http://localhost:3000`.
