# AI Plant Scan and ChatGPT Site development

This branch extends the existing GardenForge PWA from upstream commit
`a0143a5c9682d175227a71253c53cb1972e3ee0d`. It does not replace the app or merge to main.
The ChatGPT Site is a new, private deployment; the existing Vercel deployment is unchanged.

## Use

Open **AI Plant Scan** from Home, the desktop sidebar, or the phone's More menu.
Take photos one at a time with the native iPhone camera, or select multiple gallery images.
Up to six images of the same plant can be previewed, removed or retaken. Desktop file selection
works through the same gallery control. Images are resized to at most 1536 pixels and re-encoded
as JPEG (at most 1 MB each), discarding EXIF/GPS. If the browser cannot decode a HEIC original,
choose/export a JPEG instead. The OS owns the permission prompt; a camera denial does not
block gallery use. Actual iPhone Safari/Home Screen camera and Photos behavior remains a device test.

Photos, notes and completed results are stored in the separate IndexedDB database
`gardenforge.scans.v1`, object store `scans`, version 1. Draft capture, browsing history and
export/import work offline after the shell has cached. Analysis requires internet and is
never automatically retried or uploaded in the background. Provider failures retain the draft.
Scan changes invalidate an earlier analysis so stale results cannot describe new photos or notes.
Cloud results are suggestions with stated uncertainty, not diagnoses or proof of food safety.

## Runtime secrets and activation

In this new Site's runtime settings, configure **ANTHROPIC_API_KEY** as a secret and redeploy
this saved version. Do not paste a key into the app, source, backup, GitHub, or a PR. Optionally set
**PLANTNET_API_KEY** as a secret to activate both Pl@ntNet switches. No API keys were supplied
or configured during implementation. The UI explicitly disables cloud analysis until configured.

Defaults verified against Anthropic's model documentation on 2026-11-17:

- `ANTHROPIC_HAIKU_MODEL=claude-haiku-5-5`
- `ANTHROPIC_SONNET_MODEL=claude-sonnet-5-5`

These server environment overrides allow a model ID compatible with the owner's account.
Haiku receives all images and only the chosen planting label, stage and notes. If its confidence
is below 0.75, it flags uncertainty, or health is uncertain, an enabled Sonnet review uses the same
images/context. There is at most one Sonnet call per scan. Both model usages are retained. If
Sonnet fails, the Haiku result is explicitly marked as still needing review.

The optional Pl@ntNet identification and disease endpoints receive the first five images (their
published limit). Both are opt-in for each draft. Disease coverage is limited; empty results do
not establish health. Their results are displayed separately with provider attribution and also
provided to Claude as untrusted supporting evidence. No arbitrary MCP endpoint or client-supplied
provider URL is accepted. Fixed server adapters implement the requested specialist integrations
without granting a third-party tool access to the rest of the garden.

`/api/scan` requires the Sites authenticated-user header, a matching Origin and JSON. It validates
body size, image count/type/base64, context and model response structure. Provider timeouts and
errors return sanitized messages; API responses are no-store, and the service worker ignores them.
Secrets are only read by `server/scan.mjs`. Private Site access is enforced by Sites.
The in-memory burst guard is **per isolate**, not a durable account quota or monthly spend cap.
Configure an Anthropic workspace spending limit before enabling a key. A distributed quota and
idempotent paid-request ledger would be needed before broadening this personal Site's audience.
No live provider call was made during development; mocked tests verify wiring, not model accuracy.

## Data compatibility and moving to a new address

The existing `gardenforge.brownsville.v1` storage key, schemaVersion 1 JSON, portable HTML,
reference data and `gardenforge.photos.v1` database are retained. No migration runs and no
existing records are uploaded, seeded into the Site, rewritten into a new schema or deleted.
The new scan database is independent of planned garden schema v2.

A new address has different browser storage. Existing records do **not** appear there automatically.
Export garden JSON from the current app and import it into the new Site, using the existing
confirmed-replace import. Keep the original app and backups until transfer is verified.

Legacy JSON and portable HTML **do not contain progress photos**. This branch adds separate
Export / Import progress photos controls under Backup & restore. The photo archive uses
`format: gardenforge-progress-photos`, version 1, and includes all stored photos, including orphans.
Import validates the complete archive, then adds missing IDs in one transaction; existing photos
are not overwritten. Import the matching garden JSON to connect photos to their original plantings.
Exports are capped at 50 MB of image bytes; imports at 75 MB of JSON for device-memory safety.

**The new Site cannot read photos held at the old address.** The old deployed build currently lacks
photo export. These new controls must run at the old origin to export those stored photos, which
requires a separately authorized update of that deployment, or another explicitly authorized
same-origin transfer operation. This branch does not change that deployment. Do not clear or
uninstall the old app. This limitation cannot be solved by copying the GitHub repository.

Scan archives (`format: gardenforge-scans`, version 1) include scan photos and results separately.
Imports merge by ID and keep existing scans. They do not alter garden JSON or progress photos.
Archives are private, unencrypted files; browser storage is device-local, not a cross-device backup.

## Build and review

The Vercel static application retains its no-root-package.json layout. The separate command
`node tools/build-site.mjs` embeds the exact app, manifest, icons and service worker into a
Cloudflare Worker at `dist/server/index.js`, alongside the server-only scan route. No frontend
framework rewrite, third-party browser script or external asset dependency was introduced.
The tracked `.openai/hosting.json` identifies only the new Site.

Run `npm ci --prefix tools`, `cd tools && npx playwright install chromium`, then
`npm test --prefix tools` from the repository root. Build with `node tools/build-site.mjs`.
No test uses a real API key or charges a provider. Review the diff against the upstream SHA,
server boundary, storage failure handling, photo archive and real-device checklist before merging.

## Primary documentation

- Models: https://platform.claude.com/docs/en/models/overview
- Vision and Messages image blocks: https://platform.claude.com/docs/en/build-with-claude/vision
- Pl@ntNet identification: https://my.plantnet.org/doc/api/identify
- Pl@ntNet disease API: https://my.plantnet.org/doc/api/diseases
