# Plant care dashboard

New scans return a care guide alongside the existing identification and visual health assessment.
The mobile dashboard shows watering, light, soil/drainage, and growing zones; expandable sections
cover pH, feeding, seasonal care, health findings, sources, and growing context. Results appear
before the capture controls. A moisture-check action opens the existing journal form for review.

## Data and evidence

The server requests qualitative care estimates in the same Claude call. No new provider or API
key is required. Output token allowance is raised from 2000 to 3500; actual provider use remains
billed normally. Pl@ntNet stays optional and does not provide this complete care guide.

The browser explicitly sends the profile zone, growing location selection, and the app's
Brownsville context. The profile zone is not independently verified; the dashboard links to
https://planthardiness.ars.usda.gov/ and does not treat a zone as a planting calendar or heat rating.
No weather or soil measurements are inferred. Watering intervals are tentative moisture-check
guidance, never an instruction to water regardless of conditions.

Reviewed species facts live in server/care.mjs, checked 2026-11-17 against these primary pages:

- https://plants.ces.ncsu.edu/plants/solanum-lycopersicum/
- https://plants.ces.ncsu.edu/plants/ocimum-basilicum/
- https://plants.ces.ncsu.edu/plants/capsicum-annuum/
- https://plants.ces.ncsu.edu/plants/quercus-virginiana/
- https://plants.ces.ncsu.edu/plants/aloe-vera/

Profiles match exact scientific names (plus explicit synonyms), only when identification is not
flagged uncertain and model confidence is at least 0.75. Confidence remains uncalibrated. Every
reference fact applies conditionally to that proposed identification. No common-name fuzzy
matching. Unmatched species get AI care estimates, with zone and pH explicitly unverified.
Model-supplied zone, pH, URLs, and provenance are discarded; reviewed facts override estimates.
Tomato/pepper entries emphasize frost-sensitive seasonal growing instead of misleading perennial
hardiness ranges. More verified species can be added independently.

Moisture-first guidance background:
https://extension.umd.edu/resource/watering-indoor-plants
https://extension.umn.edu/garden-and-home/yard-and-garden/gardening-in-minnesota/fertilizing-and-watering-container-plants

## Compatibility and validation

Existing garden/photo formats, tools, mobile layouts, exports and offline shell are preserved.
Care snapshots travel with scan exports/imports and are readable offline. Legacy scans display
a clear explanation that care requires a new analysis, retaining the old scan in history.
Source URLs in imported care records are restricted to the reviewed profiles; all text is escaped.

Automated browser coverage: 320, 390 and 1440 px; care cards, expandable details, 44px controls,
no horizontal overflow, growing-context request, journal reminder, history, archive round trip,
offline reload, and legacy results. Server coverage includes unknown/uncertain species, malformed
care, model-injected provenance, and context validation. Provider responses are mocked.
The managed visual-preview launcher cannot serve this custom Worker configuration (no dev script
or static.directory). Real iPhone/Safari and live provider output remain unverified.
