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

## Backend

```bash
cd backend
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # fill in keys; mock routes run without them
uvicorn app.main:app --reload --port 8000
```

- API: http://localhost:8000
- Interactive docs: http://localhost:8000/docs
- Health check: `curl localhost:8000/health`

Every route currently returns data from `shared/mocks/`. `POST /reports` keeps new reports in memory until restart.

## Frontend

```bash
cd frontend
npm install
cp .env.example .env.local      # NEXT_PUBLIC_API_URL=http://localhost:8000
npm run dev
```

Open http://localhost:3000. The home page lists every site, highest risk first, using `components/SiteCard.tsx`. If the backend isn't running, the frontend falls back to `shared/mocks` and logs a warning in the terminal.

Other commands: `npm run typecheck`, `npm run build`.

## Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/sites` | All sites with current hazard index and top hazard |
| GET | `/sites/{id}` | Conditions per hazard, today/tomorrow index, top factors |
| GET | `/alerts` | Active alerts with all-clear countdown |
| GET | `/reports` | Crew hazard reports |
| POST | `/reports` | Create a hazard report |
| GET | `/briefing/{site_id}` | Next-day briefing text and key numbers |

Shapes: [`shared/types.ts`](shared/types.ts).

## Contributing

Branch from `main` as `<name>/<topic>`, keep PRs small, and don't add libraries without asking. See `CLAUDE.md`.
