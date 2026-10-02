# Working on GardenForge

Guidance for anyone changing this repository, human or AI (Claude Code, Codex, others). Read this
first, then `docs/AUDIT-2026-10.md` and `docs/ROADMAP.md`.

## What GardenForge is

A local-first, offline-capable garden-management PWA for one household in Brownsville, Texas
(Lower Rio Grande Valley). The owner uses it mainly as an iPhone Home Screen web app and wants the
same garden on a PC. It deploys to Vercel as plain static files: no build step, no server, no
accounts yet. Soil-mix builder, regional planting calendar, growing spaces, plantings, tasks,
journal, and a timestamped plant-progress photo journal.

## Repository layout

| Path | What it is |
| --- | --- |
| `index.html` | The whole app: base CSS (`<style>`), phone overrides (`<style id="mobile-styles">`), reference data (`<script id="reference-data">`), an `embedded-state` slot (always `null` in the shipped file; filled only by "portable HTML" exports), then one inline `<script>` of about 97 KB. Most statements sit one per line; a few lines are 19,000 characters long. |
| `sw.js` | Service worker. Network-first for navigations with an offline fallback to the cached `index.html`; cache-first for the listed shell assets. The `CACHE` name must change on every release or installed phones keep the old shell assets. |
| `manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png` | Install metadata and icons. |
| `vercel.json` | Cache headers only. `/sw.js` is `no-store`, `/index.html` is `no-cache`. |
| `.vercelignore` | Keeps `docs/`, `tools/` and the Markdown files out of the deployed site. |
| `tools/` | Development-only test harness (node:test + Playwright). See `tools/README.md`. |
| `docs/` | Audit, roadmap, sync architecture decision, data model, migration plan. |
| `README.md`, `TESTING.md` | User-facing install notes and the original test record. |

The repository root deliberately has **no `package.json`**. Vercel treats a root `package.json` as a
signal to look for a build command and an output directory; the app is served as-is. If a build
step is ever introduced, set `framework`, `buildCommand` and `outputDirectory` explicitly in
`vercel.json` and verify a preview deployment before merging.

## Where the data lives (schema v1)

- `localStorage["gardenforge.brownsville.v1"]`: one JSON document, `schemaVersion: 1`, validated
  by `validateState()` on load and on import. Collections: `settings`, `draft` (soil mix being
  edited), `recipes`, `beds`, `plans` (these are *plantings*; their ids start with `plant_` for
  historical reasons), `logs` (journal), `completed` (task check-offs), `customCrops`,
  `customIngredients`. Only a single top-level `updatedAt` exists.
- IndexedDB `gardenforge.photos.v1`, store `photos`: `{id, planId, createdAt, height, heightUnit,
  stage, note, blob}` where `blob` is a re-encoded JPEG (max 1600 px). **Photos are not included in
  the JSON backup, the portable HTML export or the copy/paste backup.** This is the top item in the
  roadmap; do not describe backups as complete until it is fixed.
- The reference data (crops, planting windows, sources, ingredients, amendments, recipe templates)
  is static and lives in `index.html`; user records never go there.

Any schema change needs: a `schemaVersion` bump, a migration that leaves the previous data readable
until the owner confirms, `validateState` still accepting older backups, and an entry in
`docs/MIGRATION.md`. Never ship a destructive migration.

## Rules that are not negotiable

1. iPhone is the primary device. Test at 320 px and 390 px wide. Touch targets stay at least 44 px.
2. Offline must keep working. Anything the shell needs offline goes in the service worker's
   `ASSETS` list.
3. Never break saved data. Never remove a feature to make the code tidier.
4. Horticulture: do not invent planting dates, maturity days, rates or zone claims. Reference crops
   without a cited source must have `source: null` and `windows: []` (the static test enforces this).
   UI copy must say whether a number is sourced or an estimate.
5. Soil and fertilizer math stays transparent: show the arithmetic, never an unexplained recommendation.
6. No analytics, trackers, third-party scripts, or API keys in client code. Future AI features go
   through a server-side endpoint that holds the key.
7. Every control has a programmatic label; destructive actions confirm first.
8. Branch for every change; never commit to `main` directly. Open a pull request whose description
   covers: what changed, why, data/schema changes, migration behaviour, tests performed, known
   limitations, and what a reviewer should inspect.

## Editing `index.html` safely

- The app script is one `<script>`; some lines are very long. Make edits with exact-string
  replacement (an editor find/replace, or a short Python script that asserts each target string
  occurs exactly once), never by retyping a line.
- After any edit run `cd tools && npm test`. The static test extracts the inline script and parses
  it; the browser tests boot the real page.
- Rendering is `render()` → `#view.innerHTML`. Event handling is delegated from `document` by
  `data-action`, `data-nav`, `data-change`, `data-mix`, `data-part`, `data-rate`, `data-task`,
  `data-plan-status`, `data-setting` attributes. There are two click listeners that both read
  `data-action`; keep new actions in `handleAction()` unless they need `await`.
- Every interpolation of user data into a template goes through `h()`. Numbers and dates are only
  interpolated raw when `validateState` has already proven their type.
- Reformatting the whole file (prettier) is a proposed but not yet taken step; see the roadmap.
  Do not reformat in the same commit as a behaviour change.

## Releasing

1. Bump `APP_VERSION` in `index.html`, the `CACHE` suffix in `sw.js`, and the version line in
   `README.md`. The static test fails if they disagree.
2. `cd tools && npm test`.
3. Merge to `main`; Vercel deploys. Installed phones see the "update ready" banner on their next
   online load.

## Running the tests

```bash
cd tools && npm install && npx playwright install chromium && npm test
```
