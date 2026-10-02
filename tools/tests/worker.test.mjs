// Exercise real worker registration, update activation and Cache Storage in Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startServer, phoneContext, fixture, STORAGE_KEY, PHOTO_DB, makePng } from './helpers.mjs';

const version = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/const APP_VERSION='([^']+)'/)[1];
const numericVersion = version.split('-')[0];
// An existing, controlling worker keeps updates waiting until the app requests activation.
const oldWorker = `
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => event.respondWith(fetch(event.request)));
`;
let browser, srv, useLegacyWorker, networkAvailable = true;
before(async () => {
  srv = await startServer({ handleRequest(req, res) {
    // Chromium's worker fetches can outlive the page's offline emulation; fail the
    // server connection too so a successful reload must actually use Cache Storage.
    if (!networkAvailable) { req.destroy(); return true; }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.endsWith('/seed.html') || (useLegacyWorker && pathname.endsWith('/sw.js'))) {
      const script = pathname.endsWith('/sw.js');
      res.writeHead(200, { 'Content-Type': script ? 'text/javascript' : 'text/html', 'Cache-Control': 'no-store' });
      res.end(script ? oldWorker : '<!doctype html><title>Worker setup</title>');
      return true;
    }
    // Serve the same static app at a subdirectory to exercise relative worker URLs.
    if (pathname.startsWith('/garden/')) req.url = req.url.slice('/garden'.length);
    return false;
  } });
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  srv?.server.close();
});

function cacheNames(scope) {
  const encoded = encodeURIComponent(scope);
  return {
    current: `gardenforge-mobile-${encoded}-v${numericVersion}`,
    obsolete: [
      `gardenforge-mobile-${encoded}-v1.1.0`,
      `gardenforge-v1.2-growth-journal${encoded}-v1.1.0`,
      `gardenforge-v1.2-growth-journal${encoded}-v1.2.1`,
    ],
    preserved: [
      'weather-widget-v1',
      `gardenforge-mobile-${encodeURIComponent('/sibling/')}-v1.1.0`,
      `gardenforge-v1.2-growth-journal${encodeURIComponent('/sibling/')}-v1.2.1`,
      // This scope shares a literal prefix with the current scope's cache names.
      `gardenforge-mobile-${encodeURIComponent(scope + '-v1/')}-v1.1.0`,
    ],
  };
}

async function seed(page, base, names) {
  await page.goto(base + 'seed.html');
  await page.evaluate(async ({ base, names, key, garden }) => {
    localStorage.setItem(key, JSON.stringify(garden));
    // Create unrelated caches first: a broad caches.match would return these stale responses.
    for (const name of [...names.preserved, ...names.obsolete]) {
      const cache = await caches.open(name);
      await cache.put(base + 'index.html', new Response('<!doctype html><title>STALE SHELL</title>', { headers: { 'Content-Type': 'text/html' } }));
      await cache.put(base + 'manifest.webmanifest', new Response('{"name":"STALE MANIFEST"}', { headers: { 'Content-Type': 'application/manifest+json' } }));
    }
  }, { base, names, key: STORAGE_KEY, garden: { ...fixture, settings: { ...fixture.settings, name: 'Offline upgrade garden' } } });
}

async function waitForController(page) {
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
}

for (const [scope, width] of [['/', 390], ['/garden/', 320]]) {
  test(`worker upgrade cleans only its historical caches and preserves the garden offline at ${scope}`, async () => {
    const ctx = await browser.newContext(phoneContext(width));
    try {
      useLegacyWorker = true;
      const base = srv.url + scope;
      const names = cacheNames(scope);
      const page = await ctx.newPage();
      await seed(page, base, names);
      await page.evaluate(async () => { await navigator.serviceWorker.register('./sw.js'); await navigator.serviceWorker.ready; });
      await waitForController(page);
      await page.goto(base + '#garden');
      await page.waitForSelector('#view h1');
      const saved = await page.evaluate(() => ({ ...window.GardenForge.getState(), updatedAt: '' }));
      assert.equal(saved.settings.name, 'Offline upgrade garden');

      // Keep a real photo record across activation and offline reload as well as localStorage.
      const png = (await makePng(page, 32, 32)).toString('base64');
      await page.evaluate(async ({ name, png }) => {
        const db = await new Promise((resolve, reject) => {
          const q = indexedDB.open(name, 1);
          q.onupgradeneeded = () => {
            const store = q.result.createObjectStore('photos', { keyPath: 'id' });
            store.createIndex('planId', 'planId');
            store.createIndex('createdAt', 'createdAt');
          };
          q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error);
        });
        const blob = new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))], { type: 'image/png' });
        await new Promise((resolve, reject) => {
          const tx = db.transaction('photos', 'readwrite');
          tx.objectStore('photos').put({ id: 'upgrade-photo', planId: 'plant_1', createdAt: '2026-10-01T12:00:00Z', note: 'Keep this photo', blob });
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
        });
        db.close();
      }, { name: PHOTO_DB, png });

      useLegacyWorker = false;
      await page.evaluate(async () => { const reg = await navigator.serviceWorker.ready; await reg.update(); });
      await page.waitForSelector('[data-action="apply-update"]');
      await Promise.all([
        page.waitForEvent('domcontentloaded'),
        page.click('[data-action="apply-update"]'),
      ]);
      await waitForController(page);
      await page.waitForSelector('#view h1');
      const keys = await page.evaluate(() => caches.keys());
      assert.deepEqual(keys.sort(), [...names.preserved, names.current].sort(), 'activation removes both historical namespaces, preserves unrelated apps/scopes and the current cache');

      networkAvailable = false;
      await ctx.setOffline(true);
      const response = await page.reload();
      assert.equal(response.status(), 200);
      await page.waitForSelector('#view h1');
      assert.equal(await page.evaluate(() => window.GardenForge.version), version, 'offline reload runs the new shell');
      assert.deepEqual(await page.evaluate(() => ({ ...window.GardenForge.getState(), updatedAt: '' })), saved, 'worker activation and reload preserve all saved garden records');
      await page.waitForSelector('[data-growth-gallery="plant_1"] article.growth-photo');
      assert.match(await page.textContent('[data-growth-gallery="plant_1"]'), /Keep this photo/);
      const manifestName = await page.evaluate(async () => (await (await fetch('./manifest.webmanifest')).json()).name);
      assert.match(manifestName, /^GardenForge/, 'offline shell assets come from the current cache, despite stale identical URLs elsewhere');
    } finally {
      networkAvailable = true;
      await ctx.close();
    }
  });
}

test('missing current shell and assets never fall back to unrelated cached responses', async () => {
  const ctx = await browser.newContext(phoneContext(320));
  try {
    useLegacyWorker = false;
    const base = srv.url + '/';
    const names = cacheNames('/');
    const page = await ctx.newPage();
    await seed(page, base, names);
    await page.goto(base);
    await page.waitForSelector('#view h1');
    await waitForController(page);
    await page.evaluate(async ({ base, current }) => {
      const cache = await caches.open(current);
      for (const path of ['', 'index.html', 'manifest.webmanifest']) await cache.delete(base + path);
    }, { base, current: names.current });
    networkAvailable = false;
    await ctx.setOffline(true);
    assert.equal(await page.evaluate(async () => {
      try { await fetch('./manifest.webmanifest'); return true; } catch { return false; }
    }), false, 'a missing current asset fails offline instead of returning a stale unrelated asset');
    const response = await page.goto(base + '?cache-missing=1');
    assert.equal(response.status(), 503, 'a missing current shell must not serve another cache');
    assert.match(await page.textContent('body'), /Reconnect once to load GardenForge/);
    assert.deepEqual((await page.evaluate(() => caches.keys())).sort(), [...names.preserved, names.current].sort());
  } finally {
    networkAvailable = true;
    await ctx.close();
  }
});
