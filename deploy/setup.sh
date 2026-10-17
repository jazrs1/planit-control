#!/usr/bin/env bash
# One-time server setup for the PlanIT Control API on Ubuntu 24.04 (or 22.04). Safe to rerun.
#
#   scp deploy/setup.sh root@SERVER_IP:/root/
#   ssh -t root@SERVER_IP bash /root/setup.sh api.example.com [git-ref]
#
# Installs Python 3.11, libgomp1 (LightGBM), git, Caddy and a firewall; creates the `planit` user,
# a read-only GitHub deploy key, the checkout (/opt/planit/app), the venv (/opt/planit/venv) and the
# persistent photo folder (/var/lib/planit/uploads); installs the systemd service (one uvicorn worker)
# and Caddy (automatic HTTPS for the api domain). The API starts once backend/.env is on the server
# (deploy/copy-to-server.sh). On a rerun the checkout is left alone: use deploy/update.sh for code.
# Step by step: docs/deploy.md.
set -euo pipefail

DOMAIN=${1:-}
REF=${2:-main}
REPO=git@github.com:jazrs1/planit-control.git
APP_USER=planit
HOME_DIR=/opt/planit
APP_DIR=$HOME_DIR/app
VENV=$HOME_DIR/venv
UPLOADS=/var/lib/planit/uploads
# GitHub's published SSH host key (docs.github.com, "GitHub's SSH key fingerprints").
GITHUB_ED25519=SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU

step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
as_app() { sudo -u "$APP_USER" -H "$@"; }

[[ $DOMAIN =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
  || fail "usage: setup.sh API_DOMAIN [GIT_REF]   e.g. setup.sh api.example.com main"
[[ $EUID -eq 0 ]] || fail "run as root"
. /etc/os-release
[[ ${ID:-} == ubuntu ]] || fail "this script is for Ubuntu (found ${ID:-unknown})"
export DEBIAN_FRONTEND=noninteractive
cd /

step "System packages (git, libgomp1 for LightGBM, firewall)"
apt-get update -q
apt-get install -y -q git curl ca-certificates gnupg ufw libgomp1 sudo software-properties-common

step "Python 3.11"
if ! apt-cache show python3.11-venv >/dev/null 2>&1; then
  add-apt-repository -y ppa:deadsnakes/ppa   # Ubuntu 24.04 ships 3.12; our pins need 3.11
  apt-get update -q
fi
apt-get install -y -q python3.11 python3.11-venv
python3.11 --version

step "Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi
caddy version

step "Swap (only on servers under 3 GB of RAM without any)"
if [[ -z $(swapon --show --noheadings) ]] && (( $(awk '/MemTotal/ {print $2}' /proc/meminfo) < 3000000 )); then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "Added a 2 GB swap file"
else
  echo "Skipped"
fi

step "User and folders"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$HOME_DIR" --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$HOME_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$HOME_DIR/.ssh"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 /var/lib/planit "$UPLOADS"

step "GitHub deploy key (the repo is private)"
KEY=$HOME_DIR/.ssh/id_ed25519
[[ -f $KEY ]] || as_app ssh-keygen -q -t ed25519 -N '' -C "planit-deploy@$(hostname)" -f "$KEY"
KNOWN=$HOME_DIR/.ssh/known_hosts
if ! as_app ssh-keygen -F github.com -f "$KNOWN" >/dev/null 2>&1; then
  scanned=$(ssh-keyscan -t ed25519 github.com 2>/dev/null)
  [[ $(ssh-keygen -lf - <<<"$scanned" | awk '{print $2}') == "$GITHUB_ED25519" ]] \
    || fail "github.com's host key doesn't match GitHub's published fingerprint"
  echo "$scanned" | as_app tee -a "$KNOWN" >/dev/null
fi
shown=0
until as_app git ls-remote "$REPO" HEAD >/dev/null 2>&1; do
  if (( ! shown )); then
    echo
    echo "Add this key as a read-only deploy key (no write access):"
    echo "  https://github.com/jazrs1/planit-control/settings/keys/new"
    echo "  or from a machine with gh: gh repo deploy-key add KEYFILE -R jazrs1/planit-control -t <title>"
    echo
    cat "$KEY.pub"
    echo
    shown=1
  fi
  if [[ -t 0 ]]; then
    read -rp "Press Enter once it's added (Ctrl-C to stop)... "
  else
    # No terminal (e.g. ssh without -t, or run by another script): wait for the key instead of
    # exiting at the prompt.
    echo "Waiting for the deploy key (checking every 10 s; Ctrl-C to stop)..."
    sleep 10
  fi
done
echo "GitHub access OK"

step "Checkout ($APP_DIR)"
if [[ ! -d $APP_DIR/.git ]]; then
  as_app git clone -q "$REPO" "$APP_DIR"
  target=$(as_app git -C "$APP_DIR" rev-parse --verify -q "origin/$REF^{commit}" \
           || as_app git -C "$APP_DIR" rev-parse --verify "$REF^{commit}")
  as_app git -C "$APP_DIR" checkout -q --detach "$target"
  echo "$(date -u +%FT%TZ) setup -> $target ($REF)" | as_app tee -a "$HOME_DIR/deploys.log" >/dev/null
else
  echo "Exists; leaving it at $(as_app git -C "$APP_DIR" rev-parse --short HEAD) (deploy code with deploy/update.sh)"
fi
[[ -f $APP_DIR/deploy/planit-api.service ]] \
  || fail "this checkout has no deploy/ folder. Rerun with the branch that has it: setup.sh $DOMAIN deploy-prep"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR/backend/data" "$APP_DIR/backend/data/replay"

step "Python venv and requirements"
[[ -x $VENV/bin/python ]] || as_app python3.11 -m venv "$VENV"
as_app "$VENV/bin/pip" install -q --upgrade pip
as_app "$VENV/bin/pip" install -q -r "$APP_DIR/backend/requirements.txt"
if grep -qi '^lightgbm' "$APP_DIR/backend/requirements.txt"; then
  as_app "$VENV/bin/python" -c "import lightgbm; print('lightgbm', lightgbm.__version__)"
fi

step "systemd service (planit-api) and log limits"
install -m 644 "$APP_DIR/deploy/planit-api.service" /etc/systemd/system/planit-api.service
install -d /etc/systemd/journald.conf.d
install -m 644 "$APP_DIR/deploy/journald-planit.conf" /etc/systemd/journald.conf.d/planit.conf
systemctl restart systemd-journald
systemctl daemon-reload
systemctl enable planit-api >/dev/null

step "Caddy reverse proxy for https://$DOMAIN"
install -d -o caddy -g caddy /var/log/caddy
sed "s/API_DOMAIN/$DOMAIN/g" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null
systemctl reload-or-restart caddy

step "Firewall (SSH, HTTP, HTTPS)"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null   # HTTP/3
ufw --force enable >/dev/null
ufw status | sed -n '1,12p'

step "Done"
ip=$(hostname -I | awk '{print $1}')
dns=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)
echo "Server IPv4: $ip"
if [[ $dns == "$ip" ]]; then
  echo "DNS: $DOMAIN -> $ip (OK; Caddy gets the HTTPS certificate on its own)"
else
  echo "DNS: $DOMAIN -> ${dns:-nothing yet}. Add an A record: $DOMAIN -> $ip, then: systemctl restart caddy"
fi
if [[ -f $APP_DIR/backend/.env ]]; then
  systemctl restart planit-api
  echo "planit-api restarted. Check it: curl -s localhost:8000/health"
else
  echo "Next, from your laptop: deploy/copy-to-server.sh root@$ip --cors https://<frontend-domain>"
  echo "(copies backend/.env and the replay files, then starts planit-api)"
fi
