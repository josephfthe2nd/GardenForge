#!/usr/bin/env bash
#
# GardenForge server smoke test: quick curl checks after install, after tunnel changes and after
# every PocketBase update.
#
# STATUS: NOT YET EXECUTED - verify on first install.
#
# Usage:
#   smoke.sh [--local http://127.0.0.1:8090] [--public https://api.example.com]
#            [--origin https://your-site.vercel.app]
#
#   --local   PocketBase's own address (run this on the server). Default http://127.0.0.1:8090.
#   --public  the tunnel hostname. Checks that ONLY the app's paths answer and that the admin UI
#             (/_/), the superuser API, backups and settings return 404 through the tunnel.
#   --origin  the app's address; checks that CORS allows it and refuses another origin.
#
# Creates nothing when the server is configured correctly. If sign-ups are open (a FAIL), the
# check below may have created an account named smoke-<random>@invalid.example: delete it in the
# admin UI (Collections > users).
# Exit status = number of failed checks.

set -uo pipefail

LOCAL="http://127.0.0.1:8090"
PUBLIC=""
ORIGIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --local) LOCAL="${2:-}"; shift 2 ;;
    --local=*) LOCAL="${1#*=}"; shift ;;
    --public) PUBLIC="${2:-}"; shift 2 ;;
    --public=*) PUBLIC="${1#*=}"; shift ;;
    --origin) ORIGIN="${2:-}"; shift 2 ;;
    --origin=*) ORIGIN="${1#*=}"; shift ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
done
LOCAL="${LOCAL%/}"
PUBLIC="${PUBLIC%/}"

command -v curl >/dev/null || { echo "curl is required" >&2; exit 64; }

passes=0
fails=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$*"; passes=$((passes + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fails=$((fails + 1)); }

# http_code METHOD URL [curl args...]  -> prints the status code, 000 on connection failure
http_code() {
  local method="$1" url="$2"
  shift 2
  curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X "$method" "$@" "$url" 2>/dev/null || true
}

# expect DESCRIPTION ALLOWED_CODES_REGEX METHOD URL [curl args...]
expect() {
  local desc="$1" allowed="$2" method="$3" url="$4"
  shift 4
  local code
  code="$(http_code "$method" "$url" "$@")"
  [ -n "$code" ] || code="000"
  if [[ "$code" =~ ^(${allowed})$ ]]; then ok "$desc (HTTP $code)"; else bad "$desc: expected ${allowed}, got HTTP $code ($method $url)"; fi
}

RAND="$(date +%s)$RANDOM"
SIGNUP_JSON="{\"email\":\"smoke-${RAND}@invalid.example\",\"password\":\"smoke-${RAND}-pass\",\"passwordConfirm\":\"smoke-${RAND}-pass\"}"

echo "Local checks against ${LOCAL}"
expect "health endpoint" "200" GET "${LOCAL}/api/health"
expect "sync status needs a token" "401" GET "${LOCAL}/api/gf/sync/status"
expect "public sign-up is closed" "400|403" POST "${LOCAL}/api/collections/users/records" \
  -H 'Content-Type: application/json' --data "$SIGNUP_JSON"
expect "gf_applied_ops is locked" "403" GET "${LOCAL}/api/collections/gf_applied_ops/records"
expect "gf_records cannot be created through the record API" "403" POST "${LOCAL}/api/collections/gf_records/records" \
  -H 'Content-Type: application/json' --data '{}'
guest_list="$(curl -sS --max-time 20 "${LOCAL}/api/collections/gf_records/records" 2>/dev/null || true)"
if grep -q '"items":\[\]' <<<"$guest_list"; then ok "guests see no records"; else bad "guest list of gf_records is not empty or failed: ${guest_list:0:200}"; fi
expect "tunnel allowlist (proxied request for /_/ gets 404)" "404" GET "${LOCAL}/_/" -H 'X-Forwarded-For: 203.0.113.9'

if [ -n "$PUBLIC" ]; then
  echo "Public checks against ${PUBLIC}"
  case "$PUBLIC" in
    https://*) ok "public address uses HTTPS" ;;
    *) bad "public address must start with https:// (got ${PUBLIC})" ;;
  esac
  expect "health endpoint through the tunnel" "200" GET "${PUBLIC}/api/health"
  expect "sync status through the tunnel needs a token" "401" GET "${PUBLIC}/api/gf/sync/status"
  expect "admin UI /_/ is NOT reachable" "404" GET "${PUBLIC}/_/"
  expect "site root is NOT served" "404" GET "${PUBLIC}/"
  expect "superuser login is NOT reachable" "404" POST "${PUBLIC}/api/collections/_superusers/auth-with-password" \
    -H 'Content-Type: application/json' --data '{"identity":"x@invalid.example","password":"x"}'
  expect "backups API is NOT reachable" "404" GET "${PUBLIC}/api/backups"
  expect "settings API is NOT reachable" "404" GET "${PUBLIC}/api/settings"
  expect "collections API is NOT reachable" "404" GET "${PUBLIC}/api/collections"
  expect "user sign-up path is NOT reachable" "404" POST "${PUBLIC}/api/collections/users/records" \
    -H 'Content-Type: application/json' --data "$SIGNUP_JSON"
  expect "admin route is NOT reachable" "404" POST "${PUBLIC}/api/gf/admin/rotate-epoch"
  expect "realtime is NOT reachable" "404" GET "${PUBLIC}/api/realtime"
  expect "owner sign-in path is reachable (bad password -> 400)" "400" POST "${PUBLIC}/api/collections/users/auth-with-password" \
    -H 'Content-Type: application/json' --data '{"identity":"nobody@invalid.example","password":"wrong-password"}'
fi

if [ -n "$ORIGIN" ]; then
  target="${PUBLIC:-$LOCAL}/api/gf/sync/status"
  echo "CORS checks against ${target}"
  allow="$(curl -sS -o /dev/null -D - --max-time 20 -X OPTIONS -H "Origin: ${ORIGIN}" \
    -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization' "$target" 2>/dev/null \
    | tr -d '\r' | sed -n 's/^[Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin: *//p')"
  if [ "$allow" = "$ORIGIN" ] || [ "$allow" = "*" ]; then ok "CORS allows ${ORIGIN} (${allow})"; else bad "CORS does not allow ${ORIGIN} (got '${allow}'); check PB_ORIGINS"; fi
  [ "$allow" = "*" ] && bad "CORS allows every origin (*); set PB_ORIGINS in /etc/gardenforge/pocketbase.env"
  evil="$(curl -sS -o /dev/null -D - --max-time 20 -X OPTIONS -H 'Origin: https://evil.invalid' \
    -H 'Access-Control-Request-Method: GET' "$target" 2>/dev/null \
    | tr -d '\r' | sed -n 's/^[Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin: *//p')"
  if [ -z "$evil" ]; then ok "CORS refuses an unknown origin"; else bad "CORS answered an unknown origin with '${evil}'"; fi
fi

echo
echo "${passes} passed, ${fails} failed"
exit "$fails"
