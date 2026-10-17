# PlanIT Control

Real-time job-site safety for utility field crews: per-site heat, lightning, flood, soil, wildfire, and wildlife hazards; lightning stop-work countdowns; a 0–10 hazard index; photo hazard reports; and a 6 PM next-day briefing. Built for the Sperry Tech challenge at SwampHacks XII.

Project rules and conventions are in [`CLAUDE.md`](CLAUDE.md) (identical copies: `AGENTS.md`, `GEMINI.md`).

```
backend/    FastAPI API (Python 3.11)
frontend/   Next.js App Router + TypeScript + Tailwind + MapLibre GL
shared/     types.ts (API contract) + mocks/ (sample JSON for every endpoint)
```

## Prerequisites

- Python 3.11
- Node.js 20.9+ and npm
- The OpenMP runtime for LightGBM (the hazard model): on Debian/Ubuntu servers `sudo apt-get install libgomp1` (slim Docker images don't include it); on macOS `brew install libomp`

## Backend

```bash
cd backend
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # fill in keys (ask John for DATABASE_URL)
python -m scripts.migrate       # create/upgrade the database schema
python -m scripts.seed_sites    # load the 55 sites into the database
uvicorn app.main:app --reload --port 8000
```

- API: http://localhost:8000
- Interactive docs: http://localhost:8000/docs
- Health check (includes the database): `curl localhost:8000/health`

`/sites` and `/sites/{id}` serve 55 real Florida plants from `backend/data/sites.json` with live hazard data (see **Hazard data sources** below); `hazard_index` is the hybrid score: the ML weather model (LightGBM, see [docs/ml-model.md](docs/ml-model.md)) or a safety rule (OSHA heat band, wildfire, wildlife, crew reports), whichever is higher, plus the lightning stop-work override. Reports are stored in the Tiger Data (TimescaleDB) database, and their photos in `backend/uploads/`. Alerts come from the alert engine (`backend/alerts/`) and the 6 PM briefings from `backend/briefing/` (written by Claude, then Gemini, then a template; see `CLAUDE.md`). Without `DATABASE_URL` the API still starts: `/health` and the report routes return 503, and everything else works.

### Hazard data sources

With `DATABASE_URL` set, the API polls these in the background (`HAZARD_POLLING_ENABLED=false` turns it off):

| Source | What | Every |
|---|---|---|
| Open-Meteo | heat index (NWS formula) + OSHA band, rain past 12/24/72 h and next 24 h, soil moisture | 60 min (`WEATHER_POLL_MINUTES`) |
| api.weather.gov | active NWS alerts at each site (heat, flood, severe storm, red flag) | 5 min |
| NASA FIRMS | VIIRS fire detections over Florida, last 24 h. **Needs `FIRMS_MAP_KEY`** (free at firms.modaps.eosdis.nasa.gov/api/map_key); skipped without it | 30 min |
| iNaturalist | alligator and venomous snake sightings within 5 km, last 30 days | 6 h |
| FEMA NFHL, USGS NHD, NWS points | flood zone, river within 1 mile, NWS zones | once per site |

A flood-risk alert opens when 2+ inches of rain fell in the past 12 hours at a site in a FEMA flood zone or near a river, or when NWS has a flood warning there. Set `NWS_CONTACT` in `.env` to a URL or email NWS can reach you at.

### Lightning (GOES-19 GLM)

With `DATABASE_URL` set, the API polls NOAA's public GOES-19 bucket every 20 s and stores flashes over Florida (+30 mi) in `lightning_flashes`. Set `LIGHTNING_INGEST_ENABLED=false` in `.env` to turn that off. `GET /lightning/recent?minutes=15` returns them for the map.

**Replay mode** plays a real storm back through the same pipeline with a simulated clock:

```bash
python -m scripts.find_replay_window      # samples Aug 2025 afternoons, downloads the stormiest hour to data/replay/ (~150 MB, gitignored)
curl -X POST localhost:8000/replay/start -H "X-Admin-Token: $ADMIN_TOKEN" -H "content-type: application/json" -d '{"speed": 30}'
curl localhost:8000/replay/status
curl -X POST localhost:8000/replay/stop -H "X-Admin-Token: $ADMIN_TOKEN"
```

Starting or stopping a replay needs the **demo code**: `ADMIN_TOKEN` from `backend/.env`, sent as the `X-Admin-Token` header (the frontend asks for it once and remembers it on that device). Without `ADMIN_TOKEN` set, those actions are off.

At 30x, one hour of lightning plays in 2 minutes, followed by 31 quiet simulated minutes so stop-work countdowns can clear. While it runs, every time-based route (sites, recent flashes) uses the simulated clock. Live lightning polling keeps running on real time, and `GET /alerts` returns real alerts alongside the replay's, each with `replay: true/false`, so a real stop-work never disappears during a demo. If ingestion can't keep up with the requested speed, the clock waits for it rather than running ahead.

**Stop-work alerts:** any flash within 10 miles of a site opens an alert that clears 30 minutes after the last strike. How it works: [`docs/alert-engine.md`](docs/alert-engine.md).

### Tests

```bash
cd backend
pip install -r requirements-dev.txt
python -m pytest -v      # needs DATABASE_URL; each test is rolled back
```

### Rebuilding the site list

`backend/data/sites.json` is generated from the EIA-860M monthly generator inventory and committed, so you only need this when you want fresher EIA data:

```bash
cd backend
pip install -r scripts/requirements.txt
python -m scripts.load_sites        # downloads the newest workbook to data/raw/ (gitignored)
```

## Frontend

```bash
cd frontend
npm install
cp .env.example .env.local      # NEXT_PUBLIC_API_URL=http://localhost:8000
npm run dev
```

Open http://localhost:3000 for the supervisor dashboard: a live map of every site with recent lightning, sites ranked by risk with stop-work countdowns, and a **⚡ Replay storm** button that plays the Aug 4, 2025 storm (after `python -m scripts.find_replay_window`). `/alerts` lists active alerts. The frontend never shows mock data when the backend is down: it says the server can't be reached and stop-work status is unknown. Sample data from `shared/mocks` is shown only if you click **Show demo data**, and is labeled "Demo data" everywhere.

Other commands: `npm run typecheck`, `npm run build`.

## Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/sites` | All sites with current hazard index and top hazard |
| GET | `/sites/{id}` | Conditions per hazard, today/tomorrow index, top factors |
| GET | `/sites/{id}/score-history` | Hazard index at every hourly scoring run, last 7 days (sparkline) |
| GET | `/model/info` | The hazard model: test metrics, baselines, training years, calibration (`/model/calibration.svg`) |
| GET | `/alerts` | Active alerts with all-clear countdown |
| GET | `/reports` | Crew hazard reports |
| POST | `/reports` | Create a hazard report |
| POST | `/uploads` | Upload a report photo (raw image body); returns `photo_url` |
| GET | `/briefing/{site_id}` | Latest next-day briefing (generated 6 PM site time) and key numbers |
| GET | `/briefings` | Latest briefing for every site in one response |
| POST | `/briefing/send-now` | Generate tomorrow's briefing now for one site (`{"site_id": "big-bend"}`, at most once a minute per site) or all (needs `X-Admin-Token`, at most once per 15 min) |
| GET | `/lightning/cells` | Storm cells from the last 20 min with motion (for the map) |
| GET | `/sites/{id}/beacon` | Tiny alarm state: stop / approaching / flood / clear, with countdowns |

Shapes: [`shared/types.ts`](shared/types.ts).

## Deploying

The API runs on a Vultr Ubuntu server (systemd, one uvicorn worker, Caddy for HTTPS) and the frontend on Vercel. Step by step, DNS records, health checks, restart and rollback: [`docs/deploy.md`](docs/deploy.md). Scripts: [`deploy/`](deploy/). Once the server runs, set `LIGHTNING_INGEST_ENABLED`, `HAZARD_POLLING_ENABLED` and `BRIEFING_ENABLED` to `false` in your local `backend/.env`.

## Contributing

Branch from `main` as `<name>/<topic>`, keep PRs small, and don't add libraries without asking. See `CLAUDE.md`.
