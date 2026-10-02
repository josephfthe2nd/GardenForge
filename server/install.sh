#!/usr/bin/env bash
#
# GardenForge sync backend installer (PocketBase) for Debian, Ubuntu and Raspberry Pi OS.
#
# STATUS: NOT YET EXECUTED - verify on first install. Written without running it (the
# development sandbox may not download or run external code). Read it before running it.
# Try `sudo ./server/install.sh --dry-run` first: it prints the plan and changes nothing.
#
# Usage (from a checkout of the GardenForge repository):
#   sudo ./server/install.sh [--version 0.40.4] [--dir /opt/gardenforge] [--user gardenforge]
#                            [--http 127.0.0.1:8090] [--i-have-a-backup] [--dry-run]
#
# What it does, in order (safe to re-run; it never deletes pb_data):
#   1. checks it runs as root, on a Debian-family system, with curl/unzip/sha256sum/systemctl
#      (installs curl, unzip, ca-certificates with apt-get when missing);
#   2. detects the CPU (amd64, arm64, armv7) and downloads the matching PocketBase release zip
#      and the release's checksums file from GitHub, and refuses to continue unless the zip's
#      SHA-256 matches;
#   3. creates the system user, <dir>/bin, <dir>/pb_data (only if missing), copies
#      server/pb_hooks and server/pb_migrations into <dir>;
#   4. creates /etc/gardenforge/pocketbase.env from server/env.example (only if missing);
#   5. installs the systemd unit as gardenforge-pocketbase.service, starts it, waits for
#      /api/health, then prints the next steps (superuser, owner account, tunnel, backups).
#
# Release asset names relied on (VERIFY ON FIRST INSTALL against
# https://github.com/pocketbase/pocketbase/releases):
#   https://github.com/pocketbase/pocketbase/releases/download/v<V>/pocketbase_<V>_linux_<ARCH>.zip
#       <ARCH> = amd64 | arm64 | armv7   (amd64/arm64 names are confirmed by the docs site's own
#       download links; armv7 follows the same pattern but is not confirmed by the docs)
#   .../v<V>/checksums.txt   (tried first)  or  .../v<V>/pocketbase_<V>_checksums.txt
#       lines of "<sha256>  <file name>" (sha256sum format)

set -Eeuo pipefail
umask 022

VERSION="0.40.4"
DIR="/opt/gardenforge"
SVC_USER="gardenforge"
HTTP_ADDR="127.0.0.1:8090"
DRY_RUN=0
HAVE_BACKUP=0
SERVICE_NAME="gardenforge-pocketbase"
ENV_DIR="/etc/gardenforge"
ENV_FILE="${ENV_DIR}/pocketbase.env"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORIG_ARGS="$*"
CHANGED=0

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mWARNING:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --dir=*) DIR="${1#*=}"; shift ;;
    --user) SVC_USER="${2:-}"; shift 2 ;;
    --user=*) SVC_USER="${1#*=}"; shift ;;
    --http) HTTP_ADDR="${2:-}"; shift 2 ;;
    --http=*) HTTP_ADDR="${1#*=}"; shift ;;
    --i-have-a-backup) HAVE_BACKUP=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage 0 ;;
    *) warn "unknown option: $1"; usage 2 ;;
  esac
done

# ---- validate arguments ------------------------------------------------------------------------
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--version must look like 0.40.4 (got '$VERSION')"
[[ "$DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--dir must be an absolute path of letters, digits, . _ - / (got '$DIR')"
DIR="${DIR%/}"
case "$DIR" in /|/bin|/boot|/dev|/etc|/home|/lib|/proc|/root|/run|/sbin|/sys|/tmp|/usr|/var) die "--dir '$DIR' is a system directory" ;; esac
[[ "$SVC_USER" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || die "--user must be a valid system user name (got '$SVC_USER')"
[[ "$HTTP_ADDR" =~ ^[0-9.]+:[0-9]{2,5}$ ]] || die "--http must look like 127.0.0.1:8090 (got '$HTTP_ADDR')"
case "$HTTP_ADDR" in
  127.*) ;;
  *) warn "--http $HTTP_ADDR is not a loopback address: PocketBase will be reachable from the network, bypassing the tunnel's path rules." ;;
esac

# ---- detect architecture -------------------------------------------------------------------------
detect_arch() {
  local m
  m="$(uname -m)"
  case "$m" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;   # a static arm64 binary also runs on a 64-bit kernel with 32-bit userland
    armv7l|armv7*|armhf) echo "armv7" ;;
    armv6l) die "armv6 (Raspberry Pi Zero/1) is not a PocketBase release target" ;;
    *) die "unsupported CPU architecture: $m" ;;
  esac
}
ARCH="$(detect_arch)"
ZIP="pocketbase_${VERSION}_linux_${ARCH}.zip"
BASE_URL="https://github.com/pocketbase/pocketbase/releases/download/v${VERSION}"
BIN="${DIR}/bin/pocketbase"
UNIT_DST="/etc/systemd/system/${SERVICE_NAME}.service"

if [ "$DRY_RUN" -eq 1 ]; then
  cat <<EOF
Dry run - nothing will be changed.
  PocketBase version : ${VERSION}
  CPU architecture   : ${ARCH} (uname -m: $(uname -m))
  download           : ${BASE_URL}/${ZIP}
  checksums          : ${BASE_URL}/checksums.txt (fallback: pocketbase_${VERSION}_checksums.txt)
  binary             : ${BIN}
  data (kept)        : ${DIR}/pb_data   owner ${SVC_USER}
  hooks              : ${SCRIPT_DIR}/pb_hooks -> ${DIR}/pb_hooks
  migrations         : ${SCRIPT_DIR}/pb_migrations -> ${DIR}/pb_migrations
  scripts            : backup.sh, smoke.sh -> ${DIR}/scripts
  settings           : ${ENV_FILE} (created from env.example only if missing)
  service            : ${UNIT_DST}, listening on ${HTTP_ADDR}
EOF
  exit 0
fi

# ---- preflight -------------------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "run this as root, e.g.: sudo $0 ${ORIG_ARGS}"
[ -r /etc/os-release ] || die "/etc/os-release missing; this installer supports Debian, Ubuntu and Raspberry Pi OS"
# shellcheck disable=SC1091
. /etc/os-release
case " ${ID:-} ${ID_LIKE:-} " in
  *" debian "*|*" ubuntu "*|*" raspbian "*) ;;
  *) die "unsupported OS '${PRETTY_NAME:-unknown}'. This installer is for Debian, Ubuntu and Raspberry Pi OS." ;;
esac
command -v systemctl >/dev/null || die "systemd is required"
for f in pb_hooks/gardenforge_sync.pb.js pb_hooks/gardenforge_lib.js pocketbase.service env.example backup.sh smoke.sh; do
  [ -e "${SCRIPT_DIR}/${f}" ] || die "missing ${SCRIPT_DIR}/${f}: run this from a complete GardenForge checkout"
done
ls "${SCRIPT_DIR}"/pb_migrations/*.js >/dev/null 2>&1 || die "no migrations found in ${SCRIPT_DIR}/pb_migrations"

missing=()
for c in curl unzip sha256sum; do command -v "$c" >/dev/null || missing+=("$c"); done
if [ "${#missing[@]}" -gt 0 ]; then
  say "Installing missing tools: ${missing[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl unzip ca-certificates coreutils
fi

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ---- download and verify -----------------------------------------------------------------------
fetch() { curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 -o "$2" "$1"; }

say "Downloading PocketBase ${VERSION} (${ARCH})"
fetch "${BASE_URL}/${ZIP}" "${TMP}/${ZIP}" || die "download failed: ${BASE_URL}/${ZIP} (check --version and the asset name on the releases page)"

CHECKSUMS=""
for name in "checksums.txt" "pocketbase_${VERSION}_checksums.txt"; do
  if fetch "${BASE_URL}/${name}" "${TMP}/checksums.txt" 2>/dev/null; then CHECKSUMS="${name}"; break; fi
done
[ -n "$CHECKSUMS" ] || die "could not download the release checksums file; refusing to install an unverified binary"

expected="$(awk -v f="$ZIP" '$2 == f || $2 == "*" f { print $1 }' "${TMP}/checksums.txt" | head -n1)"
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || die "${CHECKSUMS} has no SHA-256 line for ${ZIP}; refusing to install"
actual="$(sha256sum "${TMP}/${ZIP}" | awk '{ print $1 }')"
[ "$expected" = "$actual" ] || die "checksum mismatch for ${ZIP}: expected ${expected}, got ${actual}"
say "Checksum OK (${CHECKSUMS}): ${actual}"

unzip -q -o "${TMP}/${ZIP}" -d "${TMP}/unpacked"
[ -f "${TMP}/unpacked/pocketbase" ] || die "the zip did not contain a 'pocketbase' binary"
chmod 0755 "${TMP}/unpacked/pocketbase"

# The flags the service uses must exist in this release (--hooksDir is not in the checked-out docs).
help_text="$("${TMP}/unpacked/pocketbase" serve --help 2>&1 || true)"
for flag in --dir --hooksDir --migrationsDir --http --origins --automigrate; do
  grep -q -- "$flag" <<<"$help_text" || die "this PocketBase release does not list the '$flag' flag in 'serve --help'; the service file needs updating"
done

# ---- user and directories ----------------------------------------------------------------------
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  say "Creating system user ${SVC_USER}"
  useradd --system --user-group --home-dir "$DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi

install -d -m 0755 -o root -g root "$DIR" "${DIR}/bin" "${DIR}/pb_hooks" "${DIR}/pb_migrations" "${DIR}/scripts"
if [ -d "${DIR}/pb_data" ]; then
  say "Keeping existing ${DIR}/pb_data (never modified by this installer)"
  data_owner="$(stat -c %U "${DIR}/pb_data")"
  [ "$data_owner" = "$SVC_USER" ] || warn "${DIR}/pb_data is owned by '${data_owner}', not '${SVC_USER}'; the service may fail to write. Fix with: chown -R ${SVC_USER}:${SVC_USER} ${DIR}/pb_data"
else
  install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "${DIR}/pb_data"
fi

# ---- binary (replace only when different) -------------------------------------------------------
new_sha="$(sha256sum "${TMP}/unpacked/pocketbase" | awk '{ print $1 }')"
old_sha=""
[ -f "$BIN" ] && old_sha="$(sha256sum "$BIN" | awk '{ print $1 }')"
BINARY_CHANGED=0
if [ "$new_sha" != "$old_sha" ]; then
  if [ -n "$old_sha" ] && [ -f "${DIR}/pb_data/data.db" ] && [ "$HAVE_BACKUP" -ne 1 ]; then
    die "this would replace the installed PocketBase binary while ${DIR}/pb_data holds data.
Make a backup first (server/README.md, 'Backups'), check the release notes for breaking changes,
then re-run with --i-have-a-backup."
  fi
  [ -f "$BIN" ] && cp -p "$BIN" "${BIN}.prev"
  install -m 0755 -o root -g root "${TMP}/unpacked/pocketbase" "${BIN}.new"
  mv -f "${BIN}.new" "$BIN"
  BINARY_CHANGED=1
  say "Installed ${BIN} (${VERSION})${old_sha:+; previous binary kept as ${BIN}.prev}"
else
  say "PocketBase binary already up to date"
fi

# ---- hooks, migrations, scripts ----------------------------------------------------------------
# Migrations are never deleted (PocketBase records applied ones); hooks found in the target but
# not in the repository are reported, not deleted.
copy_if_changed() { # src dst mode
  if ! cmp -s "$1" "$2" 2>/dev/null; then
    install -m "$3" -o root -g root "$1" "$2"
    CHANGED=1
  fi
}
for f in "${SCRIPT_DIR}"/pb_hooks/*; do copy_if_changed "$f" "${DIR}/pb_hooks/$(basename "$f")" 0644; done
for f in "${SCRIPT_DIR}"/pb_migrations/*.js; do copy_if_changed "$f" "${DIR}/pb_migrations/$(basename "$f")" 0644; done
for f in "${DIR}"/pb_hooks/*; do
  [ -e "$f" ] || continue
  [ -e "${SCRIPT_DIR}/pb_hooks/$(basename "$f")" ] || warn "extra file in ${DIR}/pb_hooks not in the repository: $(basename "$f") (it is still loaded if it ends in .pb.js)"
done
install -m 0750 -o root -g root "${SCRIPT_DIR}/backup.sh" "${DIR}/scripts/backup.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/smoke.sh" "${DIR}/scripts/smoke.sh"
[ "$BINARY_CHANGED" -eq 1 ] && CHANGED=1

# ---- settings file -------------------------------------------------------------------------------
install -d -m 0750 -o root -g "$SVC_USER" "$ENV_DIR"
if [ ! -f "$ENV_FILE" ]; then
  sed "s|^PB_HTTP=.*|PB_HTTP=${HTTP_ADDR}|" "${SCRIPT_DIR}/env.example" > "${TMP}/pocketbase.env"
  install -m 0640 -o root -g "$SVC_USER" "${TMP}/pocketbase.env" "$ENV_FILE"
  CHANGED=1
  say "Created ${ENV_FILE} - edit PB_ORIGINS and BACKUP_DIR"
else
  say "Keeping existing ${ENV_FILE}"
  grep -q "^PB_HTTP=${HTTP_ADDR}\$" "$ENV_FILE" || warn "${ENV_FILE} has a different PB_HTTP than --http ${HTTP_ADDR}; the file wins"
fi
grep -q "REPLACE-WITH" "$ENV_FILE" && warn "PB_ORIGINS in ${ENV_FILE} is still the placeholder: browsers will be refused until you set your site's address"
PB_HTTP_EFFECTIVE="$(sed -n 's/^PB_HTTP=//p' "$ENV_FILE" | tail -n1)"
PB_HTTP_EFFECTIVE="${PB_HTTP_EFFECTIVE:-$HTTP_ADDR}"

# ---- systemd unit --------------------------------------------------------------------------------
sed -e "s|/opt/gardenforge|${DIR}|g" \
    -e "s|^User=gardenforge\$|User=${SVC_USER}|" \
    -e "s|^Group=gardenforge\$|Group=${SVC_USER}|" \
    "${SCRIPT_DIR}/pocketbase.service" > "${TMP}/unit"
if ! cmp -s "${TMP}/unit" "$UNIT_DST" 2>/dev/null; then
  install -m 0644 -o root -g root "${TMP}/unit" "$UNIT_DST"
  CHANGED=1
fi
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service" >/dev/null
if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
  if [ "$CHANGED" -eq 1 ]; then
    say "Restarting ${SERVICE_NAME} to pick up the changes"
    systemctl restart "${SERVICE_NAME}.service"
  else
    say "Nothing changed; ${SERVICE_NAME} keeps running"
  fi
else
  say "Starting ${SERVICE_NAME}"
  systemctl start "${SERVICE_NAME}.service"
fi

say "Waiting for http://${PB_HTTP_EFFECTIVE}/api/health"
ok=0
for _ in $(seq 1 60); do
  if curl -fsS "http://${PB_HTTP_EFFECTIVE}/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  warn "PocketBase did not answer within 60 s. Recent log:"
  journalctl -u "${SERVICE_NAME}" -n 40 --no-pager >&2 || true
  die "service not healthy"
fi
say "PocketBase is running on ${PB_HTTP_EFFECTIVE}"

cat <<EOF

Next steps (details in server/README.md):

 1. Create the superuser (the server's administrator) right away:
      sudo -u ${SVC_USER} ${BIN} superuser create YOUR-ADMIN-EMAIL 'A-LONG-PASSWORD' --dir=${DIR}/pb_data
    (If your release has 'superuser upsert', it does the same and can also reset the password.)

 2. Open the admin UI from your own computer through an SSH tunnel (it is never exposed publicly):
      ssh -L 8090:${PB_HTTP_EFFECTIVE} YOUR-USER@THIS-MACHINE
    then browse to http://127.0.0.1:8090/_/ and sign in as the superuser.
    - Collections > users > New record: create the garden owner's account (email, password, verified).
    - Settings > Application: enable the rate limiter; set "User IP proxy headers" for your tunnel.

 3. Edit ${ENV_FILE}: set PB_ORIGINS to your app's address, then
      sudo systemctl restart ${SERVICE_NAME}

 4. Expose only the app's API paths through a tunnel:
      Cloudflare (own domain): server/cloudflared/README.md
      Tailscale Funnel (no domain): server/cloudflared/tailscale-funnel.md

 5. Check it:   ${DIR}/scripts/smoke.sh --local http://${PB_HTTP_EFFECTIVE} --public https://api.YOUR-DOMAIN
 6. Backups:    server/README.md, "Backups" (nightly backup.sh to a second disk)
EOF
