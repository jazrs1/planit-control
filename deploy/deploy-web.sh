#!/usr/bin/env bash
# Build and serve the frontend on this server, the standby for Vercel. Run ON the server as root.
#
#   /opt/planit/app/deploy/deploy-web.sh               # build latest main, restart planit-web
#   /opt/planit/app/deploy/deploy-web.sh some-branch   # a branch, tag or commit
#   /opt/planit/app/deploy/deploy-web.sh --rollback    # back to the build that ran before the last deploy
#   /opt/planit/app/deploy/deploy-web.sh --caddy-on    # serve stormsafecrews.us from here (after the DNS switch)
#   /opt/planit/app/deploy/deploy-web.sh --caddy-off   # stop serving it (before switching DNS back to Vercel)
#
# The source (frontend/ and shared/) is exported with git archive from the API checkout's repository after a
# fetch, so the API's checked-out commit never moves. Each build goes in a new folder under
# /opt/planit-web/releases and the planit-web service runs /opt/planit-web/current (the last 3 are kept).
# Deploys are logged in /opt/planit-web/deploys.log. One-time setup: deploy/setup-web.sh. Docs: docs/deploy.md.
set -euo pipefail

API_URL=https://api.stormsafecrews.us   # baked into the build (NEXT_PUBLIC_API_URL), as on Vercel
SRC=/opt/planit/app
WEB=/opt/planit-web
RELEASES=$WEB/releases
LOG=$WEB/deploys.log
KEEP=3
NODE_BIN=/opt/node/bin
CADDYFILE=/etc/caddy/Caddyfile
SITE=/etc/caddy/web.caddy
IMPORT="import $SITE"
REF=main
MODE=deploy

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
as_src() { sudo -u planit -H "$@"; }
as_web() { sudo -u planit-web -H env PATH="$NODE_BIN:/usr/bin:/bin" NEXT_TELEMETRY_DISABLED=1 "$@"; }

for arg in "$@"; do
  case $arg in
    --rollback) MODE=rollback ;;
    --caddy-on) MODE=caddy-on ;;
    --caddy-off) MODE=caddy-off ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    -*) fail "unknown option $arg" ;;
    *) REF=$arg ;;
  esac
done
[[ $EUID -eq 0 ]] || fail "run as root"

# Add or remove the one import line in the API's Caddyfile; validate before reloading, keep a backup.
caddy_set() {
  local tmp
  tmp=$(mktemp)
  grep -vxF "$IMPORT" "$CADDYFILE" > "$tmp" || true
  if [[ $1 == on ]]; then
    [[ -f $SITE ]] || fail "$SITE is missing: run deploy/setup-web.sh"
    printf '%s\n' "$IMPORT" >> "$tmp"
  fi
  if cmp -s "$tmp" "$CADDYFILE"; then
    echo "Caddy already $1"; rm -f "$tmp"; return
  fi
  chmod 644 "$tmp"   # validated as the caddy user, so any log file it opens stays writable by Caddy
  sudo -u caddy caddy validate --adapter caddyfile --config "$tmp" >/dev/null 2>"$tmp.err" \
    || { cat "$tmp.err" >&2; rm -f "$tmp" "$tmp.err"; fail "the new Caddyfile doesn't validate; nothing changed"; }
  cp -p "$CADDYFILE" "$CADDYFILE.before-web-$1"
  install -m 644 "$tmp" "$CADDYFILE"
  rm -f "$tmp" "$tmp.err"
  systemctl reload caddy
  echo "Caddy $1 (previous Caddyfile: $CADDYFILE.before-web-$1)"
  if [[ $1 == on ]]; then
    echo "Caddy now gets certificates for stormsafecrews.us and www (needs DNS pointing here). Check with:"
    echo "  curl -sI https://stormsafecrews.us | head -1; journalctl -u caddy --since '5 min ago' | grep -i -E 'certificate|error'"
  fi
}

# Point current at a release, restart, wait until it answers.
switch_to() {
  local rel=$1 why=$2 prev
  prev=none
  [[ -L $WEB/current ]] && prev=$(readlink -f "$WEB/current")
  ln -sfn "$rel" "$WEB/current.new"
  chown -h planit-web:planit-web "$WEB/current.new"
  mv -T "$WEB/current.new" "$WEB/current"
  echo "$(date -u +%FT%TZ) $prev -> $rel ($why)" >> "$LOG"
  chown planit-web:planit-web "$LOG"
  systemctl restart planit-web
  for _ in $(seq 1 30); do
    if code=$(curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ 2>/dev/null); then
      echo "Serving $(basename "$rel") on 127.0.0.1:3000 (HTTP $code)"
      return
    fi
    sleep 1
  done
  echo "Not answering after 30 s. Last log lines:"
  journalctl -u planit-web -n 40 --no-pager
  echo "Roll back with: $SRC/deploy/deploy-web.sh --rollback"
  exit 1
}

case $MODE in
  caddy-on) caddy_set on; exit 0 ;;
  caddy-off) caddy_set off; exit 0 ;;
  rollback)
    [[ -s $LOG ]] || fail "no web deploys logged yet"
    target=$(tail -n 1 "$LOG" | awk '{print $2}')
    [[ -d $target && $target == "$RELEASES"/* ]] || fail "the last deploy has no previous build to go back to (see $LOG)"
    echo "Rolling back to $(basename "$target")"
    switch_to "$target" rollback
    exit 0 ;;
esac

[[ -x $NODE_BIN/node ]] || fail "Node isn't installed: run deploy/setup-web.sh first"
as_src git -C "$SRC" fetch -q --prune --tags origin
sha=$(as_src git -C "$SRC" rev-parse --verify -q "origin/$REF^{commit}" \
      || as_src git -C "$SRC" rev-parse --verify -q "$REF^{commit}") || fail "unknown ref $REF"
rel=$RELEASES/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:12}
echo "Building $REF: $(as_src git -C "$SRC" log -1 --format='%h %s' "$sha")"

as_web mkdir -p "$rel"
trap 'rm -rf "$rel"; echo "Build failed; nothing changed (the old build is still serving)." >&2' ERR
as_src git -C "$SRC" archive "$sha" frontend shared | as_web tar -x -C "$rel"
echo "$sha" | as_web tee "$rel/REVISION" >/dev/null
cd "$rel/frontend"
as_web npm ci --no-audit --no-fund --loglevel=error
as_web env NEXT_PUBLIC_API_URL="$API_URL" npm run build
grep -rqF "$API_URL" .next/static || { echo "the build doesn't contain $API_URL" >&2; false; }
trap - ERR
cd /

switch_to "$rel" "$REF $sha"

# Keep the newest $KEEP builds, plus whatever current points to.
current=$(readlink -f "$WEB/current")
mapfile -t old < <(ls -1d "$RELEASES"/*/ 2>/dev/null | sed 's:/$::' | sort | head -n -"$KEEP")
for d in "${old[@]}"; do
  [[ $d == "$current" ]] || rm -rf "$d"
done
