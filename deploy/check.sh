#!/usr/bin/env bash
# Is the deployed API healthy? Run from anywhere (your laptop is fine).
#
#   deploy/check.sh https://api.example.com https://example.com https://planit-control.vercel.app
#
# Checks HTTPS, /health (database), the 55 sites, how fresh the hazard data is, alerts, replay state,
# and that CORS allows each frontend origin you list.
set -uo pipefail

API=${1:?usage: deploy/check.sh https://api.example.com [frontend-origin ...]}
API=${API%/}
shift
status=0
ok() { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; status=1; }

get() { curl -fsS --max-time 20 "$API$1"; }

echo "API $API"
if body=$(get /health); then ok "/health $body"; else bad "/health unreachable or unhealthy (HTTPS, DNS, Caddy or the database)"; fi

if sites=$(get /sites); then
  n=$(python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' <<<"$sites")
  [[ $n == 55 ]] && ok "/sites: $n sites" || bad "/sites: $n sites (expected 55)"
  first=$(python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])' <<<"$sites")
  if detail=$(get "/sites/$first"); then
    DETAIL=$detail python3 - "$first" <<'PY'
import json, os, sys
from datetime import datetime, timezone
site = json.loads(os.environ["DETAIL"])
stamps = []
def walk(node, path):
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "as_of" and isinstance(v, str):
                stamps.append((datetime.fromisoformat(v.replace("Z", "+00:00")), path))
            else:
                walk(v, f"{path}.{k}" if path else k)
    elif isinstance(node, list):
        for v in node[:1]:
            walk(v, path)
walk(site.get("conditions", {}), "")
now = datetime.now(timezone.utc)
if not stamps:
    print(f"  FAIL  /sites/{sys.argv[1]}: no hazard card has data yet (pollers off, or still starting)")
else:
    for ts, path in sorted(stamps):
        print(f"  info  {path or 'conditions'} as of {(now - ts).total_seconds() / 60:.0f} min ago")
PY
  else bad "/sites/$first"; fi
else bad "/sites"; fi

if alerts=$(get /alerts); then
  ok "/alerts: $(python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' <<<"$alerts") active"
else bad "/alerts"; fi
if replay=$(get /replay/status); then
  ok "/replay/status: $(python3 -c 'import json,sys; r=json.load(sys.stdin); print("running " + str(r["window"]) if r["running"] else "not running")' <<<"$replay")"
else bad "/replay/status"; fi

for origin in "$@"; do
  origin=${origin%/}
  allowed=$(curl -sS --max-time 20 -o /dev/null -D - -X OPTIONS "$API/sites" -H "Origin: $origin" \
              -H "Access-Control-Request-Method: GET" | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin" {print $2}')
  [[ $allowed == "$origin" ]] && ok "CORS allows $origin" || bad "CORS blocks $origin (add it to CORS_ORIGINS on the server)"
done
exit $status
