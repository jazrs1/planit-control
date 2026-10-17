# PlanIT Control

Real-time job-site safety platform for utility field crews. Built for the Sperry Tech challenge at SwampHacks XII.

> CLAUDE.md, AGENTS.md, and GEMINI.md are identical. Edit CLAUDE.md, then copy it over the other two in the same commit.

## What it does

- Tracks 50+ real Florida power plant sites.
- Pulls per-site hazard data: heat, lightning, flooding, soil saturation, wildfire (NASA FIRMS), and wildlife.
- Lightning stop-work alerts with a 30-minute all-clear countdown that **resets on every new strike**.
- Scores each site with a 0–10 **hazard index** from an ML model, for today and tomorrow.
- Crews report hazards with a photo pinned to a map.
- Sends a next-day safety briefing at **6 PM site-local time**.

## Repo layout and ownership

| Folder | Owner | Contents |
|---|---|---|
| `frontend/` | Frontend teammates | Next.js (App Router), TypeScript, Tailwind v4, MapLibre GL |
| `backend/` | John Azer | Python 3.11, FastAPI, uvicorn. Config from `backend/.env` |
| `shared/` | John Azer | `types.ts` (the API contract) and `mocks/` (sample JSON for every endpoint) |

Only change files in folders you own. If you need something in another folder (a new field, a new endpoint, a bug fix), ask the owner or open an issue.

## API contract

`shared/types.ts` is the single source of truth. `backend/app/schemas.py` mirrors it in Pydantic. Each endpoint has sample JSON in `shared/mocks/`.

| Method | Path | Response type | Mock |
|---|---|---|---|
| GET | `/sites` | `Site[]` | `sites.json` |
| GET | `/sites/{id}` | `SiteDetail` | `site_details.json` (keyed by id) |
| GET | `/alerts` | `Alert[]` (active only) | `alerts.json` |
| GET | `/reports` | `HazardReport[]` (newest first) | `reports.json` |
| POST | `/reports` | body `CreateReportRequest`, returns `HazardReport` (201) | `create_report_request.json` |
| GET | `/briefing/{site_id}` | `Briefing` | `briefings.json` (keyed by site id) |

Changing the contract: update `shared/types.ts`, `backend/app/schemas.py`, and the matching mock in **one PR**. Don't rename or remove fields the frontend already uses without telling the frontend team.

## Rules

1. **The frontend uses only shapes from `shared/types.ts`.** Import them with `import type { Site } from "@shared/types"`. Don't define API response types in the frontend.
2. **Risk bands for the hazard index (0–10) are fixed:** green 0–3, amber 4–6, red 7–10. Scores can be decimals, so the cutoffs are green `< 4`, amber `4` to `< 7`, red `>= 7`. In the frontend, always use `riskLevel()` from `frontend/lib/risk.ts`.
3. **No new libraries without approval.** The approved stack is everything already in `backend/requirements.txt` and `frontend/package.json`. Ask before adding to either one.
4. **Small PRs from personal branches.** Branch as `<name>/<short-topic>` (e.g. `maria/site-map`), keep each PR to one change, and never push directly to `main`.
5. **Never commit secrets.** Real values go in `backend/.env` / `frontend/.env.local` (both gitignored). Add new keys to the matching `.env.example` with an empty or placeholder value.

## Conventions

- **Timestamps:** ISO 8601 with a UTC offset (`2026-10-16T16:38:00-04:00`). Store and compare in UTC. Show times in the **site's** `timezone`, not the viewer's. Panhandle sites (e.g. Crist, Escambia County) use `America/Chicago`; the rest use `America/New_York`.
- **Units:** miles, °F, inches of rain, percent. Put the unit in the field name (`distance_mi`, `heat_index_f`, `moisture_pct`).
- **JSON fields** are `snake_case` everywhere, frontend included. Don't convert them to camelCase.
- **Site ids** are lowercase slugs (`big-bend`, `turkey-point`).
- **Lightning:** a strike within 10 mi of a site starts a stop-work alert. `all_clear_at` = latest strike + 30 min and moves later with every new strike.
- **Nullable fields** use `null`, never a missing key.
- **Frontend styling:** use the tokens in `frontend/styles/tokens.css` through their Tailwind names (`bg-surface`, `text-muted`, `bg-risk-red-bg`, `rounded-card`, ...). No raw hex colors in components. `frontend/components/SiteCard.tsx` is the reference component: copy its structure.
- **Frontend data:** fetch through `frontend/lib/api.ts`. If the backend can't be reached, it falls back to `shared/mocks`, so UI work never waits on the API.
- **Next.js 16:** APIs have changed from older versions. Check `frontend/node_modules/next/dist/docs/` before using a Next API you're unsure of.
- **Backend:** one router per resource in `backend/app/routers/`. Read config only through `get_settings()` in `backend/app/config.py`. Routes return mock data until a real source is wired in. Keep each route's response model the same when you swap in real data.
- **Data downloads** (FIRMS CSVs, rasters, etc.) go in a `data/` folder, which is gitignored.

## Running locally

See `README.md`. Short version: backend runs on `http://localhost:8000` (API docs at `/docs`), frontend runs on `http://localhost:3000`.
