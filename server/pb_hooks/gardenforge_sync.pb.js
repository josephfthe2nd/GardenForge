/// <reference path="../pb_data/types.d.ts" />
//
// GardenForge sync routes and hooks for PocketBase.
//
// STATUS: NOT YET EXECUTED - verify on first install. Written from the PocketBase docs for
// v0.39/v0.40 (js-routing, js-records, js-database, js-event-hooks, api-rules-and-filters,
// files-handling) without running PocketBase. Run tools/tests/server.test.mjs against a real
// binary before relying on it.
//
// What this file adds:
//   POST /api/gf/sync/push           (signed-in owner)  idempotent batch write, one transaction
//   GET  /api/gf/sync/pull           (signed-in owner)  changes since a cursor
//   GET  /api/gf/sync/status         (signed-in owner)  counters for the sync pill
//   POST /api/gf/admin/rotate-epoch  (superuser only)   run after restoring a backup
//   - a middleware that answers 404 to proxied (tunnel) requests outside the app's paths
//   - users: public sign-ups rejected (also locked by the migration's createRule = null)
//   - gf_photos: the uploaded bytes must hash to the declared sha256
//   - gf_conflicts: an owner may change only the "resolved" field
//
// Notes for readers new to PocketBase:
//   - Each handler runs in its own isolated context and cannot see variables declared outside it
//     (js-overview, "Handlers scope"), so every handler require()s the helper module itself.
//   - Throwing an error, or not calling e.next(), stops a hook chain (js-event-hooks).
//   - "e.auth" is the signed-in record; PocketBase loads it from the Authorization header
//     (js-routing, "Retrieving the current auth state").

// -----------------------------------------------------------------------------------------------
// Tunnel allowlist (defence in depth). The tunnel's ingress rules are the first layer; this
// catches a misconfigured tunnel. A request that carries proxy headers (Cf-Connecting-Ip,
// X-Forwarded-For, ...) and asks for any path the app does not need gets 404, so the /_/ admin
// UI and the superuser API are never served through the tunnel.
// Priority -1025: after the built-in panic recovery (-1030), before the auth token loader (-1020)
// (js-routing, "Default globally registered middlewares"; lower numbers run first).
// -----------------------------------------------------------------------------------------------
routerUse(new Middleware((e) => {
  const lib = require(`${__hooks}/gardenforge_lib.js`);
  const proxied = lib.looksProxied((name) => e.request.header.get(name));
  if (proxied && !lib.isTunnelPath(e.request.url.path)) {
    throw new NotFoundError();
  }
  return e.next();
}, -1025, "gardenforgeTunnelAllowlist"));

// -----------------------------------------------------------------------------------------------
// POST /api/gf/sync/push
// Body: {deviceId, ops: [{opId, rid, t, baseRev, data, deleted, clientUpdatedAt}]}
// Reply: {results: [{opId, rid, status, rev, serverSeq, record, ...}], serverSeq, epoch}
// The owner always comes from the auth token (e.auth), never from the body.
// -----------------------------------------------------------------------------------------------
routerAdd("POST", "/api/gf/sync/push", (e) => {
  const lib = require(`${__hooks}/gardenforge_lib.js`);
  const ownerId = e.auth.id;

  let raw = "";
  try {
    raw = toString(e.request.body); // js-routing, "Reading request body"
  } catch (err) {
    throw new BadRequestError("Could not read the request body.");
  }
  const parsed = lib.parsePushBody(raw);
  if (!parsed.ok) {
    throw new BadRequestError(parsed.error);
  }

  let out = null;
  let failure = null;
  try {
    // All ops in ONE transaction: either every write of the batch is stored or none is
    // (js-database, "Transaction"). Inside, only txApp may be used.
    e.app.runInTransaction((txApp) => {
      const store = lib.makePbStore(txApp, ownerId);
      const result = lib.processPush(store, parsed.value.deviceId, parsed.value.ops);
      if (result.error) {
        failure = result.error;
        throw new Error(result.error.message); // forces the rollback
      }
      store.flush();
      out = result;
    });
  } catch (err) {
    if (failure) {
      throw new ApiError(failure.status, failure.message);
    }
    throw err;
  }
  return e.json(200, out);
}, $apis.requireAuth("users"), $apis.bodyLimit(16 * 1024 * 1024));

// -----------------------------------------------------------------------------------------------
// GET /api/gf/sync/pull?since=<serverSeq>&limit=<1..1000>
// Reply: {records, conflicts, cursor, more, serverSeq, epoch, cursorAhead, serverTime}
// records: this owner's rows with serverSeq > since, ascending, tombstones included.
// conflicts: unresolved conflict copies created in (since, cursor].
// -----------------------------------------------------------------------------------------------
routerAdd("GET", "/api/gf/sync/pull", (e) => {
  const lib = require(`${__hooks}/gardenforge_lib.js`);
  const query = e.request.url.query(); // js-routing, "Reading query parameters"
  const q = lib.parsePullQuery(query.get("since"), query.get("limit"));
  if (!q.ok) {
    throw new BadRequestError(q.error);
  }
  const reader = lib.makePbReader(e.app, e.auth.id);
  return e.json(200, lib.buildPull(reader, q.since, q.limit, new Date().toISOString()));
}, $apis.requireAuth("users"));

// -----------------------------------------------------------------------------------------------
// GET /api/gf/sync/status
// Reply: {serverSeq, epoch, records, conflictsUnresolved, photos, serverTime, pocketbaseVersion}
// -----------------------------------------------------------------------------------------------
routerAdd("GET", "/api/gf/sync/status", (e) => {
  const lib = require(`${__hooks}/gardenforge_lib.js`);
  const ownerId = e.auth.id;
  const reader = lib.makePbReader(e.app, ownerId);

  // countRecords + $dbx.hashExp: js-records "Fetch multiple records", js-database "hashExp".
  const records = e.app.countRecords("gf_records", $dbx.hashExp({ owner: ownerId }));
  const conflictsUnresolved = e.app.countRecords("gf_conflicts", $dbx.hashExp({ owner: ownerId, resolved: false }));
  const photos = e.app.countRecords("gf_photos", $dbx.hashExp({ owner: ownerId }));

  // UNCERTAIN: the docs do not name a version accessor; $app.rootCmd is the cobra root command
  // (types.d.ts, PocketBase.rootCmd) and cobra's Command has a "version" field. Empty if unset.
  let pocketbaseVersion = "";
  try {
    pocketbaseVersion = String($app.rootCmd && $app.rootCmd.version ? $app.rootCmd.version : "");
  } catch (err) {
    pocketbaseVersion = "";
  }

  return e.json(200, {
    serverSeq: reader.serverSeq(),
    epoch: reader.epoch(),
    records: records,
    conflictsUnresolved: conflictsUnresolved,
    photos: photos,
    serverTime: new Date().toISOString(),
    pocketbaseVersion: pocketbaseVersion
  });
}, $apis.requireAuth("users"));

// -----------------------------------------------------------------------------------------------
// POST /api/gf/admin/rotate-epoch   (superuser only; not reachable through the tunnel)
// Gives every owner a new random epoch. Run it once after restoring a backup: a client that sees
// a different epoch must reset its pull cursor to 0, pull everything and re-push its local
// changes, because the restored server may be missing edits the devices already consider synced.
// See server/restore.md.
// -----------------------------------------------------------------------------------------------
routerAdd("POST", "/api/gf/admin/rotate-epoch", (e) => {
  const lib = require(`${__hooks}/gardenforge_lib.js`);
  let rotated = 0;
  e.app.runInTransaction((txApp) => {
    // empty filter + limit 0 = every row (types.d.ts, findRecordsByFilter)
    const rows = txApp.findRecordsByFilter("gf_counters", "", "", 0, 0);
    for (let i = 0; i < rows.length; i++) {
      rows[i].set("epoch", lib.newEpoch());
      txApp.save(rows[i]);
      rotated++;
    }
  });
  return e.json(200, { rotated: rotated });
}, $apis.requireSuperuserAuth());

// -----------------------------------------------------------------------------------------------
// Sign-ups are closed. The migration sets users.createRule = null (superusers only); this hook
// is a second lock in case the rule is ever relaxed from the dashboard by mistake.
// (js-records, "Intercept create request")
// -----------------------------------------------------------------------------------------------
onRecordCreateRequest((e) => {
  if (!e.hasSuperuserAuth()) {
    throw new ForbiddenError("Sign-ups are closed. The owner account is created by the server's superuser.");
  }
  e.next();
}, "users");

// OAuth2 is disabled by default; if it is ever enabled, it must not create new accounts either.
// (js-event-hooks, onRecordAuthWithOAuth2Request: e.isNewRecord)
onRecordAuthWithOAuth2Request((e) => {
  if (e.isNewRecord) {
    throw new ForbiddenError("Sign-ups are closed.");
  }
  e.next();
}, "users");

// -----------------------------------------------------------------------------------------------
// gf_photos create: content-addressed upload. The API rule already requires
// @request.body.owner = @request.auth.id; here we re-check it, read the uploaded bytes
// (record.getUnsavedFiles - js-records; File.reader.open() - types.d.ts filesystem.File;
// toBytes() - types.d.ts), verify SHA-256, and set "bytes" and "mime" from the content.
// A duplicate (same owner + sha256) gets 409; the unique index is the final guard.
// -----------------------------------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const lib = require(`${__hooks}/gardenforge_lib.js`);
  const isSuperuser = e.hasSuperuserAuth();
  if (!isSuperuser) {
    if (!e.auth || e.auth.collection().name !== "users") {
      throw new ForbiddenError();
    }
    if (e.record.getString("owner") !== e.auth.id) {
      throw new ForbiddenError("owner must be the signed-in user.");
    }
  }

  const declared = e.record.getString("sha256");
  if (!lib.RE_SHA256.test(declared)) {
    throw new BadRequestError("sha256 must be 64 lowercase hexadecimal characters.");
  }

  // UNCERTAIN: the docs show getUnsavedFiles() for "inspecting ... the file(s) before save" but
  // do not say explicitly that the request hook already sees them; e.findUploadedFiles()
  // (js-routing, "Retrieving uploaded files") reads the same multipart field as a fallback.
  let files = e.record.getUnsavedFiles("file");
  if (!files || files.length === 0) {
    try {
      files = e.findUploadedFiles("file");
    } catch (err) {
      files = [];
    }
  }
  if (!files || files.length !== 1) {
    throw new BadRequestError("Exactly one file must be uploaded in the 'file' field.");
  }
  const file = files[0];
  if (file.size > lib.LIMITS.maxPhotoBytes) {
    throw new BadRequestError("The file is larger than " + lib.LIMITS.maxPhotoBytes + " bytes.");
  }

  let reader = null;
  let bytes = null;
  try {
    reader = file.reader.open();
    bytes = toBytes(reader, lib.LIMITS.maxPhotoBytes + 1);
  } finally {
    if (reader) {
      reader.close();
    }
  }
  if (!bytes || bytes.length === 0) {
    throw new BadRequestError("The uploaded file is empty.");
  }
  if (lib.sha256Hex(bytes) !== declared) {
    throw new BadRequestError("sha256 does not match the uploaded bytes.");
  }
  const mime = lib.sniffImageMime(bytes);
  if (!mime) {
    throw new BadRequestError("Only JPEG, PNG and WebP images are accepted.");
  }

  const owner = e.record.getString("owner");
  const dup = e.app.findRecordsByFilter(
    "gf_photos",
    "owner = {:owner} && sha256 = {:sha}",
    "",
    1,
    0,
    { owner: owner, sha: declared }
  );
  if (dup.length > 0) {
    throw new ApiError(409, "This photo is already stored (same sha256).");
  }

  e.record.set("bytes", bytes.length);
  e.record.set("mime", mime);
  e.next();
}, "gf_photos");

// -----------------------------------------------------------------------------------------------
// gf_conflicts update: the owner may only mark a conflict copy resolved (or unresolved).
// Two checks: the request body may contain no key except "resolved", and no stored field other
// than "resolved" may differ from its original value (record.original() - js-records "Copies").
// -----------------------------------------------------------------------------------------------
onRecordUpdateRequest((e) => {
  if (e.hasSuperuserAuth()) {
    return e.next();
  }
  const body = e.requestInfo().body || {};
  for (const key in body) {
    if (key !== "resolved") {
      throw new BadRequestError("Only the 'resolved' field of a conflict can be changed.");
    }
  }
  const original = e.record.original();
  const frozen = [
    "owner", "rid", "t", "op_id", "loser_rev", "loser_deleted", "loser_device_id",
    "loser_client_updated_at", "winner_rev", "server_seq"
  ];
  for (let i = 0; i < frozen.length; i++) {
    if (e.record.getString(frozen[i]) !== original.getString(frozen[i])) {
      throw new BadRequestError("Only the 'resolved' field of a conflict can be changed.");
    }
  }
  e.next();
}, "gf_conflicts");
