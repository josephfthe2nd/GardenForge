// Browser tests against the real index.html at phone widths (Chromium via Playwright).
// Chromium is not WebKit: these tests catch logic and layout regressions, not iOS-only behaviour.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer, openApp, phoneContext, tapTab, probe, makePng, fixture, STORAGE_KEY } from './helpers.mjs';

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

for (const width of [320, 390]) {
  test(`boots with saved data at ${width}px, every tab renders without errors or horizontal overflow`, async () => {
    const ctx = await browser.newContext(phoneContext(width));
    const page = await ctx.newPage();
    const errors = await openApp(page, srv.url);
    assert.match(await page.textContent('#view h1'), /garden/i, 'overview hero heading should render');
    for (const tab of TABS) {
      await tapTab(page, tab);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${tab} overflows horizontally by ${overflow}px at ${width}px`);
    }
    // Saved records from the fixture are visible.
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
      beetJan: C.inWindow(beet, '2026-01-15'),
      beetJune: C.inWindow(beet, '2026-06-01'),
      beetNext: C.nextDate(beet, '2026-06-01'),
      beetFeb: C.monthMatch(beet, '2026-02'),
      beetMar: C.monthMatch(beet, '2026-03'),
      tomatoNextFromApril: C.nextDate(tomato, '2026-04-01'),
      basilUnknown: C.inWindow(basil, '2026-04-01'),
      leap: C.addDays('2024-02-28', 1),
      nonLeap: C.addDays('2026-02-28', 1),
      yearEnd: C.addDays('2026-12-31', 1),
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

test('mix arithmetic scales parts to a batch and tracks carried-in amendments', async () => {
  const ctx = await browser.newContext(phoneContext());
  const page = await ctx.newPage();
  await openApp(page, srv.url);
  const r = await page.evaluate(() => {
    const C = window.GardenForge.calculations;
    const seed = C.mixNumbers({ target: 10, unit: 'gal', parts: { peat: 50, perlite: 25, vermiculite: 25 }, rates: {}, enrichedBio: null, enrichedZeo: null });
    const unknown = C.mixNumbers({ target: 1, unit: 'L', parts: { peat: 50, enriched: 50 }, rates: {}, enrichedBio: null, enrichedZeo: null });
    const known = C.mixNumbers({ target: 1, unit: 'L', parts: { peat: 50, enriched: 50, biochar: 0 }, rates: {}, enrichedBio: 10, enrichedZeo: 4 });
    return { L: seed.L, peat: seed.fr('peat'), comp: seed.comp, unknownKnown: unknown.carriedKnown, knownKnown: known.carriedKnown, bio: known.bio, zeo: known.zeo, comp2: known.comp };
  });
  assert.ok(Math.abs(r.L - 37.854) < 0.01, `10 US gal should be ~37.854 L, got ${r.L}`);
  assert.equal(r.peat, 0.5);
  assert.equal(r.comp, 0, 'seed mix has no compost-derived fraction');
  assert.equal(r.unknownKnown, false, 'amended compost with unknown fractions must flag carried-in as unknown');
  assert.equal(r.knownKnown, true);
  assert.ok(Math.abs(r.bio - 0.05) < 1e-9, 'half the mix is compost carrying 10% biochar → 5% biochar overall');
  assert.ok(Math.abs(r.zeo - 0.02) < 1e-9);
  assert.equal(r.comp2, 0.5);
  await ctx.close();
});

test('validateState accepts the fixture and rejects malformed backups', async () => {
  const ctx = await browser.newContext(phoneContext());
  const page = await ctx.newPage();
  await openApp(page, srv.url);
  const r = await page.evaluate((fx) => {
    const v = window.GardenForge.validateState;
    const tryIt = (s) => {
      try {
        v(s);
        return 'ok';
      } catch (e) {
        return 'rejected: ' + e.message;
      }
    };
    const badPlan = JSON.parse(JSON.stringify(fx));
    badPlan.plans[0].count = 0;
    const badDate = JSON.parse(JSON.stringify(fx));
    badDate.logs[0].date = '2026-13-40';
    return { good: tryIt(fx), v2: tryIt({ ...fx, schemaVersion: 2 }), badPlan: tryIt(badPlan), badDate: tryIt(badDate), empty: tryIt(null), noCompleted: tryIt({ ...fx, completed: null }), noRates: tryIt({ ...fx, draft: { ...fx.draft, rates: undefined } }) };
  }, fixture);
  assert.equal(r.good, 'ok');
  assert.match(r.v2, /^rejected/);
  assert.match(r.badPlan, /^rejected/);
  assert.match(r.badDate, /^rejected/);
  assert.match(r.empty, /^rejected/);
  assert.match(r.noCompleted, /^rejected/, 'completed must be an object: render() dereferences it');
  assert.match(r.noRates, /^rejected/, 'draft.rates must be an object: the mix page dereferences it');
  await ctx.close();
});

test('progress photo: saves into the gallery, does not re-render in a loop, releases blob URLs on navigation', async () => {
  const ctx = await browser.newContext(phoneContext());
  const page = await ctx.newPage();
  const errors = await openApp(page, srv.url, { hash: '#garden' });
  await page.click('[data-action="growth-photo"][data-id="plant_1"]');
  await page.waitForSelector('#growth-photo-form');
  // Every visible control in the photo form must have a programmatic label (iOS VoiceOver reads it).
  const unlabeled = await page.evaluate(() =>
    [...document.querySelectorAll('#growth-photo-form input:not([type=hidden]), #growth-photo-form select, #growth-photo-form textarea')]
      .filter((el) => !el.labels?.length && !el.getAttribute('aria-label'))
      .map((el) => el.name || el.id),
  );
  assert.deepEqual(unlabeled, []);
  await page.setInputFiles('#growth-image', { name: 'tomato.png', mimeType: 'image/png', buffer: await makePng(page, 1200, 900) });
  await page.fill('#growth-height', '12.5');
  await page.selectOption('#growth-stage', 'Vegetative growth');
  await page.click('#growth-photo-form button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('saved'));
  await page.waitForSelector('[data-growth-gallery="plant_1"] article.growth-photo');
  const cards = await page.$$('[data-growth-gallery="plant_1"] article.growth-photo');
  assert.equal(cards.length, 1);
  assert.ok((await page.textContent('[data-growth-gallery="plant_1"]')).includes('12.5 in tall'));
  // Regression guard for the former MutationObserver loop: nothing should touch IndexedDB or create URLs while idle.
  const a = await probe(page);
  await page.waitForTimeout(1500);
  const b = await probe(page);
  assert.equal(b.idbOpen - a.idbOpen, 0, 'galleries must not keep reopening IndexedDB while idle');
  assert.equal(b.createObjectURL - a.createObjectURL, 0, 'galleries must not keep creating blob URLs while idle');
  // Leaving the page must release the image URLs it created.
  await tapTab(page, 'overview');
  const c = await probe(page);
  assert.ok(c.revokeObjectURL >= 1, 'blob URLs should be revoked when the gallery is discarded');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('progress photo: an undecodable image reports an error and keeps the form usable', async () => {
  const ctx = await browser.newContext(phoneContext());
  const page = await ctx.newPage();
  await openApp(page, srv.url, { hash: '#garden' });
  await page.click('[data-action="growth-photo"][data-id="plant_2"]');
  await page.waitForSelector('#growth-photo-form');
  await page.setInputFiles('#growth-image', { name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('this is not a jpeg') });
  await page.click('#growth-photo-form button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('could not be saved'));
  assert.equal(await page.evaluate(() => document.getElementById('dialog').open), true, 'dialog stays open so the user can pick another photo');
  assert.equal(await page.evaluate(() => document.querySelector('#growth-photo-form button[type="submit"]').disabled), false);
  assert.equal(await page.$$eval('[data-growth-gallery="plant_2"] article.growth-photo', (a) => a.length), 0);
  await ctx.close();
});

test('unreadable saved data is preserved in a recovery slot instead of being overwritten', async () => {
  const ctx = await browser.newContext(phoneContext());
  const page = await ctx.newPage();
  // completed: null passed the old validator but crashed render(); it must now be treated as unreadable.
  const broken = { ...fixture, completed: null };
  const seeded = JSON.stringify(broken);
  const errors = await openApp(page, srv.url, { state: broken });
  const warning = await page.textContent('#boot-warning');
  assert.match(warning, /could not be read/);
  const ls = await page.evaluate((key) => {
    const out = { original: localStorage.getItem(key), slots: [] };
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith(key + '.unreadable.')) out.slots.push(localStorage.getItem(k));
    }
    return out;
  }, STORAGE_KEY);
  assert.equal(ls.original, seeded, 'the main slot must not be overwritten at boot');
  assert.deepEqual(ls.slots, [seeded], 'exactly one verbatim recovery copy');
  assert.ok(await page.$('[data-action="download-unreadable"]'), 'download button offered');
  // Reloading must reuse the existing copy, not add another one per launch.
  await page.reload();
  await page.waitForSelector('#view h1');
  const slotCount = await page.evaluate((key) => [...Array(localStorage.length).keys()].map((i) => localStorage.key(i)).filter((k) => k.startsWith(key + '.unreadable.')).length, STORAGE_KEY);
  assert.equal(slotCount, 1, 'one recovery copy, however many times the app is opened');
  // The app itself still works with a fresh garden.
  await tapTab(page, 'garden');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a long-lived garden with more than 1500 journal entries still loads', async () => {
  const ctx = await browser.newContext(phoneContext());
  const page = await ctx.newPage();
  const big = JSON.parse(JSON.stringify(fixture));
  big.logs = Array.from({ length: 1600 }, (_, i) => ({ id: 'log_' + i, kind: 'Observation', title: 'Note ' + i, date: '2026-09-01', reviewDate: '', bedId: '', notes: 'n' }));
  const errors = await openApp(page, srv.url, { state: big, hash: '#tasks' });
  assert.equal(await page.evaluate(() => document.getElementById('boot-warning').hidden), true, 'no boot warning');
  assert.equal(await page.evaluate(() => window.GardenForge.getState().logs.length), 1600);
  assert.deepEqual(errors, []);
  await ctx.close();
});
