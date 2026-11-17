# Scan response recovery — 1.3.3

The November 17 iPhone report showed a photo preview followed by an incomplete-analysis
error. Worker logs showed completed POST requests returning HTTP 502. The uploaded photo
reached the analysis path; raw provider output was not logged, so the specific invalid field
in those requests remains unknown. The screenshot's older subtitle also indicates an older
open page. Do not clear site storage to update it.

## Changes

- Both Claude models now receive a constrained JSON response schema through
  `output_config.format`. Required scan fields and qualitative care fields are explicit.
  Unsupported schema length/range constraints are described in the schema and enforced by
  the existing server validation. Scientific names may be an empty string when unknown.
- Invalid JSON, missing/invalid scan fields, and truncated Haiku responses can use the
  already-enabled Sonnet review option. There are at most two Claude calls per scan.
  Opting out prevents the second call. Refusals, provider failures, and connection failures
  do not trigger this format-recovery path. A valid but uncertain Haiku result remains
  available if its Sonnet review fails.
- Only harmless health enum casing is normalized. Invalid confidence values and invented
  health categories remain rejected. Failed-format usage is retained in successful recovery
  records. Diagnostics record field names and allowlisted stop reasons, never response
  text, photographs, notes, or keys.
- The scan screen shows its app version and offers Refresh app. Refresh and applying a
  waiting update save the scan and garden first, stop on storage failure, and wait for any
  active import or scan. Refresh requests a fresh navigation without deleting device data.
  The config response identifies newer server versions. The update banner stays visible.
- Analysis errors no longer append a misleading storage-warning message unless a result
  actually arrived and its subsequent save failed.

No garden or scan schema migration is involved. Original features, IndexedDB stores,
offline assets, portable export, and existing records remain compatible. Original Vercel
deployment and GitHub main are outside this change. This branch stacks on the gallery fix.

## Verification

The complete regression suite passed 58/58 tests, including 320px/390px layout, gallery
selection, failed retake preservation, offline upgrades, legacy data, scan export/import,
structured requests, malformed response recovery, review opt-out, refusal handling, and
draft restoration after refresh. After the final diagnostic allowlist change and added
server/frontend version guard, all 19 server/build tests passed (59 distinct tests total).

Provider requests are mocked in these tests. A fresh live provider scan and native iPhone
camera/gallery interaction still require device verification; Chromium is not iOS WebKit.
The fix prevents the observed class of formatting failures but does not prove plant
identification accuracy. JSON constraints and local validation can still yield a useful
retry error on refusal, truncation, or an invalid semantic value.

API reference: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
