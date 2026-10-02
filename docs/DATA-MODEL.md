# GardenForge data model

**Status: design for schema v2. Nothing here is implemented yet.** The shipped app (HEAD
`e1e56e1`/`ce869ef`, `APP_VERSION` 1.2.1) reads and writes schema v1 only. How existing data gets from v1 to
v2 without loss is in [`MIGRATION.md`](MIGRATION.md). Read both before changing storage code.

Items marked **(verify)** are assumptions that need a test on a real iPhone or in WebKit before
anyone relies on them.

## 1. Purpose

Schema v1 stores one household's garden as one JSON document in `localStorage`, plus progress
photos in IndexedDB. It has no per-record timestamps, no tombstones, no history beyond the journal,
and its photos are not in any backup. Schema v2 has to:

1. Model the owner's hierarchy: **Garden → growing space (bed or container) → planting →
   individual plant(s) → events**, where a photo can belong to an event and carries its own
   timestamps and metadata.
2. Make it possible to rebuild one plant's whole history, and later answer growth, yield, timing,
   comparison and plant-health questions (section 12).
3. Keep every existing v1 record readable and every existing screen working (`MIGRATION.md`).
4. Be ready for a later cloud sync: a per-record id, timestamps, a revision and device id,
   soft-delete tombstones, content-addressed photos and conflict copies (section 9). Sync itself is
   not part of v2.
5. Keep backup and restore working offline, with no cloud, and this time include photos.
6. Never let the schema present a guess as a horticultural fact (section 13).

## 2. Schema v1 as it exists today

This section describes HEAD (`ce869ef` on `audit/roadmap-and-small-fixes`). Older cached builds differ where noted. A v2 build must cope
with data written by any of them.

| Store | Key | Contents |
| --- | --- | --- |
| `localStorage` | `gardenforge.brownsville.v1` | One JSON document: `schemaVersion: 1`, `updatedAt` (one global ISO string, `''` in a fresh default state), `settings`, `draft`, `recipes`, `beds`, `plans`, `logs`, `completed`, `customCrops`, `customIngredients`. |
| `localStorage` | `gardenforge.brownsville.v1.unreadable.<timestamp>` | Added in `e1e56e1`/`ce869ef`. A verbatim copy of a saved document that failed `validateState` at boot. It is never deleted automatically. It counts against the same roughly 5 MB origin quota. |
| IndexedDB | database `gardenforge.photos.v1` (version 1), store `photos` (keyPath `id`, indexes `planId` and `createdAt`) | `{id, planId, createdAt, height, heightUnit, stage, note, blob}`. |
| `index.html` | `<script id="reference-data">` | Static reference crops, windows, sources, ingredients, amendments and recipe templates. No user data. |
| `index.html` | `<script id="embedded-state">` | `null` in the shipped file. A portable HTML export puts a whole v1 document here. |

Record shapes (all fields are written by the current forms):

- `settings`: `{name, zone}`. The form offers `9b`, `10a`, `10b` and `Confirm on USDA map` for
  `zone`; validation accepts any string up to 60 characters.
- `draft` (the soil mix being edited): `{presetId, name, type, description, parts{ingredientId: parts},
  target, unit, rates{amendmentId: g per 10 gal}, enrichedBio, enrichedZeo, notes}`. Loading a saved
  recipe copies the recipe into the draft, so a draft can also carry `id` and `savedAt`.
- `recipes[]`: the draft fields plus `id` (`mix_*`) and `savedAt`. `savedAt` is a **date**
  (`YYYY-MM-DD` from `today()`), not an instant.
- `beds[]`: `{id (bed_*), name, type, length (ft), width (ft), depth (in), light, notes}`.
  `type` is one of `Raised bed`, `In-ground bed`, `Rectangular planter`, `Seed tray`.
- `plans[]` (these are **plantings**): `{id (plant_*), cropId, cropName, group, variety, count,
  bedId, date, mode, leadWeeks, harvestMin, harvestMax, notes, mixId, mixName, status}`. `date` is
  the planned outdoor sow or plant date. `harvestMin`/`harvestMax` are estimates, often pre-filled
  from reference data. `mixId` may be a built-in `DB.recipes` id (for example `bed`) as well as a
  saved recipe id. `status` is one of `planned`, `sown`, `planted`, `harvesting`, `done`.
- `logs[]` (the journal): `{id (log_*), kind, title, date, reviewDate, bedId, notes}`. `kind` is one
  of `Observation`, `Mix batch`, `Compost`, `Soil / media test`, `Feeding`, `Harvest`,
  `Pest scouting`. Logs have no planting link. `title` can be `''`, because the handler trims a
  whitespace-only title.
- `completed`: `{taskId: boolean}`. Task ids are `<planId>:sow|harden|plant|review|harvest` and
  `<logId>:review`. Tasks are computed by `planTasks()` and `tasks()`, never stored. `false` values
  are stored too.
- `customCrops[]`: `{id (customcrop_*), name, group, family, windows[[MM-DD, MM-DD]] (max 8),
  harvestMin, harvestMax, method, source: null, sourceNote}`. `group` is `Vegetable`, `Herb` or
  `Flower`; `source` must be `null` (HEAD enforces both).
- `customIngredients[]`: `{id (ingredient_*), name, category, note}`.
- Photos: `id` is `photo_*`; `createdAt` is the **save** time (`new Date().toISOString()`, UTC);
  `height` is a string and is `''` when not entered (the input is `type=number`, so non-empty
  values are numeric strings such as `12.5`, or rarely `1e2`); `heightUnit` is always sent, `in` or
  `cm`; `stage` is `''` or one of `Seedling`, `Vegetative growth`, `Flowering`, `Fruiting`,
  `Harvesting`, `Stress / pest issue`, `Recovery`; `note` is at most 1000 characters; `blob` is a
  canvas re-encoded JPEG (max 1600 px, quality 0.82), which carries **no EXIF**.

Behaviour that constrains v2:

- **Ids.** `uid(prefix)` returns `prefix + '_' + crypto.randomUUID()`, or a `Date.now()` base-36
  string plus random characters when `randomUUID` is missing. Prefixes in use: `bed`, `plant`,
  `log`, `photo`, `mix`, `customcrop`, `ingredient`. `validateState` only checks that ids are truthy
  (and strings, for custom ingredients). The test fixture uses `bed_a`, `plant_1` and `log_1`.
  Imported backups can therefore contain ids of any shape, duplicates, or even numbers.
- **`validateState`** (HEAD): at most 20,000 items per array collection (older cached builds:
  1500); `completed` and `draft.rates` must be objects (new in `e1e56e1`/`ce869ef`); numeric ranges for
  counts, dimensions, lead weeks and maturity; valid dates. HEAD also caps string lengths, and these
  caps are what a v1 document may legally contain: `settings.name` 200, `settings.zone` 60;
  plan `variety`, `cropName`, `mixName` 200, plan `notes` 8000, plan `bedId` and `mixId` 120; bed
  `name` 200, `type` and `light` 100, `notes` 8000; log `kind` 100, `title` 400, `notes` 24,000,
  `bedId` 120; recipe `name` 200, `type` 100, `notes` 12,000; custom crop `name` and `family` 200,
  `sourceNote` 4000; custom ingredient `name` 200, `category` 100, `note` 1000. A missing string
  passes (`str()` accepts `null`/`undefined`). The forms write less (bed and plan notes 4000, log
  notes 12,000, log title 140, variety 100), but imports can carry the larger values. It does **not**
  check `kind` values, id format or id uniqueness.
- **`validateState` also normalises** what it accepts, in place: a missing `completed` becomes `{}`,
  a missing `rates` becomes `{}`, a missing `harvestMin` is filled from `harvestMax` and vice versa.
  Builds before `e1e56e1`/`ce869ef` did none of this and had no string caps.
- **Boot** (HEAD): takes the newer of embedded state and the saved key. If the saved key fails
  validation, it copies it to a `.unreadable.<timestamp>` slot, leaves the key alone and shows a
  warning. **Otherwise boot writes the chosen state back into the key on every launch**
  (`if(!unreadableSaved) localStorage.setItem(KEY, …)`): the re-serialised saved document, a newer
  embedded document, or, when the key is absent, `defaultState()` with `updatedAt: ''`. Because
  `validateState` normalises, the rewritten string can differ from the stored one while `updatedAt`
  stays the same.
  Builds before `e1e56e1`/`ce869ef` do the same, except that a failed validation only sets `storageOK=false`
  and writes nothing at boot.
  In every build, the next `save()` overwrites whatever is in the key (HEAD pauses saving only when
  it could not make the recovery copy).
- **`save()`** serialises the whole state into the key on every change, including each keystroke
  in the mix page.
- **In-place mutation.** Handlers mutate objects directly: `p.status = …` (status select),
  `p.bedId = ''` (bed delete), `state.completed[k] = …` and `delete state.completed[…]`,
  `state.settings[k] = …`, and `state.draft.parts[id]`, `state.draft.rates[id]`, `state.draft.target`,
  `.unit` and `.name`. Other collections are only pushed to, filtered, or have elements replaced.
- **Deletes are hard.** Plan delete removes the plan and its `<planId>:*` check-offs, but **not its
  photos** (orphan photos exist on real devices). Bed delete sets `bedId = ''` on its plantings. Log
  delete removes `<logId>:review`.
- **Time.** `today()` uses `America/Chicago`. Photo `createdAt` is UTC.
- **Backups.** `exportJSON` writes the state document only (and calls `save()` first).
  `importFile` accepts at most 15 MB in HEAD and **3 MB in older cached builds**, replaces the whole
  state after a confirm, and never touches photos. The portable HTML export
  embeds the state. **No export includes photos.**

## 3. Schema v2 overview

```
Garden  (gdn_)                                 one now; every record carries gardenId
 └── Space  (bed_)                             bed, planter, tray, pot, grow bag ...
      └── Planting  (plant_ = v1 legacy, pln_ = new)   one crop + variety planted together
           └── Plant  (ind_)                   optional, owner-numbered individuals

Event  (ev_ new, log_ from v1 journal, photo_ from v1 photos)
   scope = garden | space | planting | plant   (what the event is about)
   └── photoAssetIds[] ──► PhotoAsset  (sha256-<64 hex>)   immutable metadata, synced
                              ├── blobs[sha256]    1600 px JPEG bytes   (device-local)
                              └── thumbs[sha256]   320 px JPEG          (device-local, derived)

Also carried over: TaskMark (v1 completed), Recipe, CustomCrop, CustomIngredient, Draft
```

Design rules:

1. **Events are the history.** Anything that happened or was observed is an event. Gardens,
   spaces, plantings and plants hold names, intent (variety, planned date, soil mix) and a small
   amount of state the owner sets on purpose.
2. **Derived state is computed in memory and never stored**: current stage, latest height, current
   location after a transplant, first-flower date, total harvest, open health problems. Nothing
   derived is saved, exported or synced, so nothing derived can go stale or conflict.
3. **Two stored state fields, both owner intent:** `Planting.status` (the v1 task engine reads it)
   and `Plant.status`. Every change to either, and every change to `Planting.bedId` or
   `Planting.count`, also writes a `state_change` event in the same IndexedDB transaction, so the
   history is never lost.
4. **Three clocks on every event**: `occurredOn` (local garden date, required, used by all
   day-level analytics), `occurredAt` (an instant, only when the real time is known) and
   `recordedAt` (when it was entered).
5. **v1 field names are kept** on spaces and plantings (`bedId`, `date`, `count`, `harvestMin` ...),
   so the v1 screens and rollback are identity mappings. Their meaning is documented here, and
   helper accessors (for example `plannedDate(planting)`) carry it in code.
6. **No Blob inside a structured record.** Photo bytes and thumbnails live in their own stores.
7. **Never fabricate.** Unknown means `null` or `''`, and the UI says "not recorded".

## 4. Storage layout

One IndexedDB database, `gardenforge.v2`, version 1. Using one database lets a photo's bytes and
its metadata commit in one transaction.

| Store | Key path | Holds | Synced later | In backups |
| --- | --- | --- | --- | --- |
| `records` | `['t', 'id']` | Every structured record (section 5 onward). Never a Blob. | Yes | Yes (`data.json`) |
| `blobs` | `sha256` | `{sha256, blob}`: the stored 1600 px JPEG. | Bytes uploaded by hash later | Full archive only |
| `thumbs` | `sha256` | `{sha256, blob, width, height}`: 320 px long-edge JPEG, quality 0.7. Derived. | No | No (regenerated) |
| `assetLocal` | `sha256` | Where this device keeps an asset's bytes (section 6.8). | No | No |
| `meta` | `k` | Mode, device id, migration journal, review lists, sync bookkeeping (section 6.11). | No | No |
| `snapshots` | `id` | Byte-exact v1 copies and pre-import or pre-merge v2 copies (section 6.12). | No | No |

Indexes on `records`: `t`, `id`, `plantingId`, `spaceId`, `plantIds` (multiEntry), `occurredOn`,
`photoAssetIds` (multiEntry), `updatedAt`. The key is `[t, id]`, so an id only has to be unique within
its type. Ids that v2 issues are globally unique anyway (prefix plus UUID); the compound key makes
hand-edited v1 backups whose ids collide across collections harmless.

At boot the app reads all of `records` into memory (one cursor pass) and builds three maps:
`eventsByPlanting`, `eventsByPlant` (from `plantIds`) and `eventsBySpace`, each sorted by the event
order in section 9.6. Estimate: about 30,000 events after ten years, roughly 15 to 25 MB of
JSON, a few hundred milliseconds to load on a recent iPhone **(verify)**. Past roughly 100,000
events, a later version should load recent seasons first and query older ones through the indexes.

`localStorage` keys used by a v2 build:

| Key | Contents |
| --- | --- |
| `gardenforge.brownsville.v1` | The v1 document. **v2 never writes it on its own.** Three owner-confirmed actions do: the lossy "copy my changes into version 1" rollback (`MIGRATION.md` R1b), "Restore version 1 data" (R3), and the retirement stub (section 12). Each takes a `v1-raw` snapshot of the current value first. |
| `gardenforge.mode` | `'v1'` or `'v2'`. A mirror of `meta.mode` used as a hint only; IndexedDB is authoritative. |
| `gardenforge.deviceId` | Mirror of `meta.device.id`. |
| `gardenforge.probe` | Written and removed at boot to test that storage works (replaces v1's boot write-back). |
| `gardenforge.v2.pending` | Overflow copy of unsaved changes when an IndexedDB write fails, if they fit (under 1 MB). Replayed at next boot. |

If IndexedDB is unavailable (some `file://` copies, some private modes), v2 runs from memory with
the same "Autosave unavailable, export before closing" warning that v1 shows when `storageOK` is
false.

### 4.1 Backups and exports (v2)

All of these work offline and need no account or cloud.

| Export | File name | Contents | Notes |
| --- | --- | --- | --- |
| Data backup | `GardenForge-backup-YYYY-MM-DD.json` | `{format: 'gardenforge-backup', schemaVersion: 2, exportedAt, appVersion, deviceId, gardenId, counts, records: [...]}`. Every record, including tombstones and conflict copies. | No image bytes: photo assets are listed by hash and size. Small (tens of MB after years). The UI must not call it a complete backup, because it has no photos. |
| Full archive | `GardenForge-archive-YYYY-MM-DD[-partN].zip` | `manifest.json` (`{format: 'gardenforge-archive', schemaVersion: 2, part, parts, files: [{path, sha256, bytes}]}`), `data.json` (as above, in part 1), `photos/<sha256>.jpg` (the exact stored bytes). | The complete backup. Store-only ZIP written by an inline writer (about 150 lines with CRC32, no library), built from Blob parts so it is never one giant string, split at about 400 MB per part for the iOS share sheet. "Photos added since the last archive" (by asset `recordedAt`) gives incremental archives. Thumbnails are not included. |
| Version 1 compatible export | `GardenForge-v1-compatible-YYYY-MM-DD.json` | The `toV1` projection as a `schemaVersion: 1` document. | Lossy, for older builds. Same guards and loss list as the R1b rollback in `MIGRATION.md`. |
| Portable HTML | `GardenForge-mobile-portable-YYYY-MM-DD.html` | `data.json` in `#embedded-state`, with `<` escaped as today. | No photos, and the export dialog says so. |
| Calendar | `GardenForge-tasks-YYYY-MM-DD.ics` | Unchanged. | Built from `tasks()`. |

Local-only stores (`thumbs`, `assetLocal`, `meta`, `snapshots`) are never exported. Imports are
described in `MIGRATION.md` section 13.

## 5. The record envelope

Every record in `records` carries these fields.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `t` | string enum | yes | `garden`, `space`, `planting`, `plant`, `event`, `photoAsset`, `taskMark`, `recipe`, `customCrop`, `customIngredient`, `draft`. **The type comes only from `t`, never from the id prefix.** Unknown values from a newer build are kept on disk and ignored. |
| `id` | string, 1 to 200 characters, no control characters | yes | Unique within `t`. v1 ids are kept verbatim; new ids follow section 10. |
| `createdAt` | ISO-8601 instant or `null` | yes | `null` only for records migrated from v1 (`legacy` present), because v1 kept no creation times. Never estimated. |
| `updatedAt` | ISO-8601 instant | yes | Set on every local write. Migrated records get the migration time. |
| `rev` | integer, 1 or more | yes | Goes up by 1 on each local write **that changes the body**. A write that changes nothing is skipped and does not bump `rev`. |
| `deviceId` | string `dev_*` | yes | Device of the last write. |
| `originDeviceId` | string `dev_*` | yes | Device that created the record (for migrated records, the device that migrated it). |
| `deleted` | boolean | yes | Soft-delete tombstone. Hidden from the UI and from analytics. |
| `deletedAt` | ISO instant or `null` | yes | Set with `deleted: true`. |
| `conflictOf` | string or `null` | no | On a conflict copy: the id of the record it diverged from. |
| `conflictResolvedAt` | ISO instant or `null` | no | Set when the owner keeps or discards the copy. |
| `legacy` | object or `null` | no | Only on records that came from v1: `{src: 'v1', store: 'localStorage' or 'photosDB', migrationId: 'm1', migratedAt, v1}` where `v1` is a deep copy of the v1 record as last merged, **as HEAD's `validateState` leaves it** (so with HEAD's three normalisations from section 2 applied; for photos, every field except `blob`). It is the base for three-way merges, the source of the v1 projection for untouched records, and the per-record rollback record. The byte-exact original document is the `v1-raw` snapshot (6.12). |

Two derived notions are used throughout:

- **`toV1(record)`** (the v1 projection): if the record is untouched, or was flagged by migration
  verification (`MIGRATION.md` section 5, P5), return `legacy.v1` exactly (with `id` set to the
  record's id when migration had to rename a duplicate or non-string id).
  Otherwise return `{...legacy.v1, ...v1Fields(record)}`, so unknown v1 keys survive edits.
  `v1Fields` for each type is defined in `MIGRATION.md` section 6.
- **Untouched** means `canonical(v1Fields(record)) === canonical(v1Fields(migrateRecord(legacy.v1)))`:
  the v1-visible fields still equal what the migration produced from `legacy.v1`. It does not use
  `rev`, so it stays correct after sync delivers records written elsewhere.

`canonical(x)` is JSON with object keys sorted recursively, arrays kept in order and `undefined`
dropped. `bodyHash(record)` is the SHA-256 of `canonical` of the record without `updatedAt`, `rev`,
`deviceId`, `originDeviceId` and `legacy.migratedAt`. Two devices that migrate the same v1 data get
equal body hashes.

```json
{
  "t": "space",
  "id": "bed_3f0c2a9e-1b7d-4c55-9a51-0a2b8c7d6e11",
  "createdAt": null,
  "updatedAt": "2026-10-01T15:02:11.204Z",
  "rev": 1,
  "deviceId": "dev_7b1e9c40-2f6a-4f0e-b0a4-5d1c2e3f4a5b",
  "originDeviceId": "dev_7b1e9c40-2f6a-4f0e-b0a4-5d1c2e3f4a5b",
  "deleted": false,
  "deletedAt": null,
  "conflictOf": null,
  "legacy": {
    "src": "v1",
    "store": "localStorage",
    "migrationId": "m1",
    "migratedAt": "2026-10-01T15:02:11.204Z",
    "v1": { "id": "bed_3f0c2a9e-1b7d-4c55-9a51-0a2b8c7d6e11", "name": "Behind the gate - bed 1", "type": "Raised bed", "length": 8, "width": 4, "depth": 11, "light": "6 or more hours", "notes": "Drip line on north edge" }
  }
}
```

The examples below omit the envelope unless it matters.

## 6. Entities

### 6.1 Garden (`t: 'garden'`)

Top of the hierarchy. There is one garden today, but every space, planting and event carries
`gardenId` so more can be added later. It holds the v1 `settings` and the time zone used to compute
`occurredOn`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Migration always uses `gdn_default`, so two devices that migrate separately converge on one garden. New gardens use `gdn_<uuid>`. |
| `name` | string, up to 200 (form: 100) | yes | From v1 `settings.name`; `''` if v1 had none (warning). |
| `zone` | string, up to 60 | yes | From v1 `settings.zone`. A reference label, not a climate claim. Nothing is computed from it. |
| `timeZone` | IANA time zone | yes | Default `America/Chicago` (matches v1 `today()`). Used to turn instants into `occurredOn`. |
| `seasons` | array (up to 12) of `{label: string up to 40, startMMDD: 'MM-DD'}` | no | Season boundaries the owner defines for season analytics, for example `[{label: 'Spring', startMMDD: '01-15'}, {label: 'Fall', startMMDD: '08-15'}]`. Empty (the migration default) means analytics group by calendar year. Never pre-filled. |
| `displayUnits` | `{length: 'in' or 'cm', weight: 'g', 'oz', 'lb' or 'kg', volume: 'gal' or 'L'}` | no | Display only. Stored values keep the unit they were entered in. |

```json
{ "t": "garden", "id": "gdn_default", "name": "My Brownsville garden", "zone": "10a",
  "timeZone": "America/Chicago",
  "seasons": [],
  "legacy": { "src": "v1", "store": "localStorage", "migrationId": "m1", "migratedAt": "2026-10-01T15:02:11.204Z", "v1": { "name": "My Brownsville garden", "zone": "10a" } } }
```

### 6.2 Space (`t: 'space'`): growing space, bed or container

All eight v1 bed fields keep their names and units.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | v1 `bed_*` verbatim. New spaces also use `bed_<uuid>`. |
| `gardenId` | string | yes | `gdn_default` for migrated rows. |
| `name` | string, up to 200 (form: 1 to 100) | yes | v1 verbatim. |
| `type` | string, up to 100 | yes | v1 values, plus `Pot`, `Grow bag`, `Container (other)`, `Indoor shelf`. Unknown values are kept and printed as-is. |
| `length` | number, ft, over 0, up to 10000 | yes | Inside length. For a round container, the diameter. |
| `width` | number, ft, over 0, up to 10000 | yes | Inside width (or diameter). |
| `depth` | number, in, over 0, up to 10000 | yes | Soil fill depth, excluding headspace. |
| `light` | string, up to 100 | yes | Owner-observed direct sun label, v1 verbatim. |
| `notes` | string, up to 8000 (form: 4000) | yes | v1 verbatim. |
| `capacityL` | number (litres) or `null` | no | Owner-measured volume for containers that are not rectangular. Never estimated. When set, the UI shows it next to the rectangular formula result. |
| `archivedAt` | ISO instant or `null` | no | Set by "Remove space" in v2 (section 9.4). The space leaves lists but keeps its history and links. |

```json
{ "t": "space", "id": "bed_3f0c2a9e-1b7d-4c55-9a51-0a2b8c7d6e11", "gardenId": "gdn_default",
  "name": "Behind the gate - bed 1", "type": "Raised bed", "length": 8, "width": 4, "depth": 11,
  "light": "6 or more hours", "notes": "Drip line on north edge", "capacityL": null, "archivedAt": null }
```

### 6.3 Planting (`t: 'planting'`)

One crop and variety planted together in one space. All 16 v1 `plans` fields keep their names. A
planting with no Plant records is "unnumbered" and uses `count`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | v1 `plant_*` verbatim (**it means planting**). New plantings get `pln_<uuid>`. `plant_` is never issued again. |
| `gardenId` | string | yes | |
| `cropId` | string | yes | Reference crop id or a custom crop id. |
| `cropName` | string, up to 200 | yes | Name snapshot. |
| `group` | string | yes | v1 verbatim. |
| `variety` | string, up to 200 (form: 100) | yes | `''` means not entered. Variety analytics key on `(cropId, lower(trim(variety)))`. |
| `count` | number, 1 to 1e6 | yes | The **stated** number of plants (planned or started), as in v1. An integer is expected; a non-integer from v1 is kept with a warning. Not a live count: when Plant records exist, per-plant maths use them instead (section 12.4) and say so. |
| `bedId` | string or `''` | yes | The **assigned** space, edited through the existing plan dialog. The current location after transplants is derived (section 12.1), never written here automatically. |
| `date` | `YYYY-MM-DD` | yes | The **planned** outdoor sow or plant date. Task dates come from it exactly as in v1. Never treated as an observed date. |
| `mode` | `direct`, `transplant`, `indoor`, `pieces`, `slips` | yes | v1 verbatim. |
| `leadWeeks` | number, 0 to 52 | yes | Owner planning estimate. |
| `harvestMin`, `harvestMax` | number of days, 0 to 1000, or `null` | yes | Planning **estimates**. Shown as "your estimate", never as observed facts, and never used as observed dates. |
| `harvestEstimateSource` | `owner`, `reference`, `unknown` | no | New. Migration and the v1 plan dialog set `unknown`, because v1 did not record which it was. |
| `notes` | string, up to 8000 (form: 4000) | yes | |
| `mixId` | string or `''`, up to 200 | yes | Saved recipe id **or** built-in `DB.recipes` id. May dangle after a recipe is deleted. |
| `mixName` | string, up to 200 | yes | Name snapshot, so comparisons survive recipe deletion. |
| `status` | `planned`, `sown`, `planted`, `harvesting`, `done` | yes | Stored owner intent; `planTasks()` reads it. Exactly the v1 enum. Every change writes a `state_change` event. Why a planting ended (harvest complete, failed, removed early) is recorded on that event, not as a new status value. |
| `seasonLabel` | string up to 40, or `null` | no | Optional owner label such as `Fall 2026`. Overrides the derived season (section 12.2). |

```json
{ "t": "planting", "id": "plant_5e7a1c22-9d3b-4f61-8a0e-2b4c6d8e0f12", "gardenId": "gdn_default",
  "cropId": "tomato", "cropName": "Tomato", "group": "Vegetable", "variety": "Everglades", "count": 6,
  "bedId": "bed_3f0c2a9e-1b7d-4c55-9a51-0a2b8c7d6e11", "date": "2026-09-10", "mode": "transplant",
  "leadWeeks": 6, "harvestMin": 60, "harvestMax": 80, "harvestEstimateSource": "unknown", "notes": "",
  "mixId": "mix_a1b2c3d4-0000-4000-8000-000000000001", "mixName": "Raised bed blend", "status": "planted",
  "seasonLabel": null }
```

### 6.4 Plant (`t: 'plant'`): individual plant

Optional. Migration never creates Plant records, because v1 only had counts and inventing
individuals would be fabrication. The owner creates them with "Number these plants" (creates labels
1 to N) or one at a time.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | `ind_<uuid>`. Never `plant_`. |
| `plantingId` | string | yes | Parent planting. Fixed: a transplant changes a plant's space, not its planting. Splitting is "removed here" plus a new Plant elsewhere, linked by `relatedEventIds`. |
| `label` | string, 1 to 40 | yes | Owner tag, for example `3` or `North-A`. The UI keeps labels unique among live plants of a planting; duplicates arriving from a merge are kept and flagged. |
| `number` | integer, 1 to 100000, or `null` | no | Sort key when the label is numeric. |
| `status` | `active`, `removed`, `died`, `harvested-out` | yes | Stored owner intent. Every change writes a `state_change` event. |
| `plantedAt` | `YYYY-MM-DD` or `null` | no | Date the owner entered. `null` means unknown. The form may suggest the planting's date, but only what the owner saves is stored. |
| `removedAt` | `YYYY-MM-DD` or `null` | no | Expected when status is not `active` (a warning if missing, never a rejection). |
| `originSpaceId` | string or `null` | no | Space at creation. Defaults to the planting's `bedId`. |
| `positionText` | string, up to 200 | no | For example `row 2, third from the gate`. |
| `notes` | string, up to 4000 | no | |

```json
{ "t": "plant", "id": "ind_c4a9e0b1-77f2-4d3e-8b16-0f9e8d7c6b5a",
  "plantingId": "plant_5e7a1c22-9d3b-4f61-8a0e-2b4c6d8e0f12", "label": "3", "number": 3,
  "status": "active", "plantedAt": "2026-09-12", "removedAt": null,
  "originSpaceId": "bed_3f0c2a9e-1b7d-4c55-9a51-0a2b8c7d6e11", "positionText": "middle of the row",
  "notes": "Tallest of the row", "createdAt": "2026-10-02T13:20:00.000Z", "legacy": null }
```

### 6.5 Event (`t: 'event'`): common shape

One record per thing that happened or was observed, at a stated scope. Type-specific data lives in
`payload` (section 7).

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | New: `ev_<uuid>`. From a v1 journal entry: the `log_*` id verbatim (so `<logId>:review` still matches). From a v1 photo: the `photo_*` id verbatim. |
| `type` | string matching `^[a-z][a-z0-9_]{1,40}$` | yes | Catalogue in section 7. Unknown types from a newer build are kept and shown as a generic note. |
| `payloadVersion` | integer, 1 or more | yes | `1` for every type defined here. |
| `gardenId` | string | yes | |
| `scope` | `garden`, `space`, `planting`, `plant` | yes | Rules in section 7.1. |
| `spaceId` | string or `null` | depends on scope | For `space` scope: the space. For `planting`/`plant` scope: **where the owner said it happened, recorded at save time** (defaults to the derived current location). An immutable recorded fact: it is never recomputed when a transplant is added or edited later. |
| `plantingId` | string or `null` | depends on scope | |
| `plantIds` | array of `ind_*` (0 to 500) | yes | Empty unless `scope` is `plant`. |
| `occurredOn` | `YYYY-MM-DD` | yes | Local date in `Garden.timeZone` when it happened. **All day, month and season analytics use this field only.** |
| `occurredAt` | ISO instant or `null` | no | Only when the real time is known. |
| `occurredAtSource` | `user`, `exif`, `save-time`, `none` | yes | `save-time` means the time is when the app saved the record (all v1 photos; new photos without EXIF; status changes from the dropdown), which may differ from when it happened. `none` when `occurredAt` is `null`. |
| `recordedAt` | ISO instant or `null` | yes | When the record was first entered. `null` only for migrated v1 journal entries, whose entry time is unknown. |
| `title` | string, up to 400 (form: 140) | no | v1 log title verbatim, including `''`. |
| `notes` | string, up to 24,000 (form: 12,000) | no | Free text. **Never parsed into payload numbers.** |
| `photoAssetIds` | array of `sha256-*` (0 to 50) | yes | Ordered. One asset may appear on several events. |
| `stageObserved` | string up to 40, or `null` | no | Owner-observed stage on any event (v1 stage labels, `Dormant`, or free text). An observation, not a first-occurrence claim. |
| `followUpOn` | `YYYY-MM-DD` or `null` | no | From v1 `reviewDate`. Produces task `<eventId>:review` for any type. During dual-read the unchanged v1 task list sees only events projected into `logs` (every type except `photo`, `measurement` and `state_change`), so the progress-photo dialog does not offer a follow-up date until a v2 task list ships. |
| `healthCaseId` | string or `null` | no | Groups observations, treatments and follow-ups of one problem. Convention: the id of the first observation in the case. |
| `relatedEventIds` | array of strings (0 to 50) | yes | Generic links. |
| `payload` | object, up to 32 KiB serialised | yes | By type; `{}` allowed. |
| `payloadStatus` | `complete`, `partial`, `legacy-text` | yes | `legacy-text`: the information is only in `title`/`notes` (all migrated v1 logs, and entries made through the v1 log form). `partial`: some fields the type requires are missing. Required payload fields are enforced only for `complete`. Analytics report how many records they had to skip because of this. |
| `source` | `user`, `migration-v1`, `v1-facade`, `import`, `system` | yes | Provenance. `v1-facade` means it was written through an unchanged v1 screen. |

```json
{ "t": "event", "id": "ev_1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", "type": "harvest", "payloadVersion": 1,
  "gardenId": "gdn_default", "scope": "planting", "spaceId": "bed_3f0c2a9e-1b7d-4c55-9a51-0a2b8c7d6e11",
  "plantingId": "plant_5e7a1c22-9d3b-4f61-8a0e-2b4c6d8e0f12", "plantIds": [],
  "occurredOn": "2026-11-20", "occurredAt": "2026-11-20T14:05:00.000Z", "occurredAtSource": "user",
  "recordedAt": "2026-11-20T14:09:31.112Z", "title": "First real picking", "notes": "Two cracked after rain",
  "photoAssetIds": ["sha256-3b7f0c9a5d2e8f1b4c6a7e9d0f2b3c5a6e8d9f0a1b2c3d4e5f6a7b8c9d0e1f2a"],
  "stageObserved": "Harvesting", "followUpOn": null, "healthCaseId": null, "relatedEventIds": [],
  "payload": { "weightG": 1842, "weightEntered": { "value": 4.06, "unit": "lb" }, "count": 14, "countUnit": "fruit",
               "qualityRating": 4, "qualityNotes": "2 cracked", "discardWeightG": 210, "isFinal": false },
  "payloadStatus": "complete", "source": "user", "createdAt": "2026-11-20T14:09:31.112Z", "legacy": null }
```

A v1 photo after migration (its `createdAt` 01:10 UTC is 20:10 the previous evening in Brownsville,
so `occurredOn` is the 28th):

```json
{ "t": "event", "id": "photo_77e1d2c3-b4a5-4f69-8877-665544332211", "type": "measurement", "payloadVersion": 1,
  "gardenId": "gdn_default", "scope": "planting", "spaceId": "bed_3f0c2a9e-1b7d-4c55-9a51-0a2b8c7d6e11",
  "plantingId": "plant_5e7a1c22-9d3b-4f61-8a0e-2b4c6d8e0f12", "plantIds": [],
  "occurredOn": "2026-09-28", "occurredAt": "2026-09-29T01:10:00.000Z", "occurredAtSource": "save-time",
  "recordedAt": "2026-09-29T01:10:00.000Z", "title": "", "notes": "New leaves after rain",
  "photoAssetIds": ["sha256-9b2c41d07e5a3f6b8c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b"],
  "stageObserved": "Vegetative growth", "followUpOn": null, "healthCaseId": null, "relatedEventIds": [],
  "payload": { "measures": [ { "metric": "height", "value": 12.5, "unit": "in", "rawText": "12.5" } ], "aggregate": "unspecified" },
  "payloadStatus": "complete", "source": "migration-v1", "createdAt": null,
  "legacy": { "src": "v1", "store": "photosDB", "migrationId": "m1", "migratedAt": "2026-10-01T15:04:40.000Z",
              "v1": { "id": "photo_77e1d2c3-b4a5-4f69-8877-665544332211", "planId": "plant_5e7a1c22-9d3b-4f61-8a0e-2b4c6d8e0f12",
                      "createdAt": "2026-09-29T01:10:00.000Z", "height": "12.5", "heightUnit": "in",
                      "stage": "Vegetative growth", "note": "New leaves after rain" } } }
```

### 6.6 PhotoAsset (`t: 'photoAsset'`): synced, immutable metadata

Content-addressed metadata for one stored image. **The bytes are not in this record.** It is
written once and never edited, except to tombstone it. Device-specific facts (where the bytes are,
the thumbnail) live in `assetLocal` (6.8), so copying bytes or regenerating a thumbnail never bumps
`rev` or causes sync traffic.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | `'sha256-' + sha256`. |
| `sha256` | 64 lowercase hex | yes | SHA-256 of the exact **stored** bytes (the re-encoded JPEG, or the v1 blob byte for byte). |
| `mime` | `image/jpeg`, `image/webp`, `image/png` | yes | All current and v1 photos are `image/jpeg`. |
| `bytes` | integer, 1 to 25,000,000 | yes | Stored size. |
| `width`, `height` | integer px, 1 to 10000, or `null` | yes | Of the stored image (after the 1600 px downscale). Not the plant's height. `null` only when the stored bytes could not be decoded (possible for a damaged v1 photo). |
| `capturedAt` | string or `null` | yes | EXIF `DateTimeOriginal`, read from the **original** file before re-encoding: ISO with offset when `OffsetTimeOriginal` exists, otherwise naive local `YYYY-MM-DDTHH:mm:ss`. `null` without EXIF. **Always `null` for v1 photos**: the v1 canvas re-encode already discarded EXIF. |
| `capturedAtRaw` | string or `null` | no | EXIF text verbatim, for example `2026:10:03 07:41:22`. |
| `capturedAtTz` | `exif-offset`, `assumed-garden-tz`, `null` | no | How to read `capturedAt`. |
| `recordedAt` | ISO instant | yes | When the app stored the image. For v1 photos: v1 `createdAt`. |
| `exifStripped` | boolean | yes | `true` when the stored bytes carry no EXIF (every canvas re-encode, so every current and v1 photo). GPS is therefore never stored. |
| `sourceSha256` | 64 hex or `null` | no | Hash of the original picked file, to warn when the same library photo is added twice (also across devices). The original bytes are never stored. `null` for v1 photos. |
| `transform` | string, up to 80 | no | How the stored bytes were made, for example `canvas-jpeg-q0.82-max1600`. |
| `legacy` | object or `null` | no | For assets registered by the migration: `{src: 'v1', store: 'photosDB', migrationId: 'm1', migratedAt, v1: null}`. The v1 photo record itself is kept on the event's `legacy.v1`, because one asset can serve several events. `null` for assets created in v2. |

```json
{ "t": "photoAsset", "id": "sha256-3b7f0c9a5d2e8f1b4c6a7e9d0f2b3c5a6e8d9f0a1b2c3d4e5f6a7b8c9d0e1f2a",
  "sha256": "3b7f0c9a5d2e8f1b4c6a7e9d0f2b3c5a6e8d9f0a1b2c3d4e5f6a7b8c9d0e1f2a", "mime": "image/jpeg",
  "bytes": 412883, "width": 1200, "height": 1600, "capturedAt": "2026-11-20T08:04:51-06:00",
  "capturedAtRaw": "2026:11:20 08:04:51", "capturedAtTz": "exif-offset", "recordedAt": "2026-11-20T14:09:31.112Z",
  "exifStripped": true, "sourceSha256": "aa91f3c2...07", "transform": "canvas-jpeg-q0.82-max1600",
  "createdAt": "2026-11-20T14:09:31.112Z", "rev": 1, "deleted": false, "legacy": null }
```

### 6.7 Blob and thumbnail entries (stores `blobs` and `thumbs`)

Not records. `blobs`: `{sha256, blob}`; the hash is re-verified when written. `thumbs`:
`{sha256, blob, width, height}`, keyed by the **asset's** hash (a thumbnail is not content-addressed
itself, because canvas JPEG output differs between browsers). Thumbnails are derived data:
regenerated when missing, never synced, never exported.

### 6.8 AssetLocal (store `assetLocal`): device-local, not synced, not exported

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `sha256` | 64 hex | yes | Key. |
| `where` | `v2`, `v1db`, `missing`, `purged` | yes | `v2`: bytes in `blobs`. `v1db`: bytes still read from `gardenforge.photos.v1` record `v1PhotoId` (until the background copy finishes). `missing`: this device has metadata but no bytes (for example after importing a data-only backup); a "photo not on this device" placeholder is shown, and it is never garbage-collected. `purged`: bytes removed by garbage collection. |
| `v1PhotoId` | string | when `where` is `v1db` | |
| `thumb` | `{width, height, bytes}` or `null` | yes | `null` until generated or if generation failed. |
| `thumbError` | string or `null` | no | |
| `verifiedAt` | ISO instant or `null` | no | Last time the bytes were re-hashed and matched. |
| `unreferencedSince` | ISO instant or `null` | no | Set when the last live event reference goes away. Used by garbage collection (section 8.5). |
| `remote` | `{state: 'local' or 'uploaded', at}` or `null` | no | Reserved for sync. |

### 6.9 TaskMark (`t: 'taskMark'`)

Replaces the v1 `completed` map with one record per key, so check-offs can sync.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string, up to 200 | yes | The v1 task key verbatim, for example `plant_5e7a...:plant` or `log_ab12...:review`. Works because planting and log ids are kept verbatim. |
| `done` | boolean | yes | v1 value verbatim. `false` entries are kept. |

```json
{ "t": "taskMark", "id": "plant_5e7a1c22-9d3b-4f61-8a0e-2b4c6d8e0f12:plant", "done": true, "createdAt": null }
```

### 6.10 Recipe, CustomCrop, CustomIngredient, Draft

Carried over with every v1 field unchanged, plus the envelope. The soil and fertilizer calculator
(`mixNumbers`) reads exactly the same inputs, so its arithmetic and its on-screen explanation are
unchanged.

| Type | Id | Fields |
| --- | --- | --- |
| `recipe` | v1 id verbatim (`mix_*`) | `presetId, name, type, description, parts, target, unit, rates, enrichedBio, enrichedZeo, notes, id, savedAt` verbatim. `savedAt` stays a `YYYY-MM-DD` date; `createdAt` stays `null` for migrated recipes. Recipes are never edited in place by v1 (saving creates a new id). |
| `customCrop` | v1 id verbatim (`customcrop_*`) | `id, name, group, family, windows, harvestMin, harvestMax, method, source, sourceNote` verbatim. `source` stays `null`; its `harvestMin`/`harvestMax` are owner estimates. |
| `customIngredient` | v1 id verbatim (`ingredient_*`) | `id, name, category, note` verbatim. No physical or nutrient analysis is implied. |
| `draft` | `draft` (singleton) | `value`: the v1 draft verbatim. `syncScope`: `device` (default) or `synced`. Last write wins; never a conflict copy. |

```json
{ "t": "recipe", "id": "mix_a1b2c3d4-0000-4000-8000-000000000001", "presetId": "bed", "name": "Raised bed blend",
  "type": "Raised bed", "description": "", "parts": { "topsoil": 4, "compost": 3, "pumice": 1 }, "target": 21.3,
  "unit": "ft3", "rates": { "gypsum": 20 }, "enrichedBio": null, "enrichedZeo": null, "notes": "",
  "savedAt": "2026-03-02", "createdAt": null }
```

### 6.11 Meta records (store `meta`, device-local)

| `k` | Value | Notes |
| --- | --- | --- |
| `mode` | `{value: 'v1' or 'v2', since, migrationId: 'm1', v1Hash, v1UpdatedAt}` | **The authoritative switch.** Written only by the final migration transaction, a rollback or a return to v2. `v1Hash` is the SHA-256 of the raw v1 string last merged. |
| `device` | `{id: 'dev_<uuid>', createdAt, container: 'home-screen' or 'browser-tab'}` | One per installation. On iOS the Home Screen app and a Safari tab have separate storage and are separate devices. |
| `migration` | `{phase, runs, attemptsByV1Hash, startedAt, finishedAt, counts, photoProgress, photosFailed[], flagged[], errors[] (max 200), preMigrationBackup}` | Phases and fields: `MIGRATION.md` section 5. |
| `v1Review` | `{removedInV1: [{t, id, seenAt}], photosRemovedInV1: [{v1PhotoId, seenAt, bytesSafe}], foreignV1Docs: [...]}` | Things an older copy of the app changed that are never applied automatically (`MIGRATION.md` section 9). |
| `downProjection` | `{at, written: {'<t>:<id>': <v1 record written>}}` | Written by the lossy "copy changes back to version 1" rollback; used as the merge base when those records come back. |
| `sync:<t>:<id>` | `{lastSyncedRev, baseBodyHash, dirty}` | Reserved for sync. Never exported. |

### 6.12 Snapshots (store `snapshots`, device-local)

`{id, kind, reason, takenAt, sha256, raw | records}`. Kinds:

- `v1-raw`: the v1 `localStorage` string, byte for byte, with its SHA-256. Taken before any other v2
  write, again at retirement, and before any write to the v1 key. The pre-migration and retirement
  copies are kept for **at least 365 days**; other `v1-raw` copies keep the last 5.
- `v2-records`: every record (no blobs) before a replace-import, a rollback or a down-projection.
  Last 3 kept.
- `v2-before-images`: only the records a merge is about to change. Last 10 kept. Used for "Undo".

## 7. Event catalogue

### 7.1 Scope rules

| `scope` | `spaceId` | `plantingId` | `plantIds` | Meaning |
| --- | --- | --- | --- | --- |
| `garden` | usually `null` | `null` | `[]` | Whole garden (rain, a garden-wide note). |
| `space` | required | `null` | `[]` | Everything in that space on that date (bed watering, amendment). |
| `planting` | recorded location, may be `null` | required | `[]` | The **whole** planting. |
| `plant` | recorded location, may be `null` | required | 1 to 500 ids, each a Plant of `plantingId` (a warning if not) | One plant or a named subset. |

Timelines show inherited events with a badge: `whole planting`, `bed-wide`, `garden-wide`
(section 12.1). Amounts on multi-plant or planting-scope events are never presented as one plant's
amount without a `split evenly` or `averaged` label.

Common to all types: `title`, `notes`, `photoAssetIds`, `stageObserved`, `followUpOn`,
`healthCaseId`, `relatedEventIds`. Units are stored as entered; analytics convert at query time
(length to cm: `in` 2.54, `ft` 30.48, `mm` 0.1, `m` 100; weight to g: `oz` 28.349523125, `lb`
453.59237, `kg` 1000; volume to L: `gal` 3.785411784, `qt` 0.946352946, `fl oz` 0.0295735295625,
`mL` 0.001). Converted values are never written back.

"Required" below means required when `payloadStatus` is `complete`.

### 7.2 Types

**`photo`**: a photo session. Payload `{}`. Requires at least one `photoAssetIds` entry.
Scopes: plant, planting, space, garden. If something was measured at the same time, use
`measurement` with photos attached instead. A guided AI capture (`docs/AI-CAMERA.md` section 4.7) is a
`photo` event whose `photoAssetIds` are in the order the photos were sent, with payload
`{captureSetId, shots: [{slot, index, scaleRef, shotNote}]}`.

**`ai_assessment`** (planned with the AI camera; full definition in `docs/AI-CAMERA.md` sections 4.7 and 7).
Scopes: planting, plant. The stored result of one AI check: provider, model, prompt version, the
`gf-assessment-1` answer (at most 8,192 bytes), the context that was sent, the sanitizer report, usage and
the owner's feedback. Rules: it never creates or edits a `pest_observation` or `disease_observation` by
itself, its feedback never sets `labConfirmed`, and it carries no product, rate or dose. Builds that do not
know the type show it as a generic note (6.5).

**`measurement`**. Scopes: plant (preferred), planting.
- `measures` (required, 1 to 20): `{metric, label?, value, unit, rawText?, method?}`.
  `metric`: `height`, `width`, `canopy_diameter`, `stem_diameter`, `leaf_count`, `fruit_count`,
  `truss_count`, `other` (then `label`, up to 60, is required). `value`: number, 0 to 100000.
  `unit`: `in`, `cm`, `mm`, `ft`, `m`, or `count` (count metrics only). `rawText`: the value as typed,
  up to 40. `method`: up to 200, for example `soil line to growing tip, tape`.
- `aggregate`: `single`, `typical`, `max`, `mean`, `unspecified`. Required when scope is `planting`
  or more than one plant. Migrated v1 heights use `unspecified`, because v1 did not record how the
  owner measured a planting.
- Analytics draw planting-scope measures as a separate labelled series, never as one plant's value.

**`watering`**. Scopes: space (typical), planting, plant, garden. All payload fields optional, so
"watered bed 1" alone is complete.
- `amount` (number over 0, up to 100000), `amountUnit` (`gal`, `L`, `qt`, `mL`, `fl oz`; required
  with `amount`), `durationMin` (0 to 1440), `method` (`hand`, `drip`, `soaker`, `sprinkler`,
  `bottom`, `wick`, `rain`, `other`), `sourceText` (up to 100, for example `rain barrel`).

**`fertilization`** (fertilizer or amendment). Scopes: space, planting, plant, garden.
- `product` (required, 1 to 120, as on the label, for example `fish emulsion`), `productKind`
  (`recipe`, `amendment`, `commercial`, `compost`, `tea`, `other`), `labelNPK` (up to 20, exactly as
  printed, owner-entered), `recipeId` (saved or built-in recipe id), `amendmentIds` (up to 50),
  `amount` (number, 0 or more), `amountUnit` (`g`, `kg`, `oz`, `lb`, `mL`, `L`, `tsp`, `tbsp`, `cup`,
  `fl oz`, `gal`, `ft3`; required with `amount`), `basisText` (up to 120, for example
  `per 10 gal media`), `dilutionText` (up to 120, verbatim, for example `1 tbsp per gal`), `method`
  (`top-dress`, `side-dress`, `soil drench`, `foliar`, `incorporated`, `fertigation`, `other`),
  `appliedToText` (up to 120), `calcInputs` (`{source: 'mix-calculator', formulaVersion, recipeId,
  target, unit, parts, rates}` or `null`: a snapshot of the calculator inputs so the record keeps
  its own arithmetic if the recipe changes).
- No nutrient amount is computed and stored as fact. Totals are recomputed on screen from
  `amount`, `amountUnit`, `labelNPK` and `calcInputs`, with the formula shown.

**`transplant`**. Scopes: planting, plant.
- `fromSpaceId` (or `null`), `toSpaceId`, `fromLabel` and `toLabel` (up to 100, for spaces with no
  record, for example `72-cell tray`), `reason` (required: `planting_out`, `potting_up`, `move`,
  `correction`, `unknown`), `containerText` (up to 100), `rootNote` (up to 500).
- At least one of `toSpaceId` and `toLabel` is required unless `reason` is `unknown`.
- Changes the **derived** current location from `occurredOn` onward. `reason: 'correction'` is
  excluded from location history. `Planting.bedId` is not changed automatically; the UI asks "Also
  set this planting's assigned space?".

**`sowing`**. Scopes: planting, plant. The observed anchor for "days from sowing".
- `method` (required: `direct`, `indoor_tray`, `indoor_pot`, `pieces`, `slips`, `other`),
  `seedCount` (integer or `null`), `seedLotText` (up to 120), `depthText` (up to 40).
- Migration never creates sowing events; v1 recorded no sowing dates.

**`state_change`**. Scopes: planting, plant. Written automatically, in the same transaction, with
any change to `Planting.status`, `Planting.bedId`, `Planting.count` or `Plant.status`. Hidden from
the journal list.
- `entity` (`planting` or `plant`), `field` (`status`, `bedId`, `count`), `from`, `to`, `reason`
  (`user`, `v1-facade` for the status dropdown, `v1-form-edit` for the plan dialog, `correction`,
  `reconcile`), `endReason` (only when the status moves to `done`, `removed`, `died` or
  `harvested-out`: `harvest_complete`, `failed`, `removed_early`, `other`, or `null` when not asked,
  as with the v1 dropdown).
- `occurredOn` is the device's local date and `occurredAtSource` is `save-time`; the owner can edit
  the date afterwards. A `bedId` change from the plan dialog is labelled "assignment changed in a
  form" in location history, because it may be a correction rather than a physical move.
- Migration writes none: v1 status has no date, and inventing one would be fabrication.

**`flowering`**. Scopes: plant, planting.
- `phase` (required: `first`, `ongoing`, `peak`, `ended`), `flowerType` (`male`, `female`,
  `perfect`, `mixed`, `unknown`), `countEstimate` (integer, 0 or more).

**`fruiting`**. Scopes: plant, planting.
- `phase` (required: `fruit_set`, `first_ripe`, `ongoing`, `ended`), `countEstimate`, `sizeText` (up
  to 60).

**`harvest`**. Scopes: plant (preferred), planting, space.
- `weightG` (number, 0 to 10,000,000, grams), `weightEntered` (`{value, unit: g, kg, oz or lb}`, as
  typed; `weightG` is derived from it), `count` (integer, 0 to 1,000,000), `countUnit` (`fruit`,
  `heads`, `bunches`, `pods`, `stems`, `leaves`, `roots`, `ears`, `flower_stems`, `other`; required
  with `count`), `countUnitLabel` (up to 40, when `other`), `discardWeightG` (unmarketable part,
  included in `weightG`), `qualityRating` (integer 1 to 5, owner scale), `qualityNotes` (up to 1000),
  `isFinal` (last harvest of this scope).
- At least one of `weightG` and `count` is required. Migrated v1 `Harvest` entries are
  `legacy-text`: weights written in notes are **not** parsed, and the UI lists them under "Add
  weights to old harvest notes".

**`pruning`**. Scopes: plant, planting.
- `kind` (required: `pinch`, `sucker_removal`, `topping`, `deadhead`, `thin`, `leaf_removal`,
  `train_tie`, `cut_back`, `other`), `partText` (up to 120), `amountText` (up to 200).

**`pest_observation`**. Scopes: plant, planting, space.
- `label` (required, 1 to 120, the owner's words, for example `whiteflies under leaves`), `code`
  (optional grouping tag: `aphids`, `whiteflies`, `spider_mites`, `thrips`, `mealybugs`, `scale`,
  `leafminers`, `caterpillars`, `hornworms`, `armyworms`, `stink_bugs`, `leaffooted_bugs`,
  `squash_bugs`, `flea_beetles`, `cucumber_beetles`, `fire_ants`, `grasshoppers`, `snails_slugs`,
  `birds`, `rodents`, `other`), `lifeStage` (`egg`, `larva_nymph`, `pupa`, `adult`, `mixed`,
  `unknown`), `severity` (required, integer 1 to 5, owner-relative: 1 trace, 2 light, 3 moderate,
  4 heavy, 5 severe or plant at risk), `affectedParts` (up to 7 of `leaf`, `stem`, `flower`, `fruit`,
  `root`, `crown`, `whole_plant`), `countText` (up to 60), `affectedPlantsCount` (integer),
  `confidence` (required: `confirmed`, `likely`, `unsure`), `confidenceNote` (up to 500, how it was
  identified), `progression` (`new`, `spreading`, `stable`, `improving`, `resolved`).
- The code list carries names only, no facts. The owner's `label` is always what is displayed.

**`disease_observation`** (disease or symptom). Scopes: plant, planting, space. Symptoms and the
suspected cause are separate fields, so a guess is never stored as a diagnosis.
- `symptomLabel` (required, 1 to 120, what is seen), `symptomCodes` (up to 20 of `yellowing`,
  `interveinal_chlorosis`, `wilting`, `leaf_spot`, `powdery_coating`, `downy_growth`,
  `mosaic_mottle`, `leaf_curl`, `blight_dieback`, `stem_lesion`, `rot`, `blossom_end_rot`,
  `cracking`, `stunting`, `scorch`, `damping_off`, `other`), `suspectedCauseLabel` (up to 120, for
  example `early blight?`), `suspectedCauseConfidence` (`confirmed`, `likely`, `unsure`),
  `labConfirmed` (boolean, default `false`), `labTestText` (up to 500), `severity` (required, same
  scale as pests), `affectedParts`, `affectedPlantsCount`, `progression`, `confidenceNote`.

**`treatment`**. Scopes: plant, planting, space, garden.
- `product` (required, 1 to 120; `hand-picked` and `none` allowed), `activeIngredientText` (up to
  200, as printed), `method` (required: `spray`, `drench`, `dust`, `hand_removal`, `water_blast`,
  `prune_out`, `barrier`, `trap`, `beneficial_release`, `remove_plant`, `cultural_change`, `other`),
  `doseText` (up to 200, verbatim), `doseAmount` and `doseUnit` (optional number and unit text),
  `targetObservationIds` (up to 50 pest or disease observation ids), `labelFollowed` (boolean),
  `labelNotesText` (up to 500, owner-copied re-entry or harvest-interval notes; never filled in by
  the app), `outcome` (`{assessedOn, result: resolved, improved, no_change, worse, too_early or
  unknown, followUpObservationIds: [], notes up to 2000}` or `null`).
- `healthCaseId` is set to the case of the targeted observations. `outcome` may be filled in later
  (a normal edit that bumps `rev`). `followUpOn` creates the task "Check whether the treatment
  helped".

**`note`** (general note). Any scope. Payload `{topic?: string up to 60}`. v1 `Observation`
entries and unknown v1 kinds become notes.

**`soil_test`**. Scopes: space, garden.
- `method` (`lab`, `meter`, `strip`, `kit`, `other`), `methodText` (up to 500; required for
  `complete`: how the sample was taken and measured), `sampleDepthIn`, `labName` (up to 100), `pH`
  (0 to 14), `ec`, `ecUnit` (`mS/cm`, `dS/m`, `uS/cm`, `ppm500`, `ppm700`), `resultsText` (up to
  12000). pH and EC are never parsed out of notes.

**`mix_batch`**. Scopes: garden, space.
- `recipeId`, `volume` and `unit` (`gal`, `L`, `ft3`, `qt`, `dryqt`), `partsSnapshot`,
  `ratesSnapshot`. Migrated v1 `Mix batch` entries keep the v1 `mixText()` output in `notes`.

**`compost`**. Scopes: garden, space.
- `action` (`build`, `turn`, `moisture_check`, `temperature_check`, `charge_biochar`, `harvest`,
  `other`), `temperatureEntered` (`{value, unit: C or F}`), `moistureText` (up to 120). A follow-up
  date is a check-in, not a maturity claim.

### 7.3 v1 journal kinds

| v1 `kind` | v2 `type` | `payloadStatus` |
| --- | --- | --- |
| `Observation` | `note` | `legacy-text` |
| `Harvest` | `harvest` | `legacy-text` |
| `Feeding` | `fertilization` | `legacy-text` |
| `Pest scouting` | `pest_observation` | `legacy-text` |
| `Soil / media test` | `soil_test` | `legacy-text` |
| `Mix batch` | `mix_batch` | `legacy-text` |
| `Compost` | `compost` | `legacy-text` |
| any kind, when the entry carries a valid `ai` object (an AI estimate, `docs/AI-CAMERA.md` 4.2) | `ai_assessment` | `complete` |
| anything else | `note` | `legacy-text` |

The original kind stays in `legacy.v1.kind` and is what the v1 screens show. The payload stays `{}`.
The owner can "Complete this record" later, which fills the payload and changes the status.

## 8. Photo assets and thumbnails

### 8.1 Layers

Event (what happened) → `photoAssetIds[]` → PhotoAsset (immutable metadata in `records`) → bytes in
`blobs` (or, until copied, in the v1 photo database) and a thumbnail in `thumbs`. Galleries and
timelines load thumbnails only; full bytes are read only in the photo viewer.

### 8.2 New capture (replaces the inside of `saveGrowthPhoto`; the dialog stays)

All slow work happens **before** any write transaction opens, because an IndexedDB transaction
commits on its own once the code awaits anything that is not an IndexedDB request.

1. Read the first 128 KB of the **original** file and parse JPEG APP1 EXIF (an inline parser of
   about 100 lines): `DateTimeOriginal`, `OffsetTimeOriginal`, `Orientation`. HEIC files and parse
   failures give `capturedAt: null`. **(verify)** what iOS hands to a web page for camera captures
   and library picks: EXIF may already be missing.
2. `sourceSha256` = SHA-256 of the original file. Warn if a live asset already has it.
3. `compressPhoto()` exactly as in v1 (max 1600 px, JPEG 0.82). EXIF, including GPS, is gone.
4. `sha256` of the stored bytes; width and height from the bitmap.
5. Thumbnail from the same bitmap (320 px long edge, JPEG 0.7). **(verify)** whether WebKit
   honours the `resizeWidth`/`resizeHeight` options of `createImageBitmap`; if not, draw the
   full bitmap to a small canvas, and release each bitmap with `close()` to limit memory.
6. One `readwrite` transaction over `records`, `blobs`, `thumbs` and `assetLocal`: put the blob,
   thumb and asset if absent (revive a tombstoned asset with `rev + 1`), put `assetLocal`, put the
   event.

The event is `measurement` when a value was entered, otherwise `photo`. `occurredAt` is the EXIF
instant when known (`occurredAtSource: 'exif'`), otherwise the save instant (`save-time`);
`occurredOn` is computed in `Garden.timeZone`. The asset's `recordedAt` is always the save instant.

SHA-256 uses `crypto.subtle.digest`. It needs a secure context, so the build inlines a small
pure-JS SHA-256 for `file://` portable copies.

### 8.3 Deduplication

Identical stored bytes produce one asset referenced by many events. Picking the same library photo
twice usually gives identical re-encoded bytes on the same device, but not across devices; the
`sourceSha256` warning covers that case.

### 8.4 v1 photos

Existing photos keep their bytes exactly (no re-encode). Each becomes a PhotoAsset with
`capturedAt: null`, `exifStripped: true`, `recordedAt` = v1 `createdAt`, plus one event whose id is
the v1 photo id. Thumbnails are generated during migration so galleries work immediately; the full
bytes are copied into `blobs` in the background after the switch. Details: `MIGRATION.md` section 7.

### 8.5 Deletion and garbage collection

Deleting a photo tombstones its event, or removes the hash from the event's `photoAssetIds`. Garbage
collection is **local only**: it deletes this device's `blobs` and `thumbs` entries for an asset
when all of these hold:

- no live event references it, and `assetLocal.unreferencedSince` is more than 30 days ago (the undo
  window);
- no `v2-records` snapshot younger than 90 days references it;
- `assetLocal.where` is `v2` (bytes whose only copy is in the v1 database are never collected);
- it is not `missing`.

Reference counts are computed by scanning, never stored. The PhotoAsset record itself is kept (it is
small), and `assetLocal.where` becomes `purged`. Until sync can confirm that no device still
references an asset, its synced metadata is never tombstoned by garbage collection.

### 8.6 Scale

About 300 to 400 KB per stored photo and 20 KB per thumbnail: 1,000 photos a year is roughly 400 MB a
year in IndexedDB, with about 600 bytes of metadata per asset. The app calls
`navigator.storage.persist()` on first v2 boot and shows `navigator.storage.estimate()` in
Save/restore. Home Screen web apps on iOS are reported to be exempt from Safari's seven-day storage
eviction **(verify)**; a Safari tab is not, and the app warns about that.

### 8.7 Cloud later

Upload by `sha256` with "put if absent"; record the result in `assetLocal.remote`. A device may then
drop local full bytes and keep thumbnails (`where` stays meaningful per device).

## 9. Sync readiness

Sync is not built. These rules exist now so that it can be added without another migration.

### 9.1 Writes

All local writes go through one `putRecords(changes[])` helper that:

- merges each change onto the stored record, so fields this build does not know about (from a newer
  build, or v2-only fields the v1 screens cannot see) are kept;
- skips the write when `canonical(body)` did not change;
- otherwise sets `updatedAt`, `rev + 1` and `deviceId`;
- writes every touched record in **one** transaction, including the `state_change` event that
  accompanies a status, `bedId` or `count` change;
- updates the in-memory model only after the transaction's `oncomplete`;
- on failure, sets `storageOK = false`, keeps the changes queued in memory (and in
  `gardenforge.v2.pending` if they fit), shows the existing "Backup needed" status and retries after
  reconnecting.

Writes from the v1 screens are coalesced for 250 ms (the mix page saves on every keystroke) and
flushed on `pagehide` and on `visibilitychange` to hidden. This is a real regression risk compared
with v1, whose `localStorage` write was synchronous: if iOS kills the app inside the coalescing
window, or before a started transaction commits, that window's edits are lost. **(verify)** on a
real iPhone that a transaction started in a `visibilitychange` handler completes. Dialog submits
(plan, bed, log, photo) are written immediately, without coalescing.

### 9.2 Tombstones

- Deleting sets `deleted: true`, `deletedAt`, `rev + 1`. The full body is kept for 30 days for Undo
  and Trash.
- After 30 days, **events** may be compacted to a stub (`id`, `t`, `type`, `scope`, `occurredOn`,
  the envelope), which also removes deleted notes for privacy. Plantings, spaces, plants, recipes
  and photo assets are never compacted, because history refers to them.
- Stubs are kept locally indefinitely (they are tiny). Once sync exists, they may be purged only
  after every known device has acknowledged them.
- **Deleting a planting tombstones the planting and its TaskMarks** (as v1 removed its check-offs)
  and nothing else. Its events, plants and photos stay and are shown as "planting deleted". Restoring
  the planting restores the TaskMarks.

### 9.3 Conflicts (for the later sync, and for import-merge now)

- **Content-equal is not a conflict.** If two versions have the same `bodyHash`, keep one, take the
  higher `rev`, the earlier `createdAt` and the earlier `legacy.migratedAt`.
- If only one side changed since the common base (`meta.sync:*.baseBodyHash`, or `legacy.v1` for v1
  merges), take that side.
- If both changed: the higher `(updatedAt, deviceId)` wins in place, and the other version is saved
  as a **conflict copy**: a new record with a new id (the type's current prefix, so a planting copy
  gets `pln_`), `conflictOf` = the winner's id. Conflict copies are excluded from the v1 screens, from
  tasks and from analytics, and listed under "Needs review". Conflict copies of history records never
  expire.
- **Edit beats delete**: the edit wins and undeletes the record, and the owner is told.
- `draft` and `taskMark`: plain last-writer-wins, no copies.
- `photoAsset`: never conflicts (same id, same bytes). If metadata differs, a non-null `capturedAt`
  wins.
- After a merge, a stored status is repaired from the latest `state_change` for it only if they
  differ; a record with no `state_change` keeps its stored value as the baseline. Equal values are
  never rewritten, so devices do not ping-pong. If a `state_change` ever has to be synthesised (for
  example, an import brings a status with no matching event), it gets a deterministic id,
  `ev_rec_<entityId>_<field>_<first 12 hex of bodyHash>`, so two devices produce the same record.

### 9.4 Archive instead of delete for spaces

"Remove space" in v2 sets `archivedAt`. The space disappears from lists, and plantings keep their
`bedId`, so the v1 screens still show "Unassigned growing space" while bed history survives. A real
delete (tombstone) is offered only for a space nothing refers to.

### 9.5 Device identity

`dev_<uuid>`, created once per installation and kept in `meta.device` (mirrored in
`localStorage`). On iOS the Home Screen app and a Safari tab are separate installations with
separate storage: each migrates on its own, and Settings shows which one is open.

### 9.6 Ordering

Events sort by `occurredOn`, then `occurredAt ?? ''`, then `recordedAt ?? ''`, then `id`. Every device
gets the same order.

## 10. Id prefixes

> Server note: the self-hosted sync server (`server/`) requires a record id to be unique per owner across all
> types, up to 200 characters. Every id carries a type-specific prefix, so this holds for migrated v1 ids and new
> ids alike; a client must never reuse an id for a different type.

| Prefix | Type | Issued by |
| --- | --- | --- |
| `gdn_default` | garden | Migration (deterministic). New gardens: `gdn_<uuid>`. |
| `bed_` | space | v1 and v2. |
| `plant_` | planting | **v1 only.** Means a planting. Never issued again, and no code may read it as "individual plant". |
| `pln_` | planting | v2, including the v1 plan dialog running inside a v2 build. |
| `ind_` | individual plant | v2. |
| `log_` | event | v1 journal entries (kept verbatim). |
| `photo_` | event | v1 photos (the v1 photo id becomes the event id). |
| `ev_` | event | v2. |
| `sha256-` | photo asset | `'sha256-' + 64 lowercase hex`. |
| (task key) | task mark | The v1 key verbatim, for example `plant_x:sow`. |
| `draft` | draft | Singleton. |
| `mix_` | recipe | v1 and v2. |
| `customcrop_` | custom crop | v1 and v2. |
| `ingredient_` | custom ingredient | v1 and v2. |
| `dev_` | device | v2. |
| `cset_` | (not a record) | AI capture-set grouping key on photo records and events (`docs/AI-CAMERA.md` 4.1). |
| `aireq_` | (not a record) | AI request id, one per paid attempt (`docs/AI-CAMERA.md` 5.7). |

New ids are `prefix + '_' + crypto.randomUUID()` (or the v1 fallback when `randomUUID` is missing).
Prefixes are for people reading data. **Validation never rejects an id because of its shape**; the
type always comes from `t`. A test feeds real `uid()` output for every prefix, the `Date.now()`
fallback form and the fixture's short ids (`bed_a`, `plant_1`) through migration and v2 validation and
expects zero rejections.

## 11. Validation (v2)

`validateStateV2(input, mode)` returns `{records, quarantined: [{t, id, reason}], warnings: []}`.
`mode` is `import` (a backup file) or `load` (this device's own IndexedDB).

1. **Container.** A v2 backup has `format: 'gardenforge-backup'` and `schemaVersion: 2`.
   `schemaVersion: 1` is routed to the v1 validator and the migration transform. A
   `schemaVersion` above 2 is refused with "made by a newer version of GardenForge", and nothing is
   written.
2. **No blanket item cap.** v1's 1500 (later 20,000) items per collection is gone. The limits below
   protect memory and refuse rather than truncate:

   | Limit | Value |
   | --- | --- |
   | Whole `data.json` | 100 MB |
   | Total records | 1,000,000 |
   | Events | 1,000,000 |
   | Photo assets | 500,000 |
   | Plants | 500,000 |
   | Plantings | 200,000 |
   | Spaces, recipes, custom crops, custom ingredients | 50,000 each (above v1's 20,000, so every v1 document fits) |
   | Task marks | 2,000,000 |
   | Gardens | 100 |
   | One record, serialised | 64 KiB (events: payload 32 KiB). Records with `legacy.src: 'v1'`: up to 1 MiB, with a warning above 64 KiB. |
   | One media file in an archive | 25 MB |

3. **Envelope.** `t` is a string; unknown `t` values are kept on disk and ignored. `id` is a string
   of 1 to 200 characters without control characters, unique within `t` in the file. `updatedAt` is
   an ISO instant; `rev` is an integer from 1 to 1e9; `deviceId` is a non-empty string; `deleted` is
   a boolean. `createdAt` is an ISO instant, or `null` when `legacy` is present. Tombstones are
   checked for the envelope only.
4. **Strings and arrays.** Every validation cap is **at least** HEAD's v1 cap for the same field,
   so any string HEAD accepted is accepted again. The forms keep their smaller limits; validation
   only protects memory.

   | Field | Form limit (v2 UI) | Validation limit |
   | --- | --- | --- |
   | Garden `name` / `zone` | 100 / select | 200 / 60 |
   | Space `name`, `type`, `light`, `notes` | 100, select, select, 4000 | 200, 100, 100, 8000 |
   | Planting `variety`, `cropName`, `mixName`, `notes` | 100, from the crop, from the recipe, 4000 | 200, 200, 200, 8000 |
   | Planting `bedId`, `mixId`; any reference id | chosen from a list | 200 |
   | Plant `label`, `positionText`, `notes` | 40, 200, 4000 | 40, 200, 4000 |
   | Event `title`, `notes` | 140, 12,000 | 400, 24,000 |
   | `legacy.v1.kind` | chosen from a list | 100 |
   | Recipe `name`, `type`, `notes` | 120, from the preset, none | 200, 100, 12,000 |
   | Custom crop `name`, `family`, `sourceNote` | none, fixed text, 2000 | 200, 200, 4000 |
   | Custom ingredient `name`, `category`, `note` | none, fixed text, fixed text | 200, 100, 1000 |
   | Payload short texts | as listed in section 7 | the same |

   Array caps: `plantIds` 500, `photoAssetIds` 50, `relatedEventIds` 50, `measures` 20,
   `targetObservationIds` 50, `symptomCodes` 20, `affectedParts` 7, `amendmentIds` 50, `seasons` 12,
   `customCrop.windows` 8. Strings are stored raw and escaped only at render time through `h()`.
5. **Dates and numbers.** Dates use v1 `validDate` (`YYYY-MM-DD`, years 1900 to 2200). Instants are
   ISO-8601 with `Z` or an offset. Numbers must be finite and inside the ranges in sections 6 and 7.
   Recipes and the draft use v1 `validParts` and the v1 draft rules unchanged (`completed` and
   `draft.rates` must be objects, as in `e1e56e1`/`ce869ef`). `sha256` is 64 lowercase hex and
   `id === 'sha256-' + sha256`; photo `width`/`height` are 1 to 10000 or `null`. An `occurredOn`
   more than 2 days in the future is a warning.
6. **Events.** `occurredOn` must be valid. Scope invariants per section 7.1. A type's required
   payload fields are enforced only when `payloadStatus` is `complete`. Unit enums are enforced
   whenever a value is present; an unknown enum value in a known type downgrades the record to
   `partial` with a warning. Unknown event types are accepted and shown as notes.
7. **References never fail validation.** A dangling `plantingId`, `spaceId`, `plantIds` entry,
   `photoAssetIds` entry, `mixId` or `recipeId` is a warning. v1 already allowed references to
   deleted beds and recipes, and sync and partial imports can arrive out of order.
8. **Unknown fields are kept** and count toward the record size cap.
9. **v1 data is never rejected by stricter v2 rules.** Any record that has `legacy.src: 'v1'`, or
   that came from a v1 document that passed v1 `validateState`, gets warnings, never quarantine:
   non-integer counts, long names, missing optional fields, `''` titles, odd id shapes. Only
   structural damage (not an object, no string `t` or `id`) quarantines it.
10. **Failure policy.** In `import` mode, structural failures (container, duplicate ids within a
    type, an exceeded limit) reject the whole file; per-record failures are listed and the owner
    chooses "Import the valid records" or "Cancel". In `load` mode nothing throws: a quarantined
    record stays on disk, is left out of the in-memory model (so no screen can overwrite it) and is
    listed under Settings, "Check data". A test asserts that migrating `tools/tests/fixture.json`
    and loading the result quarantines zero records.

## 12. Analytics this model supports

All of these are computed in memory on demand, never stored. Every result shows its sample size and
the basis of its dates, and says "association only, not proof" when it compares groups with
fewer than 3 members. Shared helpers:

```js
const live = (r) => !r.deleted && !r.conflictOf;
const E = allRecords.filter((r) => r.t === 'event' && live(r));
const order = (a, b) =>
  a.occurredOn.localeCompare(b.occurredOn) ||
  (a.occurredAt ?? '').localeCompare(b.occurredAt ?? '') ||
  (a.recordedAt ?? '').localeCompare(b.recordedAt ?? '') ||
  a.id.localeCompare(b.id);
const CM = { cm: 1, mm: 0.1, in: 2.54, ft: 30.48, m: 100 };
const covers = (e, p) => e.scope === 'planting' || (e.scope === 'plant' && e.plantIds.includes(p.id));
// groupBy, groupSum, daysBetween(dayA, dayB), plantsOf(plantingId) and byId(eventId) are plain
// helpers over the in-memory maps; plantings, recipes and garden are the live records.
```

### 12.1 Location and timelines

Where a plant was on a given day, then one plant's complete history:

```js
function spaceAt(p, day) {
  const L = plantings.get(p.plantingId);
  const moves = [...(eventsByPlant.get(p.id) ?? []), ...(eventsByPlanting.get(L.id) ?? [])]
    .filter((e) => e.type === 'transplant' && e.payload.reason !== 'correction' &&
                   e.occurredOn <= day && covers(e, p))
    .sort(order);
  if (moves.length) return moves.at(-1).payload.toSpaceId ?? null;
  return p.originSpaceId ?? (L.bedId || null);
}

function plantTimeline(p, { includeGarden = false } = {}) {
  const L = plantings.get(p.plantingId);
  const from = p.plantedAt ?? '0000-01-01', to = p.removedAt ?? '9999-12-31';
  const inLife = (e) => e.occurredOn >= from && e.occurredOn <= to;
  return E.filter((e) =>
      (e.scope === 'plant' && e.plantIds.includes(p.id)) ||
      (e.scope === 'planting' && e.plantingId === L.id) ||                  // badge "whole planting"
      (e.scope === 'space' && inLife(e) && e.spaceId === spaceAt(p, e.occurredOn)) || // "bed-wide"
      (e.scope === 'garden' && includeGarden && inLife(e)))                  // "garden-wide"
    .sort(order);
}
```

A planting's timeline is the same with `plantingId === L.id` for planting and plant scope, plus
space-scope events in `L.bedId` (and in transplant destinations) between the start anchor and the
last event.

### 12.2 Start anchors and seasons

Days-to-anything needs a start date. The anchor ladder, best first, always reported with its basis:

```js
function anchor(L, p, basis /* 'sowing' or 'planting_out' */) {
  const ev = p ? plantTimeline(p) : (eventsByPlanting.get(L.id) ?? []);
  if (p?.plantedAt && basis === 'planting_out') return { day: p.plantedAt, basis: 'date you entered' };
  const explicit = ev.filter((e) => basis === 'sowing'
      ? e.type === 'sowing'
      : e.type === 'transplant' && e.payload.reason === 'planting_out').sort(order)[0];
  if (explicit) return { day: explicit.occurredOn, basis: 'recorded ' + basis.replace('_', ' ') };
  const sc = ev.filter((e) => e.type === 'state_change' && e.payload.field === 'status' &&
      e.payload.to === (basis === 'sowing' ? 'sown' : 'planted')).sort(order)[0];
  if (sc) return { day: sc.occurredOn, basis: 'day the status was changed' };
  return { day: L.date, basis: 'planned date (not observed)' };
}
const defaultBasis = (L) => (['indoor', 'transplant'].includes(L.mode) ? 'planting_out' : 'sowing');

function seasonOf(L) {
  if (L.seasonLabel) return L.seasonLabel;
  const day = anchor(L, null, defaultBasis(L)).day;            // a Fall planting harvested in
  if (!garden.seasons.length) return day.slice(0, 4);          // January stays in Fall
  const md = day.slice(5), y = Number(day.slice(0, 4));
  const starts = [...garden.seasons].sort((a, b) => a.startMMDD.localeCompare(b.startMMDD));
  const s = [...starts].reverse().find((x) => x.startMMDD <= md);
  return s ? `${s.label} ${y}` : `${starts.at(-1).label} ${y - 1}`; // before the first start: last season of the previous year
}
```

### 12.3 Growth curve

```js
function growth(p) {
  const L = plantings.get(p.plantingId), a = anchor(L, p, defaultBasis(L));
  return E.filter((e) => e.type === 'measurement' && covers(e, p) && e.payloadStatus !== 'legacy-text')
    .flatMap((e) => e.payload.measures.filter((m) => m.metric === 'height' && CM[m.unit])
      .map((m) => ({
        day: e.occurredOn, x: daysBetween(a.day, e.occurredOn), cm: m.value * CM[m.unit],
        series: e.scope === 'plant' && e.plantIds.length === 1 ? 'this plant'
              : 'planting (' + (e.payload.aggregate ?? 'unspecified') + ')',
        timeBasis: e.occurredAtSource, startBasis: a.basis })))
    .sort((u, v) => u.day.localeCompare(v.day));
}
```

### 12.4 Yield

```js
const harvests = E.filter((e) => e.type === 'harvest');
const weighed = harvests.filter((e) => e.payload.weightG != null);
// Always reported next to any total:
const skipped = { textOnly: harvests.filter((e) => e.payloadStatus === 'legacy-text').length,
                  noWeight: harvests.filter((e) => e.payloadStatus !== 'legacy-text' && e.payload.weightG == null).length,
                  noPlanting: weighed.filter((e) => !e.plantingId).length };

function livePlantCount(L, day) {
  const ps = plantsOf(L.id);
  if (!ps.length) return { n: L.count, basis: 'stated count' };
  return { n: ps.filter((p) => (p.plantedAt ?? '') <= day && (!p.removedAt || p.removedAt >= day)).length,
           basis: 'numbered plants' };
}

function yieldOfPlant(p) {
  let g = 0; const flags = new Set();
  for (const e of weighed) {
    if (e.scope === 'plant' && e.plantIds.includes(p.id)) {
      g += e.payload.weightG / e.plantIds.length;
      if (e.plantIds.length > 1) flags.add('split evenly');
    } else if (e.scope === 'planting' && e.plantingId === p.plantingId) {
      g += e.payload.weightG / Math.max(1, livePlantCount(plantings.get(p.plantingId), e.occurredOn).n);
      flags.add('averaged across the planting');
    }
  }
  return { g, flags: [...flags] };
}

// Per variety and per season. Weight is summed per planting FIRST, then divided by that
// planting's plant count, so a planting with many harvests does not inflate the denominator.
function yieldBy(keyFn) {
  const perPlanting = new Map();
  for (const e of weighed) if (e.plantingId)
    perPlanting.set(e.plantingId, (perPlanting.get(e.plantingId) ?? 0) + e.payload.weightG);
  const groups = new Map();
  for (const [id, g] of perPlanting) {
    const L = plantings.get(id); if (!L) continue;                 // reported as "planting deleted"
    const ps = plantsOf(L.id);                                       // every plant it ever had
    const k = keyFn(L), c = ps.length ? { n: ps.length, basis: 'numbered plants' } : { n: L.count, basis: 'stated count' };
    const s = groups.get(k) ?? { g: 0, plants: 0, plantings: 0, bases: new Set() };
    s.g += g; s.plants += c.n; s.plantings += 1; s.bases.add(c.basis); groups.set(k, s);
  }
  return groups; // show g, g per plant, n plantings, n plants and the denominator basis
}
yieldBy((L) => L.cropId + '|' + L.variety.trim().toLowerCase());   // variety
yieldBy((L) => seasonOf(L));                                        // season
// Per bed uses the event's recorded spaceId (where it was harvested), not the planting's bedId:
groupSum(weighed, (e) => e.spaceId ?? 'not recorded', (e) => e.payload.weightG);
```

### 12.5 Days to first flower, first fruit, first harvest

```js
function firstOf(L, p, kind) {
  const ev = (p ? plantTimeline(p) : eventsByPlanting.get(L.id) ?? []).filter(live);
  const pick = {
    flower: [(e) => e.type === 'flowering' && e.payload.phase === 'first',
             (e) => e.type === 'flowering' || e.stageObserved === 'Flowering'],
    fruit:  [(e) => e.type === 'fruiting' && ['fruit_set', 'first_ripe'].includes(e.payload.phase),
             (e) => e.type === 'fruiting' || e.stageObserved === 'Fruiting'],
    harvest:[(e) => e.type === 'harvest', () => false],
  }[kind];
  const exact = ev.filter(pick[0]).sort(order)[0];
  const loose = exact ? null : ev.filter(pick[1]).sort(order)[0];
  const hit = exact ?? loose; if (!hit) return null;
  const a = anchor(L, p, defaultBasis(L));
  return { days: daysBetween(a.day, hit.occurredOn), label: exact ? 'first' : 'first recorded',
           startBasis: a.basis, yourEstimate: kind === 'harvest' ? [L.harvestMin, L.harvestMax] : null };
}
```

`harvestMin`/`harvestMax` are shown beside the observed number as "your estimate", never as a
target the plant missed.

### 12.6 Compare varieties, beds and soil recipes

- Varieties: group plantings by `(cropId, lower(trim(variety)))`; per group show median g per plant
  (12.4), median days to first harvest (12.5), health cases per planting (12.8) and `n`.
- Beds: the same, grouped by the harvest event's `spaceId`.
- Soil recipes: group by `mixId` (not by name, so two recipes with the same name stay apart). Display
  name: the saved recipe's name, else the built-in `DB.recipes` name, else the planting's `mixName`
  snapshot.

```js
const recipeName = (L) => recipes.get(L.mixId)?.name ?? DB.recipes.find((r) => r.id === L.mixId)?.name ?? L.mixName ?? 'No mix recorded';
```

### 12.7 Recurring pest and disease problems

```js
const obs = E.filter((e) => ['pest_observation', 'disease_observation'].includes(e.type) && e.payloadStatus !== 'legacy-text');
const key = (e) => e.payload.code ?? e.payload.symptomCodes?.[0] ??
  ((e.payload.label ?? e.payload.symptomLabel ?? '').trim().toLowerCase() || 'unlabelled');
const byProblem = groupBy(obs, (e) => key(e) + '|' + (e.spaceId ?? 'garden'));
const recurring = [...byProblem].filter(([, es]) =>
  new Set(es.map((e) => e.plantingId ? seasonOf(plantings.get(e.plantingId)) : e.occurredOn.slice(0, 4))).size >= 2);
// For each: first date seen per season, months seen (e.occurredOn.slice(5, 7)), max severity, n.
```

Legacy `Pest scouting` notes are not keyed (their text is not parsed); the result says how many were
left out.

### 12.8 Health cases and "did the treatment help"

```js
const cases = groupBy(E.filter((e) => e.healthCaseId), (e) => e.healthCaseId);
function treatmentEffect(t, windowDays = [3, 21]) {           // the window is owner-adjustable
  const sev = (e) => e?.payload?.severity ?? null;
  const maxOrNull = (xs) => { const v = xs.filter((x) => x != null); return v.length ? Math.max(...v) : null; };
  const targets = (t.payload.targetObservationIds ?? []).map(byId).filter(Boolean);
  const before = maxOrNull(targets.map(sev));
  const linked = (t.payload.outcome?.followUpObservationIds ?? []).map(byId).filter(Boolean);
  const fallback = (cases.get(t.healthCaseId) ?? [])
    .filter((e) => /_observation$/.test(e.type) && daysBetween(t.occurredOn, e.occurredOn) >= windowDays[0]
                   && daysBetween(t.occurredOn, e.occurredOn) <= windowDays[1]).sort(order)[0];
  const after = linked.length ? maxOrNull(linked.map(sev)) : sev(fallback);
  return {
    ownerSaid: t.payload.outcome?.result ?? 'no outcome recorded',
    before,
    after,
    afterBasis: linked.length ? 'follow-ups you linked' : fallback ? `first observation ${windowDays[0]}-${windowDays[1]} days later` : 'no follow-up recorded',
  };
}
```

A missing follow-up is shown as "no follow-up recorded", never as "worked". Results are listed per
product and method with `n`; no causal claim is made.

A case is **open** when it has no treatment with `outcome.result: 'resolved'`, no observation with
`progression: 'resolved'`, and no observation with severity 1 in the last 14 days. Shown as a badge on
the planting card (memoised per planting, recomputed when one of its events changes).

### 12.9 Inputs ledger and bed history

- Inputs per bed and season: watering amounts converted to litres, plus fertilization events listed
  with verbatim product, dose and `calcInputs`, with the arithmetic shown. Nutrient totals only from
  owner-entered `labelNPK` and amounts, with the formula displayed.
- Bed history across years: plantings with `bedId === S`, transplant events into or out of `S`,
  `state_change` events with `field: 'bedId'` involving `S` (labelled "assignment changed in a form")
  and space-scope events on `S`, merged and sorted. Archived spaces keep all of it.

### 12.10 Data quality

- Records to complete: `legacy-text` harvests, feedings and pest notes ("Complete this record"), and
  harvests with no planting ("Link to a planting"). Both are normal edits that bump `rev`.
- Photos without a planting (dangling `plantingId`), with "Link to a planting".
- Conflict copies, quarantined records, review lists from older app copies.

## 13. Non-goals, and what the schema must not pretend to know

Not in v2:

- No sync, accounts, server or cloud storage. The fields in section 9 only make them possible.
- No multi-garden UI (the field exists; the UI shows one garden).
- No field-level merge; record-level last-writer-wins plus conflict copies.
- No storage of original full-resolution photos, EXIF blocks or GPS.
- No event-sourced replay or edit log; corrections are in-place edits that bump `rev`.
- No reformatting of `index.html` in the same change as the storage work (`AGENTS.md`).

What the schema must not pretend to know:

- **Planned is not observed.** `Planting.date`, `leadWeeks`, `harvestMin` and `harvestMax` are plan
  inputs. They never fill an observed date, a "days to" result or a `state_change` event.
- **No dates for v1 status.** v1 recorded that a planting was `planted`, not when. Migration creates
  no `state_change`, `sowing` or `transplant` events.
- **No capture time for v1 photos.** Their `createdAt` is a save time: `capturedAt` is `null` and
  `occurredAtSource` is `save-time`. A photo stage of `Flowering` is an observation, not a
  first-flowering milestone.
- **No numbers from free text.** Weights, pH, EC, doses and pest names written in v1 notes stay text
  (`legacy-text`) until the owner enters them.
- **No individuals from counts.** Plant records exist only when the owner creates them.
- **No diagnoses.** Symptoms, suspected causes and confirmations are separate fields with a
  confidence. Code lists are grouping tags with no facts attached.
- **Severity is the owner's scale**, explained in the UI, not a standard.
- **No nutrient facts.** NPK is stored as printed and used only in visible arithmetic.
- **The zone is a label.** Nothing derives planting dates, frost dates or maturity from it.
- **No invented creation times.** v1 records have `createdAt: null`; v1 journal entries have
  `recordedAt: null`.
- **No invented measurement method.** Migrated heights are `aggregate: 'unspecified'`.
- **Seasons are the owner's.** `Garden.seasons` is never pre-filled with Brownsville claims.
- **Reference crops** without a cited source keep `source: null` and `windows: []` (the static test
  enforces this); custom crop timings are labelled as the owner's.
- **No yield predictions** and no "treatment worked" without an owner-recorded outcome or a
  follow-up observation.

## 14. Open questions

1. Season boundaries for Brownsville's fall, spring and summer: will the owner define
   `Garden.seasons`, or should analytics default to calendar years?
2. Should garden-scope events appear in individual plant timelines by default, or only behind the
   toggle (current design)?
3. When the owner numbers an existing planting, should the UI offer to re-attribute earlier
   planting-scope events to specific plants? That rewrites history (a `rev` bump plus an audit note);
   the design keeps them at planting scope.
4. Should a transplant update `Planting.bedId` automatically? The design asks each time.
5. Should the pest and symptom code lists be fixed or owner-editable? The draft lists need owner
   review either way.
6. Is a 1 to 5 severity scale enough, or are percent-of-leaf-area estimates wanted for some problems?
7. Should "Number these plants" be suggested for small counts (for example up to 12 tomatoes or
   peppers), and never for direct-sown crops such as carrots?
8. Should the soil-mix draft sync between devices later, or stay per device (current default)?
9. For later sync: is record-level last-writer-wins with conflict copies acceptable, or is
   field-level merge wanted for plantings and spaces?
10. Are multiple gardens (for example a community plot) needed soon?
11. **(verify)** Does iOS deliver EXIF `DateTimeOriginal` to a web page for camera captures and for
    library picks? If not, should `File.lastModified` be stored as a clearly labelled, unreliable
    `capturedAtHint`?
12. Should a planting that ended in failure get a visible marker on the v1 planting card? (The
    design records it as `state_change.endReason: 'failed'` and keeps `status: 'done'`.)
