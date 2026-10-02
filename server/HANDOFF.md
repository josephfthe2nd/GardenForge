# Hand-off for the local session that installs and verifies the server

This folder was written in a cloud session that was **not allowed to run PocketBase, cloudflared or
Tailscale**. Everything here parses and was exercised against fakes built from the official docs, but nothing
has run against the real binary. The local session's job is to make it real: install, run the checks, fix what
the checks find, and report back. Treat every failure as a bug in this folder, not as a reason to skip a step.

## Ground rules for the local session

- Work on branch `audit/roadmap-and-small-fixes` (or a branch cut from it); never commit to `main`.
- Only change files under `server/` and `tools/tests/server.test.mjs` unless a check proves another file is
  wrong. Keep the repository root free of a `package.json` (Vercel would look for a build). Read `AGENTS.md`.
- Do not put secrets in the repository: superuser or owner passwords, impersonate tokens, tunnel credentials
  and `/etc/gardenforge/*.env` contents stay on the machine.
- Pinned PocketBase version: see `VERSION=` in `install.sh` (0.40.4 at hand-off, the newest release when the
  cloud session checked). The code was written from the v0.40 documentation. If a newer patch release exists
  and passes the integration test, pin that instead and say so in the report.
- Commit in small steps with messages that say what the real binary did differently from the draft.

## Sequence

1. On a dev machine with Node 18+ (can be the server itself):
   ```bash
   git clone https://github.com/josephfthe2nd/GardenForge.git && cd GardenForge
   git checkout audit/roadmap-and-small-fixes
   cd tools && npm install && npm test            # baseline: 17 pass, 1 skipped (the server test)
   ```
2. Get the binary once, without installing anything system-wide, and run the integration test against it:
   ```bash
   mkdir -p /tmp/pb && cd /tmp/pb
   # asset names are documented at the top of server/install.sh; adjust the arch (amd64 | arm64 | armv7)
   curl -fLO https://github.com/pocketbase/pocketbase/releases/download/v0.40.4/pocketbase_0.40.4_linux_amd64.zip
   unzip -o pocketbase_0.40.4_linux_amd64.zip && ./pocketbase --version
   cd /path/to/GardenForge/tools && POCKETBASE_BIN=/tmp/pb/pocketbase npm run test:server
   ```
   Expected: 20 tests pass. The items most likely to need a fix are listed under "Where the draft is least
   sure" below. Fix the hook, migration or test, re-run until green, commit.
3. On the server machine (Debian, Ubuntu or Raspberry Pi OS; amd64, arm64 or armv7), as root:
   ```bash
   sudo ./server/install.sh --dry-run
   sudo ./server/install.sh
   ```
   then follow `server/README.md` section 2 (superuser, the single owner account, `PB_ORIGINS` in
   `/etc/gardenforge/pocketbase.env`, rate limiter and trusted-proxy header in the dashboard over an SSH tunnel).
4. Tunnel: `server/cloudflared/README.md` (owner has a domain on Cloudflare) or
   `server/cloudflared/tailscale-funnel.md` (no domain). The owner logs in to their own Cloudflare or Tailscale
   account; the session only runs the documented commands.
5. Checks from the server and from a phone on cellular:
   ```bash
   /opt/gardenforge/scripts/smoke.sh
   /opt/gardenforge/scripts/smoke.sh --public https://<tunnel-hostname> --origin https://<app-origin>
   ```
   Expected: every public check passes, and `/_/` is unreachable through the tunnel.
6. Backups: configure `BACKUP_DIR` (a second disk or NAS), create the impersonate token as in README section 6,
   run `backup.sh` once by hand, confirm the zip lands and verifies, enable the timer.

## Where the draft is least sure (check these first when something fails)

- `--hooksDir` and `superuser upsert` were not in the documentation the draft used; `install.sh` greps
  `serve --help` for every flag it needs and aborts if one is missing.
- Release asset and checksum file names (`pocketbase_<V>_linux_<arch>.zip`, `checksums.txt`); armv7 naming
  is inferred.
- Whether `onRecordCreateRequest` on `gf_photos` can read the uploaded bytes (`getUnsavedFiles` or
  `findUploadedFiles`) to verify the SHA-256; if neither works every upload fails with 400 and the test shows it.
- `toBytes()` yielding plain 0-255 numbers for the pure-JS SHA-256; hashing speed on a Pi is unmeasured.
- Reading JSON fields back (`getString` versus `toString(record.get())`).
- `POST /api/backups` returning before the zip is complete (`backup.sh` polls for a stable size).
- cloudflared ingress path-regex semantics, Tailscale Funnel `--set-path` semantics, and which proxy header each
  adds; the in-process allowlist in `gardenforge_sync.pb.js` and the ingress regex must agree.
- systemd hardening lines; relax one at a time if the service fails to start, and record which.

## What to report back (paste into the main thread)

- PocketBase version pinned and the exact asset names that worked.
- Integration test result (count passed) and every change made to get there, with the commit hashes.
- `smoke.sh` output, local and public, plus the tunnel hostname and which tunnel option was used.
- Backup: where the first zip landed, its size, and that `unzip -t` passed.
- Anything in `server/README.md` section 10 that the owner should decide before the client work starts.
- Anything you could not complete and why.
