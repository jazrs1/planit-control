# Deploying PlanIT Control

The backend runs on one Vultr Ubuntu server behind Caddy (automatic HTTPS) at `https://api.<domain>`. The frontend runs on Vercel at `https://<domain>`. Both machines use the same Tiger Data database. Scripts are in [`deploy/`](../deploy/).

Below, `planit.example.com` stands for your domain and `203.0.113.10` for the server's IP.

| Piece | Where | How it runs |
|---|---|---|
| API | Vultr, `/opt/planit/app` (a git checkout) | `planit-api` systemd service: uvicorn with **one worker** on 127.0.0.1:8000, restarts on crash and boot |
| HTTPS | Vultr, Caddy | `https://api.planit.example.com` → 127.0.0.1:8000, certificate from Let's Encrypt, renewed automatically |
| Report photos | Vultr, `/var/lib/planit/uploads` | outside the checkout, so deploys and rollbacks never touch them |
| Replay storm | Vultr, `/opt/planit/app/backend/data/replay/` | copied from your laptop (gitignored) |
| Frontend | Vercel | `frontend/`, built with `npm run build` |
| Database | Tiger Data | unchanged |

**Why one worker:** the API cache, the replay clock and every background poller (lightning every 20 s, hazards, 6 PM briefings) live inside the process. Two workers would poll twice, and each would have its own replay clock and cache. Don't add `--workers` or run a second copy.

## What you do by hand

1. **Buy the domain** at any registrar.
2. **Create the server** on Vultr (*Deploy → Cloud Compute*):
   - **OS:** Ubuntu **24.04** LTS x64.
   - **Size:** 2 GB RAM or more. With 1 GB, `setup.sh` adds swap, but replay parsing and LightGBM are tight.
   - **Region:** near the Tiger database, e.g. New Jersey for AWS us-east-1.
   - **SSH key:** add yours.
   - **Vultr firewall group:** if you attach one, allow TCP 22, 80, 443 and UDP 443. The server also runs its own firewall (`ufw`).
3. **Set DNS** (next section). Do this first so it has time to propagate.
4. **Tiger Data allow list:** if your Tiger service restricts IPs, add the server's IP.
5. **Vercel project** (step 6 below).

## DNS records

Create these at your registrar's DNS settings (or wherever the domain's nameservers point):

| Type | Name | Value | For |
|---|---|---|---|
| A | `@` (planit.example.com) | `76.76.21.21` | Vercel |
| CNAME | `www` | `cname.vercel-dns.com` | Vercel |
| A | `api` | `203.0.113.10` (the Vultr IPv4) | the API |
| AAAA | `api` | the Vultr IPv6 | optional; only if IPv6 is enabled on the server |

- **TTL:** use 300 seconds so mistakes are quick to fix.
- **Vercel's values:** Vercel shows the exact records under *Project → Settings → Domains* after you add the domain. If they differ from the table, use Vercel's.
- **CAA records:** if the domain has any, add `0 issue "letsencrypt.org"`, or Caddy can't get a certificate.

Check the API record before running setup (it should print the Vultr IP):

```bash
dig +short api.planit.example.com
```

## Step by step

### 1. Set up the server (about 10 minutes)

The server needs a branch that has `deploy/`. Use `main` once this PR is merged; until then pass `deploy-prep`.

```bash
# from the repo root on your laptop
scp deploy/setup.sh root@203.0.113.10:/root/
ssh -t root@203.0.113.10 bash /root/setup.sh api.planit.example.com main
```

`setup.sh` is safe to rerun. It:

1. Installs:
   - git;
   - Python 3.11 (from the deadsnakes PPA: Ubuntu 24.04 ships 3.12, and our pins need 3.11);
   - `libgomp1`, which LightGBM needs on Linux;
   - Caddy, from Caddy's official apt repository;
   - `ufw`, allowing SSH, 80 and 443.
2. Adds 2 GB of swap on small servers.
3. Creates a `planit` system user and a read-only **GitHub deploy key**. The repo is private, so it prints the public key and waits:
   - Open https://github.com/jazrs1/planit-control/settings/keys/new.
   - Paste the key and leave **Allow write access** off.
   - Press Enter.
4. Clones the repo to `/opt/planit/app`, creates the venv in `/opt/planit/venv`, and installs `backend/requirements.txt`.
5. Installs `planit-api.service` and a journald size cap (500 MB, 30 days), and writes `/etc/caddy/Caddyfile` for `api.planit.example.com`.

The API doesn't start until `.env` is there (next step). Caddy gets the certificate on its own once DNS points at the server. If DNS wasn't ready, rerun `systemctl restart caddy` after it is.

### 2. Database migrations (only if new ones merged)

Migrations are applied by hand, once, because the laptop and the server share one database. To apply any pending ones from the server:

```bash
ssh root@203.0.113.10 'cd /opt/planit/app/backend && sudo -u planit -H /opt/planit/venv/bin/python -m scripts.migrate'
```

`scripts.migrate` prints `Up to date` when there is nothing to do. You can do this after step 3 too, since it needs `.env`.

### 3. Copy `.env` and the replay files (about 5 minutes)

```bash
deploy/copy-to-server.sh root@203.0.113.10 \
  --cors https://planit.example.com,https://www.planit.example.com,https://planit-control.vercel.app
```

- **What gets copied:**
  - your `backend/.env`, to `/opt/planit/app/backend/.env`, owned by `planit` with mode 600;
  - `backend/data/replay/` (about 150 MB);
  - with `--uploads`, the report photos in `backend/uploads/`.
- **After copying**, it restarts the API and waits for `/health`.
- **Your local `.env` is never changed.** In the server's copy, the script:
  - forces `LIGHTNING_INGEST_ENABLED`, `HAZARD_POLLING_ENABLED` and `BRIEFING_ENABLED` to `true`, since the server is the only machine that polls;
  - sets `CORS_ORIGINS` to the `--cors` list.

  So the same command still works after you turn your laptop's flags off.
- **Checks before copying:**
  - It refuses to copy if `DATABASE_URL` is empty or there's no `https://` CORS origin.
  - It warns if `FIRMS_MAP_KEY` is empty, or if there's neither `ANTHROPIC_API_KEY` nor `GEMINI_API_KEY`.
  - It never prints secret values.
- **To change one value later,** edit `backend/.env` on your laptop and rerun the command. Add `--no-replay` to skip the 150 MB. To edit the server's copy directly instead:

  ```bash
  ssh root@203.0.113.10 'nano /opt/planit/app/backend/.env && systemctl restart planit-api'
  ```

Put the exact Vercel production domain (`<project>.vercel.app`) in `--cors`. Preview deployments get a new URL each time. To allow them too, add one line to the server's `.env`:

```bash
CORS_ORIGIN_REGEX=^https://planit-control-[a-z0-9-]+\.vercel\.app$
```

Match the pattern to one of your real preview URLs (they include the project and team names), and keep it anchored (`^…$`) so other sites can't match.

### 4. Stop your laptop polling (do this right after step 3)

Once the server is healthy, **your laptop must stop polling and ingesting**. Otherwise both machines write the same rows to the shared database, both spend the same API quotas, and both write the 6 PM briefings. Set these in your laptop's `backend/.env` (and in any teammate's that has the shared `DATABASE_URL`), then restart or stop the local backend:

```bash
LIGHTNING_INGEST_ENABLED=false   # GOES-19 lightning, every 20 s, and the stop-work alert engine that runs with it
HAZARD_POLLING_ENABLED=false     # Open-Meteo weather, NWS alerts, FIRMS fires, iNaturalist, FEMA/river lookups, flood alerts, hazard scores
BRIEFING_ENABLED=false           # the 6 PM briefings (Claude / Gemini)
```

These three cover every background job (`backend/app/main.py`, `lifespan`).

**Why it matters:**
- Lightning rows are deduplicated, so a few minutes of overlap does no harm. Two stop-work engines running at once, though, would both open, extend and close the same alerts.
- The NASA FIRMS key, the Gemini free-tier quota and Anthropic billing are per key, so two machines spend them twice.
- Open-Meteo's free limit is per IP, so once the laptop stops, it has its full 10,000 calls/day for the ML retrain.

**Don't leave a gap of more than 3 minutes** between the server starting and the laptop stopping. A gap that long would miss lightning: live polling looks back 3 minutes.

**To check the laptop is off:** start it with `uvicorn app.main:app --port 8000`. The startup log must **not** contain these lines:
- `GLM live ingestion started`
- `Hazard source`
- `Briefings generated`

The server's log (`journalctl -u planit-api`) should contain the first two.

**While your laptop shares the database, don't:**
- press **Replay storm** or call `POST /replay/start` against a local backend. Replay start deletes all replay alerts in the shared database, which would wipe a replay running on the server.
- call `POST /briefing/send-now` locally. It writes real briefings.

**For frontend work,** the simplest setup is to skip the local backend and point it at the server: set `NEXT_PUBLIC_API_URL=https://api.planit.example.com` in `frontend/.env.local`, and add `http://localhost:3000` to the server's CORS list, e.g. `--cors https://planit.example.com,...,http://localhost:3000`.

### 5. Check the API

```bash
deploy/check.sh https://api.planit.example.com https://planit.example.com https://planit-control.vercel.app
```

| Check | Healthy |
|---|---|
| `/health` | `{"status":"ok","database":"ok"}` (503 means the database is unreachable: check `DATABASE_URL` and the Tiger allow list) |
| `/sites` | 55 sites |
| Hazard cards' `as_of` | minutes old once the pollers have run. Weather is hourly; FIRMS every 30 min; a fresh server needs a few minutes |
| `/alerts`, `/replay/status` | respond (`not running` unless a replay is on) |
| CORS | `ok` for each origin you list; `FAIL` means it's missing from `CORS_ORIGINS` |

The same checks by hand:

```bash
curl -s https://api.planit.example.com/health
open https://api.planit.example.com/docs          # interactive API docs
ssh root@203.0.113.10 'systemctl status planit-api --no-pager; journalctl -u planit-api -n 50 --no-pager'
```

A healthy server log shows, within a minute:
- `GLM live ingestion started (every 20 s)`;
- `Hazard source open-meteo: …` and `Hazard source nws-alerts: …`;
- the hourly weather poll after that.

### 6. Frontend on Vercel (about 5 minutes)

*Add New → Project → Import* `jazrs1/planit-control`, then:

| Setting | Value |
|---|---|
| Framework preset | Next.js |
| **Root Directory** | `frontend` |
| Include files outside the root directory in the Build Step | **On** (the default; the app imports `../shared` for types and demo data) |
| Install command | `npm ci` (default) |
| **Build command** | `npm run build` (default) |
| Output directory | default (`.next`) |
| Node.js version | 22.x (Next 16 needs 20.9+) |
| **Environment variable** | `NEXT_PUBLIC_API_URL` = `https://api.planit.example.com` (Production and Preview; no trailing slash) |

Then:
1. Deploy.
2. Add `planit.example.com` and `www.planit.example.com` under *Settings → Domains*, using the DNS records from earlier.
3. Make sure the production `*.vercel.app` domain and your domain are both in the server's `CORS_ORIGINS` (step 3).

`NEXT_PUBLIC_API_URL` is baked in at build time. After changing it, **redeploy** (*Deployments → … → Redeploy*); saving the variable alone doesn't change the live site.

The API must be HTTPS: browsers block an `https://` page from calling an `http://` API. Report photo URLs come out as `https://api.planit.example.com/uploads/...` because uvicorn trusts Caddy's `X-Forwarded-Proto` header (`--proxy-headers`).

### 7. Smoke test in the browser

1. Open `https://planit.example.com`. The dashboard should load without "Can't reach the server".
2. Open the browser console and check there are no CORS errors.
3. Click **Replay storm**. Stop-work countdowns should appear within seconds.
4. Submit a crew report with a photo, and check the photo loads.

## Restart, deploy, roll back

On the server, as root:

```bash
systemctl restart planit-api               # restart the API (pollers resume; any running replay stops)
systemctl status planit-api --no-pager     # running? since when?
journalctl -u planit-api -f                # follow the app log
journalctl -u planit-api --since "1 hour ago" | grep -i -E "error|failed|warning"
tail -f /var/log/caddy/planit-api.log      # HTTP requests (JSON lines)
systemctl reload caddy                     # after editing /etc/caddy/Caddyfile
```

**Deploy new code** (fetch, check out, install requirements, restart, wait for `/health`):

```bash
/opt/planit/app/deploy/update.sh                  # latest main
/opt/planit/app/deploy/update.sh some-branch      # a branch, tag or commit
/opt/planit/app/deploy/update.sh main --migrate   # also apply new migrations first
```

**Roll back** to the commit that ran before the last update:

```bash
/opt/planit/app/deploy/update.sh --rollback
cat /opt/planit/deploys.log                       # every deploy: time, from -> to
/opt/planit/app/deploy/update.sh <commit-sha>     # or go to any commit
```

**What a rollback doesn't undo:**
- **Migrations.** Ours so far only add tables and columns, so older code runs fine on a newer schema.
- **`.env`, report photos, replay files.** They aren't part of the checkout.

Running `--rollback` twice goes back to the newer commit, since the rollback itself is the last deploy.

**Changes to `deploy/` files:**
- `update.sh` reinstalls the systemd unit if it changed.
- For a changed `Caddyfile` or package list, rerun `setup.sh` (safe; it leaves the checkout alone).

## Every `.env` variable

`backend/app/config.py` reads all of these. "Server" is what the server's `backend/.env` needs; "Laptop" is what yours should say after the cutover.

| Variable | Server | Laptop | Notes |
|---|---|---|---|
| `DATABASE_URL` | **required** | same | The shared Tiger database. Never print or paste it. |
| `ANTHROPIC_API_KEY` | recommended | keep or empty | Claude writes the briefings; skipped without a key. |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | — | |
| `GEMINI_API_KEY` | recommended | keep or empty | Fallback briefing writer (free tier, per key). |
| `GEMINI_MODEL` | `gemini-3.8-flash` | — | |
| `GEMINI_MIN_INTERVAL_SECONDS` | default `4` | — | Not in `.env.example`; spacing between Gemini calls. |
| `BRIEFING_CONCURRENCY` | `4` | — | |
| `FIRMS_MAP_KEY` | **required for fires** | keep | No wildfire data without it. |
| `CORS_ORIGINS` | **your domain(s) + `<project>.vercel.app`**, comma-separated, `https://`, no path | `http://localhost:3000` | Set by `copy-to-server.sh --cors`. Trailing slashes are ignored. |
| `CORS_ORIGIN_REGEX` | optional | empty | Vercel preview URLs, anchored regex. |
| `LIGHTNING_INGEST_ENABLED` | `true` (forced by the copy script) | **`false`** | GOES-19 polling and the stop-work engine. |
| `LIGHTNING_POLL_SECONDS` | `20` | — | |
| `HAZARD_POLLING_ENABLED` | `true` (forced) | **`false`** | Weather, NWS, FIRMS, iNaturalist, FEMA/river, flood alerts, hazard scores. |
| `WEATHER_POLL_MINUTES` | `60` | — | Open-Meteo budget assumes hourly. |
| `NWS_CONTACT` | repo URL (default) | — | Sent in the User-Agent; NWS requires one. |
| `API_CACHE_SECONDS` | `2.5` | — | |
| `BRIEFING_ENABLED` | `true` (forced) | **`false`** | 6 PM briefings. |
| `BRIEFING_HOUR` | `18` | — | Site-local hour. |
| `UPLOADS_DIR` | set by the systemd unit to `/var/lib/planit/uploads` (overrides `.env`) | empty (`backend/uploads`) | |
| `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` | not used yet | — | Read by config, used by no route. |

## Known gaps

- **The write endpoints are open to the internet.** `POST /replay/start` and `/replay/stop`, `POST /briefing/send-now`, `POST /reports` and `POST /uploads` have no authentication. The worst cases:
  - Anyone who finds the API can start a replay, which pauses live lightning ingestion and switches the server to simulated time until it ends.
  - They can trigger paid Claude briefing calls.

  The frontend's Replay button calls the first endpoint from the browser, so it can't simply be blocked at Caddy without breaking the demo. Fine for judging. Add authentication before real crews depend on it.
- **One server, no failover.** If the box goes down, the API is down until it's back (systemd restarts the process on crashes and on boot).
- **Report photos and the replay are only on the server's disk.** Vultr's automatic backups (an add-on) would cover `/var/lib/planit/uploads`.
- **Photo URLs are stored as full URLs.** Reports made against `localhost` keep their `http://localhost:8000/...` photo links.
