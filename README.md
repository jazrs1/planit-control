# PlanIT Control

**Live: [stormsafecrews.us](https://stormsafecrews.us)** · API docs: [api.stormsafecrews.us/docs](https://api.stormsafecrews.us/docs) · Built for the Sperry Tech challenge at SwampHacks XII.

Utility crews decide every morning whether a site is safe to work, but the data behind that call (lightning, heat, flood warnings, fires, alligator sightings) is scattered across agencies and apps. PlanIT Control puts it on one screen for **55 real Florida power plants** (EIA-860M): live hazard cards, a lightning stop-work countdown, a 0–10 hazard index for today and tomorrow, and a go / caution / no-go briefing every evening. When the data is missing, it says "unknown", never "all clear".

## Features

- **Lightning stop-work.** A GOES-19 satellite flash within 10 miles of a site stops work. All clear is 30 minutes after the latest strike, and every new strike resets the countdown.
- **Lightning approaching.** Storm cells are tracked and projected; a site gets a heads-up when a cell is expected to reach its 10-mile ring within the hour.
- **Hazard index (0–10)** for today and tomorrow: the higher of a LightGBM weather model and safety rules (OSHA heat band, wildfire, wildlife, crew reports), with floors from NWS warnings and stop-works. Green below 4, amber 4 to below 7, red 7 and up.
- **Hazard cards** per site: heat, lightning, flooding, soil, wildfire and wildlife.
- **Crew reports:** a photo pinned to the map, which raises the matching hazard for nearby sites.
- **6 PM briefing** in each site's own timezone. The verdict is decided in code; Claude writes the text, every number is checked against the input data, and Gemini or a template takes over if a draft fails.
- **Push notifications** for stop-work, approaching lightning, all clear, flood alerts and briefings.
- **Hardware beacon:** an Arduino with red / yellow / green lights, a buzzer and an LCD countdown ([`hardware/`](hardware/README.md)).
- **Replay mode** plays the real storm of Aug 4, 2025 through the live pipeline on a simulated clock. Replay alerts are labeled REPLAY and never mix with real ones.

## Architecture

```
GOES-19 GLM (every 20 s) ──► lightning ingest ──► stop-work engine ──► alerts, push, beacon
Open-Meteo, NWS, FEMA, USGS, FIRMS, iNaturalist ──► hazard pollers ──► hourly hazard index (ML + rules)
                                                                    └─► 6 PM briefings (Claude → Gemini → template)
Tiger Data (TimescaleDB) ◄──► FastAPI on Vultr (Caddy, HTTPS) ◄──► Next.js on Vercel, Arduino beacon
```

- `backend/`: Python 3.11, FastAPI. Lightning in `lightning/`, stop-work engine in `alerts/`, hazard sources in `hazards/`, model in `ml/`, briefings in `briefing/`, push in `push/`.
- `frontend/`: Next.js (App Router), TypeScript, Tailwind, MapLibre GL.
- `shared/types.ts`: the API contract both sides use; `shared/mocks/` has sample JSON for every endpoint.
- `hardware/`: the beacon sketch and a USB bridge that polls `GET /sites/{id}/beacon`.

How the pieces work: [alert engine](docs/alert-engine.md), [lightning forecast](docs/lightning-forecast.md), [hazard model](docs/ml-model.md), [push](docs/push-notifications.md), [replay timeline](docs/replay-timeline.md), [deployment](docs/deploy.md).

## Data sources

| Source | Used for |
|---|---|
| [EIA-860M](https://www.eia.gov/electricity/data/eia860m/) | The 55 sites and the Florida thermal plants filtered out of fire detections |
| NOAA GOES-19 GLM (public AWS bucket) | Lightning flashes, live and replay |
| [Open-Meteo](https://open-meteo.com/) | Heat index, rain, soil moisture |
| [api.weather.gov](https://www.weather.gov/documentation/services-web-api) | NWS alerts and the gridpoint rain forecast the briefing cross-checks |
| FEMA NFHL, USGS NHD | Flood zones and rivers within a mile of each site |
| [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) (VIIRS) | Fire detections, last 24 h |
| [iNaturalist](https://www.inaturalist.org/) | Alligator and venomous snake sightings within 5 km, last 30 days |
| NOAA HRRR archive, NOAA Storm Events | Training and testing the hazard model (2022–2025) |

## Honest limits

- The hazard index predicts hazardous weather, not injuries. On 2025 it beat both baselines, but 58% of logged events still fell on green days: many Florida storms form with little warning, so the lightning engine and NWS warnings are what protect the crew.
- The lightning forecast was tested on one storm, which we also tuned on. It misses storms that form overhead, and its arrival estimates run late, so the app never shows an arrival countdown.
- Satellite lightning positions are accurate to about 8–14 km, and the 10-mile radius has no extra margin yet.
- Rainfall is a model estimate. Fire detection depends on a few satellite passes a day and ignores anything within 1 km of a site or a Florida thermal plant, so a real fire there would be missed.
- If the lightning feed stalls, the beacon switches to "unknown" after 2 minutes, but the website doesn't yet say lightning data is delayed.
- PlanIT supports a supervisor's judgment; it doesn't replace it.

Numbers and details: [`docs/devpost.md`](docs/devpost.md) and [`docs/ml-model.md`](docs/ml-model.md).

## Team

John Azer, William Lin, Abid Panahie.

## Running locally

Needs Python 3.11, Node.js 20.9+, and the OpenMP runtime for LightGBM (`brew install libomp` on macOS, `sudo apt-get install libgomp1` on Debian/Ubuntu).

**Backend** (http://localhost:8000, API docs at `/docs`):

```bash
cd backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # fill in the keys you have; each one is explained in the file
python -m scripts.migrate       # create/upgrade the database schema (needs DATABASE_URL)
python -m scripts.seed_sites    # load the 55 sites into the database
uvicorn app.main:app --reload --port 8000
```

Without `DATABASE_URL` the API still starts and serves placeholder hazard data; `/health` and the report routes return 503. Missing API keys turn off only their own feature (no `FIRMS_MAP_KEY`: no fires; no `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`: template briefings). If your machine shares a database with a running server, set `LIGHTNING_INGEST_ENABLED`, `HAZARD_POLLING_ENABLED`, `BRIEFING_ENABLED` and `PUSH_ENABLED` to `false` so only the server polls.

**Frontend** (http://localhost:3000):

```bash
cd frontend
npm install
cp .env.example .env.local      # NEXT_PUBLIC_API_URL=http://localhost:8000
npm run dev
```

If the backend is unreachable, the frontend says so instead of showing sample data. **Show demo data** switches to the labeled sample data in `shared/mocks/`.

**Replay a storm** (needs `DATABASE_URL` and `ADMIN_TOKEN`, the "demo code" the frontend asks for):

```bash
cd backend
python -m scripts.find_replay_window      # finds the stormiest August 2025 afternoon, downloads it to data/replay/ (~150 MB)
curl -X POST localhost:8000/replay/start -H "X-Admin-Token: $ADMIN_TOKEN" -H "content-type: application/json" -d '{"speed": 30}'
```

Or press **Replay storm** on the dashboard.

**Tests:** `cd backend && pip install -r requirements-dev.txt && python -m pytest` (database tests need `DATABASE_URL` and roll back), and `cd frontend && npm run typecheck`.

Project rules and conventions for contributors: [`CLAUDE.md`](CLAUDE.md).
