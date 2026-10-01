# GardenForge Mobile

Version 1.2.1-audit-fixes • Brownsville, Texas • October 1, 2026

## Start here: iPhone use

The HTML download is the source app, not a published website. An iPhone attachment/file preview may display the document without running its controls. Changing the CSS cannot change that preview behavior.

Publish this directory on a static HTTPS host. No build command, framework, database, API key or application server is needed. `index.html` is the entry point. The accompanying Vercel configuration supplies basic cache headers. Deployment has not been performed by this delivery.

After publication:

1. Open the site's HTTPS address in Safari.
2. Open Share → Add to Home Screen.
3. Leave “Open as Web App” on when that option is shown, then tap Add.
4. Open GardenForge from its new icon. Use More → Phone setup to check the app status.

On Android, open the published site in Chrome and use Install app / Add to Home screen. The app can expose an install button when the browser offers the installation prompt.

Offline use requires a successful online load and a retained service-worker cache. External reference links need internet. Offline readiness is displayed in More / Phone setup; do not assume it before checking. No push alerts, live-weather checks or background synchronization are included.

## Mobile changes

- Fixed five-tab bottom navigation: Home, Mixes, Planting, Garden, Journal.
- Sources, setup and backup controls in the header's More menu.
- Safe-area padding, large touch controls, readable form inputs and single-column forms.
- Mix ingredients displayed as cards, with plus/minus parts controls and live batch quantities.
- Sticky batch summary, copyable ingredient lists and preserved separate fertilizer calculations.
- Native month/year dropdowns instead of relying on an input type that varies by mobile browser.
- Year-calendar cards with tappable month cells, instead of a wide table on phones.
- Full-screen phone forms; no automatic keyboard opening when a form is first shown.
- Share-sheet export when the browser supports file sharing; ordinary download and copy/paste alternatives.
- Home Screen manifest, icons and scoped offline service worker for the hosted version.

## Preserve your earlier garden

The storage key remains `gardenforge.brownsville.v1`; the backup schema is still version 1. Your original GardenForge JSON backups are compatible.

Export JSON from the original app, then use More → Backup & restore → Import a backup file in this version. Importing replaces this device's records only after confirmation. Copy/paste JSON is also available.

A different browser, address or separate Home Screen app may use a different storage area. Import a backup rather than assuming data will appear automatically. Save periodic backups to Files or another location you control. Browser storage is not permanent archival storage.

**Progress photos are not yet included in JSON backups, the portable HTML copy or the copy/paste backup.** They live only in this browser's IndexedDB. A backup that includes photos is the first item in `docs/ROADMAP.md`; until it ships, treat photos as unbacked-up.

A portable HTML export contains your private garden records. Do not publish that export as your public site. The supplied `index.html` starts with no personal beds, plans or journal entries.

## What stayed unchanged

- Eight editable soil templates and the ingredient palette from the previous app.
- 53 sourced vegetable/herb records (44 with Lower Rio Grande Valley planting windows, 9 herbs with no regional window entered) and 6 flower templates, plus the previous local sources. The regional rows still need a row-by-row check against the cited guide; see `docs/AUDIT-2026-10.md`.
- Custom flowers/crops, bed geometry, crop succession, journals and calendar-file export.
- Fertilizer rates start at zero; the app scales entered rates, not agronomic recommendations.
- The app still distinguishes mineral garden beds, containers and seed-starting media.
- No new crop dates, nutrient rates, zone claims or weather predictions were added in this mobile update.

## Files

`index.html` — complete app, reference data, styling and logic.
`manifest.webmanifest` — installation metadata.
`sw.js` — offline shell caching; no cloud storage of garden data.
`icon-192.png`, `icon-512.png`, `apple-touch-icon.png` — app icons.
`vercel.json` — optional Vercel cache/header configuration.
`.nojekyll` — allows plain-file publishing with GitHub Pages.
`TESTING.md` — the original verification record.
`AGENTS.md` — conventions for people and AI agents changing this repository.
`docs/` — audit, roadmap, sync architecture decision, data model and migration plan.
`tools/` — development-only test harness (`cd tools && npm install && npm test`); not deployed.
`.vercelignore` — keeps `docs/`, `tools/` and the Markdown files out of the deployed site.

To test on a desktop with Python, run `python -m http.server 8000` in this directory and open `http://localhost:8000`. This is local development only, not a live link accessible from your phone. Use HTTPS hosting for phone installation and offline-worker support.

## Installation references

Apple: https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios
MDN: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable

Garden reference sources remain in the app's Reference & backup section.
