# GardenForge sync server (self-hosted PocketBase)

> **Status: NOT YET EXECUTED.** Every file in this folder was written from PocketBase's official
> documentation (v0.39/v0.40) without ever running PocketBase, the installer, cloudflared or
> Tailscale: the development sandbox does not allow downloading or running external programs.
> Treat it as a careful draft. Before the GardenForge app depends on it, the owner (or a session
> allowed to run the binary) must run, in this order: `install.sh --dry-run`, `install.sh`,
> `smoke.sh`, and the integration test `tools/tests/server.test.mjs`. Anything that fails is a bug
> in this folder, not something to work around on the server.

## What this is

The server half of GardenForge's multi-device sync (decision recorded in
`docs/SYNC-ARCHITECTURE.md`, section 0). The app stays local-first: it keeps working offline and
syncs when it can reach this server.

```
 iPhone / PC (GardenForge PWA)                       your machine (Pi, old PC, NAS, small VPS)
 ------------------------------        HTTPS          ---------------------------------------------
  local IndexedDB + change log  <---------------->  Cloudflare tunnel   -->  PocketBase on 127.0.0.1:8090
                                  only /api/...      or Tailscale Funnel      - SQLite database (pb_data/data.db)
                                  paths the app                               - photos (pb_data/storage)
                                  needs                                       - pb_hooks: /api/gf/sync/*
                                                                              - admin UI /_/  (SSH tunnel only)
```

[PocketBase](https://pocketbase.io) is a single program: a SQLite database, sign-in, file storage,
an admin web page ("dashboard", at `/_/`) and a small JavaScript engine for custom endpoints. This
folder adds:

- a **schema** (`pb_migrations/`): collections `gf_records`, `gf_conflicts`, `gf_applied_ops`,
  `gf_counters`, `gf_photos`, and closed sign-ups;
- **sync endpoints** (`pb_hooks/`): `POST /api/gf/sync/push`, `GET /api/gf/sync/pull`,
  `GET /api/gf/sync/status`, plus server-side checks;
- an **installer**, a **systemd service**, **backup**/**restore** procedures, **tunnel**
  configurations and a **smoke test**.

## What the owner must provide

- An always-on machine running Debian, Ubuntu or Raspberry Pi OS (64-bit recommended; amd64,
  arm64 or armv7), with `sudo`, about 1 GB free disk to start, plus room for photos.
- **Either** a domain whose DNS is on Cloudflare (about $10-15 a year) for a Cloudflare tunnel,
  **or** a free Tailscale account (no domain needed).
- The address the app is served from (your Vercel site), for CORS.
- Two passwords kept in a password manager: the **superuser** (server administrator; never used
  in the app) and the **garden owner** account (used to sign in from the phone and the PC).
- A **second disk or NAS** for nightly backups, and a plan for an off-site copy.
- Node.js 18 or newer on some machine, to run the integration test (the server itself does not
  need Node).
- Calendar reminders: renew the backup token before it expires; check for PocketBase updates
  monthly.

## 1. Install (one command)

On the server, from a checkout of this repository:

```bash
git clone https://github.com/OWNER/GardenForge.git && cd GardenForge
sudo ./server/install.sh --dry-run      # prints what it would do; changes nothing
sudo ./server/install.sh                # defaults: --version 0.40.4 --dir /opt/gardenforge
                                        #           --user gardenforge --http 127.0.0.1:8090
```

The installer downloads PocketBase for your CPU from GitHub, verifies it against the release's
checksums file, creates the `gardenforge` system user and `/opt/gardenforge/{bin,pb_data,
pb_hooks,pb_migrations,scripts}`, creates `/etc/gardenforge/pocketbase.env`, and installs and
starts `gardenforge-pocketbase.service`. Re-running it is safe: it never touches existing data,
never overwrites your settings file, and only restarts the service when something changed. The
release asset names it relies on are listed at the top of `install.sh` (**verify on first
install**).

On first start PocketBase applies `pb_migrations/1790899200_gardenforge_v1.js`. If that fails the
service will not start; see the log with `journalctl -u gardenforge-pocketbase -n 100`.

## 2. First-time setup

### Superuser (do this immediately after installing)

```bash
sudo -u gardenforge /opt/gardenforge/bin/pocketbase superuser create ADMIN-EMAIL 'A-LONG-PASSWORD' \
  --dir=/opt/gardenforge/pb_data
```

`superuser create EMAIL PASS` is the documented command. Newer releases also have
`superuser upsert` (create or reset the password); it is not in the documentation this folder
was written from, so check `pocketbase superuser --help`.

### Admin UI

The admin UI is never published through the tunnel. Reach it from your computer with an SSH port
forward:

```bash
ssh -L 8090:127.0.0.1:8090 YOU@YOUR-SERVER
# then open http://127.0.0.1:8090/_/ in your browser and sign in as the superuser
```

### Owner account

In the admin UI: **Collections > users > + New record**: the owner's email, a password (twice),
tick **verified**, save. Public sign-up is closed, so this is the only way accounts are created.

### Settings (admin UI > Settings)

- **Application > Rate limiting:** turn it on (PocketBase calls this "highly recommended"). Keep
  a strict rule on sign-in (for example `*:auth`, 10 requests per 60 s) and a generous one for
  `/api/gf/` (for example 120 per 60 s). Exact defaults vary by release.
- **Application > User IP proxy headers:** `CF-Connecting-IP` with Cloudflare,
  `X-Forwarded-For` with Tailscale (see the tunnel guides). Without it every visitor looks like
  `127.0.0.1`.
- **Application > Superuser IPs** (PocketBase 0.38+): optional. Caution: the tunnel connects from
  `127.0.0.1` too, so allowing `127.0.0.1` does not by itself separate tunnel traffic from local
  use. The superuser API is already unreachable through the tunnel (section 4).
- **Mail settings:** not needed. GardenForge does not send email.
- **Backups:** leave PocketBase's built-in schedule off; `backup.sh` (section 6) runs the backups
  and copies them off the data disk.

### CORS origins

Edit `/etc/gardenforge/pocketbase.env`:

```ini
PB_ORIGINS=https://your-site.vercel.app
```

Comma-separate several origins (for example a preview URL), no trailing slash. Then
`sudo systemctl restart gardenforge-pocketbase`. Until you do, browsers are refused (the
placeholder origin matches nothing).

## 3. Make it reachable from the phone

PocketBase listens only on `127.0.0.1`. A tunnel on the same machine makes the app's paths
reachable over HTTPS, and nothing else:

- **Own domain on Cloudflare:** `server/cloudflared/README.md` (named tunnel, explicit path list,
  everything else 404 at Cloudflare's edge).
- **No domain:** `server/cloudflared/tailscale-funnel.md` (Tailscale Funnel with path mounts, or
  private Tailscale Serve).

## 4. Check it: the smoke test

```bash
/opt/gardenforge/scripts/smoke.sh                                       # local checks only
/opt/gardenforge/scripts/smoke.sh --public https://api.example.com \
  --origin https://your-site.vercel.app                                 # plus tunnel and CORS
```

It checks: health; `/api/gf/sync/status` answers 401 without a token; public sign-up is closed;
locked collections refuse access; through the tunnel, `/_/`, superuser sign-in, backups,
settings, collections, realtime and the admin route all answer 404, while owner sign-in answers.
Run it after installing, after any tunnel change and after every update. Exit status = number of
failures.

## 5. Integration test (run before the client work starts)

Exercises everything with a throw-away database on a random localhost port; it never touches the
live data.

```bash
cd tools
POCKETBASE_BIN=/opt/gardenforge/bin/pocketbase npm run test:server
# or, without the npm script:
POCKETBASE_BIN=/opt/gardenforge/bin/pocketbase node --test tests/server.test.mjs
```

No `npm install` is needed for this test (Node built-ins only). Without `POCKETBASE_BIN` the test
reports itself as skipped, so the normal `npm test` stays green on machines without PocketBase.
`GF_SERVER_LOGS=1` prints PocketBase's output; `GF_KEEP_TMP=1` keeps the temporary data directory.

## 6. Backups

PocketBase's backup API writes a ZIP of the whole `pb_data` directory: the database **and the
photos** (PocketBase docs, "Backup and Restore"). `scripts/backup.sh` asks for one, copies it to
`BACKUP_DIR`, checks it (ZIP integrity, `data.db` present, photos present when there are any),
stores its SHA-256, removes PocketBase's local copy, and deletes backups older than
`BACKUP_KEEP_DAYS`.

1. Set `BACKUP_DIR` (on another disk) and `BACKUP_KEEP_DAYS` in `/etc/gardenforge/pocketbase.env`.
2. Create a long-lived superuser token: admin UI > **Collections > _superusers** > select your
   superuser > **Impersonate**, choose a duration (for example 31536000 seconds = one year), copy
   the token. PocketBase calls this its form of "API key"; it cannot be refreshed, so note the
   expiry date. Store it readable by root only:

   ```bash
   sudo install -m 600 -o root -g root /dev/null /etc/gardenforge/backup.env
   sudo nano /etc/gardenforge/backup.env      # one line: PB_BACKUP_TOKEN=eyJ...
   ```

   To revoke it early, change the superuser's password.
3. Run it once by hand and look at the result: `sudo /opt/gardenforge/scripts/backup.sh`.
4. Schedule it nightly with a systemd timer:

   ```ini
   # /etc/systemd/system/gardenforge-backup.service
   [Unit]
   Description=GardenForge nightly backup
   After=gardenforge-pocketbase.service

   [Service]
   Type=oneshot
   ExecStart=/opt/gardenforge/scripts/backup.sh
   ```

   ```ini
   # /etc/systemd/system/gardenforge-backup.timer
   [Unit]
   Description=Run the GardenForge backup every night

   [Timer]
   OnCalendar=*-*-* 03:17:00
   RandomizedDelaySec=10min
   Persistent=true

   [Install]
   WantedBy=timers.target
   ```

   ```bash
   sudo systemctl daemon-reload && sudo systemctl enable --now gardenforge-backup.timer
   systemctl list-timers gardenforge-backup.timer     # next run
   journalctl -u gardenforge-backup -n 50             # last runs; a failure shows here
   ```

   Or with cron: `/etc/cron.d/gardenforge-backup` containing
   `17 3 * * * root /opt/gardenforge/scripts/backup.sh >> /var/log/gardenforge-backup.log 2>&1`.
5. Copy `BACKUP_DIR` off the machine regularly (another computer, a NAS in another room, or an
   encrypted cloud copy): one disk, one fire or one theft should never take every copy.

No token? `backup.sh --mode offline` stops PocketBase for a few seconds, archives `pb_data` with
`tar` and starts it again. Exit codes: 0 ok, 1 error, 2 configuration, 3 token rejected.

**Restore:** `server/restore.md`. Rehearse it once, and rotate the epoch after any restore.

## 7. Updating

**GardenForge server code** (after `git pull`): `sudo ./server/install.sh`. It copies changed
hooks and migrations and restarts the service.

**PocketBase itself** (check the release notes monthly):

1. Read PocketBase's changelog for every version between yours and the new one, especially
   anything about the JavaScript hooks (JSVM), migrations or API rules.
2. Make a backup (`sudo /opt/gardenforge/scripts/backup.sh`).
3. Test the new version **before** switching: download and verify it by hand into a scratch
   folder (the URL pattern is at the top of `install.sh`) and run the integration test with
   `POCKETBASE_BIN=/path/to/new/pocketbase`.
4. `sudo ./server/install.sh --version X.Y.Z --i-have-a-backup` (it refuses to replace the binary
   over existing data without that flag). The previous binary is kept as
   `/opt/gardenforge/bin/pocketbase.prev`.
5. Run `smoke.sh`.
6. Rollback if needed: `sudo systemctl stop gardenforge-pocketbase`, move `pocketbase.prev` back
   to `pocketbase`, start again. If the new version already changed the database in a way the old
   one cannot read, restore the backup from step 2 (`restore.md`).

## 8. API for the client sync engine

All endpoints need `Authorization: <token>` from the owner's sign-in. Limits are enforced by the
server; a rejected request stores nothing.

### Sign-in (standard PocketBase)

- `POST /api/collections/users/auth-with-password` `{"identity": email, "password": ...}` →
  `{"token", "record"}`. Invalid credentials → 400.
- `POST /api/collections/users/auth-refresh` (with the current token) → a fresh token.
- Changing the owner's password in the admin UI invalidates every issued token (lost device).

### `POST /api/gf/sync/push`

```jsonc
{
  "deviceId": "dev_7b1e…",               // 1-80 chars: A-Z a-z 0-9 . _ : -
  "ops": [{                              // 0-500 ops, applied in order, ALL OR NOTHING
    "opId": "4f0e…",                     // 1-80 chars, same alphabet; re-sending it is a safe retry
    "rid": "plant_123",                  // 1-200 chars, no control characters, unique per owner
    "t": "planting",                     // 1-40 chars, a letter then letters/digits/_; fixed per rid
    "baseRev": 3,                        // server rev this edit started from; 0 = never synced
    "data": { … },                       // JSON object, at most 65,536 bytes as UTF-8 JSON;
                                         //   may be null or absent only when deleted is true
    "deleted": false,                    // optional
    "clientUpdatedAt": "2026-10-01T15:02:11.204Z" // 1-64 chars, ISO-8601 or HLC: ONE format, always
  }]
}
```

Whole request at most 16 MiB. Reply 200:

```jsonc
{
  "results": [{
    "opId": "…", "rid": "…",
    "status": "applied" | "conflict" | "replayed",
    "rev": 4, "serverSeq": 17,
    "record": { "rid", "t", "data", "rev", "deleted", "deviceId", "clientUpdatedAt", "serverSeq", "originOp" },
    "conflict": true, "conflictId": "…", "loser": "incoming" | "stored",   // conflicts only
    "originalStatus": "applied" | "conflict"                               // replays only
  }],
  "serverSeq": 17,          // the owner's latest sequence number
  "epoch": "…"              // changes only after a restore (section 6 / restore.md)
}
```

Rules, per op:

- **Replay:** an `opId` already applied returns the stored result unchanged, with
  `status: "replayed"` and the first outcome in `originalStatus`.
- **New record:** stored with `rev` 1 (any `baseRev` is ignored).
- **Fast-forward** (`baseRev` equals the server's `rev`): stored, `rev` + 1, new `serverSeq`.
- **Conflict** (`baseRev` differs): the version with the greater `clientUpdatedAt` (plain string
  comparison; a tie keeps the server's version) becomes the record with `rev` + 1 and a new
  `serverSeq`, even when the server's version wins, so every device pulls the outcome. The other
  version is stored in `gf_conflicts` first, in the same transaction, and is never deleted.
- **Delete:** `deleted: true` keeps the data (the op's, or the server's if the op sent none).
- Errors: 400 invalid input, 401 missing/expired token, 403 not an owner token, 409 an op tried
  to change a record's `t`, 413 request too large. Any error means nothing in the batch was
  stored.

### `GET /api/gf/sync/pull?since=<serverSeq>&limit=<1..1000, default 500>`

```jsonc
{
  "records": [ /* envelopes as above, serverSeq > since, ascending, tombstones included */ ],
  "conflicts": [{ "id", "rid", "t", "opId", "loserData", "loserRev", "loserDeleted",
                  "loserDeviceId", "loserClientUpdatedAt", "winnerRev", "serverSeq", "resolved" }],
  "cursor": 17,              // pass as the next "since"
  "more": false,             // true: call again with since = cursor
  "serverSeq": 17, "epoch": "…",
  "cursorAhead": false,      // true: since > serverSeq, so reset to 0 and resync
  "serverTime": "2026-10-02T03:17:00.000Z"
}
```

`conflicts` holds the unresolved conflict copies created within `(since, cursor]`. All of them,
any time: `GET /api/collections/gf_conflicts/records?filter=(resolved=false)&sort=server_seq`.
Mark one handled: `PATCH /api/collections/gf_conflicts/records/<id>` `{"resolved": true}` (the
only field an owner may change).

### `GET /api/gf/sync/status`

`{"serverSeq", "epoch", "records", "conflictsUnresolved", "photos", "serverTime",
"pocketbaseVersion"}`. `records` counts tombstones too. `pocketbaseVersion` may be empty (how
PocketBase exposes its version to hooks is not documented).

### Photos (standard PocketBase record API on `gf_photos`)

1. Dedupe first: `GET /api/collections/gf_photos/records?filter=(sha256='<hex>')`.
2. Upload: `POST /api/collections/gf_photos/records` as `multipart/form-data` with `owner` (the
   signed-in user's id), `sha256` (64 lowercase hex of the exact bytes), `width`, `height`, and
   `file` (JPEG, PNG or WebP, at most 25 MiB). The server re-computes SHA-256 and rejects a
   mismatch (400), sets `bytes` and `mime` itself, and answers 409 if this owner already has that
   hash (treat 409 as success). Photos cannot be changed or deleted through the API.
3. Download: `POST /api/files/token` → `{"token"}` (short-lived, about 2 minutes), then
   `GET /api/files/gf_photos/<recordId>/<file>?token=<token>`. Files are protected: no token, or
   another user's token, gets an error.

Verifying the hash on the server means hashing in the server's JavaScript engine, which is slow:
very roughly a second per megabyte on a Raspberry Pi (an estimate, not measured). GardenForge's
photos are about 150-400 KB.

### Administration (superuser only, not reachable through the tunnel)

`POST /api/gf/admin/rotate-epoch` → `{"rotated": n}`. Run after a restore (`restore.md`).

## 9. Security notes

- **Owner-only accounts.** `users.createRule` is locked (superusers only) and a hook rejects any
  other sign-up attempt; OAuth2 is off, and a hook stops it from creating accounts if it is ever
  enabled. A stolen session cannot delete the account (`users.deleteRule` locked), which would
  otherwise cascade-delete the garden.
- **Least privilege per collection.** The owner can read their own `gf_records`, `gf_conflicts`
  and `gf_photos` and nobody else's. Records are written only through the push endpoint, which
  takes the owner from the token, never from the request body. Conflict copies can only be marked
  resolved. `gf_applied_ops` and `gf_counters` are locked entirely. Photos are immutable and served
  only with a short-lived file token.
- **Admin surface not exposed.** The tunnel forwards an explicit list of paths; PocketBase itself
  answers 404 to proxied requests outside that list (a second layer, recognising tunnel traffic by
  headers such as `CF-Connecting-IP`/`X-Forwarded-For`). The admin UI and superuser API are used
  only over SSH.
- **HTTPS from the tunnel.** TLS ends at Cloudflare's edge or at Tailscale; the last hop is
  `127.0.0.1` on the same machine. Never set `PB_HTTP` to a public interface.
- **Rate limits.** Turn on PocketBase's rate limiter (section 2) and set the proxy header so
  limits apply per visitor, not to everyone at once.
- **Secrets stay on the server.** The app holds only its session token. The backup token lives in
  a root-only file; the tunnel credentials in `/etc/cloudflared` (mode 600). Nothing secret is in
  this repository.
- **Service hardening.** PocketBase runs as an unprivileged user that can write only `pb_data`;
  its hooks and migrations are root-owned and read-only (see `pocketbase.service`).
- **Keep the OS patched** (for example Debian's `unattended-upgrades`) and update PocketBase
  (section 7).

## 10. Differences from `docs/SYNC-ARCHITECTURE.md` section 4 (to settle before the client work)

This server implements the simpler protocol it was specified with, not every rule of section 4:

1. **Conflict rule:** whole-record, newest `clientUpdatedAt` wins, loser kept in `gf_conflicts`.
   Section 4.6's three-way field merge (`merged`), "edit beats delete" and "same content is
   `unchanged`" are not implemented. Nothing is lost either way, but under this rule a newer delete
   beats an older edit (the edit waits in `gf_conflicts` for review).
2. **No `record_history`:** a fast-forward overwrites the previous server version; only conflict
   losers are kept. Older versions exist only in backups.
3. Statuses are `applied | conflict | replayed`; there is no per-op `rejected` (an invalid op
   rejects the whole batch with 400/409).
4. Field names: `records/cursor/more` instead of `rows/next_since/has_more`; `rid`, `t`,
   `clientUpdatedAt` instead of `collection`, `id`, `hlc`/`updatedAt`. Batch limit 500 (section
   4.5 says 200 per call, which fits).
5. `rid` is unique per owner across all types (up to 200 characters). `docs/DATA-MODEL.md` keys records by
   type and id; the two agree as long as every id keeps its type prefix, which is now a stated rule there
   (section 10): an id is never reused for a different type.
6. No `devices` table, no clock-skew clamp, `gf_applied_ops` never pruned, only the original photo
   is stored (thumbnails are regenerated on each device, as `docs/DATA-MODEL.md` 6.7 says).
7. **Epoch** (not in section 4): a value that changes after a restore, telling devices to resync
   and re-send their changes.

## Files in this folder

| File | Purpose |
| --- | --- |
| `README.md` | This runbook. |
| `install.sh` | Installer: download + verify PocketBase, user, directories, settings, service. |
| `pocketbase.service` | systemd unit (installed as `gardenforge-pocketbase.service`). |
| `env.example` | Settings template (`PB_HTTP`, `PB_ORIGINS`, `BACKUP_DIR`, `BACKUP_KEEP_DAYS`). |
| `pb_migrations/1790899200_gardenforge_v1.js` | Collections, fields, indexes, API rules; closes sign-ups. |
| `pb_hooks/gardenforge_sync.pb.js` | Sync endpoints, tunnel allowlist, sign-up/photo/conflict hooks. |
| `pb_hooks/gardenforge_lib.js` | Shared logic: validation, push algorithm, SHA-256, allowlist. |
| `backup.sh` | Nightly backup (PocketBase backup API, or offline tar). |
| `restore.md` | Restore procedures and the post-restore epoch rotation. |
| `smoke.sh` | Post-install checks, local and through the tunnel. |
| `cloudflared/README.md`, `cloudflared/config.yml.example` | Cloudflare named tunnel. |
| `cloudflared/tailscale-funnel.md` | Tailscale Funnel / Serve for owners without a domain. |

The integration test is `tools/tests/server.test.mjs`.
