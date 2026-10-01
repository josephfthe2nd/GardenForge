// Static checks that need no browser: syntax of the inline app script and the service worker,
// manifest/icon consistency, service-worker asset list, and version-string consistency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, extractInlineScript } from './helpers.mjs';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const html = read('index.html');
const sw = read('sw.js');

test('inline application script and sw.js parse as JavaScript', () => {
  const app = extractInlineScript(html);
  assert.ok(app.length > 50_000, 'inline script looks too short — extraction regex may be wrong');
  assert.doesNotThrow(() => new vm.Script(app, { filename: 'index.html#inline' }));
  assert.doesNotThrow(() => new vm.Script(sw, { filename: 'sw.js' }));
});

test('reference data and embedded state are valid JSON', () => {
  const ref = html.match(/<script id="reference-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(ref, 'reference-data script missing');
  const data = JSON.parse(ref[1]);
  assert.equal(data.version, 1);
  assert.ok(Array.isArray(data.crops) && data.crops.length > 30);
  for (const c of data.crops) {
    assert.ok(c.id && c.name && Array.isArray(c.windows), `crop ${c.id} malformed`);
    for (const [a, b] of c.windows) assert.match(a + b, /^\d{2}-\d{2}\d{2}-\d{2}$/, `crop ${c.id} window ${a}-${b}`);
    // Only crops that cite a source may carry planting windows; flowers/herbs without a regional source stay empty.
    if (!c.source) assert.equal(c.windows.length, 0, `${c.id} has planting windows but no source`);
  }
  const embedded = html.match(/<script id="embedded-state" type="application\/json">([\s\S]*?)<\/script>/);
  assert.equal(embedded[1].trim(), 'null', 'shipped index.html must not embed personal garden data');
});

function pngSize(file) {
  const buf = fs.readFileSync(path.join(ROOT, file));
  assert.equal(buf.toString('ascii', 1, 4), 'PNG', `${file} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('manifest icons exist and match their declared sizes', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) {
    const file = icon.src.replace(/^\.\//, '');
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.deepEqual(pngSize(file), { width: w, height: h }, `${file} size mismatch`);
  }
  assert.deepEqual(pngSize('apple-touch-icon.png'), { width: 180, height: 180 }, 'apple-touch-icon should be 180x180');
});

test('every asset the service worker pre-caches exists on disk', () => {
  const m = sw.match(/const ASSETS=\[([^\]]*)\]/);
  assert.ok(m, 'ASSETS list not found in sw.js');
  const assets = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
  for (const a of assets) {
    const file = a === './' ? 'index.html' : a.replace(/^\.\//, '');
    assert.ok(fs.existsSync(path.join(ROOT, file)), `sw.js pre-caches missing file ${a}`);
  }
});

test('version strings agree across index.html, sw.js and README', () => {
  const appVersion = html.match(/const APP_VERSION='([^']+)'/)?.[1];
  const cacheVersion = sw.match(/const CACHE=PREFIX\+'v([^']+)'/)?.[1];
  const readmeVersion = read('README.md').match(/^Version ([0-9][^\s•]*)/m)?.[1];
  assert.ok(appVersion && cacheVersion && readmeVersion, `could not read all versions: ${appVersion} / ${cacheVersion} / ${readmeVersion}`);
  const numeric = appVersion.split('-')[0];
  assert.equal(cacheVersion, numeric, 'sw.js CACHE version must match APP_VERSION so a release refreshes the offline cache');
  assert.equal(readmeVersion.split('-')[0], numeric, 'README version must match APP_VERSION');
});
