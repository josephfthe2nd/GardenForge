// Shared helpers for the GardenForge test harness (node:test + Playwright).
// The app has no build step, so tests run against the real index.html served from the repo root.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STORAGE_KEY = 'gardenforge.brownsville.v1';
export const PHOTO_DB = 'gardenforge.photos.v1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.css': 'text/css',
};

/** Serve the repository root on a random localhost port. Resolves to { server, url }. */
export function startServer({ handleRequest } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (handleRequest?.(req, res)) return;
      let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (p === '/') p = '/index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** A small but realistic saved garden: one bed, two plantings, one journal entry. */
export const fixture = JSON.parse(fs.readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));

/** The inline application script from index.html (the only <script> tag without attributes). */
export function extractInlineScript(html) {
  const m = html.match(/<script>\n?([\s\S]*?)<\/script>/);
  if (!m) throw new Error('inline <script> not found in index.html');
  return m[1];
}

/** Phone-like context options (iPhone 12/13/14 logical size). */
export const phoneContext = (width = 390) => ({
  viewport: { width, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
});

/**
 * Open the app with a saved state already in localStorage. Also installs counters on
 * URL.createObjectURL / revokeObjectURL and indexedDB.open so tests can detect leaks and loops.
 */
export async function openApp(page, baseUrl, { state = fixture, hash = '#overview' } = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
  });
  await page.addInitScript(
    ({ key, json }) => {
      localStorage.setItem(key, json);
      window.__probe = { createObjectURL: 0, revokeObjectURL: 0, idbOpen: 0, liveUrls: {} };
      const co = URL.createObjectURL.bind(URL);
      const ro = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (b) => {
        window.__probe.createObjectURL++;
        const u = co(b);
        window.__probe.liveUrls[u] = 1;
        return u;
      };
      URL.revokeObjectURL = (u) => {
        window.__probe.revokeObjectURL++;
        delete window.__probe.liveUrls[u];
        return ro(u);
      };
      const io = indexedDB.open.bind(indexedDB);
      indexedDB.open = (...a) => {
        window.__probe.idbOpen++;
        return io(...a);
      };
    },
    { key: STORAGE_KEY, json: JSON.stringify(state) },
  );
  await page.goto(baseUrl + '/' + hash);
  await page.waitForSelector('#view h1');
  return errors;
}

export const probe = (page) => page.evaluate(() => ({ ...window.__probe }));

/** Navigate with the phone tab bar (the desktop sidebar is hidden at phone widths). */
export async function tapTab(page, id) {
  await page.click(`#mobile-nav [data-nav="${id}"]`);
  await page.waitForSelector('#view h1');
}

/** Generate a solid-colour PNG inside the page and return it as a Buffer for setInputFiles. */
export async function makePng(page, width = 800, height = 600, color = '#3a7d44') {
  const dataUrl = await page.evaluate(
    ({ width, height, color }) => {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const g = c.getContext('2d');
      g.fillStyle = color;
      g.fillRect(0, 0, width, height);
      return c.toDataURL('image/png');
    },
    { width, height, color },
  );
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

export const toastText = (page) => page.evaluate(() => document.getElementById('toast').textContent);

/** Horizontal overflow in CSS px. Uses clientWidth: under mobile emulation innerWidth stretches to the content and hides overflow. */
export const overflowPx = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Number of blob: URLs created and not yet revoked. */
export const liveBlobUrls = (page) => page.evaluate(() => Object.keys(window.__probe.liveUrls).length);
