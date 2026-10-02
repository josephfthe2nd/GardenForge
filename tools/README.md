# GardenForge test harness

Development-only tooling. It lives in `tools/` instead of the repository root on purpose: the app
deploys to Vercel as plain static files, and a root `package.json` would make Vercel look for a
build step. Nothing in this folder ships (see `.vercelignore`).

## Run

```bash
cd tools
npm install
npx playwright install chromium   # once per machine; skip if PLAYWRIGHT_BROWSERS_PATH is already set up
npm test                          # static checks + browser tests
npm run test:static               # no browser needed
npm run serve                     # serve the repo root on a random localhost port for manual testing
```

## What is covered

- `tests/static.test.mjs` — the inline app script and `sw.js` parse; reference data is valid and
  unsourced crops carry no planting windows; manifest icons exist at their declared sizes; every
  asset the service worker pre-caches exists; the three version strings agree.
- `tests/app.test.mjs` — boots the real `index.html` at 320 px and 390 px with a saved garden,
  visits every tab with no errors or horizontal overflow; checks the planting-window and soil-mix
  arithmetic through `window.GardenForge.calculations`; checks `validateState`; saves a progress
  photo end to end, guards against the former gallery refresh loop and blob URL leak, and checks
  the error path for an undecodable image.
- `tests/worker.test.mjs` — activates an updated worker over an existing controller at root and
  subdirectory scopes, removes both historical cache namespaces without touching sibling scopes,
  and checks offline shell/assets plus saved garden and photo persistence. Unrelated caches with
  the same URLs cannot supply stale responses when the current cache is missing an entry.

Tests run in Chromium. They catch logic and layout regressions; iOS/WebKit-specific behaviour
still needs a real iPhone (see `TESTING.md` and `docs/AUDIT-2026-10.md`).
