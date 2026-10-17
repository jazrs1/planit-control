#!/usr/bin/env bash
# Copy backend/.env and the lightning replay files to the server over scp, then restart the API.
# Run on your laptop from anywhere in the repo, after deploy/setup.sh has run on the server.
#
#   deploy/copy-to-server.sh root@SERVER_IP --cors https://planit.example.com,https://www.planit.example.com,https://planit-control.vercel.app
#
# Options:
#   --env FILE     env file to send (default: backend/.env). Your local file is never changed.
#   --cors LIST    CORS_ORIGINS for the server: comma-separated frontend origins (https://host, no path).
#                  Without it, the file's CORS_ORIGINS is kept and must contain an https:// origin.
#   --cors-regex RE  CORS_ORIGIN_REGEX for the server, e.g. Vercel previews:
#                  '^https://planit-control-[a-z0-9-]+\.vercel\.app$' (anchored with ^ and $). Without it,
#                  the file's CORS_ORIGIN_REGEX (if any) is kept.
#   --no-replay    don't copy backend/data/replay/
#   --uploads      also copy backend/uploads/ (report photos) into /var/lib/planit/uploads (existing files kept)
#
# The server's copy always gets LIGHTNING_INGEST_ENABLED, HAZARD_POLLING_ENABLED, BRIEFING_ENABLED and
# PUSH_ENABLED set to true: the server is the only machine that polls and sends notifications. Your laptop's .env sets them to false
# (docs/deploy.md, "Stop your laptop polling"). Secret values are never printed.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE=$ROOT/backend/.env
REPLAY_DIR=$ROOT/backend/data/replay
CORS=""
CORS_REGEX=""
REPLAY=1
UPLOADS=0
REMOTE=""

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --env) ENV_FILE=${2:?--env needs a file}; shift 2 ;;
    --cors) CORS=${2:?--cors needs a list}; shift 2 ;;
    --cors-regex) CORS_REGEX=${2:?--cors-regex needs a pattern}; shift 2 ;;
    --no-replay) REPLAY=0; shift ;;
    --uploads) UPLOADS=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) fail "unknown option $1" ;;
    *) [[ -z $REMOTE ]] || fail "one server only"; REMOTE=$1; shift ;;
  esac
done
[[ -n $REMOTE ]] || fail "usage: deploy/copy-to-server.sh root@SERVER_IP [--cors ORIGINS] [--env FILE] [--no-replay] [--uploads]"
[[ -f $ENV_FILE ]] || fail "no env file at $ENV_FILE"

# Value of KEY in the env file (last one wins, quotes stripped). Only used for checks, never printed.
value_of() {
  { grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$ENV_FILE" || true; } | tail -n 1 | cut -d= -f2- \
    | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# ---- checks (names only) ----
[[ -n $(value_of DATABASE_URL) ]] || fail "DATABASE_URL is empty in $ENV_FILE"
[[ -n $CORS ]] || CORS=$(value_of CORS_ORIGINS)
CORS=$(printf '%s' "$CORS" | tr -d '[:space:]')
https_origins=0
clean=""
IFS=',' read -r -a origins <<<"$CORS"
for o in "${origins[@]}"; do
  o=${o%/}
  [[ -z $o ]] && continue
  [[ $o =~ ^https?://[^/]+$ ]] || fail "CORS origin '$o' must be scheme + host only, like https://planit.example.com"
  [[ $o == https://* ]] && https_origins=$((https_origins + 1))
  clean=${clean:+$clean,}$o
done
CORS=$clean
(( https_origins > 0 )) || fail "CORS_ORIGINS has no https:// origin. Pass --cors https://<your-domain>,https://<project>.vercel.app"
[[ -n $CORS_REGEX ]] || CORS_REGEX=$(value_of CORS_ORIGIN_REGEX)
if [[ -n $CORS_REGEX ]]; then
  # Unanchored, "vercel\.app" would also match https://vercel.app.evil.com.
  [[ $CORS_REGEX == '^https://'* && $CORS_REGEX == *'$' ]] \
    || fail "--cors-regex must start with ^https:// and end with \$ (got '$CORS_REGEX')"
  python3 -c 'import re,sys; re.compile(sys.argv[1])' "$CORS_REGEX" 2>/dev/null || fail "--cors-regex isn't a valid regex"
fi
[[ -n $(value_of FIRMS_MAP_KEY) ]] || warn "FIRMS_MAP_KEY is empty: no wildfire data"
[[ -n $(value_of ANTHROPIC_API_KEY)$(value_of GEMINI_API_KEY) ]] || warn "no ANTHROPIC_API_KEY or GEMINI_API_KEY: briefings use the template"
[[ -n $(value_of VAPID_PRIVATE_KEY) && -n $(value_of VAPID_PUBLIC_KEY) ]] \
  || warn "no VAPID keys: push notifications are off (cd backend && python -m scripts.generate_vapid_keys)"
if (( REPLAY )); then
  ls "$REPLAY_DIR"/*/*.nc >/dev/null 2>&1 || fail "no replay files in $REPLAY_DIR (use --no-replay to skip, or run python -m scripts.find_replay_window)"
fi

# ---- the server's copy of .env ----
umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
{ grep -vE '^[[:space:]]*(export[[:space:]]+)?(LIGHTNING_INGEST_ENABLED|HAZARD_POLLING_ENABLED|BRIEFING_ENABLED|PUSH_ENABLED|UPLOADS_DIR|CORS_ORIGINS|CORS_ORIGIN_REGEX)=' "$ENV_FILE" || true; } > "$tmp/env"
cat >> "$tmp/env" <<EOF

# ---- set by deploy/copy-to-server.sh: the server is the only machine that polls ----
LIGHTNING_INGEST_ENABLED=true
HAZARD_POLLING_ENABLED=true
BRIEFING_ENABLED=true
PUSH_ENABLED=true
CORS_ORIGINS=$CORS
CORS_ORIGIN_REGEX=$CORS_REGEX
EOF

echo "Server: $REMOTE"
echo "Env file: $ENV_FILE (pollers forced on; CORS_ORIGINS=$CORS; CORS_ORIGIN_REGEX=${CORS_REGEX:-none})"
ssh "$REMOTE" 'test -d /opt/planit/app/backend' || fail "no /opt/planit/app on the server: run deploy/setup.sh there first"
ssh "$REMOTE" 'rm -rf /root/planit-upload && install -d -m 700 /root/planit-upload'

echo "Copying .env"
scp -q "$tmp/env" "$REMOTE:/root/planit-upload/env"
if (( REPLAY )); then
  echo "Copying replay files ($(du -sh "$REPLAY_DIR" | cut -f1); a few minutes on a slow uplink)"
  scp -rq "$REPLAY_DIR" "$REMOTE:/root/planit-upload/replay"
fi
if (( UPLOADS )) && [[ -d $ROOT/backend/uploads ]]; then
  echo "Copying report photos"
  scp -rq "$ROOT/backend/uploads" "$REMOTE:/root/planit-upload/uploads"
fi

echo "Installing on the server and restarting planit-api"
ssh "$REMOTE" bash -s <<'EOF'
set -euo pipefail
U=/root/planit-upload
APP=/opt/planit/app/backend
install -o planit -g planit -m 600 "$U/env" "$APP/.env"
if [ -d "$U/replay" ]; then
  install -d -o planit -g planit "$APP/data" "$APP/data/replay"
  cp -R "$U/replay/." "$APP/data/replay/"
  chown -R planit:planit "$APP/data/replay"
  echo "Replay windows: $(ls "$APP/data/replay" | tr '\n' ' ')"
fi
if [ -d "$U/uploads" ]; then
  # Keep existing photos. Not `cp -n`: on Ubuntu 24.04 (coreutils 9.4) it exits 1 when it skips a file.
  for f in "$U/uploads"/*; do
    [ -e "$f" ] || continue
    [ -e "/var/lib/planit/uploads/${f##*/}" ] || cp -R "$f" /var/lib/planit/uploads/
  done
  chown -R planit:planit /var/lib/planit/uploads
fi
rm -rf "$U"
systemctl restart planit-api
for _ in $(seq 1 30); do
  if body=$(curl -fsS localhost:8000/health 2>/dev/null); then echo "Healthy: $body"; exit 0; fi
  sleep 2
done
echo "Not healthy after 60 s. Last log lines:"
journalctl -u planit-api -n 40 --no-pager
exit 1
EOF
