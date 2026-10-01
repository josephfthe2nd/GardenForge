# Test record — GardenForge Mobile 1.1.0

## Completed

114 automated interface / logic checks passed with no JavaScript runtime errors.

- All six main views and the year calendar checked at 320, 360, 375, 390, 430, 768, 1024 and 1440 px. No full-page horizontal overflow was detected.
- Nine forms / menu screens checked at 320, 390 and 430 px. No horizontal dialog overflow was detected.
- Touch plus/minus recipe controls, unit conversions, seed-template isolation and live bed geometry.
- Saving a recipe, restoring saved state, saving a growing space, successive crop planning and task checkoff.
- Month/year controls, mobile calendar presentation, JSON and calendar export payloads.
- Version 1 backup acceptance and invalid-backup rejection.
- Portable HTML export/import, including escaping an adversarial closing-script string in notes.
- Storage-denied fallback remains usable and shows a clear backup warning.
- JavaScript and service-worker syntax checks.
- Service-worker unit tests: install, scope-specific cache cleanup, offline navigation, cache refresh, external-link exclusion and update activation.

## Important limitations

Browser tests used Chromium touchscreen/viewport emulation, not an actual iPhone or Safari/WebKit. The environment blocks file and localhost navigation; rendering used set_content. Save/reload logic used an explicit localStorage test fixture, not an end-to-end browser storage persistence test. Storage-denial behavior was also tested without that fixture.

Exports were validated by inspecting generated payloads. The operating-system Share sheet and Files app were not exercised on a real phone.

Offline-worker behavior was unit-tested with mocked Fetch/Cache APIs. HTTPS deployment, real service-worker registration, cache persistence and Home Screen installation have not been verified on a hosted site. There is no live site in this delivery.

The crop reference data is unchanged from the original app; this was a mobile interface update, not an agronomic data audit.
