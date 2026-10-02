// Integration test for the self-hosted PocketBase sync server in server/.
//
// STATUS: NOT YET EXECUTED - verify on first install. This file was written without running
// PocketBase (the development sandbox may not download or run external binaries). It skips
// itself unless POCKETBASE_BIN points at a PocketBase executable.
//
// Run it on the server, or on any machine with the same PocketBase release:
//
//   cd tools
//   POCKETBASE_BIN=/opt/gardenforge/bin/pocketbase npm run test:server
//   # package.json script: "test:server": "node --test tests/server.test.mjs"
//   # equivalent without the script:
//   POCKETBASE_BIN=/path/to/pocketbase node --test tests/server.test.mjs
//
// Set GF_SERVER_LOGS=1 to print PocketBase's output at the end, GF_KEEP_TMP=1 to keep the
// temporary data directory.
//
// What it does: creates a throw-away data directory, creates a superuser with the CLI
// (`superuser create EMAIL PASS`, docs: going-to-production), starts `serve` on a free localhost
// port with --migrationsDir and --hooksDir pointing at server/, creates an owner and a second
// user through the superuser API, then exercises push/pull/status, idempotency, conflicts,
// tombstones, second-user isolation, closed sign-ups, locked collections, photo upload with
// SHA-256 verification and protected-file download, conflict resolution, epoch rotation and
// the tunnel allowlist. Only Node built-ins are used; nothing is written inside the repository.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = process.env.POCKETBASE_BIN;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const execFileP = promisify(execFile);

// A 1x1 baseline JPEG (134 bytes). Only its bytes matter: PocketBase checks the type by content.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const T = (hh) => `2026-10-01T${hh}:00:00.000Z`;

if (!BIN) {
  test('PocketBase server integration test', { skip: 'POCKETBASE_BIN is not set (see server/README.md)' }, () => {});
} else {
  describe('GardenForge PocketBase server (server/)', { timeout: 300_000 }, () => {
    let tmp;
    let dataDir;
    let base;
    let proc;
    const logs = [];
    const su = { email: `su-${crypto.randomUUID()}@example.test`, password: `pw-${crypto.randomUUID()}` };
    const ownerCreds = { email: `owner-${crypto.randomUUID()}@example.test`, password: `pw-${crypto.randomUUID()}` };
    const otherCreds = { email: `other-${crypto.randomUUID()}@example.test`, password: `pw-${crypto.randomUUID()}` };
    let suToken;
    let owner; // {token, id}
    let other;

    async function api(method, urlPath, { token, json, form, headers = {}, raw } = {}) {
      const h = { ...headers };
      if (token) h.Authorization = token;
      let body;
      if (json !== undefined) {
        h['Content-Type'] = 'application/json';
        body = JSON.stringify(json);
      } else if (raw !== undefined) {
        h['Content-Type'] = 'application/json';
        body = raw;
      } else if (form) {
        body = form;
      }
      const res = await fetch(base + urlPath, { method, headers: h, body, redirect: 'manual' });
      const buf = Buffer.from(await res.arrayBuffer());
      let parsed = null;
      try {
        parsed = JSON.parse(buf.toString('utf8'));
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed, bytes: buf, headers: res.headers };
    }
    const push = (who, deviceId, ops) => api('POST', '/api/gf/sync/push', { token: who.token, json: { deviceId, ops } });
    const pull = (who, since = 0, limit) =>
      api('GET', `/api/gf/sync/pull?since=${since}${limit ? `&limit=${limit}` : ''}`, { token: who.token });
    const status = (who) => api('GET', '/api/gf/sync/status', { token: who.token });
    const op = (o) => ({ opId: crypto.randomUUID(), rid: 'plant_1', t: 'planting', baseRev: 0, data: { a: 1 }, deleted: false, clientUpdatedAt: T('09'), ...o });
    const msg = (res) => `HTTP ${res.status}: ${JSON.stringify(res.body)}\n--- last PocketBase output ---\n${logs.join('').slice(-4000)}`;

    async function freePort() {
      return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
          const { port } = srv.address();
          srv.close(() => resolve(port));
        });
      });
    }

    async function authUser(creds) {
      const res = await api('POST', '/api/collections/users/auth-with-password', {
        json: { identity: creds.email, password: creds.password },
      });
      assert.equal(res.status, 200, msg(res));
      return { token: res.body.token, id: res.body.record.id };
    }

    before(async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-pb-test-'));
      dataDir = path.join(tmp, 'pb_data');
      fs.mkdirSync(dataDir);

      // 1. superuser via the CLI, before serve (no concurrent access to the fresh database)
      await execFileP(BIN, ['superuser', 'create', su.email, su.password, `--dir=${dataDir}`], { timeout: 60_000 });

      // 2. serve with the repository's migrations and hooks; --automigrate=false so nothing is
      //    ever written into server/pb_migrations
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      proc = spawn(
        BIN,
        [
          'serve',
          `--dir=${dataDir}`,
          `--migrationsDir=${path.join(REPO, 'server', 'pb_migrations')}`,
          `--hooksDir=${path.join(REPO, 'server', 'pb_hooks')}`,
          `--http=127.0.0.1:${port}`,
          '--automigrate=false',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      proc.stdout.on('data', (d) => logs.push(d.toString()));
      proc.stderr.on('data', (d) => logs.push(d.toString()));
      let exited = null;
      proc.on('exit', (code) => {
        exited = code;
      });
      const deadline = Date.now() + 60_000;
      for (;;) {
        if (exited !== null) throw new Error(`pocketbase exited with ${exited}\n${logs.join('')}`);
        try {
          const res = await fetch(`${base}/api/health`);
          if (res.status === 200) break;
        } catch {
          // not listening yet
        }
        if (Date.now() > deadline) throw new Error(`pocketbase did not become healthy\n${logs.join('')}`);
        await new Promise((r) => setTimeout(r, 250));
      }

      // 3. superuser token, then the two users
      const suAuth = await api('POST', '/api/collections/_superusers/auth-with-password', {
        json: { identity: su.email, password: su.password },
      });
      assert.equal(suAuth.status, 200, msg(suAuth));
      suToken = suAuth.body.token;
      for (const creds of [ownerCreds, otherCreds]) {
        const res = await api('POST', '/api/collections/users/records', {
          token: suToken,
          json: { email: creds.email, password: creds.password, passwordConfirm: creds.password, verified: true },
        });
        assert.equal(res.status, 200, msg(res));
      }
    });

    after(async () => {
      if (proc && proc.exitCode === null) {
        proc.kill('SIGTERM');
        await new Promise((r) => {
          const t = setTimeout(() => {
            proc.kill('SIGKILL');
            r();
          }, 10_000);
          proc.on('exit', () => {
            clearTimeout(t);
            r();
          });
        });
      }
      if (process.env.GF_SERVER_LOGS) console.log(logs.join(''));
      if (tmp && !process.env.GF_KEEP_TMP) fs.rmSync(tmp, { recursive: true, force: true });
      else if (tmp) console.log(`kept ${tmp}`);
    });

    test('migration created the collections and locked sign-ups', async () => {
      for (const name of ['gf_records', 'gf_conflicts', 'gf_applied_ops', 'gf_counters', 'gf_photos']) {
        const res = await api('GET', `/api/collections/${name}`, { token: suToken });
        assert.equal(res.status, 200, msg(res));
      }
      const users = await api('GET', '/api/collections/users', { token: suToken });
      assert.equal(users.status, 200, msg(users));
      assert.equal(users.body.createRule, null);
      assert.equal(users.body.deleteRule, null);
    });

    test('owner and second user can sign in', async () => {
      owner = await authUser(ownerCreds);
      other = await authUser(otherCreds);
      assert.ok(owner.token && owner.id && other.token && other.id);
      assert.notEqual(owner.id, other.id);
    });

    test('status requires auth and starts empty', async () => {
      const anon = await api('GET', '/api/gf/sync/status');
      assert.equal(anon.status, 401, msg(anon));
      const res = await status(owner);
      assert.equal(res.status, 200, msg(res));
      assert.equal(res.body.serverSeq, 0);
      assert.equal(res.body.epoch, '');
      assert.equal(res.body.records, 0);
      assert.equal(typeof res.body.serverTime, 'string');
      assert.equal(typeof res.body.pocketbaseVersion, 'string');
    });

    const A1 = op({ rid: 'r1', data: { v: 'a1' } });
    const A2 = op({ rid: 'r2', data: { v: 'a2' } });
    let epoch1;

    test('push two records', async () => {
      const res = await push(owner, 'devA', [A1, A2]);
      assert.equal(res.status, 200, msg(res));
      assert.deepEqual(
        res.body.results.map((r) => [r.opId, r.status, r.rev, r.serverSeq]),
        [
          [A1.opId, 'applied', 1, 1],
          [A2.opId, 'applied', 1, 2],
        ],
      );
      assert.equal(res.body.serverSeq, 2);
      assert.deepEqual(res.body.results[0].record.data, { v: 'a1' });
      assert.match(res.body.epoch, /^.{8,}$/);
      epoch1 = res.body.epoch;
    });

    test('re-pushing the same ops is idempotent ("replayed")', async () => {
      const res = await push(owner, 'devA', [A1, { ...A2, data: { v: 'changed in transit' } }]);
      assert.equal(res.status, 200, msg(res));
      assert.deepEqual(res.body.results.map((r) => [r.status, r.originalStatus, r.rev, r.serverSeq]), [
        ['replayed', 'applied', 1, 1],
        ['replayed', 'applied', 1, 2],
      ]);
      assert.deepEqual(res.body.results[1].record.data, { v: 'a2' }, 'the stored result is returned unchanged');
      assert.equal((await status(owner)).body.serverSeq, 2, 'a replay issues no new sequence number');
    });

    let cursor;
    test('pull since 0 returns both records with a cursor', async () => {
      const res = await pull(owner, 0);
      assert.equal(res.status, 200, msg(res));
      assert.deepEqual(res.body.records.map((r) => [r.rid, r.rev, r.serverSeq, r.deleted]), [
        ['r1', 1, 1, false],
        ['r2', 1, 2, false],
      ]);
      assert.equal(res.body.cursor, 2);
      assert.equal(res.body.more, false);
      assert.equal(res.body.cursorAhead, false);
      cursor = res.body.cursor;
      const page = await pull(owner, 0, 1);
      assert.equal(page.body.records.length, 1);
      assert.equal(page.body.more, true);
      assert.equal(page.body.cursor, 1);
      const bad = await api('GET', '/api/gf/sync/pull?limit=0', { token: owner.token });
      assert.equal(bad.status, 400, msg(bad));
    });

    test('a stale push with an OLDER clientUpdatedAt loses; the server keeps its version; the loser is kept', async () => {
      const a3 = await push(owner, 'devA', [op({ rid: 'r1', baseRev: 1, data: { v: 'a3' }, clientUpdatedAt: T('12') })]);
      assert.equal(a3.body.results[0].status, 'applied', msg(a3));
      assert.equal(a3.body.results[0].rev, 2);

      const res = await push(owner, 'devB', [op({ rid: 'r1', baseRev: 1, data: { v: 'b1' }, clientUpdatedAt: T('10') })]);
      assert.equal(res.status, 200, msg(res));
      const r = res.body.results[0];
      assert.equal(r.status, 'conflict');
      assert.equal(r.conflict, true);
      assert.equal(r.loser, 'incoming');
      assert.deepEqual(r.record.data, { v: 'a3' });
      assert.equal(r.rev, 3);

      const list = await api('GET', '/api/collections/gf_conflicts/records?sort=server_seq', { token: owner.token });
      assert.equal(list.status, 200, msg(list));
      assert.equal(list.body.items.length, 1);
      assert.deepEqual(list.body.items[0].loser_data, { v: 'b1' });
      assert.equal(list.body.items[0].loser_device_id, 'devB');
      assert.equal(list.body.items[0].resolved, false);
    });

    test('a stale push with a NEWER clientUpdatedAt wins; the previous version goes to gf_conflicts', async () => {
      const res = await push(owner, 'devB', [op({ rid: 'r1', baseRev: 2, data: { v: 'b2' }, clientUpdatedAt: T('15') })]);
      assert.equal(res.status, 200, msg(res));
      const r = res.body.results[0];
      assert.equal(r.status, 'conflict');
      assert.equal(r.loser, 'stored');
      assert.deepEqual(r.record.data, { v: 'b2' });
      assert.equal(r.rev, 4);
      const list = await api('GET', '/api/collections/gf_conflicts/records?sort=server_seq', { token: owner.token });
      assert.equal(list.body.items.length, 2);
      assert.deepEqual(list.body.items[1].loser_data, { v: 'a3' });
      assert.equal(list.body.items[1].loser_rev, 3);
    });

    test('a delete becomes a tombstone that keeps its data and appears in pull', async () => {
      const res = await push(owner, 'devA', [op({ rid: 'r2', baseRev: 1, deleted: true, data: null, clientUpdatedAt: T('16') })]);
      assert.equal(res.status, 200, msg(res));
      assert.equal(res.body.results[0].status, 'applied');
      const p = await pull(owner, cursor);
      const r2 = p.body.records.find((r) => r.rid === 'r2');
      assert.ok(r2, 'tombstone pulled');
      assert.equal(r2.deleted, true);
      assert.deepEqual(r2.data, { v: 'a2' });
      assert.equal(p.body.conflicts.length, 2, 'unresolved conflicts in (since, cursor] come with the pull');
    });

    test('a batch that fails part-way stores nothing (409 on a type change)', async () => {
      const before = (await status(owner)).body.serverSeq;
      const res = await push(owner, 'devA', [op({ rid: 'r-new', data: { v: 1 } }), op({ rid: 'r1', t: 'other', baseRev: 4 })]);
      assert.equal(res.status, 409, msg(res));
      assert.equal((await status(owner)).body.serverSeq, before);
      const p = await pull(owner, 0);
      assert.equal(p.body.records.find((r) => r.rid === 'r-new'), undefined);
    });

    test('push input is validated', async () => {
      const tooMany = Array.from({ length: 501 }, () => op({}));
      assert.equal((await push(owner, 'devA', tooMany)).status, 400);
      assert.equal((await push(owner, 'devA', [op({ data: { s: 'x'.repeat(70_000) } })])).status, 400);
      assert.equal((await push(owner, '', [op({})])).status, 400);
      assert.equal((await push(owner, 'devA', [op({ baseRev: -1 })])).status, 400);
      assert.equal((await api('POST', '/api/gf/sync/push', { token: owner.token, raw: 'not json' })).status, 400);
      assert.equal((await api('POST', '/api/gf/sync/push', { json: { deviceId: 'd', ops: [] } })).status, 401);
    });

    test('concurrent pushes get unique, increasing sequence numbers', async () => {
      const batches = Array.from({ length: 5 }, (_, b) =>
        Array.from({ length: 10 }, (_, i) => op({ rid: `c-${b}-${i}`, data: { b, i } })),
      );
      const results = await Promise.all(batches.map((ops, b) => push(owner, `dev${b}`, ops)));
      for (const res of results) assert.equal(res.status, 200, msg(res));
      const seqs = results.flatMap((res) => res.body.results.map((r) => r.serverSeq)).sort((x, y) => x - y);
      assert.equal(new Set(seqs).size, 50);
      for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1, 'no gaps inside one owner sequence');
    });

    test('a second user cannot see or touch the owner\'s data', async () => {
      const recs = await api('GET', '/api/collections/gf_records/records', { token: other.token });
      assert.equal(recs.status, 200, msg(recs));
      assert.equal(recs.body.items.length, 0);
      const conf = await api('GET', '/api/collections/gf_conflicts/records', { token: other.token });
      assert.equal(conf.body.items.length, 0);
      const ownerRecs = await api('GET', '/api/collections/gf_records/records?perPage=1', { token: owner.token });
      const someId = ownerRecs.body.items[0].id;
      assert.equal((await api('GET', `/api/collections/gf_records/records/${someId}`, { token: other.token })).status, 404);
      const p = await pull(other, 0);
      assert.equal(p.body.records.length, 0);
      const mine = await push(other, 'devZ', [op({ rid: 'r1', data: { v: 'z' } })]);
      assert.deepEqual([mine.body.results[0].status, mine.body.results[0].rev, mine.body.results[0].serverSeq], ['applied', 1, 1]);
      const ownerR1 = (await pull(owner, 0)).body.records.find((r) => r.rid === 'r1');
      assert.deepEqual(ownerR1.data, { v: 'b2' }, 'owner record untouched');
    });

    test('gf_* collections cannot be written directly through the record API', async () => {
      const create = await api('POST', '/api/collections/gf_records/records', {
        token: owner.token,
        json: { owner: owner.id, rid: 'x', t: 'planting', rev: 1, server_seq: 999 },
      });
      assert.equal(create.status, 403, msg(create));
      const any = (await api('GET', '/api/collections/gf_records/records?perPage=1', { token: owner.token })).body.items[0];
      assert.equal((await api('PATCH', `/api/collections/gf_records/records/${any.id}`, { token: owner.token, json: { rev: 99 } })).status, 403);
      assert.equal((await api('DELETE', `/api/collections/gf_records/records/${any.id}`, { token: owner.token })).status, 403);
      assert.equal((await api('GET', '/api/collections/gf_applied_ops/records', { token: owner.token })).status, 403);
      assert.equal((await api('GET', '/api/collections/gf_counters/records', { token: owner.token })).status, 403);
    });

    test('public sign-up is rejected', async () => {
      const email = `intruder-${crypto.randomUUID()}@example.test`;
      const res = await api('POST', '/api/collections/users/records', {
        json: { email, password: 'correct-horse-battery', passwordConfirm: 'correct-horse-battery' },
      });
      assert.ok([400, 403].includes(res.status), msg(res));
      const login = await api('POST', '/api/collections/users/auth-with-password', {
        json: { identity: email, password: 'correct-horse-battery' },
      });
      assert.equal(login.status, 400, msg(login));
    });

    let photo;
    test('photo upload: declared sha256 verified, duplicates rejected, protected download', async () => {
      const form = (who, sha, bytes = JPEG) => {
        const fd = new FormData();
        fd.append('owner', who.id);
        fd.append('sha256', sha);
        fd.append('width', '1');
        fd.append('height', '1');
        fd.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'photo.jpg');
        return fd;
      };
      const sha = sha256(JPEG);
      const wrong = await api('POST', '/api/collections/gf_photos/records', { token: owner.token, form: form(owner, 'a'.repeat(64)) });
      assert.equal(wrong.status, 400, msg(wrong));

      const ok = await api('POST', '/api/collections/gf_photos/records', { token: owner.token, form: form(owner, sha) });
      assert.equal(ok.status, 200, msg(ok));
      assert.equal(ok.body.sha256, sha);
      assert.equal(ok.body.bytes, JPEG.length);
      assert.equal(ok.body.mime, 'image/jpeg');
      photo = ok.body;

      const dup = await api('POST', '/api/collections/gf_photos/records', { token: owner.token, form: form(owner, sha) });
      assert.ok([400, 409].includes(dup.status), msg(dup));

      const spoof = await api('POST', '/api/collections/gf_photos/records', { token: other.token, form: form(owner, sha) });
      assert.ok([400, 403].includes(spoof.status), `cannot upload as someone else: ${msg(spoof)}`);

      const fileUrl = `/api/files/gf_photos/${photo.id}/${encodeURIComponent(photo.file)}`;
      const noToken = await api('GET', fileUrl);
      assert.ok(noToken.status >= 400 && noToken.status < 500, `protected file without token: ${noToken.status}`);

      const tok = await api('POST', '/api/files/token', { token: owner.token });
      assert.equal(tok.status, 200, msg(tok));
      const withToken = await api('GET', `${fileUrl}?token=${encodeURIComponent(tok.body.token)}`);
      assert.equal(withToken.status, 200);
      assert.equal(sha256(withToken.bytes), sha);

      const otherTok = await api('POST', '/api/files/token', { token: other.token });
      const asOther = await api('GET', `${fileUrl}?token=${encodeURIComponent(otherTok.body.token)}`);
      assert.ok(asOther.status >= 400 && asOther.status < 500, `other user's file token: ${asOther.status}`);

      const otherList = await api('GET', '/api/collections/gf_photos/records', { token: other.token });
      assert.equal(otherList.body.items.length, 0);
    });

    test('an owner can only mark a conflict resolved', async () => {
      const list = await api('GET', '/api/collections/gf_conflicts/records?sort=server_seq', { token: owner.token });
      const c = list.body.items[0];
      const sneaky = await api('PATCH', `/api/collections/gf_conflicts/records/${c.id}`, {
        token: owner.token,
        json: { resolved: true, loser_data: { v: 'rewritten' } },
      });
      assert.equal(sneaky.status, 400, msg(sneaky));
      const byOther = await api('PATCH', `/api/collections/gf_conflicts/records/${c.id}`, { token: other.token, json: { resolved: true } });
      assert.equal(byOther.status, 404, msg(byOther));
      const ok = await api('PATCH', `/api/collections/gf_conflicts/records/${c.id}`, { token: owner.token, json: { resolved: true } });
      assert.equal(ok.status, 200, msg(ok));
      assert.equal(ok.body.resolved, true);
      assert.deepEqual(ok.body.loser_data, c.loser_data);
      assert.equal((await api('DELETE', `/api/collections/gf_conflicts/records/${c.id}`, { token: owner.token })).status, 403);
    });

    test('status reports the counters', async () => {
      const res = await status(owner);
      assert.equal(res.status, 200, msg(res));
      assert.equal(res.body.records, 52); // r1, r2 and 50 concurrent ones
      assert.equal(res.body.conflictsUnresolved, 1);
      assert.equal(res.body.photos, 1);
      assert.equal(res.body.epoch, epoch1);
    });

    test('superuser can rotate the epoch; owners cannot', async () => {
      assert.equal((await api('POST', '/api/gf/admin/rotate-epoch', { token: owner.token })).status, 403);
      const res = await api('POST', '/api/gf/admin/rotate-epoch', { token: suToken });
      assert.equal(res.status, 200, msg(res));
      assert.ok(res.body.rotated >= 2);
      const s = await status(owner);
      assert.notEqual(s.body.epoch, epoch1);
    });

    test('tunnel allowlist: proxied requests outside the app paths get 404', async () => {
      const viaTunnel = { 'X-Forwarded-For': '203.0.113.7' };
      assert.equal((await api('GET', '/_/', { headers: viaTunnel })).status, 404);
      assert.notEqual((await api('GET', '/_/')).status, 404, 'admin UI still served locally');
      const suLogin = await api('POST', '/api/collections/_superusers/auth-with-password', {
        headers: { 'Cf-Connecting-Ip': '203.0.113.7' },
        json: { identity: su.email, password: su.password },
      });
      assert.equal(suLogin.status, 404, msg(suLogin));
      assert.equal((await api('GET', '/api/backups', { token: suToken, headers: viaTunnel })).status, 404);
      assert.equal((await api('GET', '/api/health', { headers: viaTunnel })).status, 200);
      assert.equal((await api('GET', '/api/gf/sync/status', { headers: viaTunnel })).status, 401);
      assert.equal((await api('GET', '/api/gf/sync/status', { token: owner.token, headers: viaTunnel })).status, 200);
    });
  });
}
