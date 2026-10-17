#!/usr/bin/env bash
# Deploy a git ref to the server, or roll back. Run ON the server as root.
#
#   /opt/planit/app/deploy/update.sh                 # latest main
#   /opt/planit/app/deploy/update.sh deploy-prep     # a branch, tag or commit
#   /opt/planit/app/deploy/update.sh --rollback      # back to the commit that ran before the last update
#   add --migrate to apply new database migrations (python -m scripts.migrate) before the restart
#
# Every deploy is logged in /opt/planit/deploys.log. Migrations are never undone by a rollback.
set -euo pipefail

# Run from a copy: the checkout (and this file) changes under us.
if [[ -z ${PLANIT_UPDATE_COPY:-} ]]; then
  copy=$(mktemp)
  cp "$0" "$copy"
  PLANIT_UPDATE_COPY=1 exec bash "$copy" "$@"
fi

APP_USER=planit
HOME_DIR=/opt/planit
APP_DIR=$HOME_DIR/app
VENV=$HOME_DIR/venv
LOG=$HOME_DIR/deploys.log
REF=main
ROLLBACK=0
MIGRATE=0

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
as_app() { sudo -u "$APP_USER" -H "$@"; }

for arg in "$@"; do
  case $arg in
    --rollback) ROLLBACK=1 ;;
    --migrate) MIGRATE=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    -*) fail "unknown option $arg" ;;
    *) REF=$arg ;;
  esac
done
[[ $EUID -eq 0 ]] || fail "run as root"
cd "$HOME_DIR"

current=$(as_app git -C "$APP_DIR" rev-parse HEAD)
if (( ROLLBACK )); then
  [[ -s $LOG ]] || fail "no deploys logged yet"
  target=$(tail -n 1 "$LOG" | awk '{print $2}')
  [[ $target =~ ^[0-9a-f]{40}$ ]] || fail "the last deploy has no previous commit to go back to (see $LOG)"
  REF="rollback"
else
  as_app git -C "$APP_DIR" fetch -q --prune --tags origin
  target=$(as_app git -C "$APP_DIR" rev-parse --verify -q "origin/$REF^{commit}" \
           || as_app git -C "$APP_DIR" rev-parse --verify -q "$REF^{commit}") || fail "unknown ref $REF"
fi
echo "Deploying $REF: $(as_app git -C "$APP_DIR" log -1 --format='%h %s' "$target")"
echo "  (was $(as_app git -C "$APP_DIR" log -1 --format='%h %s' "$current"))"

as_app git -C "$APP_DIR" checkout -q --detach "$target"
as_app "$VENV/bin/pip" install -q -r "$APP_DIR/backend/requirements.txt"
if ! cmp -s "$APP_DIR/deploy/planit-api.service" /etc/systemd/system/planit-api.service; then
  install -m 644 "$APP_DIR/deploy/planit-api.service" /etc/systemd/system/planit-api.service
  systemctl daemon-reload
  echo "Updated the systemd unit"
fi
if (( MIGRATE )); then
  (cd "$APP_DIR/backend" && as_app "$VENV/bin/python" -m scripts.migrate)
fi
echo "$(date -u +%FT%TZ) $current -> $target ($REF)" >> "$LOG"
chown "$APP_USER:$APP_USER" "$LOG"

systemctl restart planit-api
for _ in $(seq 1 30); do
  if body=$(curl -fsS localhost:8000/health 2>/dev/null); then
    echo "Healthy: $body"
    exit 0
  fi
  sleep 2
done
echo "Not healthy after 60 s. Last log lines:"
journalctl -u planit-api -n 40 --no-pager
echo "Roll back with: $APP_DIR/deploy/update.sh --rollback"
exit 1
