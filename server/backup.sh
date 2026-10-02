#!/usr/bin/env bash
#
# GardenForge nightly backup for the PocketBase sync server.
#
# STATUS: NOT YET EXECUTED - verify on first install (run it by hand once and restore the result
# into a scratch directory, see server/restore.md, before trusting it).
#
# Usage (as root; install.sh copies this script to /opt/gardenforge/scripts/backup.sh):
#   backup.sh                  # default "api" mode, no downtime
#   backup.sh --mode offline   # stops PocketBase for a few seconds and archives pb_data with tar
#   backup.sh --dir /opt/gardenforge
#
# api mode uses PocketBase's built-in backup API (docs: api-backups, going-to-production):
#   POST /api/backups {"name": "..."} with a superuser token creates a ZIP of the whole pb_data
#   directory - the SQLite database AND the uploaded files in pb_data/storage (the photos) - in
#   pb_data/backups/. This script copies that ZIP to BACKUP_DIR, checks it, records its SHA-256,
#   deletes PocketBase's local copy (DELETE /api/backups/<key>) and prunes old copies.
#   The token is a "_superusers" impersonate token (docs: authentication, "API keys"), stored in
#   /etc/gardenforge/backup.env as PB_BACKUP_TOKEN=..., owned by root, mode 0600. It is
#   non-renewable and expires on the date chosen when it was generated: when it expires this
#   script fails loudly (exit 3) and you generate a new one.
#
# offline mode needs no token: it stops the service, archives pb_data (without pb_data/backups)
# with tar, and starts the service again (docs: going-to-production, "Backup and Restore":
# copying pb_data while the application is stopped is a valid backup).
#
# Settings come from /etc/gardenforge/pocketbase.env: PB_HTTP, BACKUP_DIR, BACKUP_KEEP_DAYS.
# Exit codes: 0 ok, 1 error, 2 bad configuration, 3 token rejected.

set -Eeuo pipefail
umask 077

MODE="api"
DIR="/opt/gardenforge"
SERVICE="gardenforge-pocketbase"
ENV_FILE="${GF_ENV_FILE:-/etc/gardenforge/pocketbase.env}"
TOKEN_FILE="${GF_TOKEN_FILE:-/etc/gardenforge/backup.env}"

log()  { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die()  { log "ERROR: $2"; exit "$1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --dir=*) DIR="${1#*=}"; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die 2 "unknown option $1" ;;
  esac
done
case "$MODE" in api|offline) ;; *) die 2 "--mode must be api or offline" ;; esac
[ "$(id -u)" -eq 0 ] || die 2 "run as root"
DIR="${DIR%/}"
DATA="${DIR}/pb_data"
[ -d "$DATA" ] || die 2 "no PocketBase data directory at ${DATA}"

# Read KEY=value lines without executing the file.
env_get() { # file key
  sed -n "s/^$2=//p" "$1" | tail -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
[ -r "$ENV_FILE" ] || die 2 "cannot read ${ENV_FILE}"
PB_HTTP="$(env_get "$ENV_FILE" PB_HTTP)"
BACKUP_DIR="$(env_get "$ENV_FILE" BACKUP_DIR)"
KEEP_DAYS="$(env_get "$ENV_FILE" BACKUP_KEEP_DAYS)"
PB_HTTP="${PB_HTTP:-127.0.0.1:8090}"
KEEP_DAYS="${KEEP_DAYS:-30}"
[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] && [ "$KEEP_DAYS" -ge 1 ] || die 2 "BACKUP_KEEP_DAYS must be a whole number >= 1"
[[ "$BACKUP_DIR" =~ ^/ ]] || die 2 "BACKUP_DIR must be an absolute path (set it in ${ENV_FILE})"
real_backup="$(realpath -m "$BACKUP_DIR")"
real_data="$(realpath "$DATA")"
case "$real_backup/" in "$real_data"/*) die 2 "BACKUP_DIR (${real_backup}) must not be inside pb_data" ;; esac
mkdir -p -m 0700 "$BACKUP_DIR"
if [ "$(stat -c %d "$real_backup")" = "$(stat -c %d "$real_data")" ]; then
  log "WARNING: BACKUP_DIR is on the same filesystem as pb_data; a disk failure would take both. Use another disk or copy the backups off this machine."
fi

STAMP="$(date -u +%Y%m%d_%H%M%S)"

prune() {
  log "pruning backups older than ${KEEP_DAYS} days in ${BACKUP_DIR}"
  find "$BACKUP_DIR" -maxdepth 1 -type f \
    \( -name 'gf_*.zip' -o -name 'gf_*.tar.gz' -o -name 'gf_*.sha256' \) \
    -mtime +"$KEEP_DAYS" -print -delete
}

finish() { # file
  ( cd "$BACKUP_DIR" && sha256sum "$(basename "$1")" > "$(basename "$1").sha256" )
  log "OK: $1 ($(du -h "$1" | cut -f1)), sha256 in $(basename "$1").sha256"
  prune
}

# ------------------------------------------------------------------------------------------------
if [ "$MODE" = "offline" ]; then
  OUT="${BACKUP_DIR}/gf_offline_${STAMP}.tar.gz"
  was_active=0
  systemctl is-active --quiet "$SERVICE" 2>/dev/null && was_active=1
  restart() { [ "$was_active" -eq 1 ] && systemctl start "$SERVICE" || true; }
  trap restart EXIT
  if [ "$was_active" -eq 1 ]; then
    log "stopping ${SERVICE} for an offline copy"
    systemctl stop "$SERVICE"
  else
    log "${SERVICE} is not running; copying pb_data as it is"
  fi
  tar -C "$DIR" --exclude='pb_data/backups' --exclude='pb_data/.pb_temp_to_delete' -czf "${OUT}.partial" pb_data
  restart
  trap - EXIT
  tar -tzf "${OUT}.partial" pb_data/data.db >/dev/null || die 1 "archive check failed: pb_data/data.db missing"
  mv -f "${OUT}.partial" "$OUT"
  finish "$OUT"
  exit 0
fi

# ------------------------------------------------------------------------------------------------
# api mode
[ -f "$TOKEN_FILE" ] || die 2 "missing ${TOKEN_FILE} (PB_BACKUP_TOKEN=...), or use --mode offline"
perm="$(stat -c '%U %a' "$TOKEN_FILE")"
[ "$perm" = "root 600" ] || [ "$perm" = "root 400" ] || die 2 "${TOKEN_FILE} must be owned by root with mode 600 (is: ${perm})"
TOKEN="$(env_get "$TOKEN_FILE" PB_BACKUP_TOKEN)"
[ -n "$TOKEN" ] || die 2 "PB_BACKUP_TOKEN is empty in ${TOKEN_FILE}"
command -v unzip >/dev/null || die 2 "unzip is required (apt-get install unzip)"

API="http://${PB_HTTP}"
NAME="gf_${STAMP}.zip" # the API accepts [a-z0-9_-] names ending in .zip (api-backups, Create)
AUTH_HDR="$(mktemp)"
trap 'rm -f "$AUTH_HDR"' EXIT
# Keep the token out of the process list: curl reads the header from a file.
printf 'Authorization: %s\n' "$TOKEN" > "$AUTH_HDR"

create_backup() {
  curl -sS -o /dev/null -w '%{http_code}' -X POST -H @"$AUTH_HDR" -H 'Content-Type: application/json' \
    --data "{\"name\":\"${NAME}\"}" "${API}/api/backups"
}

log "requesting PocketBase backup ${NAME}"
code="$(create_backup || true)"
if [ "$code" = "400" ]; then
  log "PocketBase reports another backup/restore in progress; retrying in 120 s"
  sleep 120
  code="$(create_backup || true)"
fi
case "$code" in
  204|200) ;;
  401|403) die 3 "the superuser token was rejected (HTTP ${code}). Generate a new impersonate token (server/README.md, Backups)." ;;
  000) die 1 "PocketBase is not answering on ${API}" ;;
  *) die 1 "backup request failed with HTTP ${code}" ;;
esac

# The docs do not say whether the request returns before the ZIP is complete, so wait until the
# API lists it and its size stops changing.
SRC="${DATA}/backups/${NAME}"
deadline=$(( $(date +%s) + 3600 ))
last=-1
while :; do
  listed="$(curl -sS -H @"$AUTH_HDR" "${API}/api/backups" || true)"
  if grep -Eq "\"key\"[[:space:]]*:[[:space:]]*\"${NAME}\"" <<<"$listed" && [ -f "$SRC" ]; then
    size="$(stat -c %s "$SRC")"
    [ "$size" -gt 0 ] && [ "$size" = "$last" ] && break
    last="$size"
  fi
  [ "$(date +%s)" -lt "$deadline" ] || die 1 "backup ${NAME} did not appear in ${DATA}/backups within an hour (are backups stored on S3? then copy them from there)"
  sleep 5
done

OUT="${BACKUP_DIR}/${NAME}"
cp "$SRC" "${OUT}.partial"
unzip -tq "${OUT}.partial" >/dev/null || die 1 "ZIP integrity check failed for ${OUT}.partial"
entries="$(unzip -Z1 "${OUT}.partial")"
grep -qx 'data.db' <<<"$entries" || die 1 "the backup has no data.db at its top level"
if [ -d "${DATA}/storage" ] && [ -n "$(find "${DATA}/storage" -type f -print -quit)" ]; then
  grep -q '^storage/' <<<"$entries" || die 1 "pb_data/storage has files (photos) but the backup contains none"
fi
mv -f "${OUT}.partial" "$OUT"

# PocketBase's own copy inside pb_data/backups is no longer needed.
del="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H @"$AUTH_HDR" "${API}/api/backups/${NAME}" || true)"
[ "$del" = "204" ] || log "WARNING: could not delete ${SRC} through the API (HTTP ${del}); delete it by hand to save space"

finish "$OUT"
