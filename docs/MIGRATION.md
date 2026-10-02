# Migrating GardenForge data from schema v1 to v2

**Status: plan. Nothing here is implemented yet.** The shipped app (HEAD (`ce869ef` on `audit/roadmap-and-small-fixes`)) runs schema v1
only. The target model is in [`DATA-MODEL.md`](DATA-MODEL.md). Items marked **(verify)** need a test
on a real iPhone or in WebKit before anyone relies on them.

## Schema change log

`AGENTS.md` requires an entry here for every schema change.

| Schema | Migration id | Status | Summary |
| --- | --- | --- | --- |
| 1 | none | shipped | One JSON document in `localStorage["gardenforge.brownsville.v1"]`; photos in IndexedDB `gardenforge.photos.v1`. `e1e56e1`/`ce869ef` raised the per-collection cap from 1500 to 20,000, added the `completed`/`draft.rates` object checks and the `.unreadable.<timestamp>` recovery slots. No migration: every earlier backup stays valid. |
| 2 | `m1` | planned | Records with sync envelopes in IndexedDB `gardenforge.v2`; events, individual plants, content-addressed photo assets; photos included in full archives. This document. |
| 1 (no bump) | none | planned | AI camera (`docs/AI-CAMERA.md` section 4): optional fields on v1 photo records (`captureSetId`, `shotIndex`, `shotSlot`, …) and on journal entries (`planId`, `captureSetId`, `ai`), settings keys `aiConsent*`, and the device-local key `gardenforge.aiPending.v1`. No `schemaVersion` change; `validateState` neither rejects nor rewrites a document because of them; old builds ignore them. |

## 1. Principles

1. **Non-destructive.** The migration never writes, upgrades or deletes the v1 key
   `gardenforge.brownsville.v1` or the v1 photo database `gardenforge.photos.v1`. Only explicit,
   separately confirmed owner actions touch them later, each after a `v1-raw` snapshot of the key:
   the lossy "copy my changes into version 1" rollback (R1b, which writes the key and only *adds*
   photo records), "Restore version 1 data" (R3), replacing the key with a small stub at retirement
   (section 12), and deleting the v1 photo database after that (section 12.3).
2. **Idempotent.** Every v2 id is a verbatim v1 id or derived from one, and every write is an
   upsert. Running the migration again on unchanged v1 data changes zero records (no `rev` moves).
3. **Resumable.** Each phase commits atomically. If iOS kills the app mid-way, the next launch
   continues from the last committed phase (section 14).
4. **Verified before switching.** The app switches to v2 only after a per-record comparison passes.
5. **Reversible.** Until retirement, switching back to v1 is one tap and loses nothing that existed
   in v1 (section 11).
6. **Visible to the owner.** The owner starts it, makes a full backup first, sees progress and the
   counts before and after, and can read the report later in Settings. Nothing happens silently.
7. **Deletions are never inferred.** A record missing from a later re-read of v1 data goes to a
   review list; it is never tombstoned automatically (section 9.2).
8. **No fabrication.** Unknown dates, times, weights and methods stay `null`, `''` or text. The
   migration creates no Plant records and no status, sowing or transplant events.
9. **One writer.** After the switch, v2 is the only writer of garden data on that device.

## 2. Inputs

What can exist on a device before migration (details in `DATA-MODEL.md` section 2):

| Input | Notes |
| --- | --- |
| `localStorage["gardenforge.brownsville.v1"]` | The v1 document. May have been written by HEAD or by any older cached build (1500-item cap). |
| `localStorage["gardenforge.brownsville.v1.unreadable.<ts>"]` | Zero or more recovery copies written by HEAD when the key failed validation. |
| IndexedDB `gardenforge.photos.v1`, store `photos` | May be absent (the owner never opened a photo dialog), empty, or contain orphans (plan delete never removed photos). |
| `#embedded-state` | Always `null` on the hosted site. Only portable HTML copies carry data (section 13.2). |

## 3. Code that must ship before migration is offered (step 0)

The v2 build contains both code paths. At boot it chooses one (section 3.2).

### 3.1 Changes

1. **Keep the v1 code path** exactly as in HEAD for v1 mode (before migration and after a
   rollback), with changes 2 to 4 below.
2. **Remove the boot write-back of the v1 key in every mode.** HEAD rewrites the key on every
   launch (`if(!unreadableSaved) localStorage.setItem(KEY, …)`), and writes `defaultState()` when the
   key is absent. After retirement or a rollback that write would plant an empty garden that a later
   boot could mistake for real data, and even a plain rewrite changes the key's hash. Storage
   availability is tested with a probe key (`gardenforge.probe`) instead. A newer embedded document
   (portable copy) is still loaded into memory and is written by the first `save()`, as before. On
   the hosted site `#embedded-state` is always `null`. Older cached builds keep the write-back;
   section 9.2 copes with it.
3. **`savePlan` issues `uid('pln')`** for new plantings in both modes. Nothing in v1 reads the prefix.
4. **Never open `gardenforge.photos.v1` at a version other than 1, and never create it outside v1
   mode.** In IndexedDB there is no read-only open: `indexedDB.open(name, 1)` on a device without the
   database creates an empty one with no `photos` store, and v1 `photoDB()` would then fail forever
   because its `onupgradeneeded` never runs again. Migration, the v2 boot check and the byte copy
   use:

   ```js
   async function openV1PhotosIfExists() {
     if (indexedDB.databases) {
       const dbs = await indexedDB.databases();
       if (!dbs.some((d) => d.name === 'gardenforge.photos.v1')) return null;
     }
     return new Promise((resolve) => {
       const q = indexedDB.open('gardenforge.photos.v1', 1);
       q.onupgradeneeded = () => q.transaction.abort();   // the DB did not exist: do not create it
       q.onsuccess = () => {
         const db = q.result;
         if (!db.objectStoreNames.contains('photos')) { db.close(); resolve(null); } else resolve(db);
       };
       q.onerror = () => resolve(null);                    // AbortError lands here: zero v1 photos
       q.onblocked = () => resolve(null);
     });
   }
   ```

   **(verify)** that aborting the first upgrade leaves no database behind in WebKit; the spec says a
   newly created database is removed when its upgrade transaction aborts. A test opens it on a
   clean profile and then checks `indexedDB.databases()` and v1 `photoDB()` still work.
5. **`validateV1Lenient`**: HEAD's `validateState` without the per-collection count cap. Every
   structural, numeric and string-length check stays, and so do HEAD's three normalisations
   (`completed` and `rates` default to `{}`, `harvestMin`/`harvestMax` fill each other). A garden HEAD
   refuses only for size (over 20,000 entries) can then be migrated instead of being stuck. It runs
   on a deep copy, so the raw string that was hashed is never altered.
6. **Full archive export** in v1 mode (section 4.2), with an inline store-only ZIP writer.
7. **Pure functions** with unit tests and no I/O: `migrateV1toV2(doc, ctx)`, `migratePhoto(rec, ctx)`,
   `v1Fields(record)`, `toV1(record)`, `canonical(x)`, `validateStateV2(input, mode)`.
8. **Tab coordination**: `navigator.locks` (Web Locks) for the migration and the byte copy, with a
   lease record in `meta` as a fallback, and `BroadcastChannel('gardenforge')` with the messages
   `migration-started`, `schema-changed` and `records-changed`. The current `sw.js` reloads only the
   tab that applied an update, so these messages are what reload other open tabs. Tabs running an
   older build do not listen; their writes are caught by section 9.
9. The tests in section 15.

### 3.2 Boot decision

IndexedDB is authoritative. The `localStorage` value `gardenforge.mode` is only a hint used when
IndexedDB does not open.

| IndexedDB `gardenforge.v2` | `meta.mode` | Records present | Result |
| --- | --- | --- | --- |
| Opens within 4 s | `v2` | any | v2 mode. |
| Opens | `v1` | any | v1 code path (the owner rolled back). Settings offers "Return to version 2". |
| Opens (or does not exist yet) | absent | none, **and** the v1 key is absent or an untouched default (`updatedAt: ''`, every collection empty, `completed` empty), **and** `openV1PhotosIfExists()` finds no photos | Fresh install. One strict transaction writes a default Garden (`gdn_default`, name `My Brownsville garden`, zone `10a`, as v1 `defaultState()`), the default draft, `meta.device`, `meta.migration = {phase: 'fresh'}` and `meta.mode = v2` (with `v1Hash` and `v1UpdatedAt` of the key if one exists). v2 mode. Section 9.2 still watches the key, so data an older cached build saves there later is merged. No backup step, because there is nothing to back up. The v1 key, if present, is left as it is. |
| Opens (or does not exist yet) | absent | none, or only records written by migration (`legacy.migrationId === 'm1'`) from an unfinished run | v1 code path. A banner offers to start, or continue, the upgrade. |
| Opens | absent | any record with `legacy: null` (created in v2, not by migration) | Contradiction. No automatic migration. A recovery screen offers "Use the version 2 data" (writes `meta.mode = v2`) or "Use the version 1 data". |
| Fails or times out after 4 s | hint `v2` | unknown | Read-only render from the v1 key if it holds a valid v1 document, with a banner: "Showing your garden as of DATE. Changes made since the upgrade are not shown. Editing is paused." Otherwise an error screen with Retry and Import. Retries on resume. |
| Fails or times out | hint absent or `v1` | unknown | v1 code path (v1 needs IndexedDB only for photos), with a banner "Storage is slow to open; retrying". The open is retried in the background; if it later succeeds and `meta.mode` is `v2`, the page reloads into v2 mode. |

The last row can run a migrated device in v1 mode if the hint was lost (for example, the hint write
failed because storage was full) and IndexedDB was slow. Edits made then go into the frozen v1 key,
and the next v2 boot merges them under the rules in section 9.2. Nothing is lost.

**The v1 code path of a v2 build never runs over a retirement stub.** If the v1 key holds the stub
(section 12.2), that path shows the IndexedDB error screen with Retry and Import instead of an empty
garden, and its `save()` is disabled, so the stub is never overwritten by this build.

A key that is absent while v1 photos exist (site data partly cleared) is not a fresh install: the
upgrade is offered with an empty v1 document, and the photos migrate as photos without a planting
(section 8).

## 4. Preconditions

### 4.1 Automatic checks

All must pass before the upgrade is offered. If one fails, the app stays in v1 mode, shows a
non-blocking notice saying which check failed, and checks again on the next launch.

1. IndexedDB opens within 4 s and `gardenforge.v2` can be created.
2. SHA-256 works (`crypto.subtle.digest`, or the inline fallback in a non-secure context).
3. The v1 key parses and passes `validateV1Lenient`, or is absent while v1 photos exist (then an
   empty v1 document is used). If the key fails even `validateV1Lenient` (HEAD then shows its "saved
   garden data could not be read" warning), the owner resolves that first.
4. Free space from `navigator.storage.estimate()`: at least 3 × the v1 JSON size, plus 40 KB per v1
   photo (thumbnail and metadata), plus 20 MB. The full photo copy is checked separately later
   (section 7.3).
5. The migration lock is free (no other tab is migrating).
6. The page is the hosted site. A portable `file://` copy migrates in memory only (section 13.2).

### 4.2 Required full backup, including photos

v1 backups do not contain photos, so the owner must make a **full archive** before the upgrade
button is enabled. The sheet shows the counts that will be migrated and the archive size.

```
GardenForge-v1-archive-YYYY-MM-DD[-partN].zip     store-only ZIP, built from Blob parts,
                                                  split at about 400 MB per part
  manifest.json                    {format: 'gardenforge-v1-archive', version: 1, createdAt, appVersion,
                                    part, parts, v1Sha256, v1UpdatedAt, counts: {...},
                                    photosFailed: [{id, error}], files: [{path, sha256, bytes}]}
  gardenforge.brownsville.v1.json  the localStorage string, byte for byte (part 1)
  photos.json                      [{id, planId, createdAt, height, heightUnit, stage, note, path, sha256, bytes}]
  photos/<v1PhotoId>.jpg           each v1 blob, byte for byte
  unreadable/<slot key>.json       every .unreadable.<ts> slot, verbatim (part 1)
```

- The JSON file inside imports into HEAD when it is under 15 MB and into older cached builds when
  it is under 3 MB. The whole archive imports into a v2 build (section 13).
- The button counts as done when `deliverFile` returns `shared` or `downloaded` for every part. The
  app cannot see where the file went, so the sheet says "Make sure the file is in Files or iCloud
  Drive before you continue". An optional "Check a backup file" reads an archive back and checks
  every hash without writing anything.
- The result is recorded in `meta.migration.preMigrationBackup` (`{at, parts, bytes, v1Hash,
  photoCount, photosFailed}`). It stays valid for resuming an interrupted migration for 7 days, and
  only while the v1 hash is unchanged.
- If the archive cannot be made (no space, share sheet failure), the app stays on v1, which is safe.
  Whether to allow a deliberate bypass is an open question (section 16).

## 5. Step-by-step migration

| Phase | What happens | Writes | Atomicity | If the app is killed |
| --- | --- | --- | --- | --- |
| P1 Snapshot | Read the v1 key once, hash it, store a byte-exact copy | `meta`, `snapshots` | One strict transaction | Nothing or everything; v1 mode; "Continue upgrade" |
| P2 Transform | Build all non-photo v2 records in memory | none | Pure function | Rerun |
| P3 Records | Upsert structured records | `records`, `meta` | One transaction (chunked fallback) | Rerun P2 and P3; upserts are idempotent |
| P4 Photos | Hash, measure, thumbnail and register each v1 photo | `records`, `thumbs`, `assetLocal`, `meta` | One transaction per batch of 20 | Resume by set difference |
| P5 Verify | Compare every record against the snapshot | none | Read-only | Rerun |
| P6 Switch | Set `meta.mode = v2` | `meta` | One strict transaction | IndexedDB decides on next boot |
| P7 Byte copy | Copy photo bytes into `blobs` (v2 mode, background) | `blobs`, `assetLocal`, `meta` | Per batch | Resumes in the background |

While P1 to P6 run, the v1 screens stay visible under a progress sheet but are inert (read-only),
and other v2-build tabs receive `migration-started` and go read-only. The sheet says: "Upgrading
garden history storage. Your garden is not being changed. If the app closes, the upgrade continues
next time." It has a Cancel button that stops before P6 and leaves the app on v1.

### P1. Snapshot (the first v2 writes)

1. Take the migration lock. Broadcast `migration-started`.
2. `raw = localStorage.getItem('gardenforge.brownsville.v1')`, read once. `v1Hash = sha256(utf8(raw))`.
   `v1 = validateV1Lenient(JSON.parse(raw))`. Count the source records: beds, plans, logs,
   `completed` keys, recipes, custom crops, custom ingredients, v1 photo keys (through
   `openV1PhotosIfExists` and `getAllKeys`), unreadable slots.
3. Open or create `gardenforge.v2` (version 1) with the stores and indexes in `DATA-MODEL.md`
   section 4.
4. One readwrite transaction with `durability: 'strict'` where supported:
   `meta.device` (created if absent), `meta.migration = {phase: 'snapshot', runs: runs + 1,
   startedAt, v1Hash, v1UpdatedAt, counts, now}`, and
   `snapshots.put({id: 'snap_v1raw_<ts>', kind: 'v1-raw', reason: 'pre-migration', raw, sha256: v1Hash,
   takenAt})` unless a pre-migration snapshot with the same hash already exists.

### P2. Transform (pure, in memory)

`records = migrateV1toV2(v1, {now, deviceId, migrationId: 'm1'})`, following section 6 exactly.
`now` is captured once per run and stored in `meta.migration`, so every record of a run carries the
same `legacy.migratedAt`. Every record gets `rev: 1`, `createdAt: null`, `source: 'migration-v1'`
(events) and `legacy = {src: 'v1', store: 'localStorage', migrationId: 'm1', migratedAt: now,
v1: <deep copy of the record as validateV1Lenient left it>}`. The byte-exact original stays in the
P1 snapshot. Odd v1 data is handled as in section 8 (non-string ids, duplicates, missing fields).

### P3. Structured records

One readwrite transaction over `records` and `meta`. It contains only `get` and `put` requests: all
computation happened in P2, so the transaction cannot auto-commit half-way. For each built record,
look up `[t, id]`:

| Stored record | Action |
| --- | --- |
| absent | `put` it. |
| v1-sourced (`legacy.src === 'v1'`) and `canonical(stored.legacy.v1) === canonical(built.legacy.v1)` | Skip. No `rev` change. |
| v1-sourced and the v1 side changed | Three-way merge of the v1-visible fields (section 9.3). `rev + 1`. `legacy.v1` = the new v1 record. |
| not v1-sourced (created in v2) | Leave it untouched and log a warning. |

Stored v1-sourced records whose id is missing from this v1 document are **not tombstoned**. They are
added to `meta.v1Review.removedInV1` for the owner to review (only possible on a re-run). Set
`meta.migration.phase = 'records-done'` in the same transaction.

On the first run every record is "absent". **(verify)** that one transaction of tens of thousands of
puts commits on iOS. If it aborts for size, repeat P3 in chunks of 2000 records; this is safe because
the upserts are idempotent and P5 checks the result.

### P4. Photo metadata

1. `db1 = await openV1PhotosIfExists()`. If `null`, there are no v1 photos; go to P5.
2. `keys` = `getAllKeys()` on `photos` in one short read-only transaction. `pending` = keys that have
   no stored event with a `legacy.v1` photo record. (A cursor position is never trusted: v1 photo
   ids are random, so a photo added during the run could sort before it.)
3. For each pending id, in batches of 20:
   1. Short read-only transaction on the v1 database: `get(id)`.
   2. Outside any transaction: `bytes = await rec.blob.arrayBuffer()`; `sha = sha256(bytes)`;
      decode with `createImageBitmap(rec.blob)` for width and height (or read them from the JPEG
      SOF marker); make the thumbnail (320 px long edge, JPEG 0.7).
   3. One readwrite transaction on `records`, `thumbs`, `assetLocal` and `meta`: put the PhotoAsset
      if absent; put `assetLocal = {sha256, where: 'v1db', v1PhotoId: id, thumb, verifiedAt: now}`;
      put the thumbnail if absent; upsert the event (id = v1 photo id, rules as in P3); update
      `meta.migration.photoProgress`.
   - If `arrayBuffer()` throws (WebKit can fail with `NotReadableError` on stored blobs), still write
     the event with the full v1 metadata, `photoAssetIds: []` and `payloadStatus: 'partial'`, and add
     `{id, error}` to `meta.migration.photosFailed`. It never blocks the migration.
   - If the bytes read but do not decode, create the asset with `width: null`, `height: null` and no
     thumbnail. The bytes are still copied later.
4. Take `getAllKeys()` again. New ids (an older tab saved a photo meanwhile) go through step 3.
   Repeat until no new ids appear, at most 5 rounds. An id that disappeared after its event was
   written gets `assetLocal.where = 'missing'` and an entry in `meta.v1Review.photosRemovedInV1`.
5. `meta.migration.phase = 'photos-meta-done'`.

Expect P4 to take noticeable time on a phone: decoding a 1600 px JPEG and encoding a thumbnail is
roughly 50 to 150 ms per photo, so about 1 to 3 minutes per 1000 photos **(verify on a real
iPhone)**. The sheet shows "Photo N of M". Each batch commits on its own, so a kill loses at most one
batch of work.

### P5. Verify (read-only, from fresh transactions)

1. **Presence.** For every v1 record (after the id rules in section 8), a stored record `[t, id]`
   exists: one Garden, one draft, each recipe, bed, plan, log, `completed` key, custom crop and
   custom ingredient.
2. **Per-record equality.** `canonical(toV1(stored)) === canonical(v1Record)`, where `canonical`
   only sorts object keys. Untouched records project from `legacy.v1`, so this is exact.
3. **`completed`**: the same keys with the same booleans. **Settings and draft**: exact.
4. **Photos.** Every v1 photo key that exists now has an event whose `legacy.v1` equals the v1 record
   without `blob`. Readable photos have a PhotoAsset and an `assetLocal` row. Unreadable photos are
   in `photosFailed`, which is an accepted outcome. **Bytes are not re-hashed here**: P4 hashed the
   bytes it had just read, and byte verification belongs to the copy (P7) and to retirement.
5. **Freshness.** Re-read the v1 key. If its hash differs from `v1Hash` (an older tab saved), return
   to P2 with the new string.

Outcomes:

- **Pass**: go to P6.
- **Pass with flags** (per-record mismatches and/or unreadable photos): the sheet lists them by id
  and offers "Continue with N flagged records" or "Stay on version 1". Flagged records keep
  `legacy.v1` and are projected from it until the owner edits them, so the v1 screens show exactly
  the v1 data. The list stays in Settings.
- **Fail** (a record is missing, a read failed): retry P3 to P5 automatically, at most 3 attempts per
  `v1Hash` (`meta.migration.attemptsByV1Hash`). Then `phase = 'failed'`; the app stays on v1; Settings
  offers "Try again" and "Export migration diagnostics" (counts, ids and error messages, no notes or
  photos). A killed tab is an interruption, not an attempt.

### P6. Switch

1. One readwrite transaction on `meta`, `durability: 'strict'` where supported:
   `meta.mode = {value: 'v2', since: now, migrationId: 'm1', v1Hash, v1UpdatedAt}`,
   `meta.migration.phase = 'switched'`, `finishedAt`. This commit is the switch.
2. After `oncomplete`: `localStorage.setItem('gardenforge.mode', 'v2')`. A `QuotaExceededError` here
   is ignored apart from a "storage nearly full" notice; IndexedDB already holds the decision.
3. Broadcast `schema-changed` (other tabs reload). Release the lock. Reload into v2 mode.
4. Show the migration report: counts before and after, flagged records, unreadable photos, orphans,
   and what happens next (photo copy, how to roll back).

### P7. Background photo byte copy

Runs in v2 mode under the copy lock. See section 7.3.

## 6. Field-by-field mapping

### 6.1 v1 to v2

| v1 source | v2 target | Rule |
| --- | --- | --- |
| `schemaVersion` (1) | `meta.mode`; backups say `schemaVersion: 2` | The v1 value stays in the v1 key and snapshot. |
| `updatedAt` | `meta.mode.v1UpdatedAt`, `meta.migration.v1UpdatedAt` | Used by the re-merge continuity check. Never used as a record's `createdAt`. |
| `settings.name` | Garden `gdn_default`, `name` | Verbatim. |
| `settings.zone` | Garden `zone` | Verbatim. A label only. |
| `settings` (whole object) | Garden `legacy.v1` | Verbatim, including unknown keys. |
| (none) | Garden `timeZone: 'America/Chicago'`, `seasons: []` | Defaults, not claims. |
| `draft` | Draft record `{t: 'draft', id: 'draft', value, syncScope: 'device'}` | Verbatim deep copy. |
| `recipes[i]` (every field) | Recipe, same id | Verbatim. `savedAt` stays a date. `createdAt: null`. |
| `beds[i].id` | Space `id` | Verbatim. |
| `beds[i].name, type, length, width, depth, light, notes` | Space, same names and units | Verbatim. Missing strings become `''` (the original stays in `legacy.v1`). Adds `gardenId`, `capacityL: null`, `archivedAt: null`. |
| `plans[i].id` | Planting `id` | Verbatim. `plant_*` means planting. |
| `plans[i].cropId, cropName, group, variety, count, bedId, date, mode, leadWeeks, harvestMin, harvestMax, notes, mixId, mixName, status` | Planting, same 15 names | Verbatim. Missing strings become `''`; missing `harvestMin`/`harvestMax` become `null`. Adds `gardenId`, `harvestEstimateSource: 'unknown'`, `seasonLabel: null`. |
| (none) | Plant records, `state_change`, `sowing`, `transplant` events | **None created.** v1 has counts, not individuals, and no dates for status. |
| `logs[i].id` | Event `id` | Verbatim, so `completed['<logId>:review']` still matches. |
| `logs[i].kind` | Event `type`; `legacy.v1.kind` | Per `DATA-MODEL.md` section 7.3; unknown kinds become `note`. `payload: {}`, `payloadStatus: 'legacy-text'`. |
| `logs[i].title` | Event `title` | Verbatim, `''` allowed. |
| `logs[i].date` | Event `occurredOn` | Verbatim. `occurredAt: null`, `occurredAtSource: 'none'`, `recordedAt: null` (the entry time is unknown). |
| `logs[i].reviewDate` | Event `followUpOn` | `''` or missing becomes `null`; otherwise verbatim. |
| `logs[i].bedId` | Event `scope`, `spaceId` | Non-empty: `scope: 'space'`, `spaceId` = bedId, even if that bed was deleted. `''` or missing: `scope: 'garden'`, `spaceId: null`. Always `plantingId: null`, `plantIds: []`. |
| `logs[i].notes` | Event `notes` | Verbatim. Never parsed into numbers. |
| (none) | Event `gardenId`, `payloadVersion: 1`, `photoAssetIds: []`, `relatedEventIds: []`, `stageObserved: null`, `healthCaseId: null`, `source: 'migration-v1'` | Defaults. |
| `completed[key] = bool` | TaskMark `{id: key, done: bool}` | One record per key; `false` kept. |
| `customCrops[i]` | CustomCrop, same id | Verbatim. |
| `customIngredients[i]` | CustomIngredient, same id | Verbatim. |
| photo `id` | Event `id`; `assetLocal.v1PhotoId` | Verbatim, so a re-run upserts instead of duplicating. |
| photo `planId` | Event `scope: 'planting'`, `plantingId` | Verbatim, even when no such planting exists (an orphan, section 8). `spaceId` = that planting's `bedId` if it exists and is non-empty, else `null` (v1 kept no location history). `planId: ''` gives `scope: 'garden'`. |
| photo `createdAt` | Event `occurredAt`, `recordedAt`; `occurredOn`; PhotoAsset `recordedAt` | `occurredAt` = `recordedAt` = `createdAt`, `occurredAtSource: 'save-time'`. `occurredOn` = the `America/Chicago` date of that instant. PhotoAsset `capturedAt: null`. |
| photo `height`, `heightUnit` | Event `type` and `payload` | If `height.trim()` matches `^(\d+(\.\d+)?\|\.\d+)$` and `heightUnit` is `in`, `cm` or empty: `type: 'measurement'`, `payload = {measures: [{metric: 'height', value: Number(height), unit: heightUnit or 'in', rawText: height}], aggregate: 'unspecified'}`. Otherwise `type: 'photo'`, `payload: {}`. An empty height is a photo, **never a height of 0**. The raw strings are always in `legacy.v1`. |
| photo `stage` | Event `stageObserved` | `''` becomes `null`; otherwise verbatim. Never creates flowering or fruiting events. |
| photo `note` | Event `notes` | Verbatim. |
| photo `blob` | PhotoAsset `sha256-<hex>`, `thumbs` entry, `assetLocal`, Event `photoAssetIds: [assetId]` | Hash of the exact bytes. `mime` = `blob.type` or `image/jpeg`; `bytes` = `blob.size`; `width`/`height` decoded (or `null`); `exifStripped: true`; `sourceSha256: null`; `transform: 'canvas-jpeg-q0.82-max1600'`; `assetLocal.where: 'v1db'` until P7. Unreadable: `photoAssetIds: []`, `payloadStatus: 'partial'`. |
| photo record without `blob` | Event `legacy.v1` | Verbatim. |
| `.unreadable.<ts>` slots | nothing automatic | Listed in Settings, "Check data" (section 8). |

### 6.2 v2 back to v1 (`v1Fields`, used by the v1 screens and by verification)

`toV1(record)` returns `legacy.v1` for untouched or flagged records (with `id` set to the record's
id when section 8 had to rename it), otherwise `{...legacy.v1, ...v1Fields(record)}`. Records
created in v2 have no `legacy`, so they project from `v1Fields` alone.

| v2 record | v1 shape |
| --- | --- |
| Garden | `settings = {name, zone}` |
| Space (not archived, not deleted) | `beds[] = {id, name, type, length, width, depth, light, notes}` |
| Planting (live, not a conflict copy) | `plans[]` with the 16 v1 fields |
| Event of any type except `photo`, `measurement`, `state_change` (live, not a conflict copy) | `logs[] = {id, kind, title, date: occurredOn, reviewDate: followUpOn ?? '', bedId: spaceId ?? '', notes}`. `kind` = `legacy.v1.kind`, else `Observation`, `Harvest`, `Feeding`, `Pest scouting`, `Soil / media test`, `Mix batch`, `Compost` for the matching types, else a display label (`Watering`, `Pruning`, `Treatment`, `Disease / symptom`, `Transplant`, `Sowing`, `Flowering`, `Fruiting`). For v2-created events with an empty title, `title` is a short summary such as `Harvest: 1840 g`. |
| TaskMark (live) | `completed[id] = done` |
| Recipe, CustomCrop, CustomIngredient (live) | Their v1 fields verbatim |
| Draft | `draft = value` |
| `photo` and `measurement` events with photos | Not part of `state`. `photoList(planId)` returns `{id, planId, createdAt: occurredAt ?? recordedAt, height, heightUnit, stage: stageObserved ?? '', note: notes, blob}`, where `height`/`heightUnit` come from the first height measure (`rawText` and `unit`), else from `legacy.v1.height`/`heightUnit` (so a migrated raw value such as `1e2` still shows), else `''`. `blob` is the thumbnail in galleries and the full image when opened. |

## 7. Photos

### 7.1 What happens to each existing photo

- Its metadata becomes one event whose id is the v1 photo id (`measurement` if it had a usable
  height, otherwise `photo`), scoped to its planting, with the full v1 record kept in `legacy.v1`.
- Its bytes are hashed exactly as stored and registered as one PhotoAsset (`sha256-<hex>`).
  Identical bytes saved twice become one asset referenced by two events.
- A thumbnail is made during migration, so galleries work immediately.
- The bytes stay in the v1 database until P7 copies them, byte for byte, into `blobs`. Nothing is
  re-encoded.
- The v1 database is not modified or deleted by migration.
- Photos taken for AI checks follow the same rule, one event per v1 photo record, never merged; their
  `captureSetId` grouping, the `ai_assessment` mapping for journal entries that carry an `ai` object and the
  projection back to v1 are in `docs/AI-CAMERA.md` section 4.8.

### 7.2 Timestamps

v1 re-encoded every photo through a canvas, so the stored bytes carry no EXIF and the original
capture time is unrecoverable. Therefore: `capturedAt: null`; PhotoAsset `recordedAt` = v1
`createdAt`; event `occurredAt` = v1 `createdAt` with `occurredAtSource: 'save-time'` (the UI says
"saved at", not "taken at"); `occurredOn` = that instant's date in `America/Chicago`. A photo saved at
8 pm on 28 September in Brownsville is `2026-09-29T01:00Z` in v1 and `occurredOn: 2026-09-28` in v2.

### 7.3 Background byte copy (P7, after the switch)

1. Before starting, tell the owner how much space the copy will use until the old copies are removed
   ("about X MB").
2. Batches of 20 under the copy lock. Before each batch, check `navigator.storage.estimate()`: free
   space must be at least 2 × the batch's bytes, otherwise pause with a notice.
3. Per photo: short read-only transaction on the v1 database; outside any transaction,
   `arrayBuffer()` and SHA-256; compare with `asset.sha256`; then one readwrite transaction on
   `blobs` and `assetLocal`: put the blob if absent, set `where: 'v2'` and `verifiedAt`. Regenerate a
   missing thumbnail. A hash mismatch leaves `where: 'v1db'` and logs an error.
4. When every readable asset is `v2`, set `meta.migration.phase = 'photos-copied'`.
5. If space never allows the copy, the device stays in **low-space mode**: bytes are read from the v1
   database, Settings says so, and retirement is not offered.

Reading bytes always goes through `getPhotoBlob(sha256)`, which follows `assetLocal.where`.

### 7.4 Photos added or deleted by older copies of the app

v1 `photoPut` and `photoDelete` never touch `localStorage`, so the v1 key hash cannot reveal them.
Section 9.4 handles them with a key set difference on every boot.

## 8. Orphans and odd v1 data

| Case | Handling |
| --- | --- |
| Photo whose `planId` matches no plan (plan deleted in v1) | Migrated anyway: `scope: 'planting'` with the dangling `plantingId`. Orphan status is derived, not stored. Listed under "Photos without a planting" with "Link to a planting" (a normal edit). Never dropped. |
| Photo with `planId: ''` | `scope: 'garden'`. |
| Log or plan whose `bedId` points to a deleted bed | Kept verbatim (a dangling `spaceId` or `bedId`); the v1 screens show it as before. |
| Plan whose `mixId` points to a deleted recipe or a built-in recipe | Kept; the name comes from `mixName`. |
| `completed` key for a plan or log that no longer exists | TaskMark kept verbatim (harmless). |
| Non-string id (possible in a hand-edited backup) | `String(id)`; `legacy.v1` keeps the original; warning. The v1 projection uses the string id. |
| Duplicate id within one collection | The first keeps the id; later ones become `<id>~dup2`, `<id>~dup3`, with a warning. `completed` keys apply to the first. The v1 projection uses the new ids, so the v1 screens no longer see two records with one id, and P5 compares against the renamed ids. |
| Same id in two collections | No problem: the key is `[t, id]`. |
| A v1 photo id equal to a v1 log id (both become events; possible only in hand-edited data) | The log keeps the id; the photo event becomes `<id>~photo`, with a warning. `legacy.v1.id` keeps the original. |
| Values v1 accepted that v2 would not write (non-integer `count`, long strings, missing optional fields, `''` titles, unknown kinds, types or light labels) | Kept, with warnings. Never quarantined. |
| Unreadable photo blob | Event with metadata and no asset; `photosFailed`. |
| Bytes that do not decode as an image | Asset with `width`/`height` `null`, no thumbnail; bytes copied in P7. |
| `.unreadable.<ts>` slots | Not migrated automatically. Settings, "Check data" lists them with Download and "Recover into version 2": parse with `validateV1Lenient`, migrate in memory, show the records that are not already present, import only what the owner ticks. Never overwrites, never deletes, and the slot is never removed automatically. |
| A v1 document HEAD refuses only because it has more than 20,000 entries | `validateV1Lenient` accepts it, so it can be migrated. |

## 9. The dual-read period

### 9.1 Definition

From the switch until the owner retires v1 (at least 30 days, section 12). During it, v2 is the
only writer of garden data on the device. The v1 key and v1 photo database are kept untouched and
are read on every boot, to notice writes by older copies of the app and to allow rollback.

### 9.2 Re-reading the v1 key

Older copies can still write the v1 key: a tab that never reloaded, the app opened offline before
the new build was cached, a redeployed old build, or v1 mode after a rollback. On every v2 boot
(and on `visibilitychange` to visible), before and after retirement:

1. `raw = getItem(KEY)`. If `null`, do nothing except note it in "Check data". A missing key is
   never treated as deletions.
2. If `sha256(raw) === meta.mode.v1Hash`, do nothing. After retirement, a key that holds the
   retirement stub is the expected state: do nothing.
3. Parse it with `validateV1Lenient`. If that fails, do nothing automatic; note it in "Check data".
   - **Rewrite without a save.** If `incoming.updatedAt === meta.mode.v1UpdatedAt`, an older build
     rewrote the key at boot without saving (its write-back re-serialises and normalises). Compare
     `canonical(incoming)` with `canonical(validateV1Lenient(snapshot))`. Equal: store the new hash
     in `meta.mode.v1Hash` and stop. Different: treat it as foreign (step 4, "Review").
4. **Continuity check.** Merge automatically only if all hold:
   - `incoming.updatedAt` is not `''` and is later than `meta.mode.v1UpdatedAt` (a `defaultState()`
     written at boot by an older build has `updatedAt: ''`);
   - at least 50% of the ids of live v1-sourced records in v2 are present in the incoming document (or
     v2 had none);
   - the phase is not `v1-retired`.

   Otherwise nothing is applied. "Check data" shows "An older copy of GardenForge wrote different
   garden data on DATE" with "Review" (per-record import of additions only; settings and draft only
   on an explicit tap; never a delete) and "Ignore".
5. **Merge** (continuous documents only), in one transaction, after saving `v2-before-images` of the
   records it will change:
   - New ids become new records (`source: 'migration-v1'`, with `legacy.v1`).
   - Records with a v1 base are merged field by field (section 9.3). The base is `legacy.v1` for migrated
     records, or the record written by a down-projection (`meta.downProjection.written`) for records
     created in v2 and copied to v1 during a rollback.
   - Records without any v1 base (created in v2 and never down-projected) are never changed by a v1
     re-read. A matching id is logged as a collision.
   - v1-sourced records missing from the incoming document go to `meta.v1Review.removedInV1`. The
     owner can tombstone them one by one or dismiss them.
   - `meta.mode.v1Hash` and `v1UpdatedAt` are updated in the same transaction.
   - A toast says "Merged N changes made in an older copy of GardenForge", with Undo (restores the
     before-images).

### 9.3 Three-way field merge

For each v1-visible field `f`, with `base` = the stored v1 base, `theirs` = the incoming v1 record,
`ours` = `v1Fields(stored)`:

- `theirs[f]` equals `base[f]`: keep ours.
- `ours[f]` equals `base[f]`: take theirs.
- both changed to the same value: nothing to do.
- both changed differently: keep ours, and save the incoming version as a conflict copy
  (`conflictOf` set, new id with the type's current prefix). Conflict copies stay out of the v1
  screens and analytics until resolved.

v2-only fields are never touched by a v1 merge. After the merge, the stored v1 base becomes
`theirs`.

### 9.4 Re-checking the v1 photo database

While the v1 photo database exists (not yet deleted in section 12.3), every v2 boot runs:

1. `db1 = openV1PhotosIfExists()`; `keys = getAllKeys()`.
2. Keys with no event: run P4 for them, then copy their bytes (P7). Additions are safe, so this is
   automatic, with a toast "Added N photos saved by an older copy".
3. Events with a `legacy.v1` photo whose key disappeared: if `assetLocal.where === 'v2'`, the bytes
   are safe; if it was `v1db`, set `where: 'missing'` (the gallery shows "photo removed by an older
   copy of the app"). Either way, add it to `meta.v1Review.photosRemovedInV1`; the owner decides
   whether to delete the event. Nothing is deleted automatically.

### 9.5 How the unchanged screens keep working (the facade)

The global `state` object is built from v2 records with `toV1` (section 6.2): `settings` from the
Garden, `draft` from the draft record, `recipes`, `beds`, `plans`, `logs`, `customCrops` and
`customIngredients` from live records (archived spaces and unresolved conflict copies excluded), and
`completed` from TaskMarks. The existing render and handler code reads and mutates `state` as before.
`save()` hands the result to a **commit queue** that turns differences into v2 writes:

- **Compare against the stored records, never against a previous projection that shares objects
  with `state`.** v1 handlers mutate objects in place, so an object-identity diff would miss edits.
- `draft`, `settings` and `completed` are compared by `canonical` JSON on every commit (small).
  This covers the part steppers and part, rate, target, unit and name inputs on the mix page, the
  garden name and zone settings, task check boxes, `part-remove`, `bed-mix`, and the check-off
  cleanup in plan delete and log delete.
- `plans` elements are compared field by field against `v1Fields(stored)` on every commit (this
  covers the status select and the `bedId = ''` loop in bed delete). Membership is compared by id.
- `recipes`, `beds`, `logs`, `customCrops` and `customIngredients` are compared the same way as
  `plans`: membership by id, then every element field by field (nested `parts`/`rates` objects by
  `canonical`) against `toV1(stored)`. Object identity is never used. Today v1 code only replaces,
  pushes or filters these elements, but a future in-place edit is then still persisted. The cost is
  a few thousand primitive comparisons per coalesced commit.
- In the browser tests only (a `?debugFreeze=1` flag), projected elements of those five
  collections are deep-frozen, so a handler that starts mutating them in place fails a test loudly.
  Production never freezes, so an unforeseen path cannot throw at the owner.
- An edit is written as a field-level merge onto the stored record, so v2-only fields survive
  `savePlan` and `saveBed` replacing whole objects. Unchanged fields are never written back.
- A missing id becomes a tombstone (never a hard delete).
- Commits are coalesced for 250 ms and flushed on `pagehide` and `visibilitychange` to hidden. `state`
  is not rebuilt while a dialog is open or a handler is running; it is rebuilt once the queue drains.
- A failed transaction sets `storageOK = false` (the existing "Session only, export backup" status),
  keeps the changes queued and retries.

Actions with special handling (same confirm dialogs and visible result as v1):

| v1 action | v2 effect |
| --- | --- |
| `plan-delete` | Tombstone the planting and its `<planId>:*` TaskMarks. Events, plants and photos are kept and shown as "planting deleted". |
| `bed-delete` ("Remove space") | Set `archivedAt` on the space. The cascaded `p.bedId = ''` edits are ignored, so plantings keep the link; the v1 screens still show "Unassigned growing space". |
| Plan dialog saved for a planting whose space is archived, with the space field left empty | Treated as no change to `bedId` (the archived space is not in the select list). |
| `log-delete` | Tombstone the event and its `<logId>:review` TaskMark. |
| Status select | Update `Planting.status` and write `state_change` (`reason: 'v1-facade'`, `occurredAtSource: 'save-time'`) in the same transaction. |
| Plan dialog changes `bedId` or `count` | Field edit plus `state_change` (`reason: 'v1-form-edit'`). Not a transplant. |
| Log form | New event: type from the kind table, `payloadStatus: 'legacy-text'`, `source: 'v1-facade'`, `recordedAt` = now, `scope` from the space field. |
| Save recipe, add ingredient, custom crop | New or replaced records. |
| Add progress photo | The v2 capture path (`DATA-MODEL.md` section 8.2). |
| Delete progress photo | Tombstone the event. |
| Export, import, portable copy | Section 13. |

### 9.6 Screens during dual-read

| Screen or feature | Status | Notes |
| --- | --- | --- |
| Overview / Home | Unchanged | Stats and upcoming tasks come from `tasks()` over the projection. Task ids are unchanged because planting, log and TaskMark ids are verbatim. |
| Mixes (soil calculator) | Unchanged | Draft, recipe save, load and delete, add ingredient, part steppers, rates, unit change, copy list, print, "Record batch" (opens the v1 log form). The arithmetic reads identical inputs. |
| Planting calendar | Unchanged | Month picker, cards and list modes, crop detail, plan dialog and `savePlan` including repeats, custom crop dialog. |
| Garden | Unchanged | Bed cards with capacity, "Scale a fill mix", bed dialog, plan cards, status select, plan dialog, plan delete and Remove space (same visible results; section 9.5). |
| Tasks & journal | Unchanged | Task rows and check boxes, filters, show completed, journal list, log form, log delete. v2-created events appear as read-only journal rows (v1 has no log editing). |
| Reference and settings | Unchanged | Garden name and zone write the Garden record. |
| `.ics` export, print | Unchanged | `tasks()` is unchanged. |
| Growth photo gallery and "Add progress photo" | Same UI, new internals | Adapters over events and assets; galleries load thumbnails, so they get faster. v1 and v2 photos show together. |
| Save status chip | Same UI | "Saved in this browser" means the IndexedDB transaction committed. |
| Save / restore | Changed | "Export backup" writes v2 `data.json`; new "Export full archive (.zip)"; import accepts v1 and v2 with Merge or Replace; portable copy embeds v2 data. |
| Boot | Changed | A short loading state while IndexedDB loads (v1 rendered synchronously). |
| Settings | Added | Migration report, photo copy status, rollback, retirement, Check data (orphans, flags, conflicts, review lists, unreadable slots), Trash. |
| New screens | Added | Planting and plant timelines, quick event sheet, "Number these plants", health cases, analytics. They read v2 directly and do not affect the v1 screens. |

## 10. What stays untouched for rollback, and for how long

| Item | Untouched until | Then | Kept at least |
| --- | --- | --- | --- |
| v1 key, byte for byte | Retirement (owner action, at least 30 days after the switch) | Replaced by a stub; the raw string goes into a `v1-raw` snapshot | 365 days after retirement (snapshot) |
| Pre-migration `v1-raw` snapshot (P1) | Always | Never overwritten | 365 days after retirement |
| v1 photo database | Its own deletion confirmation, only after retirement and full re-verification | Deleted | Until the owner confirms |
| `legacy.v1` on every migrated record | Always | Kept | Permanently (no compaction is planned) |
| `.unreadable.<ts>` slots | Always | Kept | Until the owner deletes them |
| The owner's pre-migration archive file | Outside the app | Owner-managed | Recommended: keep it |
| `v2-records` snapshots | Before replace-imports, rollbacks, down-projections | Rotated | Last 3 |

## 11. Rollback

### R1. Switch back to v1 (lossless for v1 data)

Settings, "Use version 1 data again". Available until retirement.

1. The sheet explains: version 1 data is as it was when you upgraded on DATE (plus anything an older
   copy of the app saved there since); changes made in version 2 stay there and come back when you
   switch back.
2. It offers [Export version 2 backup] first (recommended), then [Switch] or [Copy my changes into
   version 1 (lossy)] (R1b).
3. [Switch] writes `meta.mode = v1` (strict transaction) and the hint, broadcasts `schema-changed`
   and reloads. The v1 code path runs on the untouched v1 key and v1 photo database. Photos taken
   after the upgrade are not in the v1 database, so they are not visible in v1 mode.
4. The v2 database is kept. "Return to version 2" (Settings in v1 mode) writes `meta.mode = v2`; the
   next boot merges edits made in v1 mode (section 9.2) and new v1 photos (section 9.4).

### R1b. Copy changes into version 1 (lossy, explicit)

1. Automatic `v2-records` snapshot and a `v1-raw` snapshot of the current key.
2. Build `toV1` for every live record. Before writing, check against the strictest v1 reader that
   might open it: at most 1500 items per collection (older cached builds), under 3 MB as a file
   (`importFile`), under about 4.5 MB for `localStorage`, and v1 `validateState` passes. If any check
   fails, refuse and offer a v2 export instead.
3. The dialog lists what is lost, with counts: Plant records, structured payloads (weights,
   severities, treatments, outcomes), plant-scope detail (flattened to the planting), event types
   with no v1 kind (kept as journal entries labelled with their type), tombstones, conflict copies,
   capture times and thumbnails.
4. Write the v1 key. Add photos created in v2 to the v1 photo database as new records
   (`{id, planId: plantingId, createdAt: occurredAt ?? recordedAt, height, heightUnit, stage, note,
   blob}`); existing v1 photo records are never changed or deleted.
5. Record `meta.downProjection = {at, written: {'<t>:<id>': <v1 record written>}}`, so a later return
   to v2 merges against exactly what was written (section 9.2) and does not overwrite structured
   records with their text-only projection.

### R2. Code rollback (redeploying an older build)

- **Before retirement**: an old build reads the frozen v1 key and the v1 photo database and works.
  Its edits are merged when a v2 build returns (sections 9.2 and 9.4).
- **After retirement**: an old build finds the stub, fails `validateState`, shows its "could not be
  read" warning and an empty garden (HEAD copies the stub to a recovery slot; older builds only show
  the warning). Neither writes the main key at boot, but the next save in that build overwrites
  the stub. The next v2 boot sees phase `v1-retired`, applies nothing (section 9.2, step 4) and
  lists the document under "Check data" for an additions-only review.
- **Recommendation:** a code rollback should deploy a v2-aware build with migration disabled and
  the mode forced to v1, not a pre-v2 build. A v2-aware build understands the stub and can restore
  from snapshots.

### R3. After retirement

Settings, "Restore version 1 data": write the retirement `v1-raw` snapshot back to the key (after
taking a `v1-raw` snapshot of whatever is there), then R1. If the v1 photo database was already
deleted, R3 offers to recreate v1 photo records from `blobs` (additions only).

The v2 database is never deleted by any rollback.

## 12. Retirement (later, owner-confirmed)

### 12.1 Conditions

Offered in Settings only when all hold: at least 30 days since the switch; phase `photos-copied`;
no unresolved flags, conflict copies or review items; a full v2 archive made within the last 24
hours. Before confirming, the app warns that on iPhone the Home Screen app and Safari have separate
storage, and that the other one may still hold version 1 data.

### 12.2 Retire the v1 key

1. Strict transaction: `snapshots.put({kind: 'v1-raw', reason: 'retirement', raw, sha256})`,
   `meta.migration.phase = 'v1-retired'`.
2. Then replace the key with a stub that v1 `validateState` rejects:

   ```json
   {"schemaVersion": 2, "movedTo": "indexeddb:gardenforge.v2", "retiredAt": "2026-11-15T16:00:00.000Z",
    "message": "This garden moved to GardenForge version 2 storage. Open the current version of the app."}
   ```

   It is not removed: an absent key makes older builds write `defaultState()` at boot, while a
   stub sends them down their "could not be read" path, which does not write at boot.
3. If the app is killed between steps 1 and 2, the next boot sees phase `v1-retired` with the raw
   key still present; it re-checks that the key's hash equals the snapshot and then writes the stub.
   If the key changed in between, it stops and asks.

### 12.3 Delete the old photo copies

A second, separate confirmation, offered after retirement: "Free the space used by old photo
copies". Before deleting, every asset must have `assetLocal.where: 'v2'` and pass a fresh re-hash of
its `blobs` bytes. Then `indexedDB.deleteDatabase('gardenforge.photos.v1')`.

## 13. Importing backups after migration

### 13.1 Backup files

| File | Handling |
| --- | --- |
| v2 `data.json` (`format: 'gardenforge-backup'`, `schemaVersion: 2`) | `validateStateV2(..., 'import')`. **Merge** (default: upsert by `[t, id]` with the rules in `DATA-MODEL.md` section 9.3, deletes nothing) or **Replace** (after a `v2-records` snapshot: tombstone live records absent from the file, upsert the file's records). Assets without bytes get `assetLocal.where: 'missing'`, show a placeholder and are never garbage-collected. |
| v2 full archive (`.zip`) | As above, plus every `photos/<sha256>.jpg` is re-hashed and rejected if the hash differs from its name; blobs are put if absent. Entries are read one at a time with `File.slice`, so large archives do not have to fit in memory. |
| v1 JSON (`schemaVersion: 1`) | `validateV1Lenient`, then `migrateV1toV2` in memory. **Merge** (default: new ids are added, existing ids use the section 9.3 field merge, nothing is deleted) or **Replace**. Replace applies **only to the types v1 owned**: the Garden settings, draft, recipes, spaces, plantings, TaskMarks, custom crops and ingredients, and events that came from v1 journal entries or the v1 log form **and are still `legacy-text`**. It **never** tombstones photo or measurement events, PhotoAssets, Plants, events created in v2, or journal events the owner has completed with structured detail in v2 (those are listed as "kept because you added detail in version 2"). Photo events whose planting disappears keep their `plantingId` and appear under "Photos without a planting". |
| v1 archive (`gardenforge-v1-archive` ZIP) | Its JSON as above, plus its photos through P4-style registration (byte for byte, hashes checked against `photos.json`). |
| `schemaVersion` above 2 | Refused: "made by a newer version of GardenForge". Nothing written. |

Garbage collection keeps the bytes of any asset referenced by a `v2-records` snapshot younger than 90
days, so undoing a replace-import within that window restores working photos.

### 13.2 Portable HTML copies

The v2 portable export embeds `data.json` (no photos, as the export dialog says) in
`#embedded-state`. Opening it in a v2 build: if this origin has no v2 data, the embedded records
become the initial data; otherwise the owner is asked to merge or ignore. A v1 portable file opened in
a v2 build is migrated in memory and offered the same way. `file://` pages often have no usable
IndexedDB; they run from memory with the "export before closing" warning.

## 14. iOS behaviour

### 14.1 If the app is killed mid-migration

| Killed during | On disk | Next launch |
| --- | --- | --- |
| Gate or backup step | Nothing in v2 | v1 mode; upgrade offered again |
| P1 transaction | Nothing, or the complete snapshot | v1 mode; "Continue upgrade" |
| P2 | Snapshot only | v1 mode; resume at P2 |
| P3 transaction | Nothing from P3 (atomic) | Resume at P2 |
| P4 | Records plus some photo events | Resume P4 by key set difference |
| P5 | Read-only | Rerun P5 |
| P6 transaction | Either committed or not | `meta.mode` decides |
| After P6, before the hint write | `meta.mode = v2`, hint missing | v2 (IndexedDB is read first); hint rewritten |
| P7 | Some assets copied | Copy resumes in the background |
| Retirement between its two steps | Phase `v1-retired`, raw key present | Finish after a hash check (section 12.2) |

An error while resuming is treated as an interruption to retry, not as a failure. Only verification
mismatches count toward the 3-attempt limit. The migration also pauses at the next batch boundary
when the page becomes hidden, because iOS may suspend a backgrounded web app.

### 14.2 IndexedDB on iOS

- **Transactions auto-commit** when control returns to the event loop without pending requests.
  Hashing, `arrayBuffer()`, image decoding and thumbnails always happen before a write transaction
  opens, and v1 photo records are read in short transactions of their own.
- **Open can hang** after the app resumes from the background, and connections can drop ("Connection
  to Indexed Database server lost"). Opens have a 4 s timeout (section 3.2 fallback), the app
  reconnects on `db.onclose` and on `versionchange`, and failed writes stay queued (`DATA-MODEL.md`
  section 9.1).
- **Storage**: `navigator.storage.persist()` is requested at the first v2 boot. Home Screen web apps
  are reported to be exempt from Safari's seven-day eviction of script-written storage
  **(verify)**; a Safari tab is not, and the app says so.
- **Separate containers**: the Home Screen app and a Safari tab have separate storage. Each migrates
  on its own and has its own `deviceId`. Settings shows which one is open.
- `durability: 'strict'` is passed where supported and ignored elsewhere **(verify)** WebKit's
  behaviour.

## 15. Verification checklist

### 15.1 Automated (in `tools/`, before any release that can migrate)

- Migrating `tools/tests/fixture.json` (ids `bed_a`, `plant_1`, `log_1`) quarantines zero records and
  passes P5.
- Real `uid()` output for every prefix (`bed`, `plant`, `log`, `photo`, `mix`, `customcrop`,
  `ingredient`) and the `Date.now()` fallback form all migrate and validate.
- A photo with `height: ''` becomes a `photo` event, never a measurement of 0; `'12.5'` becomes 12.5
  in; `'1e2'` stays raw.
- A v1 document at HEAD's string limits (log title 400 and notes 24,000 characters, bed and plan
  notes 8000, names 200) migrates with zero quarantines and zero length warnings.
- A v1 key rewritten by an older build's boot write-back (same `updatedAt`, normalised content)
  produces no review entry and no record change, only a new stored hash.
- `openV1PhotosIfExists()` on a clean profile creates no database, and v1 `photoDB()` still works
  afterwards.
- Running the migration twice changes zero records (all `rev` values unchanged).
- Killing the page after each phase (simulated by aborting at N writes) and relaunching ends in the
  same final state.
- Replacing the v1 key with `defaultState()` (empty, `updatedAt: ''`) after the switch causes no
  tombstones, no settings or draft change, and a "Check data" entry.
- The retirement stub makes HEAD and a pre-`e1e56e1`/`ce869ef` build boot without writing the key.
- Facade: the status select, bed delete, part steppers, rate inputs, unit change, garden name, zone,
  task check boxes, plan delete and log delete each persist after a reload in v2 mode.
- Plan delete keeps the planting's photo events; bed delete archives the space and keeps `bedId`.
- A v1 replace-import does not tombstone photo or measurement events, assets, plants or v2-created
  events.
- R1b refuses when a collection exceeds 1500 items or the file exceeds 3 MB.
- A photo added through the v1 code path after the switch is imported on the next v2 boot.
- A blob that throws on `arrayBuffer()` gives a `partial` event and does not block P6.
- All existing browser tests still pass at 320 px and 390 px.

### 15.2 Owner spot checks (shown on the report screen)

Counts before (from P1) and after (from v2), which must match: growing spaces, plantings, journal
entries, task check-offs, saved recipes, custom crops, custom ingredients, progress photos (total and
per planting), plus unreadable photos and flagged records. Then:

1. Open three plantings; their cards (crop, variety, count, space, dates, mix, status) match.
2. Tasks & journal shows the same upcoming and past-due tasks; checked tasks are still checked.
3. A journal entry with a follow-up date still produces its follow-up task.
4. The mix page shows the same draft; saved recipes load with the same numbers.
5. Custom crops appear on the calendar with their windows.
6. Each planting's gallery shows the same photos with the same timestamps, heights and stages.
7. Make a v2 full archive and keep it with the pre-migration archive.

## 16. Explicitly not done yet

- Nothing in this document is implemented. The shipped app is v1.
- No destructive step exists. Migration deletes nothing; retirement and photo-copy deletion are
  separate, later, owner-confirmed actions with snapshots.
- No sync, accounts or server. The v2 fields only prepare for them.
- No parsing of v1 notes into numbers, no recovery of EXIF for v1 photos, no Plant records or dated
  events invented from v1 data.
- No automatic migration on first boot: the owner starts it after making a full archive.

Open questions for the owner:

1. Should a deliberate "upgrade without a backup" bypass exist for devices where the full archive
   cannot be produced, or should such devices simply stay on v1?
2. Is 30 days of dual-read before retirement right?
3. When an older copy edits the v1 key after the switch, is automatic merging (with Undo) acceptable,
   or should every such merge ask first?
4. Should the v1 photo database be kept indefinitely (it costs space), or deleted soon after
   retirement?
