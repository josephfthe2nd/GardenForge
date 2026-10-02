# GardenForge roadmap

Ordered by what protects the owner's records first, then by what unlocks the features asked for
(individual plants, photo growth journal, harvest and plant-health records, analytics, multi-device
sync, AI scanning). Finding ids refer to `docs/AUDIT-2026-10.md`. Each phase is meant to ship as its own
reviewed pull request, tested at 320 px and 390 px, with saved data from every earlier version still
loading. Nothing below changes `main` until it is merged.

## Phase 0 (this branch): audit, safety net, small fixes

Done: confirmed gallery loop and blob-URL leak; boot recovery for unreadable data (F02, F11, F12); in-dialog
messages (F04); IndexedDB abort handling (F17); escaping and validation gaps (F05, F13); blank-field
fallback (F07); import limit and collection cap (F61); version alignment (F59); `tools/` test harness;
`AGENTS.md`; these documents.

## Phase 1: make the owner's records safe (before any schema work)

1. **Backup and restore that includes photos** (F01, F06, F36; feature 3). Export a single archive
   (structured JSON plus a photo manifest and the JPEG bytes, delivered through the share sheet), import
   that merges photos by id, a visible "N photos, M MB" line in Backup & restore, `navigator.storage.persist()`
   requested on first photo, a `lastBackupAt` field (optional, default null, no schema break) with a
   reminder after a chosen interval, a photo-library view that lists orphans with delete or reassign, and a
   planting-delete confirm that names its photos. Size: large. This is the first PR.
2. **Visible failure states** (F09, F60, F52). A persistent phone-visible banner when a save fails, with
   one-tap export; update banner sticky and announced; offline badge checks the cache.
3. **Service-worker hardening** (F18, F28, F40). Cache only the shell HTML for navigations, add a 3–4 s
   network timeout with cache fallback, try `./` before `./index.html` offline, test with the SW registered.
4. **CI and characterization tests** (F30, F31). A GitHub Actions workflow running `tools/` tests on every
   pull request; tests for portable export opened from `file://`, export/import round trip, each dialog
   form, and a static check that every `data-action` has a handler.
5. **Security headers** (F27). A hash-based Content-Security-Policy plus `nosniff`, `Referrer-Policy`,
   `Permissions-Policy` and frame denial in `vercel.json`, with a `tools/` script that regenerates the script
   hash and a test that it matches; verify on a Vercel preview and an iPhone before merging.
6. **Small UX and accessibility fixes** that need no schema change: F14 (landscape breakpoint), F15 (draft
   undo), F16 (task check-off keys), F19 (focus after re-render), F23 (windowless herbs in Month view), F32
   (visible ingredient cautions), F33/F34 (contrast and 10 px text), F38/F48/F84 (copy and data labels),
   F42, F43, F46, F47, F50, F51, F53, F54, F55, F56, F62, F65, F66, F67, F68, F69, F70, F71.

## Phase 2: data model v2 and the photo journal the owner asked for

Design: `docs/DATA-MODEL.md`; migration: `docs/MIGRATION.md`. Garden → growing space → planting →
individual plant → events, with photos as content-addressed assets attached to events. Ships in steps,
each behind a non-destructive migration and a backup prompt:

1. Storage layer and migration scaffolding: v2 stores created beside v1, dual-read, verification counts,
   rollback (nothing deleted). Fix the IndexedDB connection handling first (F26).
2. Individual plants and events (feature 1): numbered plants per planting, event timeline per plant and per
   planting, measurement, note, watering, fertilization, transplant, flowering, fruiting, pruning events.
3. Photo journal rebuilt on photo assets (feature 2; F08, F10, F24, F35, F57, F72): capture date from EXIF
   or the file date with an editable "Date taken", thumbnails, lazy loading, timeline and full-size view,
   edit metadata, Day 1 / Day 30 / Day 60 comparison, duplicate detection by content hash.
4. Harvest events and running yield per plant, variety, bed and season (feature 4).
5. Plant-health journal: pest and disease observations with severity, treatments linked to observations,
   outcome follow-up (feature 5).
6. Analytics views (feature 7): growth over time, yield over time, days to flowering/fruit/harvest,
   comparisons by variety, bed and soil recipe, recurring problems by month. Charts are drawn from events;
   nothing is estimated that the data does not contain.

## Phase 3: multi-device sync

Decision document: `docs/SYNC-ARCHITECTURE.md`. The owner chose a **self-hosted PocketBase** server behind a
free tunnel (section 0 there); the server scaffold, installer, tunnel configuration, backup scripts and an
integration test live under `server/`, written from the official documentation and not yet executed. Order:

1. Owner installs the server on their machine with `server/install.sh`, runs the smoke test and the integration
   test, and confirms the tunnel hostname works from the phone on cellular.
2. Client phase 0: local change log and export v2 with no cloud (testable offline).
3. Client phase 1: sign-in and metadata sync against the owner's server.
4. Client phase 2: photo sync with content-addressed dedupe.
5. Then the server-side AI endpoint (Phase 4).

No paid infrastructure is involved; Supabase remains the documented fallback.

## Phase 4: AI camera and scanning (feature 6)

Design: `docs/AI-CAMERA.md`. A PocketBase hook on the owner's server, `POST /api/gf/ai/analyze` with
`GET /api/gf/ai/status`, behind the same tunnel allowlist and owner sign-in as sync. One check sends 1 to 5
photos (guided: 3 photos of different parts of the plant, chosen per mode) plus a visible summary of the
planting's records, and returns a structured AI estimate with stated uncertainty, no products or rates, and a
pointer to AgriLife Extension. The provider key lives only in `/etc/gardenforge/ai.env` on the server; the
monthly spend cap and per-minute limit are enforced on the server in `gf_ai_usage`. Needs the server verified
and the client sign-in (Phase 3 client phase 1); it does not need metadata or photo sync. Photos taken for AI
checks are not backed up until Phase 1 item 1 ships.

## Parallel track: horticultural data review (owner, with the source documents)

F37, F41, F78–F83: read the cited 2020 AgriLife Lower Rio Grande Valley guide row by row (start with corn's
fall window and the beet window, then melon, cucumber, squash, pumpkin, watermelon, the five single-value
maturity figures and the cauliflower correction), record a per-crop `verifiedOn` and `sourceRef`, confirm
basil's 60–90 days or set it to null, reword the 40 % compost flag as an app threshold, confirm the zone
label by ZIP on the USDA map. None of these values should be changed from memory or from search snippets.

## Parallel track: incremental modularization (no rewrite)

Order (F77, F03, F21, F22, F29, F45, F75): CI and characterization tests first; one format-only prettier
commit with relaxed test regexes and a `.git-blame-ignore-revs` entry; reference data to its own
pretty-printed classic script with one crop per line; CSS to its own file; then the script into three or
four classic-script files sharing one global scope, with `exportPortable` inlining local assets and the
service worker treating same-origin scripts and styles network-first. ES modules and a bundler are not
justified at this size and would break the single-file portable export.
