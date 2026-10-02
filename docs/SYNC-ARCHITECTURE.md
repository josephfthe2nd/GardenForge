# GardenForge sync architecture: decision record

Status: **Proposed. Waiting for the owner's decision.** Nothing has been provisioned (see section 7).
Date: 2026-10-01. Applies to GardenForge 1.2.x (schema v1). Read `AGENTS.md` first.

This document chooses how GardenForge moves from "one device, manual backups" to "the same garden on the
iPhone and a PC, working offline". It was written from six independent architecture proposals and two
independent judges' scorings. Facts marked **verified 2026-10-01** were checked on that date. Anything marked
**UNVERIFIED** comes from training knowledge or a search snippet and must be re-checked before money or data
depends on it.

---

> **How this document was produced, and the one decision it leaves to the owner.** Six independent
> proposals (Supabase-direct, Vercel-native, Cloudflare-native, Firebase, hosted sync engines, user-owned Google
> Drive) were scored by two reviewers against requirements R1-R14 and then merged into this record. The reviewers
> split on first place: one preferred Supabase-direct, the other a Vercel Functions + Neon + Cloudflare R2 stack.
> Both agree on everything else: the local change log, the push/pull protocol, content-addressed photos, and that
> Firebase and Google Drive rank last. The remaining choice is therefore the owner's and it is mostly about money
> versus maintenance: about $300 a year buys managed sign-in, daily backups and no project pausing (Supabase Pro);
> about $0 a year means either accepting a free project that pauses after a quiet week and has no backups, or
> owning the sign-in and session code yourself (the fallback stack). Requirement R10 is met by both routes in
> different ways: Supabase's publishable key is public by design and Row Level Security is the boundary, while the
> fallback keeps every credential on the server. Nothing has been provisioned, and nothing should be until the
> iPhone spike in the summary below has run and the owner has chosen.

## 0. Decision taken by the owner (2026-10-01): self-hosted PocketBase

After reading the comparison the owner chose to **self-host the backend** rather than pay for Supabase Pro or
accept a free project that pauses. This section records that decision; sections 1 to 8 below are the comparison
it was made from and stay as written.

**What changes.** Only the server. The client sync engine, local change log, push/pull protocol, conflict rule,
content-addressed photo pipeline and sync-state machine in section 4 are unchanged. The server is
[PocketBase](https://pocketbase.io): one Go binary with SQLite, built-in email/password auth, file storage on the
server's own disk, an admin UI, and JavaScript hooks that implement the same `sync/push`, `sync/pull` and
`sync/status` endpoints described in section 4.5. Photos are files under the server's data directory, keyed by
SHA-256 with a per-owner unique index, so a photo is stored once. Every credential stays on the server; the app
holds only a session token, which is the strongest reading of requirement R10.

**Where it runs.** On a machine the owner controls (Raspberry Pi, old PC, NAS, or a small VPS), reachable from
the garden over a free tunnel: a Cloudflare named tunnel when the owner has a domain on Cloudflare, or Tailscale
Funnel when there is no domain (stable `*.ts.net` hostname). The tunnel exposes only `/api/*`; the admin UI is
reached over the LAN or an SSH tunnel. Setup files and the runbook are under `server/`.

**Cost.** $0 recurring on hardware the owner already has; a domain is about $10–15 a year if a Cloudflare tunnel
is used; a VPS alternative is roughly $4–6 a month. Electricity for a Pi is negligible.

**What the owner takes on.** Nightly backups to a second location (the scripts under `server/` do this, but
the second location is the owner's to provide), applying PocketBase updates, and keeping the machine on. If the
machine is off, the app keeps working offline and syncs when it returns; nothing is lost, nothing merges until
then.

**Verification status.** The `server/` component was written from PocketBase's official documentation for
v0.39 and has **not been executed**: this sandbox's policy does not allow building or running external binaries.
The integration test in `tools/tests/server.test.mjs` and the smoke script must be run on the owner's machine (or
in a session permitted to run the binary) before the client work in Phase 1 starts. Supabase-direct (section 1)
remains the fallback if self-hosting proves impractical.

---

## 1. Summary and recommendation

**Primary stack: Supabase (Postgres + Auth + Storage, guarded by Row Level Security), called directly from the
existing static PWA, with Vercel Functions used only for privileged jobs (photo garbage collection, and later
the AI endpoint).**

- Each device keeps a complete local copy in IndexedDB and a durable outbox. The app never waits on the network.
- Sync is two Postgres functions: `sync_push` (idempotent, serialized per user under an advisory lock,
  revision-checked) and `sync_pull` (everything after a monotonic `server_seq` cursor, tombstones included).
- Conflicts are detected by revision number. Disjoint field edits merge automatically. When both devices change
  the same field, the newer edit by hybrid logical clock (HLC) wins, and **the losing version is written to a
  `conflicts` table in the same transaction, mirrored on every device, and shown as "Needs attention". It is
  never discarded.**
- Photos are re-encoded and hashed on the device. Each JPEG is stored once in a private bucket under its
  SHA-256 (`u/{uid}/o/{sha256}.jpg`), with a 320 px thumbnail made on the device. Images never go into the database.
- Sign-in by default is **email plus a strong password saved in iCloud Keychain**, typed inside the Home Screen
  app. There is no redirect, no popup, no cookie and no email vendor. An emailed 6-digit code and Supabase
  passkeys (beta) are optional later additions. See section 4.9 for why this differs from the proposal.
- Cost: **$0 on Supabase Free through Phase 1** (records only). For photo sync (Phase 2) the recommendation is
  **Supabase Pro at $25/month (about $300/year), flat through year 10 at the stated scale.** Free has 1 GB of file
  storage (about one year of photos), no automated backups, and pauses after about 7 days of low database activity.
  The upgrade needs the owner's explicit approval.
- **Cost-down variant (same primary, ~$0/year):** keep Supabase Free for auth and records, and put photos in
  Cloudflare R2 through one Vercel Function that issues presigned URLs. In exchange the owner accepts Free's pause
  and no-backup terms and a second vendor. Photo transport sits behind a `BlobStore` adapter, so this is a
  contained change and can be decided at Phase 2.

**Fallback stack: Vercel Functions + Neon Postgres (Free) + Cloudflare R2.** It uses the same Postgres schema,
the same push/pull protocol and the same client sync engine. Only the transport and auth modules change. It
costs about $0/year and has the strongest credential posture (the client holds only an HttpOnly first-party
cookie). Its cost is engineering ownership: the owner's code must handle auth (password or emailed code, plus
optional passkeys), sessions and CSRF. Use it if the owner rejects Supabase as a vendor, or if the Phase-1
iPhone spike fails in a way specific to Supabase.

**Why this choice.** Across the two judges, Supabase-direct had the highest average score (76.5 and 76). Both
judges put it in their top two. It is the only option that combines four things:

- conflict handling run on the server inside one transaction, under a lock;
- managed authentication, so the owner writes no auth or session code;
- one data vendor with a standard Postgres dump and an open-source server, so the exit path is credible;
- an in-app sign-in flow that does not depend on iOS redirect behaviour.

Its weaknesses are cost (about $300/year to store 1-10 GB, against cents for raw object storage) and the fact
that RLS is the only security boundary. This document addresses both: the cost-down variant for the first, and
section 4.10 (no direct table writes, CI RLS assertions, a second-user isolation test) for the second.

**Not chosen:**

- Dexie Cloud: least code, but a small vendor's proprietary sync server for 10 years.
- Cloudflare Workers + D1 + R2: cheapest, but two clouds, and its push algorithm as written cannot be built on
  D1.
- Firebase: R7 depends on working around silent SDK rollbacks, and the Blaze plan has no hard spending cap.
- Google Drive: iOS standalone OAuth is fragile, and the merge runs only on clients with nothing to arbitrate.

**Gate before any build work that touches the cloud:** a 1-2 day spike on the owner's actual iPhone, in Home
Screen mode, against a Supabase Free project (no card) that is reset afterwards and reused for Phase 1. It must
show:

- password sign-in with Keychain autofill works;
- the session survives app kills, reloads and a week of normal use;
- offline edits made while signed in sync later;
- optionally, passkey enrolment and sign-in work.

Go or no-go is decided on that result.

---

## 2. Requirements recap (R1-R14)

| ID | Requirement | How the recommended design meets it | Residual risk |
| --- | --- | --- | --- |
| R1 | Same garden account on phone and PC | One Supabase Auth user. Every device signs in once and syncs the same RLS-scoped rows and bucket prefix. | None beyond sign-in on each device. |
| R2 | Offline changes queue and sync later; app useful offline | IndexedDB is the source of truth. A durable outbox and blob queue survive restarts. Sync runs on app open, `online`, focus, 2 s after an edit and every 60 s while visible. | iOS has no Background Sync for web apps (UNVERIFIED for current iOS), so syncing happens only while the app is open. |
| R3 | Photos sync between devices | Private Storage bucket. Thumbnails download eagerly to other devices; originals download on demand or with "Download all originals". | Uploads also run only in the foreground. |
| R4 | No repeated uploads of identical photos | The object key is the SHA-256 of the stored JPEG. A batch existence query runs before upload, `upsert:false` makes a 409 count as success, and `sourceSha256` catches the same camera-roll image picked again. | Re-encoding the same original on a different device can give different bytes; `sourceSha256` covers this only per photo record. |
| R5 | Preserve timestamps and metadata | Client `updatedAt`, HLC, `deviceId`, server time and `rev` are separate fields. Photo `createdAt`, height, unit, stage and note migrate verbatim. New `takenAt` comes from EXIF before re-encoding. | Existing v1 records have no per-record timestamps (only a document-level `updatedAt`). |
| R6 | Predictable conflict handling | Revision-based detection, three-way field merge, then per-field newest-HLC-wins with a `deviceId` tie-break. Edit beats delete. The rule runs server-side under a per-user lock, so every device gets the same answer. | Field LWW depends on device clocks. HLC, server clamping and a clock-skew warning reduce this. |
| R7 | Never silently discard a newer record | Every overwritten version goes to `record_history`. Every losing version also goes to `conflicts` in the same transaction, is mirrored locally and keeps the pill at "Needs attention" until reviewed. Tombstones never beat edits. | Correctness depends on the SQL being right, so a shared test-vector suite runs against both the SQL and a JS reference. |
| R8 | Existing data migratable | On-device, non-destructive v1 to v2 migration that keeps ids and timestamps. The v1 localStorage key and `gardenforge.photos.v1` stay untouched until the owner confirms. | v1 `validateState` caps each collection at 1,500 items; v2 must raise this while still accepting v1 backups. |
| R9 | Backups independent of cloud | Existing JSON export stays. A new "Full backup (.zip)" includes photos and is built from the local DB, so it works offline, signed out, with sync off. Optional owner `pg_dump`. | Today's backup excludes photos; Phase 0 fixes that before any cloud work. |
| R10 | No privileged credentials in client JS | Only the project URL and publishable key ship, and both are public by design. The secret key, AI key and cron secret live in Vercel env. | RLS is the only boundary. Section 4.10 makes the checks mandatory. |
| R11 | Auth that works in iOS standalone mode | Password with Keychain autofill typed in-app: no redirects, no popups, no cookies (session in the app's own localStorage). An emailed code or passkey can be added later. | Keychain autofill inside standalone mode is UNVERIFIED and is checked by the spike. |
| R12 | Years of photos without blobs in the DB | Object storage for JPEGs; Postgres holds only metadata (estimated tens of MB per year). About 10 GB at year 10 sits inside Pro's included 100 GB. | Device cache growth on the iPhone; handled by a manual "Free up space". |
| R13 | Sync state UI | A derived state machine: Saved locally / Syncing / Synced / Needs attention, with exact transitions (section 4.8). | None. |
| R14 | Vercel-compatible; owner approves paid infra; later server-side AI | The static site stays on Vercel Hobby with no build step and no root `package.json`. Functions are dependency-free and added only in Phases 2-3. Free needs no card, so nothing can bill without an explicit upgrade. `/api/identify` keeps the AI key server-side. | Vercel Hobby is for personal, non-commercial use only. |

---

## 3. Options compared

Costs are per year at the stated scale: 1 user, 2-3 devices, about 3,000 photos/year at about 300 KB plus a
20 KB thumbnail (about 1 GB/year, about 10 GB after 10 years), and about 20,000 small records/year. They assume
today's price lists. Every unit price and limit behind these figures, with its source and verification status,
is in section 5. "Judges" gives the two judges' weighted totals out of 100.

| Option | How sync works | Auth on iPhone PWA | Where secrets live | Photo storage | Free tier & gotchas | Est. cost yr1 / yr5 / yr10 | Lock-in | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **A. Supabase-direct** (Postgres + Auth + Storage + RLS; Vercel Functions for privileged jobs only) | IndexedDB outbox → `sync_push` RPC (idempotent by `op_id`, per-user advisory lock, revision check, loser written to `conflicts` in the same transaction) → `sync_pull(since server_seq)` with tombstones. | Proposal: 6-digit email code typed in-app. This document: email + Keychain password by default, with code or passkey (beta) optional. Session lives in the PWA's own localStorage; no cookies. | Publishable key in client (public by design). Secret key, cron secret and AI key in Vercel env. RLS is the only data boundary. | Supabase Storage private bucket, `u/{uid}/o/{sha256}.jpg` + thumbnail; no UPDATE or client DELETE policy. | Free: 500 MB DB, 1 GB files, 5 GB egress. Free pauses after ~7 days of low DB activity (restore within 1 year). No backups on Free. Built-in auth email is 2/hour, and new Free projects cannot edit email templates without custom SMTP. | **$0-300 / $300 / $300** (Pro from photo go-live). Cost-down variant (Free + R2 photos): **$0 / $0 / under $1**. | Low-moderate: `pg_dump`, open-source server, S3-style keys. Auth identities are the sticky part. | **Primary.** Judges 76.5 / 76. |
| **B. Vercel Functions + Neon Postgres + Cloudflare R2** (judge 2's variant of the Vercel-native proposal) | Same protocol as A, implemented in Vercel Functions over Neon: advisory lock, receipts, `record_history`, three-way merge. | Self-hosted: password or typed email code (e.g. Resend), plus passkeys via SimpleWebAuthn. First-party HttpOnly cookie on the app's origin. | All server-side: `DATABASE_URL`, R2 token and AI key in Vercel env. Client holds an HttpOnly cookie and signed URLs that last minutes. Best R10 posture. | R2 private bucket, content-addressed. Upload through a Function or a presigned PUT followed by a server hash check. | Neon Free: 1 GB/project, 100 CU-h, 5 GB transfer, scale-to-zero after 5 min (cold starts), 6-hour restore window only. R2: 10 GB-month free, free egress. Vercel Hobby features are blocked for 30 days when over limit. Adds a root `package.json` unless the Functions are dependency-free. | **$0 / $0 / under $1** (plus about $2-3/month Neon Launch if history is never compacted; proposal estimate). | Low. | **Fallback.** The Vercel-native proposal as written scored 74.5 / 77. |
| **C. Vercel-native as proposed** (Neon + private Vercel Blob + self-hosted passkeys/OTP) | Same as B. | Same as B. | Same as B, with a Blob token instead of an R2 token. | Private Vercel Blob. The server recomputes SHA-256; downloads use signed GET URLs. | Blob on Hobby: 1 GB storage and 2,000 advanced ops/month, so it fills at about month 10-12. Over the limit, Blob is blocked for 30 days; whole-team pauses are reported in community threads (disputed). Vercel Pro is $20/seat. | **$0-60 / $240 / $240-265** | Low-moderate. | Not chosen: the Blob cap forces Vercel Pro, with the same code burden as B at a higher cost. Judges 74.5 / 77. |
| **D. Cloudflare Workers + D1 + R2** behind the Vercel static app | Worker push/pull with a D1 change log, `record_versions`, whole-record LWW. | Self-built passkeys with setup, recovery and pairing codes. Bearer token in IndexedDB. No email fallback. | D1 and R2 reached through bindings, so no credentials exist. Worker secrets for the session pepper and AI key. | R2 through the Worker; `put()` with a sha256 check (confirmed by a judge). | D1 Free: 500 MB per database, 50 queries per Worker invocation, hard failure past daily limits. The push "batch" as written cannot branch, so it races. Two clouds plus the repo's first build tool (wrangler). | **$0 / $0 / under $1** (plus $60/year Workers Paid if D1 nears 500 MB, around years 6-10). | Low. | Not chosen: cheapest, but the central push algorithm needs a redesign and the operations surface doubles. Judges 70 / 75. |
| **E. Dexie Cloud** (hosted local-first engine) | Dexie Cloud addon provides the outbox, pull cursor and per-property merge; same-field conflicts go to the latest client time. An app-level revisions table provides R7. | Built-in email OTP shown in a custom in-app dialog; refresh bound to a non-exportable key; no SMTP vendor. Strangers can create evaluation accounts. | Public DB URL in client. `client_secret` only on the owner's PC. AI key in Vercel env. | Blob offloading to the vendor's S3/Azure. Server-side dedupe is undocumented, so dedupe is done in the app. | Free: 3 users, 100 MB, so photos need the paid plan from the first season. Proprietary server; self-hosting costs EUR 3,495. iPhone blob-cache eviction API undocumented. | **about $42 / $42 / $42** (EUR 3/month; VAT and FX UNVERIFIED). | Moderate-high. | Not chosen: least code, but small-vendor and closed-engine risk over 10 years. Judges 70.5 / 68. |
| **F. Firebase hybrid** (Firestore + Cloud Storage + Vercel AI proxy) | Firestore offline cache and write queue, plus a rules-enforced rev guard, an immutable revisions log and a client-side conflict detector. Custom photo outbox. | Email + Keychain password works in-app. Google redirect is fragile in standalone mode. No passkeys. | Public Firebase config (referrer-restricted). Security Rules are the boundary. AI key in Vercel env. | Cloud Storage for Firebase. | Storage requires the Blaze plan (card on file, no hard spending cap) since 2026-02-03. The SDK silently rolls back rejected writes replayed after a restart. Listeners offline >30 min are re-billed as full queries. Large SDK. | **$0 / under $1 / about $1-4** | High. | Rejected: R7 depends on working around SDK behaviour, and billing is uncapped. Judges 65 / 68. |
| **G. Google Drive op-log** (`drive.file` folder + stateless Vercel token broker) | Immutable per-device op-batch files with HLC and client-side merge, pulled through a `changes.list` cursor. | Google OAuth via `window.open` from standalone mode; it may finish in Safari, which forces a copy-paste pairing code. | OAuth client secret and encryption key in Vercel env. Refresh token in an encrypted HttpOnly cookie. | Drive files named by SHA-256, checked against Drive's `sha256Checksum`. | 15 GB free, shared with the owner's Gmail and Photos. The OAuth app must be "In production" (refresh tokens expire after 7 days in Testing). OAuth clients are auto-deleted after 6 months without use. | **$0 / $0-24 / about $24** (Google One 100 GB at $1.99/month). | Lowest. | Rejected as primary: fragile iOS OAuth, and merging only on clients with no arbiter. Its "export to a folder you own" idea is kept for R9. Judges 70 / 64. |

### 3.1 Corrections to the proposals found during review

- **Supabase pausing.** The restore window for a paused Free project is **1 year**, not 90 days. Pausing depends
  on "sufficient user database activity" over 7 days, and a few database requests a day prevent it. Paid
  projects are never paused. Verified 2026-10-01 from Supabase's published docs source.
- **Supabase storage overage** is $0.0213/GB, not $0.021. Verified 2026-10-01 from Supabase's published pricing
  data.
- **Supabase auth email (new finding).**
  - A Supabase changelog entry, found by web search on 2026-10-01, says that from 2026-06-03 new Free projects
    using the built-in sender cannot edit auth email templates.
  - The built-in sender is limited to 2 emails/hour and delivers only to project team members.
  - So an in-app 6-digit code needs custom SMTP, and in practice a sending domain. That is why this document
    makes password sign-in the default.
  - Search snippet only; that changelog URL is not in the proposals' source list.
- **Supabase `SECURITY INVOKER` sync functions** (judge 2). Invoker functions need direct table INSERT/UPDATE
  grants, so a client could skip the conflict and sequence logic. This design revokes direct writes (section 4.4).
- **Cloudflare D1 Free** caps each database at **500 MB** (5 GB is the account total) and allows **50 queries per
  Worker invocation**. Verified 2026-10-01 from Cloudflare's docs source. D1 `batch()` is a fixed list of
  statements and cannot branch on earlier results (judges).
- **Cloudflare R2** rounds billable GB-month up to the next whole GB (1.1 GB-month is billed as 2). Verified
  2026-10-01.
- **Neon Free** now includes 5 GB of Object Storage, and the 5 GB network-transfer allowance is shared across all
  products in the project. Verified 2026-10-01 from Neon's docs source. Whether browsers can upload to it directly
  is UNVERIFIED.
- **Vercel Hobby over-limit behaviour** is disputed.
  - A vercel.com search snippet (2026-10-01) says that in most cases the exceeded feature is blocked until 30
    days have passed.
  - Community threads report whole Hobby teams staying paused.
  - The Vercel-native proposal's claim that the whole account, app shell included, is paused is **UNVERIFIED**.

---

## 4. Recommended architecture in detail

### 4.1 Diagram

```
 iPhone (Home Screen PWA)                        PC (browser or installed PWA)
 +-----------------------------------------+     +--------------------------------+
 | index.html: render() reads state{} (v1) |     | same app, same code            |
 |   save() -> adapter diffs state{} vs    |     |                                |
 |            records, appends outbox ops  |     |                                |
 | IndexedDB "gardenforge.v2"              |     | IndexedDB "gardenforge.v2"     |
 |   records  outbox  conflicts  meta      |     | (own deviceId, own pull cursor)|
 |   blobs[kind,sha256]  blobQueue         |     |                                |
 | js/sync.mjs   HLC, push/pull, backoff   |     |                                |
 | js/blobstore.mjs  Supabase | R2 adapter |     |                                |
 | status pill: Saved locally | Syncing |  |     |                                |
 |              Synced | Needs attention   |     |                                |
 | sw.js caches shell + js/* + vendor/*    |     |                                |
 +--------------------+--------------------+     +----------------+---------------+
                      | HTTPS: publishable key (public) + user access token
                      |   rpc sync_push(device_id, ops[])  -> per-op results
                      |   rpc sync_pull(since, max)        -> rows + tombstones
                      |   select blobs where sha256 = any(...)      (dedupe)
                      |   storage PUT u/{uid}/o/{sha}.jpg, u/{uid}/t/{sha}.jpg (no upsert)
                      |   storage signed GET  (thumbnails eager, originals lazy)
                      v                                               v
 +----------------------------------------------------------------------------------+
 | Supabase project   (RLS enabled + forced on every table; nothing granted to anon) |
 |  Auth: owner's email + password, sign-ups disabled; optional email code/passkey   |
 |  Postgres: records | record_history | conflicts | applied_ops | blobs | devices   |
 |            ai_usage        writes only through gf_private sync functions          |
 |  Storage: bucket "photos" (private, content-addressed, immutable)                 |
 +---------------------------------------^------------------------------------------+
                                         | secret key: Vercel env only (Phase 2.1+)
 +---------------------------------------+------------------------------------------+
 | Vercel Hobby: static files (unchanged) + dependency-free Functions               |
 |   /api/cron/gc     orphan-photo garbage collection (optional, Phase 2.1)         |
 |   /api/identify    Phase 3: verifies user token, takes quota, AI key in env      |
 |   /api/photo-url   cost-down variant only: R2 presigned PUT/GET                  |
 +----------------------------------------------------------------------------------+
   Independent of all of the above: JSON export (v1) and Full backup .zip with photos (R9)
```

### 4.2 Data flow

1. **Edit (online or offline).** The UI mutates `state` as today and calls `save()`. The adapter diffs `state`
   against the `records` store and, in **one IndexedDB transaction**, writes the changed record envelopes and
   their outbox ops. The pill shows **Saved locally**, and a sync is scheduled 2 s later.
2. **Photo.** `compressPhoto()` (1600 px, JPEG q0.82) plus a 320 px thumbnail, then SHA-256. Blobs, the photo
   record and an outbox op flagged `dependsOn: [sha256]` are written in one transaction, plus a `blobQueue` entry.
3. **Sync cycle** (only when online, signed in and sync enabled):
   1. upload queued blobs, after one dedupe query;
   2. push outbox batches of up to 200 ops; photo ops go only once their blobs are confirmed;
   3. pull pages until `has_more = false`;
   4. download queued thumbnails and any requested originals;
   5. recompute the pill.
4. **Other device.** Its next cycle (on open, focus, `online`, or every 60 s while visible) pulls the new rows,
   applies them, rebuilds the affected `state` entries and re-renders. Thumbnails download in the background.
5. **Offline in the garden.** Steps 1-2 work unchanged. Outbox and blob queue persist across app kills. iOS gives
   no background sync (UNVERIFIED), so they drain the next time the app is open and online.

### 4.3 Local data model and change log

IndexedDB database `gardenforge.v2`. The v1 localStorage key `gardenforge.brownsville.v1` and the
`gardenforge.photos.v1` database are migrated into it but **not deleted**. They are removed only when the owner
explicitly confirms, after the first full backup or full sync.

| Store | Key | Contents |
| --- | --- | --- |
| `records` | `[collection, id]` | Record envelope (below). |
| `outbox` | `opSeq` (autoIncrement) | Pending ops: the local change log. |
| `blobs` | `[kind, sha256]` | `{sha256, kind: 'original'\|'thumb', blob, bytes, mime, width, height, uploaded, verifiedAt, lastAccess}` |
| `blobQueue` | `[direction, kind, sha256]` | `{direction: 'up'\|'down', state: 'queued'\|'active'\|'done'\|'failed', attempts, nextAttemptAt, lastError}` |
| `conflicts` | `conflictId` | Local mirror of open server conflicts, plus the local copy of any version this device lost. |
| `meta` | key | `deviceId` (random UUID, created once), `deviceLabel`, `hlcState`, `pullCursor`, `schemaVersion: 2`, `userId`, `syncEnabled`, `lastPullOkAt`, `lastError`, `migratedFromV1At`. |

**Record envelope** (one per syncable item):

| Field | Type | Meaning |
| --- | --- | --- |
| `collection` | string | `settings`, `draft`, `recipe`, `bed`, `plan`, `log`, `completion`, `custom_crop`, `custom_ingredient`, `photo` |
| `id` | string | Existing id (`plant_…`, `photo_…` from `uid()`); `'settings'` / `'draft'` for singletons; the task key (e.g. `<planId>:review`) for completions |
| `data` | object | The v1 item exactly as today. Photo records carry metadata only, never the blob. |
| `rev` | int | Last server revision this device has seen. 0 means never synced. |
| `baseRev` | int | The revision the current local edit started from. |
| `hlc` | string | Hybrid logical clock `<13-digit ms>-<4-digit counter>-<deviceId>`. Compares lexicographically, giving a total order. |
| `updatedAt` | ISO string | Wall-clock time of the last edit (human-meaningful, R5). |
| `deviceId` | string | Device that made the last edit. |
| `deletedAt` | ISO string or null | Tombstone. `data` is kept so a delete can be undone. |
| `dirty` | bool | A local edit the server has not yet acknowledged. |

**Mapping from schema v1:**

- Each element of `recipes`, `beds`, `plans`, `logs`, `customCrops` and `customIngredients` becomes one record.
- `settings` and `draft` become singleton records.
- Each key of the `completed` map becomes its own `completion` record `{done, at}`, so ticks made on two devices
  never collide.
- Today's code deletes completion keys by prefix when a planting is removed. In v2 those deletions become
  tombstones.
- Each photo in `gardenforge.photos.v1` becomes a `photo` record plus `blobs` entries (section 4.7).

**Outbox op:**
`{opSeq, opId (UUID v4), collection, id, baseRev, hlc, updatedAt, deviceId, deletedAt, data, dependsOn, state: 'queued'|'sent'|'rejected', attempts, lastError}`

**Change-log rules:**

1. Records and outbox are written in the same IndexedDB transaction. An edit is never in one without the other.
2. **Coalescing.** A new edit to a record whose op is still `queued` (never sent) replaces that op's payload, `hlc`
   and `updatedAt`, and keeps its `opId` and original `baseRev`. An op in state `sent` is frozen.
3. **At most one op per record per push batch.** A later op for a record whose earlier op is frozen waits until
   the earlier result arrives, then takes `baseRev = result.rev`.
4. An op is deleted only after its result has been applied locally. A lost response is retried with the same
   `opId`, and the server returns the stored result (idempotent).
5. **HLC.** A local edit sets `hlc = next(max(wallClock, hlcState))`. Every pulled row advances `hlcState` to at
   least the row's `hlc`.
6. **Phase 0 (no cloud).** The outbox still records changes. Coalescing bounds it to one op per changed record. On
   first sync it becomes the initial upload.
7. **The in-memory `state` keeps its v1 shape,** so the existing render code does not change. Removing an array
   item produces a tombstone. Pulled rows update `state`, and tombstoned records are left out of it.
8. If the full-state diff becomes slow on the iPhone at tens of thousands of records (measure it), switch the
   affected collections to explicit change marking at each mutation site.
9. **Validation.** v2 validation reuses the `validateState` rules per record. It must raise v1's limit of 1,500
   items per collection, because logs alone could pass that within a year, while still accepting v1 backups
   under v1 rules.

### 4.4 Cloud schema and privileges (Supabase Postgres)

SQL lives in `supabase/migrations/*.sql`, with tests in `supabase/tests/`. Add `supabase/` to `.vercelignore`.
This is a sketch; the Phase 1 PR finalizes it.

```sql
create schema gf_private;                       -- not exposed through the API
create sequence gf_private.records_seq;

create table public.records (
  user_id           uuid        not null default auth.uid(),
  collection        text        not null check (collection in ('settings','draft','recipe','bed','plan',
                                  'log','completion','custom_crop','custom_ingredient','photo')),
  id                text        not null check (length(id) <= 120),
  data              jsonb       not null check (pg_column_size(data) < 64000),
  rev               int         not null,
  hlc               text        not null,
  updated_at        timestamptz not null,       -- client wall time of the edit (R5)
  device_id         text        not null,
  deleted_at        timestamptz,                -- tombstone; kept forever
  server_seq        bigint      not null,
  server_updated_at timestamptz not null default now(),
  schema_version    int         not null default 2,
  primary key (user_id, collection, id)
);
create index on public.records (user_id, server_seq);

-- every superseded, deleted or losing version (append-only)
create table public.record_history (like public.records,
  reason text not null check (reason in ('superseded','deleted','conflict_loser')),
  archived_at timestamptz not null default now());

create table public.conflicts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null, collection text not null, record_id text not null,
  base_rev int, winner_rev int not null,
  loser jsonb not null,          -- full envelope of the losing version
  fields text[] not null,        -- fields decided by newest-wins, or '{_delete}'
  reason text not null check (reason in ('same_field','delete_overridden','no_base')),
  detected_at timestamptz not null default now(), resolved_at timestamptz, resolution text);

create table public.applied_ops (user_id uuid not null, op_id uuid not null, result jsonb not null,
  applied_at timestamptz not null default now(), primary key (user_id, op_id));   -- pruned after 90 days

create table public.blobs (user_id uuid not null default auth.uid(),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('original','thumb')),
  object_key text not null, bytes int not null, mime text not null, width int, height int,
  created_at timestamptz not null default now(), verified_at timestamptz,
  primary key (user_id, kind, sha256));

create table public.devices (user_id uuid not null, device_id text not null, label text,
  last_push_at timestamptz, last_pull_seq bigint, primary key (user_id, device_id));

create table public.ai_usage (user_id uuid not null, day date not null, count int not null,
  primary key (user_id, day));   -- Phase 3
```

**Privileges.** These are the fix for judge 2's finding that `SECURITY INVOKER` sync functions let clients
bypass the sync logic.

- `ENABLE` and `FORCE ROW LEVEL SECURITY` on every table in `public`. Nothing is granted to `anon`.
- `authenticated` gets `SELECT` on `records`, `conflicts`, `blobs` and `devices`, under policy
  `user_id = (select auth.uid())`. It also gets `INSERT` on `blobs` with the same `WITH CHECK`.
- **No direct `INSERT`/`UPDATE`/`DELETE`** on `records`, `record_history`, `conflicts`, `applied_ops` or `ai_usage`.
- All writes go through `public.sync_push`, `public.resolve_conflict` and (Phase 3) `public.ai_quota_take`. Each is
  a thin wrapper around a `SECURITY DEFINER` function in `gf_private` that:
  - pins `search_path = ''`;
  - takes the user id **only** from `auth.uid()` and raises if it is null;
  - never reads `user_id` from the payload;
  - has `EXECUTE` granted only to `authenticated`.
- How function ownership and RLS bypass behave on Supabase's managed roles is UNVERIFIED. Phase 1 confirms it, and
  an automated test proves that a direct PostgREST `PATCH`/`POST` on `records` fails.
- Every function that writes `records` takes the same per-user advisory lock (4.5).

**Storage** (bucket `photos`, private):

- `INSERT` and `SELECT` policies require `bucket_id = 'photos'`, `(storage.foldername(name))[1] = 'u'` and
  `(storage.foldername(name))[2] = (select auth.uid())::text`.
- **No `UPDATE` policy** (so no overwrite or upsert) and no client `DELETE`.
- Set the bucket's size limit (e.g. 3 MB) and allowed MIME type `image/jpeg` if the dashboard offers them
  (UNVERIFIED).

### 4.5 Push and pull protocol

**Push:** `rpc('sync_push', { device_id, ops })`, with at most 200 ops per call.

```
uid := auth.uid()                       -- raise if null
pg_advisory_xact_lock(hashtextextended(uid::text, 0))   -- serializes this user's writes
for each op, in the order sent:
  if (uid, op.op_id) in applied_ops:  return the stored result; continue     -- idempotent retry
  validate(op)                         -- per-collection rules; on failure: status 'rejected'
  if wall(op.hlc) > now() + 5 min:     clamp hlc to now(); add flag 'clock_skew'
  cur := select ... for update
  if cur is null:                      insert rev=1, server_seq=nextval           -> 'applied'
  elif same data and deleted_at:       no write                                   -> 'unchanged'
  elif cur.rev = op.base_rev:          copy cur to record_history ('superseded' or 'deleted');
                                       update rev=cur.rev+1, server_seq=nextval   -> 'applied'
  else:                                conflict rule (4.6): history + conflicts rows,
                                       write the result with rev=cur.rev+1        -> 'merged' | 'conflict'
  insert applied_ops(uid, op.op_id, result)
upsert devices(last_push_at)
```

Result per op: `{op_id, status, rev, server_seq, record?, conflict_id?, flags[]}`. `record` is included whenever
the stored version differs from what the client sent.

| Status | Client action |
| --- | --- |
| `applied`, `unchanged` | Set `rev = baseRev = result.rev`. Clear `dirty` unless a newer local op for that record is queued. Delete the op. |
| `merged` | Replace the local envelope with `record` and rebuild `state`. Delete the op. Nothing was lost. |
| `conflict` | As `merged`, and also store this device's version in the local `conflicts` store. The server already holds it. |
| `rejected` | Keep the op, mark it `rejected`, show **Needs attention**. Never drop it. |
| no response / network error | Leave the op `sent` and retry later with the same `op_id`. |

**Pull:** `rpc('sync_pull', { since, max: 500 })` returns
`{rows, next_since, has_more, open_conflicts, server_time}`. `rows` are this user's records with
`server_seq > since`, ordered by `server_seq`, **tombstones included**.

- For each row: if the local record has an unacknowledged op, keep the local data and note the server rev (the
  pending push is resolved by the server). Otherwise overwrite the envelope (`rev = baseRev = row.rev`), and if
  `deleted_at` is set, remove the item from `state`.
- Each page is applied and `pullCursor = next_since` saved in **one IndexedDB transaction**.
- `open_conflicts > 0` triggers a fetch of open `conflicts` rows into the local store.
- `server_time` drives the clock-skew check: more than 2 minutes off means **Needs attention**, as information only.

**Why the cursor cannot skip a row.** `server_seq` is assigned while the per-user advisory lock is held, and the
lock is released only at commit. So for each user, rows become visible in `server_seq` order. Two devices pushing
at the same moment are serialized.

**Tombstones** are kept forever (tens of MB at most over 10 years, estimated). If they are ever pruned,
`sync_pull` returns `cursor_too_old` for older cursors, and the client resyncs from 0 and reconciles.

**Triggers:** app start, `online`, `visibilitychange` to visible, 2 s after the last local save, every 60 s while
visible, and a "Sync now" button.

**Concurrency:** one cycle at a time per device, using the Web Locks API across tabs (iOS support UNVERIFIED;
fall back to an IndexedDB lease).

**Backoff:** 5 s, 15 s, 1 min, then 5 min, with jitter.

**Realtime:** not used in v1. Polling on focus is enough for one person.

### 4.6 Conflict rule

The unit of conflict is one record. A conflict exists **only** when `op.base_rev` differs from the server's
`rev`. Clocks never decide *whether* there is a conflict, only who wins a field.

1. **Same content:** no-op (`unchanged`).
2. **Fast-forward** (`base_rev = rev`): apply. The previous version is still archived in `record_history`.
3. **Edit vs edit: three-way merge** on the top-level keys of `data`.
   - The base is the `record_history` row at `base_rev`.
   - Keys changed on only one side take that side's value.
   - Keys changed on both sides to different values go to the side with the **greater HLC**. The HLC includes the
     `deviceId`, so ties are impossible.
   - Nested objects (e.g. the draft's parts) are compared as whole values.
   - If no key overlaps, the result is `merged`. Otherwise it is `conflict`.
4. **No base available** (a device's first push of migrated data with `base_rev = 0`, or a pruned base): the whole
   record goes to the greater HLC (`reason 'no_base'`), unless the content is identical.
5. **Edit vs delete,** in either order: **the edit wins, whatever the timestamps.** The record stays or comes back.
   The delete is preserved as a conflict (`reason 'delete_overridden'`), and the UI offers "Delete again".
6. **Delete vs delete:** no conflict.
7. **Task completions** are one record per task key, so independent ticks never conflict. A tick and an untick of
   the same key fall under rule 3.
8. **Photos:** blobs are immutable and content-addressed, so they cannot conflict. Photo metadata (note, stage,
   height) falls under rule 3.

**The losing version is preserved as a conflict copy, never discarded (R7):**

- The loser's full envelope (data, rev, HLC, `updatedAt`, `deviceId`, `deletedAt`) is written to `conflicts` and to
  `record_history` (`conflict_loser`) **in the same transaction, before the winner**. A crash cannot separate them.
- It is returned to the device that lost and kept there, and it is pulled to every other device.
- The pill stays at **Needs attention** ("1 edit conflict") until the owner acts. The Conflicts screen shows the two
  versions side by side, by field, with device label and local time.
  - **Keep this one** pushes the loser's values as a new edit on the current rev, so it becomes the newest version.
  - **Dismiss** sets `resolved_at`. The row is kept indefinitely and is included in the Full backup.
- The only resolution with no review is between two sequential edits from the same device, which are not concurrent.

**Worked example.** Plan X is at rev 4, `{variety: 'Celebrity', notes: 'a'}`.

1. The phone, offline, changes `notes` to `'b'` at 09:00.
2. The PC, online, changes `variety` to `'Roma'` at 12:00. The server moves to rev 5.
3. At 18:00 the phone pushes with base 4. The server changed `{variety}` and the phone changed `{notes}`, so the
   result is `merged`: rev 6, `{variety: 'Roma', notes: 'b'}`, with no prompt.
4. Had the phone also set `variety: 'Cherokee'` at 09:00, the PC's 12:00 value would win that field. The phone's
   full version would be kept as a conflict copy, and "Keep this one" would restore `'Cherokee'`.

**Implementation discipline:**

- The rule is implemented twice: in PL/pgSQL, and as a JS reference module in `tools/` used by a fake sync server.
- One shared set of JSON test vectors runs against both. The cases include disjoint edits, overlapping edits,
  edit vs delete, a missing base, duplicate pushes, lost responses, clock skew and three devices.

**`record_history` growth.** Estimated 50-80 MB/year, which is an engineering estimate.

- On Pro (8 GB disk) this is a non-issue.
- On Free (500 MB), or in the fallback on Neon Free (1 GB), compact it: keep all `conflict_loser` and `deleted`
  rows forever, and keep superseded versions for 2 years, then only the latest 10 per record.

### 4.7 Photo pipeline

**Capture** (on the device, local first):

1. Before re-encoding, read the picked file once:
   - compute `sourceSha256` (SHA-256 of the original bytes);
   - parse EXIF `DateTimeOriginal` into `takenAt`, if present. Canvas re-encoding strips EXIF, including GPS; no
     location is stored.
   - `createdAt` keeps today's meaning: the time the photo was added to GardenForge.
2. Keep `compressPhoto()` as it is (longest side 1600 px, JPEG q0.82, about 150-400 KB). In the same pass, make a
   thumbnail (longest side 320 px, JPEG q0.7, about 15-25 KB).
3. Hash with `crypto.subtle.digest('SHA-256')`:
   - `sha256` of the compressed original is the content address;
   - `thumbSha256` is used for integrity checks.
4. If a photo record with the same `sourceSha256` is already on this planting, ask "This photo is already in this
   plant's timeline. Add again?"
5. One transaction writes:
   - `blobs[original, sha256]` and `blobs[thumb, sha256]` (the thumbnail is keyed by the original's hash);
   - the `photo` record `{planId, createdAt, takenAt, height, heightUnit, stage, note, sha256, thumbSha256,
     sourceSha256, bytes, width, heightPx, mime}`;
   - an outbox op with `dependsOn: [sha256]`;
   - a `blobQueue` up entry.
6. The photo appears immediately, and the pill shows **Saved locally**.

**Upload** (sync engine, via the `BlobStore` adapter):

7. **Dedupe** with one query, `select sha256, kind from blobs where sha256 = any($queued)`. Hashes already present
   are marked done without uploading (R4).
8. **Upload the missing objects directly from the browser**, at most 3 at a time:
   - `storage.from('photos').upload('u/'+uid+'/o/'+sha+'.jpg', blob, {upsert: false, contentType: 'image/jpeg',
     cacheControl: '31536000'})`, and the same for `u/{uid}/t/{sha}.jpg`.
   - A 409 "Duplicate" is success (idempotent; covers two devices racing).
   - Then insert the `blobs` row.
9. **Release the metadata.** The photo's outbox op becomes pushable only when both objects are confirmed. Other
   devices therefore never receive a photo record whose file is missing.

**Download** (other devices):

10. Pulled photo records queue thumbnail downloads eagerly, by signed URL or `download()`, batched.
11. Originals download when opened, or through "Download all originals" (recommended on the PC).
12. Every downloaded blob is re-hashed. A mismatch means **Needs attention**, and the bad copy is not cached.

**Device storage:**

13. Nothing is evicted automatically.
14. "Free up space" (manual, with confirmation) may drop local originals older than N months, but only where
    `uploaded` and `verifiedAt` are set. Thumbnails and anything not yet uploaded are never dropped.
15. Call `navigator.storage.persist()` after first sync.

**Deletion and garbage collection:**

16. Deleting a photo tombstones its record. The objects stay.
17. Optional Phase 2.1: a daily Vercel cron `/api/cron/gc` (secret key in Vercel env, `CRON_SECRET`) deletes objects
    and `blobs` rows that no live photo record has referenced for 30 days. Until then, orphans cost fractions of a
    cent.
18. A monthly integrity sweep from the app reports missing or orphan objects and re-uploads missing ones from local
    copies. It never deletes.

**Migration of existing photos:**

- Each photo in `gardenforge.photos.v1` is hashed from its stored JPEG and gets a thumbnail.
- `sourceSha256` and `takenAt` are null, because the originals are gone.
- `id`, `planId`, `createdAt`, `height`, `heightUnit`, `stage` and `note` are copied verbatim.

**Cost-down variant (R2):**

- The same adapter calls `/api/photo-url` (a Vercel Function) with the user's access token.
- The function verifies the token and `OWNER_USER_ID`, checks size and type, and checks whether
  `photos/sha256/<hex>.jpg` already exists.
- If not, it returns a presigned PUT URL valid for 5 minutes; downloads use presigned GET URLs.
- The R2 API token, scoped to one bucket, lives in Vercel env.
- Integrity is checked by re-hashing on download, as above.

**Not used:** Supabase image transformations (Pro add-on), HEIC and video.

### 4.8 Sync-state machine

The state is **derived, never stored as truth**. It is recomputed after every write, network event and cycle step.
Inputs:

- `localWriteOk`, `persistenceOk`, `syncEnabled`, `signedIn`, `online`, `inFlight`
- `outboxCount`, `blobQueueCount`, `rejectedOps`, `openConflicts`
- `lastError {kind, firstAt, attempts}`, `lastPullOkAt`, `clockSkewMs`, `quotaUse`

| State | Shown when | Example copy |
| --- | --- | --- |
| **Needs attention** (amber, one action button) | Any of the reasons below. It wins over every other state. | "Needs attention · 1 edit conflict" / "Sign in again" / "Storage nearly full: approve upgrade" |
| **Syncing** | Online, signed in, sync on, and a push, pull or blob transfer is in flight. | "Syncing · photo 4 of 12" |
| **Saved locally** | The last local write committed, and either items are waiting (offline, backoff, signed out, sync off) or the last successful pull is over 10 min old while offline. | "Saved on this iPhone · 3 changes and 12 photos will sync when online" / "Saved on this iPhone · sync off" |
| **Synced** | Outbox and blob queue empty, last pull under 10 min ago, no open conflicts, no attention reasons. | "Synced · 2 min ago" |

Precedence is Needs attention > Syncing > Saved locally > Synced.

**Needs attention reasons**, each with one action:

- a local IndexedDB write failed, or persistence could not open (memory-only): "This device can't keep offline
  edits: export a backup now";
- refresh token rejected (400/401 after refresh): "Sign in again";
- open conflicts > 0: "Review N conflicts";
- a rejected op: "Review change";
- 403 or an RLS violation (a bug): "Export backup and report";
- cloud storage quota exceeded, or 80% of any free or included quota reached (budget guard): "Approve upgrade or
  free space";
- the project is paused or unreachable: repeated connection errors or 5xx for more than 24 h while other sites load:
  "Cloud paused: restore in dashboard";
- transient failures lasting more than 24 h while online;
- the same op failing 5 times with a non-transient error;
- remote `schema_version` newer than this app: "Update GardenForge";
- a downloaded photo whose hash does not match;
- clock skew over 2 minutes (information only).

**Transitions:**

| From | Event | To |
| --- | --- | --- |
| any | local edit committed | **Saved locally**; schedule a sync in 2 s |
| any | local write fails / persistence unavailable | **Needs attention** |
| Saved locally | trigger fires and online, signed in, sync on, not in backoff | **Syncing** |
| Syncing | cycle succeeds, queues empty, no conflicts | **Synced** |
| Syncing | batch succeeds, more work remains | **Syncing** (next batch) |
| Syncing | transient error (offline, timeout, 429, 5xx) | **Saved locally**; backoff 5 s, 15 s, 1 min, 5 min |
| Syncing | fatal error (rejected refresh, 403, rejected op, quota, newer schema) | **Needs attention**; other records keep syncing where possible |
| Syncing | a push or pull reports a conflict | **Needs attention**; the cycle continues for other records |
| Saved locally | transient failures continue for more than 24 h while online | **Needs attention** |
| Synced | local edit | **Saved locally** |
| Synced | focus, `online`, 60 s timer, or last pull over 10 min old while online | **Syncing** |
| Synced | goes offline and last pull passes 10 min | **Saved locally** ("nothing waiting · last synced 2 h ago") |
| Needs attention | owner fixes the cause and no other reason remains | **Syncing** if online, otherwise **Saved locally** |
| any | sign out or sync turned off | **Saved locally** ("sync off"); local data untouched |

**Rules:**

- Edits are allowed in every state, and the pill never blocks the UI.
- "Synced" never claims freshness that has not been checked.
- The pill replaces today's `#save-status` and `#mobile-page-status` text.
- It is a `<button>` at least 44 px tall with an `aria-live="polite"` label (AGENTS rules 1 and 7), and colour is
  never the only signal.
- Tapping it opens a sheet with pending counts, last sync time, conflicts, the device list, "Sync now" and
  "Export backup now".

### 4.9 Authentication on the iPhone Home Screen app

**Constraints, stated plainly:**

- A Home Screen web app on iOS has its own storage, separate from Safari
  ([netguru](https://www.netguru.com/blog/how-to-share-session-cookie-or-state-between-pwa-in-standalone-mode-and-safari-on-ios),
  third-party).
- Links tapped in Mail open in Safari, so **magic links leave the app signed out**
  ([supabase discussion 12227](https://github.com/orgs/supabase/discussions/12227)).
- OAuth redirects that leave the app's scope can finish in Safari
  ([third-party report](https://github.com/warren-wyn-dev/wynteam/pull/663)).
- Sign in with Apple on the web needs a paid Apple Developer membership
  ([99 USD/year](https://developer.apple.com/programs/whats-included/)).
- WebKit says Home Screen web apps are exempt from the 7-day cap on script-writable storage
  ([webkit.org](https://webkit.org/tracking-prevention/), via search snippet).

**Choice: email plus a strong password, typed inside the app and saved in iCloud Keychain. No cookies.**

The Supabase proposal chose an emailed 6-digit code. That needs custom SMTP: the built-in sender allows 2
emails/hour, and per a 2026-10-01 search snippet, new Free projects on the built-in sender cannot edit templates.
Custom SMTP in practice means a sending domain and a second vendor, plus switching to Mail and back, where iOS may
reload the app. A Keychain password avoids all of that. One judge rated it the most robust in-app flow in
standalone mode.

**One-time setup** (owner, in the Supabase dashboard, after approval; labels UNVERIFIED):

1. Create the Free project. Turn off "Allow new users to sign up".
2. Add the owner's user with email and password, already confirmed. The password is generated (20+ characters) and
   saved in iCloud Keychain and in the PC's password manager.
3. Keep the defaults: access token about 1 hour, rotating refresh tokens (UNVERIFIED).

**Sign-in on the iPhone, step by step:**

1. Open GardenForge from the Home Screen. It works fully signed out (pill: "Saved on this iPhone · sync off").
2. Go to Settings › Cloud sync › Turn on sync.
3. The form has labelled inputs with `autocomplete="username"` and `autocomplete="current-password"`. iOS offers
   the Keychain entry; autofill inside standalone mode is UNVERIFIED and is part of the spike.
4. The app calls `supabase.auth.signInWithPassword({email, password})`. This is a `fetch`: no navigation, no popup.
5. supabase-js is created with `{auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: false}}`.
   It stores the access and refresh tokens in **the Home Screen app's own localStorage**. No cookies are involved,
   so ITP cookie limits do not apply.
6. First sync. If this device has migrated v1 data, it uploads; otherwise it pulls everything. The pill moves to
   Syncing, then Synced.

**On the PC:** the same form, using the browser's password manager.

**Failure and recovery:**

- **Offline:** token refresh fails as a transient error. The app never signs out on a network error, and edits keep
  queuing.
- **Refresh token rejected:** Needs attention, "Sign in again". The outbox is untouched.
- **Sign out** clears the session only. "Remove this device's local copy" is a separate, confirmed action
  (AGENTS rule 7).
- **Forgotten password:** the owner sets a new one in the Supabase dashboard. No email is needed.
- **Lost device:** change the password and sign out all sessions from another device or the dashboard. Whether a
  password change revokes existing refresh tokens is UNVERIFIED and is tested in Phase 1.

**Token storage:**

| Item | Where | Lifetime / notes |
| --- | --- | --- |
| Access token (JWT) | PWA localStorage (supabase-js) | About 1 h (UNVERIFIED default); refreshed silently |
| Refresh token | PWA localStorage (supabase-js) | Rotating, revocable; whether it expires by default is UNVERIFIED |
| Password | iCloud Keychain / PC password manager | Never stored by the app |
| `deviceId`, `pullCursor` | IndexedDB `meta` | Not secret |

Tokens in localStorage are readable by any XSS bug, which is why section 4.10 adds a CSP and keeps the `h()`
escaping rule.

**Optional later additions** (each needs owner approval):

- **Emailed 6-digit code:** custom SMTP, with the template showing `{{ .Token }}` and no link
  ([Supabase passwordless docs](https://supabase.com/docs/guides/auth/auth-email-passwordless), not fetched).
- **Supabase passkeys (beta)** for one-tap Face ID re-auth
  ([announcement](https://github.com/orgs/supabase/discussions/46458)). Known password-manager issues mean the
  password stays as the fallback. A custom domain is preferred as the RP ID.
- **A pairing code** from a signed-in device to enrol a new one, through a Vercel Function. Feasibility with
  Supabase admin APIs is UNVERIFIED.

### 4.10 Security checklist

Required before Phase 1 ships, and checked in CI where marked.

- [ ] Client contains only the project URL and the **publishable** key (`sb_publishable_…`)
      ([API keys](https://supabase.com/docs/guides/getting-started/api-keys); legacy `anon`/`service_role` keys are
      deprecated by end of 2026). **CI:** the static test fails if `index.html`, `js/*` or `sw.js` contain
      `sb_secret_`, `service_role` or a JWT-shaped string.
- [ ] RLS `ENABLE` + `FORCE` on every table in exposed schemas. **CI:** a SQL test fails if any `public` table has
      `rowsecurity = false`. Review the dashboard Security Advisor before each release that changes SQL.
- [ ] Nothing is granted to `anon`. `authenticated` has `SELECT` only (plus `INSERT` on `blobs`). **CI:** a direct
      PostgREST write to `records`, `conflicts` or `record_history` fails.
- [ ] Sync functions take the user from `auth.uid()` only, raise on null, pin `search_path`, and run
      `EXECUTE` for `authenticated` only.
- [ ] **Second-user isolation test**, run against a local stack (`supabase start`, UNVERIFIED in CI) or a staging
      project: a second account cannot read or write the owner's rows, conflicts, blobs rows or storage objects.
- [ ] Storage bucket is private. Owner-prefix `INSERT`/`SELECT` only; no `UPDATE`; no client `DELETE`.
- [ ] Public sign-ups disabled. The owner's account is created in the dashboard.
- [ ] `CHECK` constraints cap collection names, id length and `jsonb` size.
- [ ] supabase-js is vendored as a pinned file under `vendor/` and listed in `sw.js` `ASSETS` (rule 2). No
      runtime CDN (rule 6). Bump `CACHE` on release.
- [ ] CSP header in `vercel.json`:
      `default-src 'self'; connect-src 'self' https://<ref>.supabase.co; img-src 'self' blob: data:`.
  - `script-src` needs `'self'` plus the hash of the inline app script, which the static test recomputes each
    release.
  - `style-src` will likely need `'unsafe-inline'` for the inline style blocks.
  - Test on iPhone before enabling.
- [ ] Secrets only in server-side stores:
  - Supabase secret key (`sb_secret_…`, Phase 2.1 GC only), `CRON_SECRET` and the AI key go in Vercel env vars
    (Production; Preview only if needed).
  - The DB password stays in the owner's password manager.
  - SMTP credentials, if any, go only in the Supabase dashboard.
- [ ] Every Vercel Function:
  - verifies the caller's access token against Supabase `GET /auth/v1/user` (no dependency needed);
  - requires `sub == OWNER_USER_ID`;
  - uses only Node built-ins, so the repo root still has **no `package.json`**;
  - deploys correctly without one, confirmed on a Preview deployment (UNVERIFIED).
- [ ] AI proxy (Phase 3):
  - `/api/identify` takes a downscaled JPEG (≤1 MB, under the 4.5 MB body limit) and calls `ai_quota_take()` with
    the **user's** token, so no secret key is needed for the quota.
  - It caches results by `sha256` and keeps the provider key in Vercel env.
  - Output is labelled an **unsourced suggestion** (AGENTS rule 4).
- [ ] Supabase Pro Spend Cap stays **on**.
- [ ] No analytics or third-party scripts (rule 6). Sign-out never deletes local data without confirmation (rule 7).

---

## 5. Cost

### 5.1 Unit prices and limits, with sources

**How sources were checked.** "Verified 2026-10-01" means this document's author read the vendor's own published
pricing or docs source that day. Direct fetches of supabase.com, vercel.com and developers.cloudflare.com were
blocked by this environment's egress proxy, so for those vendors the author read the source files the vendors
publish on GitHub:

- Supabase `packages/shared-data/plans.ts` and the docs page `free-project-pausing.mdx`;
- Cloudflare `r2/pricing.mdx` and `d1/platform/limits.mdx`;
- Neon `plans.md`.

The links below are the official pages that proposals cited. "Search snippet" means the claim was seen only in a
web-search result from the vendor's domain. "Proposal-checked" means a proposal or judge reported checking it that
day; this author did not re-check it.

| Item | Number | Source | Status |
| --- | --- | --- | --- |
| Supabase Free price | $0/month | https://supabase.com/pricing | Verified 2026-10-01 (pricing data source) |
| Supabase Free database | 500 MB | https://supabase.com/pricing | Verified 2026-10-01 |
| Supabase Free file storage | 1 GB | https://supabase.com/pricing | Verified 2026-10-01 |
| Supabase Free egress | 5 GB/month (+5 GB cached) | https://supabase.com/pricing | Verified 2026-10-01 |
| Supabase Free projects / MAU | 2 active projects / 50,000 MAU | https://supabase.com/pricing | Verified 2026-10-01 |
| Supabase Free pausing | Paused after low database activity over 7 days; restorable for **1 year**; paid plans never paused | https://supabase.com/docs/guides/platform/free-project-pausing | Verified 2026-10-01 (docs source) |
| Supabase Free backups | None listed (Pro lists daily backups, 7-day retention) | https://supabase.com/pricing ; https://backupdrill.com/guides/supabase-free-plan-backups | Verified 2026-10-01 (plan lists); third-party proposal-checked |
| Supabase Pro price | $25/month, includes one project on Micro compute | https://supabase.com/pricing | Verified 2026-10-01 |
| Supabase Pro disk | 8 GB per project, then $0.125/GB | https://supabase.com/pricing | Verified 2026-10-01 |
| Supabase Pro file storage | 100 GB, then $0.0213/GB | https://supabase.com/pricing | Verified 2026-10-01 |
| Supabase Pro egress | 250 GB, then $0.09/GB (cached: 250 GB, then $0.03/GB) | https://supabase.com/pricing | Verified 2026-10-01 |
| Supabase Pro backups | Daily, kept 7 days | https://supabase.com/pricing | Verified 2026-10-01 |
| Supabase Spend Cap | On by default; does not cap compute or provisioned add-ons | https://flexprice.io/blog/supabase-pricing-breakdown | Third-party, proposal-checked |
| Supabase max upload (Free) | 50 MB per file | https://supabase.com/docs/guides/storage/uploads/file-limits | UNVERIFIED (not fetched) |
| Supabase built-in auth email | 2 emails/hour; custom SMTP starts at 30/hour | https://supabase.com/docs/guides/deployment/going-into-prod | Search snippet 2026-10-01 |
| Vercel Hobby | $0; personal non-commercial use only | https://vercel.com/docs/plans/hobby ; https://vercel.com/docs/limits/fair-use-guidelines | Search snippet 2026-10-01 |
| Vercel Hobby functions | 1,000,000 invocations/month; 4 h active CPU/month | https://vercel.com/docs/plans/hobby ; https://vercel.com/docs/functions/limitations | Search snippet (proposal-checked) |
| Vercel function body limit | 4.5 MB request/response | https://vercel.com/docs/functions/limitations | Search snippet (proposal-checked) |
| Vercel Hobby over limit | Feature unusable until 30 days have passed ("in most cases") | https://vercel.com/docs/plans/hobby | Search snippet 2026-10-01; scope disputed (3.1) |
| Vercel Hobby cron | At most once per day | https://vercel.com/changelog/cron-jobs-now-support-100-per-project-on-every-plan | UNVERIFIED (not fetched) |
| Vercel Pro | $20/seat/month with $20 usage credit | https://vercel.com/docs/plans/pro-plan | Search snippet (proposal-checked) |
| Vercel Blob (Hobby) | 1 GB storage; 10k simple / 2k advanced ops; 10 GB transfer per month | https://vercel.com/docs/vercel-blob/usage-and-pricing | Search snippet 2026-10-01 (1 GB); rest proposal-checked |
| Vercel Blob (on demand) | $0.023/GB-month; $0.05/GB transfer | https://vercel.com/docs/vercel-blob/usage-and-pricing | Search snippet (proposal-checked) |
| Cloudflare R2 free tier | 10 GB-month storage; 1M Class A; 10M Class B per month; egress free; Standard class only | https://developers.cloudflare.com/r2/pricing/ | Verified 2026-10-01 (docs source) |
| Cloudflare R2 prices | $0.015/GB-month; $4.50 per M Class A; $0.36 per M Class B; GB-month rounded up | https://developers.cloudflare.com/r2/pricing/ | Verified 2026-10-01 |
| Cloudflare D1 Free | 5M rows read/day; 100k rows written/day; 5 GB per account | https://developers.cloudflare.com/d1/platform/pricing/ | Proposal-checked (search excerpt) |
| Cloudflare D1 Free | 500 MB max per database; 50 queries per Worker invocation | Cloudflare docs source `d1/platform/limits` (not in the source list, so not linked) | Verified 2026-10-01 |
| Cloudflare Workers | Free: 100,000 requests/day, 10 ms CPU; Paid from $5/month | https://developers.cloudflare.com/workers/platform/pricing/ | Proposal-checked; a judge confirmed |
| Neon Free | 100 CU-h/project/month; 1 GB storage/project (20 GB account); 5 GB transfer shared across products; scale to zero after 5 min; 6-hour restore window; 5 GB Object Storage | https://raw.githubusercontent.com/neondatabase/website/refs/heads/main/content/docs/introduction/plans.md | Verified 2026-10-01 |
| Neon Launch | $0.106/CU-hour; $0.35/GB-month; Object Storage $0.023/GB-month | https://raw.githubusercontent.com/neondatabase/website/refs/heads/main/content/docs/introduction/plans.md | Verified 2026-10-01 |
| Dexie Cloud | Free: 3 users, 100 MB. Production: EUR 3/month per 25 seats with 1 GB object, 20 GB blob, 50k blob writes; extra blob EUR 0.05/GB-month | https://dexie.org/pricing | Search snippet (proposal and both judges) |
| Firebase Storage | Requires Blaze plan from 2026-02-03 | https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024 | Search snippet (proposal and both judges) |
| Firestore free quota | 1 GiB stored; 50k reads/day; 20k writes/day | https://cloud.google.com/firestore/pricing | Proposal-checked |
| Cloud Storage Always Free | 5 GB-months; then $0.020/GiB-month (us-central1) | https://cloud.google.com/storage/pricing | Proposal-checked; one judge could not confirm |
| Google One | 100 GB for $1.99/month; free 15 GB shared with Gmail/Photos | https://one.google.com/about/plans | Search snippet (proposal) |
| Resend (SMTP, optional) | Free: 3,000 emails/month, 100/day | https://resend.com/pricing | Search snippet (proposal) |
| Apple Developer Program | 99 USD/year (only for Sign in with Apple; not used) | https://developer.apple.com/programs/whats-included/ | Proposal fetched directly |
| Custom domain (optional) | about $10-15/year | none | UNVERIFIED (training knowledge) |

### 5.2 Usage assumptions (engineering estimates, not measurements)

| Quantity | Year 1 | Year 5 | Year 10 |
| --- | --- | --- | --- |
| Photo storage: 3,000 × (300 KB + 20 KB), plus any migrated photos | about 1 GB | about 5 GB | about 10 GB |
| Postgres: records plus `record_history` (estimate 50-80 MB/year) | under 0.1 GB | 0.25-0.4 GB | 0.5-0.8 GB |
| Egress: thumbnails to 1-2 devices plus originals on demand | 0.1-1 GB/month | 0.1-1 GB/month | 0.1-1 GB/month; a one-off full re-download to a new device is about 10 GB |
| Sync requests | a few hundred/day | same | same |
| Photo object writes (original + thumbnail) | about 6,000/year (about 500/month) | same | same |

### 5.3 Annual cost estimates

| Scenario | Year 1 | Year 5 | Year 10 | Arithmetic |
| --- | --- | --- | --- | --- |
| **Primary, recommended** (Supabase Free for Phases 0-1, Pro from photo go-live) | **$0-300** | **$300** | **$300** | Pro $25 × 12 ([pricing](https://supabase.com/pricing)). Year 1 depends on when Phase 2 ships. Usage stays inside Pro's inclusions: 10 GB of 100 GB storage, under 1 GB of 8 GB disk, about 1 GB/month of 250 GB egress. No overage expected. Ten years: about $2,700-3,000. |
| **Primary, cost-down** (Supabase Free + photos in R2) | **$0** | **$0** | **about $0.18** | Year 10: about 11 GB is billed as 11 GB-month (rounded up), minus 10 free, so 1 × $0.015 = $0.015/month ([R2](https://developers.cloudflare.com/r2/pricing/)). Class A about 500/month against 1M free; egress free. Supabase Free DB stays under 500 MB only with history compaction (4.6). Risks: pause after a quiet week, no backups. |
| **Fallback** (Vercel Hobby + Neon Free + R2) | **$0** | **$0** | **about $0.18** | R2 as above. Neon Free 1 GB is enough with compaction. Without compaction, Neon Launch is about $2-3/month (12-20 CU-h × $0.106 + about 1.5 GB × $0.35, per the Vercel-native proposal; [Neon](https://raw.githubusercontent.com/neondatabase/website/refs/heads/main/content/docs/introduction/plans.md)). |

**Optional extras** (each needs approval):

- custom domain, about $10-15/year (UNVERIFIED);
- SMTP for emailed codes, $0 on Resend Free at this volume ([Resend](https://resend.com/pricing), search snippet);
- AI provider usage in Phase 3, not estimated.

**Annual figures for the options not chosen** are in section 3 and use the unit prices above.

### 5.4 What is UNVERIFIED

1. Direct fetches of supabase.com, vercel.com and developers.cloudflare.com failed today (egress proxy). Supabase,
   R2, D1 and Neon numbers were verified from the vendors' published sources on GitHub. Re-open the live pricing
   pages before approving any spend.
2. Vercel figures (Hobby invocations, CPU hours, body limit, Blob limits, Pro price): search snippets only.
3. Whether exceeding a Vercel Hobby limit blocks only that feature or pauses the whole team.
4. Vercel Hobby cron frequency (once per day).
5. That Vercel deploys plain `api/*.mjs` Functions with no root `package.json` and no build step. Check on a
   Preview deployment, as AGENTS.md requires.
6. Supabase:
   1. The restriction on editing email templates for new Free projects, and the built-in sender delivering only
      to team members (search snippet; the changelog URL is not in the source list).
   2. Default access-token lifetime, refresh-token rotation and expiry, and whether a password change revokes
      existing sessions.
   3. `SECURITY DEFINER` ownership and RLS-bypass behaviour on Supabase's managed roles.
   4. Configurable bucket size and MIME limits.
   5. The 50 MB upload limit.
   6. Spend Cap scope (third-party source).
   7. Behaviour of Supabase Passkeys (beta) inside iOS standalone mode.
   8. Running `supabase start` (Docker) in CI.
7. iOS:
   1. iCloud Keychain password autofill inside a standalone Home Screen app.
   2. No Background Sync API.
   3. Web Locks API support.
   4. Home Screen apps being exempt from WebKit's 7-day storage eviction (webkit.org search snippet).
   5. Whether iOS evicts PWA storage under pressure.
8. Whether Cloudflare R2 requires a payment method on file before the free tier can be used (training knowledge).
9. Whether Neon Object Storage accepts browser uploads, and how its egress is accounted.
10. Dexie Cloud VAT and FX, and engine internals (idempotency, blob dedupe, cache eviction).
11. Custom domain prices; AI provider prices.
12. All usage figures in 5.2 (database growth, history size, egress) are engineering estimates.
13. Ten-year figures assume today's price lists. Vendors change free tiers: Firebase and D1 both did in 2026.

---

## 6. Phased rollout

Each phase is its own branch and pull request, or a short series of them, per AGENTS rule 8. Each release bumps
`APP_VERSION`, the `sw.js` `CACHE` suffix and the README version line, and passes `cd tools && npm test`. No phase
reformats `index.html` in the same commit as a behaviour change. Effort figures are estimates for one engineer.

### Phase 0: local change-log and export v2. No cloud, nothing to provision. About 6-9 dev-days.

**Ships to users:**

1. **IndexedDB `gardenforge.v2` with non-destructive migration.**
   - v1 localStorage and `gardenforge.photos.v1` are read and copied, never modified.
   - A Full backup download is offered first.
   - `schemaVersion: 2`. `validateState` still accepts v1 backups.
   - Entry in `docs/MIGRATION.md` and `docs/DATA-MODEL.md`.
   - "Remove the old copy" is offered only after a confirmed backup, and only on the owner's command.
2. **Record envelopes and the change log:**
   - `rev = 0`, `hlc`, `updatedAt`, `deviceId`, `deletedAt` tombstones, outbox with coalescing;
   - completions split into one record per key;
   - collection size limits raised for v2.
3. **Photo upgrades:** thumbnail, `sha256`, `sourceSha256` re-pick warning, EXIF `takenAt`; existing photos hashed
   and thumbnailed.
4. **Full backup (.zip) export and import.**
   - Contents: `manifest.json` (format version, record envelopes, open conflicts), `photos/<sha256>.jpg` and
     `thumbs/<sha256>.jpg`.
   - Built with a small store-only ZIP writer kept in the repo (no CDN).
   - The v1 JSON export keeps working.
   - This fixes the top roadmap item: photos missing from backups.
   - Optional "Save to Files" / share-sheet target, so the owner can keep a copy in iCloud Drive or Google Drive
     (R9).
5. **Status pill, local states only:**
   - "Saved on this iPhone · sync off";
   - Needs attention on a failed local write or memory-only persistence;
   - `navigator.storage.persist()`.

**Also lands, development only:** `tools/sync-rules.mjs` (JS reference for the conflict rule), shared JSON test
vectors, and `tools/fake-sync-server.mjs`, an in-memory server implementing `sync_push`/`sync_pull` exactly as in
section 4.5.

**Tested without any cloud:**

- `node:test` units for the state↔records diff, coalescing, HLC, the merge rule, migration round-trips
  (fixture v1 data, including the 1,500-item edge) and ZIP round-trips.
- Playwright: boot with fixture v1 localStorage and photos DB, migrate, reload offline, export and import with
  photos, at 320 px and 390 px.

**Exit:**

- The owner's real data migrates on their iPhone with v1 untouched.
- A Full backup restores on the PC with all photos.

### Phase 1: account and metadata sync (records only). About 8-11 dev-days, including the spike.

**Gate A, the iPhone spike (1-2 days).**

- Needs approval 1: a Supabase Free project (no card), reset after the spike and reused for Phase 1.
- Tests on the owner's iPhone in Home Screen mode:
  - password sign-in with Keychain autofill;
  - the session survives app kill, reload and about a week;
  - offline edits sync later;
  - the PC signs in to the same account;
  - optionally, passkey enrolment.
- Go/no-go. A no-go caused by Supabase specifically moves the project to the fallback stack.

**Ships:**

- SQL migrations (tables, RLS, privileges, `gf_private` sync functions, `resolve_conflict`).
- Vendored, pinned supabase-js in `vendor/` and in `sw.js` `ASSETS`.
- `js/sync.mjs` transport and engine; the sign-in sheet; the Conflicts screen; the full state machine; the CSP
  header.
- **Sync is opt-in and off by default.** Users who never turn it on see no change.
- Photo records are held back from push until Phase 2.

**Tested without the hosted cloud:**

- The client engine runs against `tools/fake-sync-server.mjs` with fault injection: dropped responses, duplicate
  pushes, out-of-order delivery, three devices, days offline, clocks ±1 h.
- SQL runs against a local Postgres with a stub `auth.uid()` that reads a session setting, using the same test
  vectors.
- The static test greps the client for secrets.

**Tested against the real project:**

- the second-user isolation test;
- a direct-write-must-fail test;
- iPhone + PC concurrent edits of the same planting;
- airplane-mode edits for several days.

**Exit:** all of the above pass, and the owner's data round-trips between the iPhone and the PC with conflicts
surfaced, not lost.

### Phase 2: photos. About 4-6 dev-days.

**Gate B: storage decision** (approval 2). Either Supabase Pro at $25/month (recommended), or the cost-down variant
(Cloudflare R2 + `/api/photo-url`).

**Ships:**

- private bucket and storage policies;
- `js/blobstore.mjs` adapter;
- upload queue with dedupe;
- metadata held back until its blob is confirmed;
- thumbnails eager, originals lazy, hash re-check on download;
- "Download all originals" (PC) and "Free up space" (manual);
- 80%-of-quota warning;
- the monthly integrity sweep, report only.

**Phase 2.1 (optional):** `/api/cron/gc` with the secret key in Vercel env.

**Tested without the cloud:**

- a fake `BlobStore` in the harness, content-addressed, with 409 and quota-error semantics;
- Playwright: kill mid-upload and resume, duplicate pick, hash mismatch;
- migration of existing photos to hashed blobs.

**Tested for real:** a 50-photo burst on cellular, download on the second device, and an offline garden session
followed by catch-up.

### Phase 3: server-side AI identification endpoint. About 1-2 dev-days, plus model evaluation.

**Gate C** (approval 3): provider, model, monthly cap, and the owner's consent to send photos to that provider.

**Ships:**

- `/api/identify.mjs`:
  - dependency-free;
  - verifies the user's token through `GET /auth/v1/user`;
  - requires `OWNER_USER_ID`;
  - takes the daily quota through `ai_quota_take()` using the **user's** token;
  - downscales to about 1024 px client-side;
  - caches results by `sha256`;
  - keeps the provider key in Vercel env.
- UI labels every result an unsourced suggestion (AGENTS rule 4) and never writes it into reference data.
- Choose the model by running a small evaluation on the owner's own labelled photos, and take the cheapest model
  whose accuracy is close to the best.

**Tested without the cloud:** unit tests with mocked auth and provider responses; quota-exhaustion and
oversized-body paths; a Preview deployment confirming that Functions deploy with no root `package.json`.

---

## 7. What needs the owner's approval before anything is provisioned

**Nothing has been provisioned.** Writing this document created no account, project, database, bucket, API key,
domain, DNS record, Vercel Function, environment variable or paid plan, and changed no application code.

Each item below needs the owner's explicit yes before anyone creates it:

1. **Supabase account and one Free project** (no card) for the Phase-1 spike and Phase 1.
   - Choose the region (US East/Central suggested for Brownsville; UNVERIFIED latency benefit).
   - The project URL and publishable key will be committed to the public repo, which is fine by design.
   - The Free plan allows 2 active projects.
2. **Storage decision for photo sync (Phase 2):**
   - (a) upgrade to **Supabase Pro, $25/month**, Spend Cap left on (recommended); or
   - (b) the cost-down variant: a **Cloudflare account and R2 bucket**, an R2 API token scoped to that bucket stored
     in Vercel env, and a `/api/photo-url` Vercel Function. R2 may require a payment method on file (UNVERIFIED).
3. **Vercel environment variables and Functions** on the existing Hobby project:
   - `OWNER_USER_ID`;
   - for GC: the Supabase secret key and `CRON_SECRET`;
   - for the AI endpoint: the provider key.
   - The owner also confirms that use stays personal and non-commercial (Hobby terms).
4. **Optional: a custom domain** (about $10-15/year, UNVERIFIED). Recommended before passkeys, because passkeys
   are bound to the domain, and before any custom email sending.
5. **Optional: an SMTP provider account** (and likely DNS records on a domain the owner controls), only if emailed
   sign-in codes or password-reset emails are wanted. Credentials go only into the Supabase dashboard.
6. **Optional: enabling Supabase Passkeys (beta).**
7. **AI provider account, API key, and a hard monthly spending limit** (Phase 3).
8. **Any root `package.json` or build step.** Not planned. If one is ever needed: explicit `framework`,
   `buildCommand` and `outputDirectory` in `vercel.json`, plus a verified Preview deployment, per AGENTS.md.
9. **Switching to the fallback stack** (Neon via the Vercel Marketplace, plus R2) if the spike fails or Supabase is
   rejected.

---

## 8. Open questions for the owner

1. **Budget:**
   - Is about $300/year acceptable for Supabase Pro once photos sync? That buys daily cloud backups, no pausing and
     one vendor.
   - Or do you prefer the about-$0 cost-down variant? Free tier with photos in Cloudflare R2: the cloud pauses
     after a quiet week until you press "Resume" in the dashboard, and there are no automatic cloud backups.
2. **Sign-in:**
   - Are you happy with your email plus a strong password saved in iCloud Keychain? No extra vendor; you type
     nothing after the first time.
   - Or do you want emailed 6-digit codes? That needs an email-sending service and probably a domain.
3. **Domain:** do you own a domain, or will you buy one? This matters for passkeys and custom email.
4. **Current data:** roughly how many progress photos and journal entries are on the iPhone today? This decides
   how soon 1 GB of free storage fills.
5. **PC:** which operating system and browser, and will you install GardenForge there as an app?
6. **iPhone:** which iOS version, and is iCloud Keychain turned on? (Needed for the spike.)
7. **Photos on the phone:** keep every full-size original on the iPhone forever, or allow a manual "Free up space"
   that removes originals already safely in the cloud? Thumbnails always stay.
8. **Conflicts:** is "merge automatically when different fields were edited; newest wins when the same field was
   edited, and the other version is kept for you to review" acceptable? Or should every overlapping edit wait for
   your choice?
9. **Use and users:** will GardenForge stay personal and single-user? Vercel Hobby is non-commercial only. The
   schema already carries a user id in case that changes.
10. **AI identification:** which provider, what monthly cap, and are you comfortable sending plant photos to that
    provider?
11. **Region:** is storing your garden data in a US data centre acceptable?
12. **Backups:** do you want a quarterly in-app reminder to save a Full backup to Files or iCloud Drive?
13. **Old data:** after the first successful Full backup and sync, may the app offer to remove the old v1 copy on
    each device? It never happens without your confirmation.
