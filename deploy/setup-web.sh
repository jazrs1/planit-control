#!/usr/bin/env bash
# One-time setup for serving the frontend from this server (the standby for Vercel). Run ON the server as
# root, after deploy/setup.sh. Safe to rerun.
#
#   /opt/planit/app/deploy/setup-web.sh
#
# Installs Node LTS (pinned below, checksum-verified) in /opt/node, adds swap if the box is small, creates
# the `planit-web` user (it can't read the API's checkout or .env), installs the planit-web systemd service
# (next start on 127.0.0.1:3000) and the Caddy site block /etc/caddy/web.caddy, which stays off until the
# DNS switch, then builds and starts the first release with deploy-web.sh. Docs: docs/deploy.md.
set -euo pipefail

NODE_VERSION=24.22.0   # Node 24 "Krypton" LTS
NODE_SHA256=cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008   # node-v24.22.0-linux-x64.tar.xz
WEB=/opt/planit-web
HERE=$(cd "$(dirname "$0")" && pwd)

step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "run as root"
[[ $(uname -m) == x86_64 ]] || fail "the pinned Node build is linux-x64 (found $(uname -m))"
id planit >/dev/null 2>&1 || fail "run deploy/setup.sh first (no planit user)"

step "Node $NODE_VERSION"
if [[ $(/opt/node/bin/node -v 2>/dev/null) != "v$NODE_VERSION" ]]; then
  tmp=$(mktemp -d)
  curl -fsSLo "$tmp/node.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
  echo "$NODE_SHA256  $tmp/node.tar.xz" | sha256sum -c --quiet -
  rm -rf "/opt/node-v$NODE_VERSION"
  mkdir -p "/opt/node-v$NODE_VERSION"
  tar -xJf "$tmp/node.tar.xz" --strip-components=1 --no-same-owner -C "/opt/node-v$NODE_VERSION"
  rm -rf "$tmp"
  ln -sfn "/opt/node-v$NODE_VERSION" /opt/node
fi
for b in node npm npx; do ln -sfn "/opt/node/bin/$b" "/usr/local/bin/$b"; done
echo "node $(/opt/node/bin/node -v), npm $(/opt/node/bin/npm -v)"

step "Swap (the Next.js build wants about 2 GB on top of the API)"
mem_mb=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
swap_mb=$(awk '/SwapTotal/ {print int($2 / 1024)}' /proc/meminfo)
if (( mem_mb + swap_mb < 4000 )) && [[ ! -e /swapfile ]]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap -q /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "added a 2 GB /swapfile"
else
  echo "ok: ${mem_mb} MB RAM, ${swap_mb} MB swap"
fi

step "planit-web user and $WEB"
id planit-web >/dev/null 2>&1 \
  || useradd --system --home-dir "$WEB" --create-home --shell /usr/sbin/nologin planit-web
install -d -m 750 -o planit-web -g planit-web "$WEB" "$WEB/releases"

step "systemd service and Caddy site block (off)"
install -m 644 "$HERE/planit-web.service" /etc/systemd/system/planit-web.service
systemctl daemon-reload
systemctl enable -q planit-web
install -m 644 "$HERE/Caddyfile.web" /etc/caddy/web.caddy
if grep -qxF "import /etc/caddy/web.caddy" /etc/caddy/Caddyfile; then
  echo "Caddy is already serving the frontend (import line present); reloading for the new block"
  sudo -u caddy caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null && systemctl reload caddy
else
  echo "installed /etc/caddy/web.caddy (not imported; turn on with: deploy-web.sh --caddy-on)"
fi

step "First build"
bash "$HERE/deploy-web.sh" main
