# GardenForge Mobile

Version 1.9.1-local-windows-dev • Brownsville, Texas • November 19, 2026

Open **Journal → Plant Lookup** to search the offline catalog by common name, scientific name or variety. Look under **Tomato → Named varieties** for four included cultivar cards. **Add a plant or variety** saves any seed-packet or nursery name and notes, even offline. Use **Add to My Garden** to record a planting. **My plants** finds individual plantings, including variety names already on older records. Open the site online once to cache the offline app.

**Home → Crops in a local window today** opens a searchable list for the current date in Brownsville. The total counts crop and variety entries separately. Direct variety dates and your saved dates take priority. A linked variety can also use its parent crop’s outdoor window, labeled with the crop name. Entries with only general season or hardiness information stay in All plants. You can also reach the list from **Plant Lookup → In window today**. Database varieties still save as the parent crop and cultivar in garden format 1.

**Valley picks** shows 33 named cultivars listed by Rio Grande Valley extension guides. Their cards link the local recommendation and the source for the individual trait. The catalog also includes eight herb and pollinator profiles and names from Wikidata for 40 species. Some records overlap across sources.

The offline cultivar index adds 3,079 OpenPlantDB records across 82 parent entries. OpenPlantDB supplies general light, relative water demand, spacing and season where available. These fields do not determine a local planting date or watering reminder. Opening a database variety and choosing **Add to My Garden** stores the parent crop and the packet name in the existing planting format. Only lookup displays the large cultivar index.

**Data sources.** OpenPlantDB and Wikidata publish their structured data under CC0. The GardenForge import pins OpenPlantDB commit `91cbe3b86c6f5fddb6b8cab6d9505c630f36ea7f`; the plant card links to its source. To reproduce it, download the CSV at the pinned URL from `python tools/import-openplantdb.py --help`, then run `python tools/import-openplantdb.py /path/to/plants.csv`. The importer validates the SHA-256 digest, uses named cultivars that can be mapped to a planner crop, and gives priority to curated entries. Wikidata name links point to individual records and revisions. Extension care summaries and Valley recommendations link to the relevant source on each card.

**Load AI care guide** optionally sends the selected plant name, scientific name and cultivar to the configured Haiku model. The app shows a possible API charge before the request. Search, selection, saving a variety, and reopening a downloaded guide are free of model calls. Included entries use a common guide cache. Custom names use a private account cache on the Site. The browser keeps completed guides for offline reading while its storage is available.

From a completed scan, **Add to My Garden** links it to an existing planting or creates a plant in a selected growing space. Open that planting under **Plant Lookup → My plants** to see its dated scans.


## Using one garden on iPhone and desktop

In the private ChatGPT Site, sign in with the same ChatGPT account on both devices. On the iPhone, open Home in the browser or app that already holds your garden. Tap **Connect this device** under **Garden sync** and wait for **Last synced**. Then connect the desktop. GardenForge combines records from both devices, including progress photos, scan photos, results and drafts. Existing garden JSON remains version 1.

Return to Home after editing. While Home is open, the app checks on entry, on reconnect, and every minute. **Sync now** runs it immediately. Offline edits stay on the device. Different records merge automatically. Edit conflicts and edit-versus-delete conflicts display both versions for you to choose. Tabs sharing a browser should use the latest local copy. A garden saved on another website or in a downloaded HTML file can be moved into the Site with the existing garden, progress-photo and scan backup controls.


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

## AI Plant Scan development / ChatGPT Site

This branch adds a six-photo plant scan, native iPhone camera/gallery controls, offline drafts,
local scan history, Haiku analysis, optional Sonnet review, and optional Pl@ntNet identification
and disease checks. The original garden application and schema v1 backups remain supported.
The new ChatGPT Site uses a server Worker; ordinary static hosting still runs the garden tools,
but does not enable cloud analysis. No keys are embedded in this repository.

See [AI Plant Scan setup, data transfer and limitations](docs/AI-PLANT-SCAN.md).
Progress photos now have a separate archive in Backup & restore on this branch; JSON backups
and portable HTML still exclude them. Existing photos at another address cannot be accessed by
this Site. Keep the old installation until a separately authorized transfer is verified.

### Garden layout builder

Open **Garden → Layout builder → Start a layout**. Enter the overall dimensions in feet and choose a rectangle, an L shape with a measured cutout, or a blank canvas. Join rectangular ground sections to trace a more complex footprint. Place existing beds or create measured planters, raised beds, in-ground beds and seed trays. Drag blocks on the drawing or enter exact coordinates under **Edit measurements**. Choose **Crops by space** for a closer view of one bed.

A draft stays on the device where you started it. **Review & apply → Apply layout** saves the map and the planting assignments to your existing garden. When account sync is connected, open Home to sync the applied layout. Removing a block from the drawing keeps its existing garden records.

### AI Camera

Open **AI Camera** in the phone’s bottom bar or desktop sidebar. **Plant scan** opens the scanner and **Scan history** opens saved drafts and care guides. The section can also be opened directly at `#camera`. Older `#scan` links still work.

Choose **Take photo** or **Choose from gallery** and add up to six pictures of one plant. Tap a thumbnail to inspect, replace, or remove it. **Scan options** controls the optional second opinion and specialist requests. The cost note beside Analyze updates with your selections.

A completed scan opens its **Care guide**. Tap **Watering** for moisture checks and an editable journal reminder. **Compare IDs** shows the available visual evidence and suggests a follow-up shot. Adding photos to a completed scan creates a separate draft and preserves the original result. Older results remain readable offline.
