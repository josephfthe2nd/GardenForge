// `npm run serve` — serve the repo root for manual testing in a browser.
import { startServer } from './helpers.mjs';
const { url } = await startServer();
console.log(`GardenForge dev server: ${url}  (Ctrl+C to stop)`);
