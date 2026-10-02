/// <reference path="../pb_data/types.d.ts" />
//
// GardenForge sync helpers for PocketBase (CommonJS module, loaded with require()).
//
// STATUS: NOT YET EXECUTED - verify on first install. Written from the PocketBase docs for
// v0.39/v0.40 (js-overview, js-routing, js-records, js-database) without running PocketBase.
// Run tools/tests/server.test.mjs against a real binary before relying on it.
//
// Why a separate module: every PocketBase hook/route handler runs in its own isolated context
// and cannot see variables declared outside it, so shared code must be a local module loaded
// with require(`${__hooks}/gardenforge_lib.js`) inside each handler (js-overview, "Handlers
// scope"). The file name deliberately does NOT end in ".pb.js", so PocketBase does not load it
// as a hooks file on its own. Loaded modules share a registry, so this module keeps no state.
//
// Layout:
//   1. Limits and input validation (pure; also run under Node in development).
//   2. processPush(): the push algorithm against an abstract "store" (pure).
//   3. sha256Hex() and sniffImageMime() for photo uploads (pure).
//   4. Tunnel allowlist helpers (pure).
//   5. makePbStore() / makePbReader(): the PocketBase-backed store. These are the ONLY functions
//      that touch PocketBase globals (Record, $security, toString), and only when called.

"use strict";

// ---------------------------------------------------------------------------------------------
// 1. Limits and validation
// ---------------------------------------------------------------------------------------------

var LIMITS = {
  maxOpsPerPush: 500,
  maxDataBytes: 65536, // per op, UTF-8 bytes of JSON.stringify(data)
  maxPushBodyBytes: 16 * 1024 * 1024, // enforced by $apis.bodyLimit on the route
  maxRidChars: 200,
  maxTypeChars: 40,
  maxOpIdChars: 80,
  maxDeviceIdChars: 80,
  maxClockChars: 64,
  maxBaseRev: 2147483647,
  pullDefaultLimit: 500,
  pullMaxLimit: 1000,
  maxPhotoBytes: 25 * 1024 * 1024
};

// Non-global regular expressions only: .test() on them keeps no state between calls.
var RE_OP_ID = /^[A-Za-z0-9._:-]{1,80}$/;
var RE_DEVICE_ID = /^[A-Za-z0-9._:-]{1,80}$/;
var RE_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
// clientUpdatedAt is an ISO-8601 instant ("2026-10-01T15:02:11.204Z") or a hybrid logical clock
// ("1790899876000-0001-dev_..."). Both compare correctly as plain strings, but only if a client
// uses ONE format consistently: never mix them for the same owner.
var RE_CLOCK = /^[0-9A-Za-z.:+_-]{1,64}$/;
var RE_CONTROL = /[\u0000-\u001f\u007f]/;
var RE_SHA256 = /^[0-9a-f]{64}$/;
var RE_UINT = /^[0-9]{1,15}$/;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Number of bytes the string takes in UTF-8 (lone surrogates count as 3, like U+FFFD).
function utf8ByteLength(str) {
  var bytes = 0;
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function fail(message) {
  return { ok: false, error: message };
}

// Parses and validates the raw JSON text of a push request.
// Returns {ok: true, value: {deviceId, ops}} or {ok: false, error}.
// Every op is checked before anything is written, so one malformed op rejects the whole batch
// with nothing stored.
function parsePushBody(rawText) {
  var body;
  if (typeof rawText !== "string" || rawText.length === 0) return fail("Request body must be JSON.");
  try {
    body = JSON.parse(rawText);
  } catch (err) {
    return fail("Request body is not valid JSON.");
  }
  if (!isPlainObject(body)) return fail("Request body must be a JSON object.");
  if (typeof body.deviceId !== "string" || !RE_DEVICE_ID.test(body.deviceId)) {
    return fail("deviceId must be 1-80 characters from A-Z a-z 0-9 . _ : -");
  }
  if (!Array.isArray(body.ops)) return fail("ops must be an array.");
  if (body.ops.length > LIMITS.maxOpsPerPush) {
    return fail("At most " + LIMITS.maxOpsPerPush + " ops per push.");
  }
  var ops = [];
  for (var i = 0; i < body.ops.length; i++) {
    var op = body.ops[i];
    var where = "ops[" + i + "]: ";
    if (!isPlainObject(op)) return fail(where + "must be an object.");
    if (typeof op.opId !== "string" || !RE_OP_ID.test(op.opId)) {
      return fail(where + "opId must be 1-80 characters from A-Z a-z 0-9 . _ : -");
    }
    if (typeof op.rid !== "string" || op.rid.length < 1 || op.rid.length > LIMITS.maxRidChars || RE_CONTROL.test(op.rid)) {
      return fail(where + "rid must be 1-" + LIMITS.maxRidChars + " characters with no control characters.");
    }
    if (typeof op.t !== "string" || !RE_TYPE.test(op.t)) {
      return fail(where + "t must be 1-40 characters: a letter, then letters, digits or _.");
    }
    var baseRev = op.baseRev === undefined || op.baseRev === null ? 0 : op.baseRev;
    if (typeof baseRev !== "number" || Math.floor(baseRev) !== baseRev || baseRev < 0 || baseRev > LIMITS.maxBaseRev) {
      return fail(where + "baseRev must be a whole number >= 0 (0 = never synced).");
    }
    var deleted = op.deleted === undefined || op.deleted === null ? false : op.deleted;
    if (typeof deleted !== "boolean") return fail(where + "deleted must be true or false.");
    if (typeof op.clientUpdatedAt !== "string" || !RE_CLOCK.test(op.clientUpdatedAt)) {
      return fail(where + "clientUpdatedAt must be 1-64 characters (an ISO-8601 instant or HLC string).");
    }
    var data = hasOwn(op, "data") ? op.data : null;
    if (deleted) {
      // A delete may carry the last known data or nothing; with nothing, the stored data is kept.
      if (data !== null && !isPlainObject(data)) return fail(where + "data must be an object or null.");
    } else if (!isPlainObject(data)) {
      return fail(where + "data must be a JSON object unless deleted is true.");
    }
    if (data !== null && utf8ByteLength(JSON.stringify(data)) > LIMITS.maxDataBytes) {
      return fail(where + "data is larger than " + LIMITS.maxDataBytes + " bytes.");
    }
    ops.push({
      opId: op.opId,
      rid: op.rid,
      t: op.t,
      baseRev: baseRev,
      deleted: deleted,
      data: data,
      clientUpdatedAt: op.clientUpdatedAt
    });
  }
  return { ok: true, value: { deviceId: body.deviceId, ops: ops } };
}

// Parses ?since=&limit= (strings or null). since defaults to 0, limit to 500 (1..1000).
function parsePullQuery(sinceRaw, limitRaw) {
  var since = 0;
  var limit = LIMITS.pullDefaultLimit;
  if (sinceRaw !== null && sinceRaw !== undefined && sinceRaw !== "") {
    if (!RE_UINT.test(String(sinceRaw))) return fail("since must be a whole number >= 0.");
    since = parseInt(String(sinceRaw), 10);
  }
  if (limitRaw !== null && limitRaw !== undefined && limitRaw !== "") {
    if (!RE_UINT.test(String(limitRaw))) return fail("limit must be a whole number from 1 to " + LIMITS.pullMaxLimit + ".");
    limit = parseInt(String(limitRaw), 10);
    if (limit < 1 || limit > LIMITS.pullMaxLimit) return fail("limit must be from 1 to " + LIMITS.pullMaxLimit + ".");
  }
  return { ok: true, since: since, limit: limit };
}

// ---------------------------------------------------------------------------------------------
// 2. Push algorithm
// ---------------------------------------------------------------------------------------------
//
// store interface (implemented by makePbStore below, and by an in-memory fake in development):
//   findAppliedResult(opId)      -> stored result object, or null
//   saveAppliedResult(opId, res) -> void
//   findRecord(rid)              -> envelope {rid,t,data,rev,deleted,deviceId,clientUpdatedAt,serverSeq,originOp} or null
//   writeRecord(envelope)        -> void (insert or update by rid)
//   insertConflict(conflict)     -> id of the stored conflict row
//   nextSeq()                    -> next per-owner server sequence number (1, 2, 3, ...)
//   currentSeq()                 -> last issued sequence number (0 if none)
//   epoch()                      -> per-owner epoch string ("" before the first push)
//
// processPush never throws for a client mistake. It returns {error: {status, message}} and the
// caller must then throw inside the transaction so that every write of the batch is rolled back.
//
// Rules (from the task specification; see server/README.md "Differences from
// docs/SYNC-ARCHITECTURE.md"):
//   - (owner, opId) already applied -> return the stored result with status "replayed".
//   - record missing                -> insert with rev 1 (baseRev is ignored), status "applied".
//   - baseRev === stored rev         -> apply, rev + 1, new serverSeq, status "applied".
//   - baseRev !== stored rev         -> conflict. The greater clientUpdatedAt string wins (a tie
//     keeps the stored version). The winner is stored with rev + 1 and a new serverSeq even when
//     the stored version wins, so every device pulls the outcome. The loser is written to
//     gf_conflicts first, in the same transaction. Status "conflict", conflict: true.
//   - A delete sets deleted = true and keeps the data (the op's data if it sent some, else the
//     stored data), so a pull can show what was deleted.
//   - A record's type t never changes: an op with a different t is a client bug -> HTTP 409 for
//     the whole batch, nothing stored.

function envelope(rid, t, data, rev, deleted, deviceId, clientUpdatedAt, serverSeq, originOp) {
  return {
    rid: rid,
    t: t,
    data: data,
    rev: rev,
    deleted: deleted,
    deviceId: deviceId,
    clientUpdatedAt: clientUpdatedAt,
    serverSeq: serverSeq,
    originOp: originOp
  };
}

function copyResult(stored) {
  var out = {};
  for (var k in stored) {
    if (hasOwn(stored, k)) out[k] = stored[k];
  }
  return out;
}

function processPush(store, deviceId, ops) {
  var results = [];
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];

    var prior = store.findAppliedResult(op.opId);
    if (prior) {
      var replay = copyResult(prior);
      replay.originalStatus = prior.status;
      replay.status = "replayed";
      results.push(replay);
      continue;
    }

    var cur = store.findRecord(op.rid);
    var result;

    if (!cur) {
      var seqNew = store.nextSeq();
      var created = envelope(op.rid, op.t, op.data, 1, op.deleted, deviceId, op.clientUpdatedAt, seqNew, op.opId);
      store.writeRecord(created);
      result = { opId: op.opId, rid: op.rid, status: "applied", rev: 1, serverSeq: seqNew, record: created };
    } else {
      if (cur.t !== op.t) {
        return {
          error: {
            status: 409,
            message: "Op " + op.opId + " has t='" + op.t + "' but record '" + op.rid + "' is stored as t='" + cur.t + "'. Nothing in this batch was stored."
          }
        };
      }
      var incomingData = op.deleted && op.data === null ? cur.data : op.data;

      if (op.baseRev === cur.rev) {
        var seqA = store.nextSeq();
        var applied = envelope(op.rid, op.t, incomingData, cur.rev + 1, op.deleted, deviceId, op.clientUpdatedAt, seqA, op.opId);
        store.writeRecord(applied);
        result = { opId: op.opId, rid: op.rid, status: "applied", rev: applied.rev, serverSeq: seqA, record: applied };
      } else {
        var incomingWins = op.clientUpdatedAt > (cur.clientUpdatedAt || "");
        var seqC = store.nextSeq();
        var newRev = cur.rev + 1;
        var winner;
        var loser;
        if (incomingWins) {
          winner = envelope(op.rid, op.t, incomingData, newRev, op.deleted, deviceId, op.clientUpdatedAt, seqC, op.opId);
          loser = {
            data: cur.data,
            rev: cur.rev,
            deleted: cur.deleted,
            deviceId: cur.deviceId,
            clientUpdatedAt: cur.clientUpdatedAt,
            side: "stored"
          };
        } else {
          winner = envelope(op.rid, op.t, cur.data, newRev, cur.deleted, cur.deviceId, cur.clientUpdatedAt, seqC, op.opId);
          loser = {
            data: op.data,
            rev: op.baseRev,
            deleted: op.deleted,
            deviceId: deviceId,
            clientUpdatedAt: op.clientUpdatedAt,
            side: "incoming"
          };
        }
        // Loser first, then winner, in the same transaction (docs/SYNC-ARCHITECTURE.md 4.6).
        var conflictId = store.insertConflict({
          rid: op.rid,
          t: op.t,
          opId: op.opId,
          loserData: loser.data,
          loserRev: loser.rev,
          loserDeleted: loser.deleted,
          loserDeviceId: loser.deviceId,
          loserClientUpdatedAt: loser.clientUpdatedAt,
          winnerRev: newRev,
          serverSeq: seqC
        });
        store.writeRecord(winner);
        result = {
          opId: op.opId,
          rid: op.rid,
          status: "conflict",
          conflict: true,
          conflictId: conflictId,
          loser: loser.side,
          rev: newRev,
          serverSeq: seqC,
          record: winner
        };
      }
    }

    store.saveAppliedResult(op.opId, result);
    results.push(result);
  }
  return { results: results, serverSeq: store.currentSeq(), epoch: store.epoch() };
}

// ---------------------------------------------------------------------------------------------
// 3. Photo helpers
// ---------------------------------------------------------------------------------------------
//
// $security.sha256() takes a *string* (types.d.ts: "SHA256 creates sha256 hash ... from the
// provided text"), and the docs do not promise that arbitrary binary bytes survive conversion to
// a JS string. So the hash of uploaded bytes is computed here in plain JavaScript over the byte
// array returned by toBytes() (documented global, "converts the specified value into a bytes
// slice"). Cost: pure-JS hashing is slow in the embedded engine (js-overview, "Performance");
// expect very roughly a second per MB on a Raspberry Pi (estimate, not measured). GardenForge
// photos are about 150-400 KB.

var SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

// bytes: any array-like of integers 0..255 (a Go []byte from toBytes(), a JS array, a Buffer).
function sha256Hex(bytes) {
  var n = bytes.length;
  var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  var w = new Array(64);
  // padded length: message + 0x80 + zeros + 8-byte length, a multiple of 64
  var total = Math.ceil((n + 9) / 64) * 64;
  var bitLenHi = Math.floor(n / 0x20000000); // (n * 8) >>> 32, without overflow
  var bitLenLo = (n * 8) >>> 0;

  function byteAt(i) {
    if (i < n) return bytes[i] & 0xff;
    if (i === n) return 0x80;
    if (i >= total - 8) {
      var k = i - (total - 8); // 0..7, big-endian 64-bit length
      if (k < 4) return (bitLenHi >>> (24 - 8 * k)) & 0xff;
      return (bitLenLo >>> (24 - 8 * (k - 4))) & 0xff;
    }
    return 0;
  }

  for (var off = 0; off < total; off += 64) {
    var t;
    for (t = 0; t < 16; t++) {
      var j = off + t * 4;
      if (j + 3 < n) {
        w[t] = ((bytes[j] & 0xff) << 24) | ((bytes[j + 1] & 0xff) << 16) | ((bytes[j + 2] & 0xff) << 8) | (bytes[j + 3] & 0xff);
      } else {
        w[t] = (byteAt(j) << 24) | (byteAt(j + 1) << 16) | (byteAt(j + 2) << 8) | byteAt(j + 3);
      }
    }
    for (t = 16; t < 64; t++) {
      var x = w[t - 15];
      var y = w[t - 2];
      var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (t = 0; t < 64; t++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var temp1 = (h + S1 + ch + SHA256_K[t] + w[t]) | 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var temp2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  var out = "";
  var hs = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (var q = 0; q < 8; q++) {
    out += ("00000000" + (hs[q] >>> 0).toString(16)).slice(-8);
  }
  return out;
}

// Returns "image/jpeg", "image/png", "image/webp" from the file's magic bytes, or "".
// (The collection's mimeTypes option also makes PocketBase check the type on save.)
function sniffImageMime(bytes) {
  var n = bytes.length;
  function b(i) {
    return i < n ? bytes[i] & 0xff : -1;
  }
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 && b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a) {
    return "image/png";
  }
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) {
    return "image/webp";
  }
  return "";
}

// ---------------------------------------------------------------------------------------------
// 4. Tunnel allowlist (defence in depth; the tunnel's own ingress rules are the first layer)
// ---------------------------------------------------------------------------------------------
//
// The only paths the GardenForge app needs from the internet. Everything else - the /_/ admin
// UI, superuser auth (/api/collections/_superusers/...), /api/backups, /api/settings, collection
// management, realtime, the admin route below - answers 404 to requests that arrived through a
// proxy. Keep this list identical to the regex in server/cloudflared/config.yml.example.
var TUNNEL_PATHS = [
  /^\/api\/health$/,
  /^\/api\/gf\/sync\/(push|pull|status)$/,
  /^\/api\/collections\/users\/auth-(with-password|refresh)$/,
  /^\/api\/collections\/gf_(records|conflicts|photos)\/records(\/[A-Za-z0-9]+)?$/,
  /^\/api\/files\/token$/,
  /^\/api\/files\/gf_photos\/[A-Za-z0-9]+\/[^/]+$/
];

// Headers that tunnels/reverse proxies add. A request carrying any of them is treated as coming
// from the internet. Cloudflare adds Cf-Connecting-Ip and Cf-Ray at its edge; whether Tailscale
// Funnel adds X-Forwarded-For or Tailscale-Funnel-Request is UNVERIFIED (see
// server/cloudflared/tailscale-funnel.md). Direct local requests (SSH tunnel, the server itself)
// carry none of them.
var PROXY_HEADERS = [
  "Cf-Connecting-Ip",
  "Cf-Ray",
  "X-Forwarded-For",
  "X-Forwarded-Host",
  "X-Forwarded-Proto",
  "Forwarded",
  "X-Real-Ip",
  "Tailscale-Funnel-Request"
];

function isTunnelPath(path) {
  if (typeof path !== "string") return false;
  for (var i = 0; i < TUNNEL_PATHS.length; i++) {
    if (TUNNEL_PATHS[i].test(path)) return true;
  }
  return false;
}

// getHeader: function(name) -> string ("" when absent), e.g. (n) => e.request.header.get(n)
function looksProxied(getHeader) {
  for (var i = 0; i < PROXY_HEADERS.length; i++) {
    var v = getHeader(PROXY_HEADERS[i]);
    if (v !== undefined && v !== null && String(v) !== "") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// 5. PocketBase-backed store and reader (these touch PocketBase globals, only when called)
// ---------------------------------------------------------------------------------------------

// Reads a "json" field as a plain JS value. The docs say json values need the get()/set()
// helpers (js-overview, "Engine limitations"); record.get() returns the raw JSON bytes
// (types.JSONRaw), so we take the text and parse it. getString() relies on JSONRaw having a
// String() method (types.d.ts) - verify on first install; toString() is the documented fallback.
function readJsonField(rec, key) {
  var raw = "";
  try {
    raw = rec.getString(key);
  } catch (err) {
    raw = "";
  }
  if (raw === "" || raw === "null") {
    var alt = "";
    try {
      alt = toString(rec.get(key)); // global helper, js-routing / types.d.ts
    } catch (err2) {
      alt = "";
    }
    if (alt === "" || alt === "null") return null;
    raw = alt;
  }
  try {
    return JSON.parse(raw);
  } catch (err3) {
    throw new Error("GardenForge: could not decode json field '" + key + "' of record " + rec.id);
  }
}

function recordToEnvelope(rec) {
  return envelope(
    rec.getString("rid"),
    rec.getString("t"),
    readJsonField(rec, "data"),
    rec.getInt("rev"),
    rec.getBool("deleted"),
    rec.getString("device_id"),
    rec.getString("client_updated_at"),
    rec.getInt("server_seq"),
    rec.getString("origin_op")
  );
}

function conflictToPlain(rec) {
  return {
    id: rec.id,
    rid: rec.getString("rid"),
    t: rec.getString("t"),
    opId: rec.getString("op_id"),
    loserData: readJsonField(rec, "loser_data"),
    loserRev: rec.getInt("loser_rev"),
    loserDeleted: rec.getBool("loser_deleted"),
    loserDeviceId: rec.getString("loser_device_id"),
    loserClientUpdatedAt: rec.getString("loser_client_updated_at"),
    winnerRev: rec.getInt("winner_rev"),
    serverSeq: rec.getInt("server_seq"),
    resolved: rec.getBool("resolved")
  };
}

function newEpoch() {
  return $security.randomString(20); // js-overview: "$security.randomString(10)"
}

function findOne(app, collection, filter, params) {
  // findRecordsByFilter returns an empty array when nothing matches (js-records), unlike
  // findFirstRecordByFilter, which throws.
  var rows = app.findRecordsByFilter(collection, filter, "", 1, 0, params);
  return rows.length > 0 ? rows[0] : null;
}

// app: the transactional app passed to runInTransaction's callback (always use it, never $app,
// inside a transaction - js-database, "Transaction").
function makePbStore(app, ownerId) {
  var cols = {};
  function col(name) {
    if (!cols[name]) cols[name] = app.findCollectionByNameOrId(name);
    return cols[name];
  }
  var handles = {}; // rid -> loaded/saved Record, so updates hit the same row
  var counter = null;
  var counterDirty = false;

  function loadCounter() {
    if (counter) return counter;
    counter = findOne(app, "gf_counters", "owner = {:owner}", { owner: ownerId });
    if (!counter) {
      counter = new Record(col("gf_counters"));
      counter.set("owner", ownerId);
      counter.set("seq", 0);
      counter.set("epoch", newEpoch());
      counterDirty = true;
    }
    return counter;
  }

  return {
    findAppliedResult: function (opId) {
      var row = findOne(app, "gf_applied_ops", "owner = {:owner} && op_id = {:op}", { owner: ownerId, op: opId });
      return row ? readJsonField(row, "result") : null;
    },
    saveAppliedResult: function (opId, result) {
      var rec = new Record(col("gf_applied_ops"));
      rec.set("owner", ownerId);
      rec.set("op_id", opId);
      rec.set("result", result);
      app.save(rec);
    },
    findRecord: function (rid) {
      var row = findOne(app, "gf_records", "owner = {:owner} && rid = {:rid}", { owner: ownerId, rid: rid });
      if (!row) return null;
      handles[rid] = row;
      return recordToEnvelope(row);
    },
    writeRecord: function (env) {
      var rec = handles[env.rid];
      if (!rec) {
        rec = new Record(col("gf_records"));
        rec.set("owner", ownerId);
        rec.set("rid", env.rid);
      }
      rec.set("t", env.t);
      rec.set("data", env.data);
      rec.set("rev", env.rev);
      rec.set("deleted", env.deleted);
      rec.set("device_id", env.deviceId);
      rec.set("client_updated_at", env.clientUpdatedAt);
      rec.set("server_seq", env.serverSeq);
      rec.set("origin_op", env.originOp);
      app.save(rec);
      handles[env.rid] = rec;
    },
    insertConflict: function (c) {
      var rec = new Record(col("gf_conflicts"));
      rec.set("owner", ownerId);
      rec.set("rid", c.rid);
      rec.set("t", c.t);
      rec.set("op_id", c.opId);
      rec.set("loser_data", c.loserData);
      rec.set("loser_rev", c.loserRev);
      rec.set("loser_deleted", c.loserDeleted);
      rec.set("loser_device_id", c.loserDeviceId);
      rec.set("loser_client_updated_at", c.loserClientUpdatedAt);
      rec.set("winner_rev", c.winnerRev);
      rec.set("server_seq", c.serverSeq);
      rec.set("resolved", false);
      app.save(rec);
      return rec.id;
    },
    nextSeq: function () {
      var c = loadCounter();
      var next = c.getInt("seq") + 1;
      c.set("seq", next);
      counterDirty = true;
      return next;
    },
    currentSeq: function () {
      return loadCounter().getInt("seq");
    },
    epoch: function () {
      return loadCounter().getString("epoch");
    },
    // Must be called inside the same transaction, after processPush, to persist the counter.
    flush: function () {
      if (counter && counterDirty) {
        app.save(counter);
        counterDirty = false;
      }
    }
  };
}

// Read-only helpers for pull/status (no transaction needed).
function makePbReader(app, ownerId) {
  function counterRow() {
    return findOne(app, "gf_counters", "owner = {:owner}", { owner: ownerId });
  }
  return {
    serverSeq: function () {
      var c = counterRow();
      return c ? c.getInt("seq") : 0;
    },
    epoch: function () {
      var c = counterRow();
      return c ? c.getString("epoch") : "";
    },
    // limit+1 rows are fetched to know whether more pages exist.
    recordsSince: function (since, limit) {
      var rows = app.findRecordsByFilter(
        "gf_records",
        "owner = {:owner} && server_seq > {:since}",
        "server_seq",
        limit + 1,
        0,
        { owner: ownerId, since: since }
      );
      var out = [];
      for (var i = 0; i < rows.length; i++) out.push(recordToEnvelope(rows[i]));
      return out;
    },
    unresolvedConflictsBetween: function (since, upTo) {
      var rows = app.findRecordsByFilter(
        "gf_conflicts",
        "owner = {:owner} && resolved = false && server_seq > {:since} && server_seq <= {:upTo}",
        "server_seq",
        0,
        0,
        { owner: ownerId, since: since, upTo: upTo }
      );
      var out = [];
      for (var i = 0; i < rows.length; i++) out.push(conflictToPlain(rows[i]));
      return out;
    }
  };
}

// Builds the pull response from a reader (pure apart from the reader).
function buildPull(reader, since, limit, serverTime) {
  var rows = reader.recordsSince(since, limit);
  var more = rows.length > limit;
  if (more) rows = rows.slice(0, limit);
  var cursor = rows.length > 0 ? rows[rows.length - 1].serverSeq : since;
  var conflicts = cursor > since ? reader.unresolvedConflictsBetween(since, cursor) : [];
  var serverSeq = reader.serverSeq();
  return {
    records: rows,
    conflicts: conflicts,
    cursor: cursor,
    more: more,
    serverSeq: serverSeq,
    epoch: reader.epoch(),
    // A cursor ahead of the server means the server was restored from an older backup or the
    // client is confused: the client must reset its cursor to 0 and resync.
    cursorAhead: since > serverSeq,
    serverTime: serverTime
  };
}

module.exports = {
  LIMITS: LIMITS,
  RE_SHA256: RE_SHA256,
  utf8ByteLength: utf8ByteLength,
  parsePushBody: parsePushBody,
  parsePullQuery: parsePullQuery,
  processPush: processPush,
  sha256Hex: sha256Hex,
  sniffImageMime: sniffImageMime,
  isTunnelPath: isTunnelPath,
  looksProxied: looksProxied,
  TUNNEL_PATHS: TUNNEL_PATHS,
  PROXY_HEADERS: PROXY_HEADERS,
  readJsonField: readJsonField,
  recordToEnvelope: recordToEnvelope,
  conflictToPlain: conflictToPlain,
  newEpoch: newEpoch,
  makePbStore: makePbStore,
  makePbReader: makePbReader,
  buildPull: buildPull
};
