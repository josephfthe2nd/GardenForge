// Browser tests against the real index.html at phone widths (Chromium via Playwright).
// Chromium is not WebKit: these tests catch logic and layout regressions, not iOS-only behaviour.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer, openApp, phoneContext, tapTab, probe, makePng, fixture, STORAGE_KEY, overflowPx, liveBlobUrls } from './helpers.mjs';

let browser, srv;
before(async () => {
  srv = await startServer();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  srv?.server.close();
});

const TABS = ['overview', 'mix', 'calendar', 'garden', 'tasks'];
const clone = (x) => JSON.parse(JSON.stringify(x));

for (const width of [320, 390]) {
  test(`boots with saved data at ${width}px, every page renders without errors or horizontal overflow`, async () => {
    const ctx = await browser.newContext(phoneContext(width));
    const page = await ctx.newPage();
    const errors = await openApp(page, srv.url);
    assert.match(await page.textContent('#view h1'), /garden/i, 'overview hero heading should render');
    for (const tab of TABS) {
      await tapTab(page, tab);
      assert.ok((await overflowPx(page)) <= 0, `${tab} overflows horizontally at ${width}px`);
    }
    // Reference & backup has no tab on the phone bar; it is reached from the More menu or by hash.
    await page.evaluate(() => { location.hash = '#reference'; });
    await page.waitForFunction(() => document.querySelector('#view h1')?.textContent.includes('Reference'));
    assert.ok((await overflowPx(page)) <= 0, `reference overflows horizontally at ${width}px`);
    await tapTab(page, 'garden');
    assert.ok((await page.textContent('#view')).includes('Bed A'));
    assert.ok((await page.textContent('#view')).includes('Tomato'));
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('date-window calculations handle regional windows that cross New Year', async () => {
  const ctx = await browser.newContext(phoneContext());
  const page = await ctx.newPage();
  await openApp(page, srv.url);
  const r = await page.evaluate(() => {
    const DB = JSON.parse(document.getElementById('reference-data').textContent);
    const beet = DB.crops.find((c) => c.id === 'beet'); // windows [["09-01","02-14"]]
    const tomato = DB.crops.find((c) => c.id === 'tomato'); // [["02-14","03-20"],["07-15","08-15"]]
    const basil = DB.crops.find((c) => c.id === 'basil'); // no regional window
    const C = window.GardenForge.calculations;
    return {
      beetJan: C.inWindow(beet, '2026-01-15'), beetJune: C.inWindow(beet, '2026-06-01'), beetNext: C.nextDate(beet, '2026-06-01'),
      beetFeb: C.monthMatch(beet, '2026-02'), beetMar: C.monthMatch(beet, '2026-03'), tomatoNextFromApril: C.nextDate(tomato, '2026-04-01'),
      basilUnknown: C.inWindow(basil, '2026-04-01'), leap: C.addDays('2024-02-28', 1), nonLeap: C.addDays('2026-02-28', 1), yearEnd: C.addDays('2026-12-31', 1),
    };
  });
  assert.equal(r.beetJan, true);
  assert.equal(r.beetJune, false);
  assert.equal(r.beetNext, '2026-09-01');
  assert.equal(r.beetFeb, true);
  assert.equal(r.beetMar, false);
  assert.equal(r.tomatoNextFromApril, '2026-07-15');
  assert.equal(r.basilUnknown, null, 'crops without a regional window must report null, not false');
  assert.equal(r.leap, '2024-02-29');
  assert.equal(r.nonLeap, '2026-03-01');
  assert.equal(r.yearEnd, '2027-01-01');
  await ctx.close();
});

test('numeric parsing: an empty field means "use the fallback", not zero', async () => {
  const ctx = await browser.newContext(phoneContext());
  const page = await ctx.newPage();
  await openApp(page, srv.url);
  const r = await page.evaluate(() => {
    const n = window.GardenForge.calculations.n;
    return { blank: n('', 6), nul: n(null, 6), undef: n(undefined, 14), text: n('abc', 6), num: n('3', 6), zero: n('0', 6), blankDefault: n('') };
  });
  assert.deepEqual(r, { blank: 6, nul: 6, undef: 14, text: 6, num: 3, zero: 0, blankDefault: 0 });
  await ctx.close();
});

test('mix arithmetic scales parts to a batch and tracks carried-in amendments', async () => {
  const ctx = await browser.newContext(phoneContext());
  const page = await ctx.newPage();
  await openApp(page, srv.url);
  const r = await page.evaluate(() => {
    const C = window.GardenForge.calculations;
    const seed = C.mixNumbers({ target: 10, unit: 'gal', parts: { peat: 50, perlite: 25, vermiculite: 25 }, rates: {}, enrichedBio: null, enrichedZeo: null });
    const unknown = C.mixNumbers({ target: 1, unit: 'L', parts: { peat: 50, enriched: 50 }, rates: {}, enrichedBio: null, enrichedZeo: null });
    const undef = C.mixNumbers({ target: 1, unit: 'L', parts: { peat: 50, enriched: 50 }, rates: {} });
    const known = C.mixNumbers({ target: 1, unit: 'L', parts: { peat: 50, enriched: 50, biochar: 0 }, rates: {}, enrichedBio: 10, enrichedZeo: 4 });
    return { L: seed.L, peat: seed.fr('peat'), comp: seed.comp, unknownKnown: unknown.carriedKnown, undefKnown: undef.carriedKnown, knownKnown: known.carriedKnown, bio: known.bio, zeo: known.zeo, comp2: known.comp };
  });
  assert.ok(Math.abs(r.L - 37.854) < 0.01, `10 US gal should be ~37.854 L, got ${r.L}`);
  assert.equal(r.peat, 0.5);
  assert.equal(r.comp, 0, 'seed mix has no compost-derived fraction');
  assert.equal(r.unknownKnown, false, 'amended compost with unknown fractions must flag carried-in as unknown');
  assert.equal(r.undefKnown, false, 'a missing fraction is unknown too, not a known 0%');
  assert.equal(r.knownKnown, true);
  assert.ok(Math.abs(r.bio - 0.05) < 1e-9, 'half the mix is compost carrying 10% biochar → 5% biochar overall');
  assert.ok(Math.abs(r.zeo - 0.02) < 1e-9);
  assert.equal(r.comp2, 0.5);
  await ctx.close();
});

test('validateState repairs trivially missing fields, normalises maturity ranges and rejects malformed backups', async () => {
  const ctx = await browser.newContext(phoneContext());
  const page = await ctx.newPage();
  await openApp(page, srv.url);
  const r = await page.evaluate((fx) => {
    const v = window.GardenForge.validateState;
    const tryIt = (s) => { try { return { ok: true, s: v(s) }; } catch (e) { return { ok: false, msg: e.message }; } };
    const c = (x) => JSON.parse(JSON.stringify(x));
    const badPlan = c(fx); badPlan.plans[0].count = 0;
    const badDate = c(fx); badDate.logs[0].date = '2026-13-40';
    const noMax = c(fx); noMax.plans[0].harvestMax = null;
    const onlyMax = c(fx); onlyMax.plans[0].harvestMin = null; onlyMax.plans[0].harvestMax = 70;
    const reversed = c(fx); reversed.plans[0].harvestMin = 100; reversed.plans[0].harvestMax = 50;
    const noRates = c(fx); delete noRates.draft.rates;
    const recipeNoRates = c(fx); recipeNoRates.recipes = [{ id: 'mix_1', name: 'R', type: 'Container', parts: { peat: 1 }, target: 5 }];
    const badCrop = c(fx); badCrop.customCrops = [{ id: 'customcrop_1', name: 'X', group: 'Flower', windows: [], method: 'bogus', harvestMin: null, harvestMax: null, source: null }];
    const xssCrop = c(fx); xssCrop.customCrops = [{ id: 'customcrop_2', name: 'X', group: 'Flower', windows: [], method: 'direct', harvestMin: '<img src=x onerror=alert(1)>', harvestMax: null, source: null }];
    const numName = c(fx); numName.customCrops = [{ id: 'customcrop_3', name: 123, group: 'Flower', windows: [], method: 'direct', harvestMin: null, harvestMax: null, source: null }];
    return {
      good: tryIt(fx).ok, v2: tryIt({ ...fx, schemaVersion: 2 }).ok, badPlan: tryIt(badPlan).ok, badDate: tryIt(badDate).ok, empty: tryIt(null).ok,
      completedNull: tryIt({ ...fx, completed: null }), noRates: tryIt(noRates), recipeNoRates: tryIt(recipeNoRates),
      noMax: tryIt(noMax), onlyMax: tryIt(onlyMax), reversed: tryIt(reversed).ok, badCrop: tryIt(badCrop).ok, xssCrop: tryIt(xssCrop).ok, numName: tryIt(numName).ok,
    };
  }, fixture);
  assert.equal(r.good, true);
  assert.equal(r.v2, false, 'a future schema version is unreadable to this build');
  assert.equal(r.badPlan, false);
  assert.equal(r.badDate, false);
  assert.equal(r.empty, false);
  assert.equal(r.completedNull.ok, true, 'a missing check-off map is repaired, not fatal');
  assert.deepEqual(r.completedNull.s.completed, {});
  assert.equal(r.noRates.ok, true);
  assert.deepEqual(r.noRates.s.draft.rates, {});
  assert.equal(r.recipeNoRates.ok, true);
  assert.deepEqual(r.recipeNoRates.s.recipes[0].rates, {}, 'saved recipes get the same repair');
  assert.equal(r.noMax.s.plans[0].harvestMax, 90, 'missing upper maturity defaults to the lower value');
  assert.equal(r.onlyMax.s.plans[0].harvestMin, 70);
  assert.equal(r.reversed, false, 'upper maturity below lower is rejected');
  assert.equal(r.badCrop, false, 'custom crop with an unknown starting method is rejected');
  assert.equal(r.xssCrop, false, 'non-numeric maturity on a custom crop is rejected');
  assert.equal(r.numName, false, 'numeric custom crop name is rejected');
  await ctx.close();
});

test('messages raised while a dialog is open appear inside the dialog, not behind it', async () => {
  const ctx = await browser.newContext(phoneContext());
  const page = await ctx.newPage();
  await openApp(page, srv.url, { hash: '#garden' });
  await page.click('[data-action="plan-edit"][data-id="plant_1"]');
  await page.waitForSelector('#plan-form');
  // A reversed maturity range passes native validation and is rejected by the app's own check.
  await page.fill('#plan-min', '100');
  await page.fill('#plan-max', '50');
  await page.click('#plan-form button[type="submit"]');
  await page.waitForSelector('#dialog .dialog-alert');
  const alert = await page.evaluate(() => {
    const el = document.querySelector('#dialog .dialog-alert');
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { text: el.textContent, role: el.getAttribute('role'), visible: r.width > 0 && r.height > 0, hitInside: !!hit && (hit === el || el.contains(hit)) };
  });
  assert.match(alert.text, /upper maturity value/);
  assert.equal(alert.role, 'alert');
  assert.equal(alert.visible, true);
  assert.equal(alert.hitInside, true, 'the message must be the element actually under the pointer, not covered by the dialog');
  assert.equal(await page.evaluate(() => document.getElementById('dialog').open), true);
  await ctx.close();
});

test('progress photo: saves into the gallery, does not re-render in a loop, releases blob URLs on navigation', async () => {
  const ctx = await browser.newContext(phoneContext());
  const page = await ctx.newPage();
  const errors = await openApp(page, srv.url, { hash: '#garden' });
  await page.click('[data-action="growth-photo"][data-id="plant_1"]');
  await page.waitForSelector('#growth-photo-form');
  const unlabeled = await page.evaluate(() =>
    [...document.querySelectorAll('#growth-photo-form input:not([type=hidden]), #growth-photo-form select, #growth-photo-form textarea')]
      .filter((el) => !el.labels?.length && !el.getAttribute('aria-label')).map((el) => el.name || el.id));
  assert.deepEqual(unlabeled, []);
  assert.equal(await page.getAttribute('#growth-image', 'capture'), null, 'no capture attribute: iOS must offer the photo library as well as the camera');
  await page.setInputFiles('#growth-image', { name: 'tomato.png', mimeType: 'image/png', buffer: await makePng(page, 1200, 900) });
  await page.fill('#growth-height', '12.5');
  await page.selectOption('#growth-stage', 'Vegetative growth');
  await page.click('#growth-photo-form button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('saved'));
  await page.waitForSelector('[data-growth-gallery="plant_1"] article.growth-photo');
  assert.equal((await page.$$('[data-growth-gallery="plant_1"] article.growth-photo')).length, 1);
  assert.ok((await page.textContent('[data-growth-gallery="plant_1"]')).includes('12.5 in tall'));
  const a = await probe(page);
  await page.waitForTimeout(1500);
  const b = await probe(page);
  assert.equal(b.idbOpen - a.idbOpen, 0, 'galleries must not keep reopening IndexedDB while idle');
  assert.equal(b.createObjectURL - a.createObjectURL, 0, 'galleries must not keep creating blob URLs while idle');
  assert.equal(await liveBlobUrls(page), 1, 'exactly the displayed image holds a blob URL');
  await tapTab(page, 'overview');
  assert.equal(await liveBlobUrls(page), 0, 'leaving the Garden page must release every blob URL');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('progress photo: an undecodable image reports an error inside the dialog and keeps the form usable', async () => {
  const ctx = await browser.newContext(phoneContext());
  const page = await ctx.newPage();
  await openApp(page, srv.url, { hash: '#garden' });
  await page.click('[data-action="growth-photo"][data-id="plant_2"]');
  await page.waitForSelector('#growth-photo-form');
  await page.setInputFiles('#growth-image', { name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('this is not a jpeg') });
  await page.click('#growth-photo-form button[type="submit"]');
  await page.waitForSelector('#dialog .dialog-alert');
  assert.match(await page.textContent('#dialog .dialog-alert'), /could not be saved/);
  assert.equal(await page.evaluate(() => document.getElementById('dialog').open), true, 'dialog stays open so the user can pick another photo');
  assert.equal(await page.evaluate(() => document.querySelector('#growth-photo-form button[type="submit"]').disabled), false);
  assert.equal(await page.$$eval('[data-growth-gallery="plant_2"] article.growth-photo', (a) => a.length), 0);
  await ctx.close();
});

test('progress photo: a storage-quota failure during the IndexedDB write is reported, not hung', async () => {
  const ctx = await browser.newContext(phoneContext());
  const page = await ctx.newPage();
  await openApp(page, srv.url, { hash: '#garden' });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Storage.overrideQuotaForOrigin', { origin: srv.url, quotaSize: 50 * 1024 });
  await page.click('[data-action="growth-photo"][data-id="plant_2"]');
  await page.waitForSelector('#growth-photo-form');
  // Random pixels compress badly, so the stored JPEG is far larger than the 50 KB quota.
  const noisy = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1600; c.height = 1200; const g = c.getContext('2d');
    const img = g.createImageData(1600, 1200); for (let i = 0; i < img.data.length; i++) img.data[i] = (Math.random() * 256) | 0;
    g.putImageData(img, 0, 0); return c.toDataURL('image/png');
  });
  await page.setInputFiles('#growth-image', { name: 'noisy.png', mimeType: 'image/png', buffer: Buffer.from(noisy.split(',')[1], 'base64') });
  await page.click('#growth-photo-form button[type="submit"]');
  await page.waitForSelector('#dialog .dialog-alert', { timeout: 15000 });
  assert.match(await page.textContent('#dialog .dialog-alert'), /storage space|could not be saved/);
  assert.equal(await page.evaluate(() => document.querySelector('#growth-photo-form button[type="submit"]').disabled), false, 'submit is re-enabled after the failure');
  await ctx.close();
});

test('unreadable saved data is preserved in a recovery slot, listed on later launches, and deletable', async () => {
  const ctx = await browser.newContext(phoneContext());
  const page = await ctx.newPage();
  // A backup from a future schema version is the realistic "unreadable" case for this build.
  const future = { ...fixture, schemaVersion: 2 };
  const seeded = JSON.stringify(future);
  const errors = await openApp(page, srv.url, { state: future });
  assert.match(await page.textContent('#boot-warning'), /could not be read/);
  const ls = await page.evaluate((key) => {
    const out = { original: localStorage.getItem(key), slots: [] };
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(key + '.unreadable.')) out.slots.push(localStorage.getItem(k)); }
    return out;
  }, STORAGE_KEY);
  assert.equal(ls.original, seeded, 'the main slot must not be overwritten at boot');
  assert.deepEqual(ls.slots, [seeded], 'exactly one verbatim recovery copy');
  assert.ok(await page.$('[data-action="download-unreadable"]'), 'download button offered');
  await page.reload();
  await page.waitForSelector('#view h1');
  const slotCount = () => page.evaluate((key) => [...Array(localStorage.length).keys()].map((i) => localStorage.key(i)).filter((k) => k.startsWith(key + '.unreadable.')).length, STORAGE_KEY);
  assert.equal(await slotCount(), 1, 'one recovery copy, however many times the app is opened');
  // Once the main slot holds a readable garden again, the copy must still be visible and manageable.
  // (A second page: the first page's init script would re-seed the unreadable data on every reload.)
  const page2 = await ctx.newPage();
  await page2.goto(srv.url + '/#overview');
  await page2.waitForSelector('#view h1');
  await page2.evaluate(([key, fx]) => localStorage.setItem(key, fx), [STORAGE_KEY, JSON.stringify(fixture)]);
  await page2.reload();
  await page2.waitForSelector('#view h1');
  assert.match(await page2.textContent('#boot-warning'), /recovery cop/);
  assert.ok(await page2.$('[data-action="download-recovery"]'));
  page2.once('dialog', (d) => d.accept());
  await page2.click('[data-action="delete-recovery"]');
  await page2.waitForFunction(() => document.getElementById('boot-warning').hidden);
  assert.equal(await page2.evaluate((key) => [...Array(localStorage.length).keys()].map((i) => localStorage.key(i)).filter((k) => k.startsWith(key + '.unreadable.')).length, STORAGE_KEY), 0);
  await tapTab(page, 'garden');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a long-lived garden with thousands of journal entries loads, exports and re-imports', async () => {
  const ctx = await browser.newContext(phoneContext());
  const page = await ctx.newPage();
  const big = clone(fixture);
  big.logs = Array.from({ length: 8000 }, (_, i) => ({ id: 'log_' + i, kind: 'Observation', title: 'Note ' + i, date: '2026-09-01', reviewDate: '', bedId: '', notes: 'n'.repeat(200) }));
  const errors = await openApp(page, srv.url, { state: big, hash: '#tasks' });
  assert.equal(await page.evaluate(() => document.getElementById('boot-warning').hidden), true, 'no boot warning');
  assert.equal(await page.evaluate(() => window.GardenForge.getState().logs.length), 8000);
  // The same pretty-printed JSON the app exports must import again.
  const exported = Buffer.from(await page.evaluate(() => JSON.stringify(window.GardenForge.getState(), null, 2)));
  assert.ok(exported.length > 3_000_000, `export is ${exported.length} bytes, which the old 3 MB import limit rejected`);
  page.once('dialog', (d) => d.accept());
  await page.setInputFiles('#import-file', { name: 'backup.json', mimeType: 'application/json', buffer: exported });
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('imported'), { timeout: 20000 });
  assert.equal(await page.evaluate(() => window.GardenForge.getState().logs.length), 8000);
  assert.deepEqual(errors, []);
  await ctx.close();
});
