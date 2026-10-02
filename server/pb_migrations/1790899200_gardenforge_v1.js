/// <reference path="../pb_data/types.d.ts" />
//
// GardenForge schema v1 for the self-hosted sync server.
//
// STATUS: NOT YET EXECUTED - verify on first install. Written from the PocketBase docs
// (js-migrations, js-collections, api-rules-and-filters, files-handling) and the field option
// names in the JSVM type declarations, without running PocketBase.
//
// PocketBase applies every unapplied file in pb_migrations automatically, inside a transaction,
// when "serve" starts, and records it in the _migrations table so it runs only once
// (js-migrations). If anything below fails, nothing is created and the server refuses to start;
// the error is in the service log (journalctl -u gardenforge-pocketbase).
//
// API rules (api-rules-and-filters): null = "locked" (superusers only), "" = anyone,
// a filter string = only requests that satisfy it. Superusers bypass every rule.
//
// Collections:
//   gf_records      one row per synced record envelope; read-only for the owner, written only by
//                   POST /api/gf/sync/push (create/update/delete rules locked)
//   gf_conflicts    the losing version of every conflict, never discarded; the owner may only set
//                   "resolved" (enforced by the update rule plus a hook in gardenforge_sync.pb.js)
//   gf_applied_ops  stored push results, for idempotent retries; fully locked
//   gf_counters     per-owner server sequence number and epoch; fully locked
//   gf_photos       content-addressed photo files (protected), one per owner + sha256
// And the built-in "users" collection: sign-ups closed, self-delete disabled.

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const OWNER_ONLY = '@request.auth.id != "" && owner = @request.auth.id';

  // Every gf_* row belongs to one user. cascadeDelete: deleting that user (superusers only, see
  // the users rules below) deletes the user's rows too (js-collections, relation field example).
  function ownerField() {
    return {
      name: "owner",
      type: "relation",
      required: true,
      maxSelect: 1,
      collectionId: users.id,
      cascadeDelete: true
    };
  }
  // Base collections created in code do not get "created"/"updated" automatically: the docs'
  // go-collections "Create new collection" example adds them as autodate fields, as done here
  // (AutodateField onCreate/onUpdate - types.d.ts). Even if a release did add them, a field with
  // the same name replaces the existing one (types.d.ts FieldsList.add).
  function createdField() {
    return { name: "created", type: "autodate", onCreate: true, onUpdate: false };
  }
  function updatedField() {
    return { name: "updated", type: "autodate", onCreate: true, onUpdate: true };
  }

  // ---------------------------------------------------------------------------------------------
  // gf_records
  // "data" is not marked required because a tombstone of a record the server never saw may have
  // no data, and PocketBase's required check rejects null, "", [] and {} (types.d.ts JSONField).
  // The push route requires an object for every non-delete op.
  // maxSize is 128 KiB although the push route limits data to 64 KiB (UTF-8 of JSON.stringify):
  // the server re-serializes JSON and may escape characters such as < > & as <, which can
  // grow the stored text (UNCERTAIN: exact re-serialization not verified), so the field limit
  // keeps a margin and the route enforces the real limit.
  // ---------------------------------------------------------------------------------------------
  const records = new Collection({
    type: "base",
    name: "gf_records",
    listRule: OWNER_ONLY,
    viewRule: OWNER_ONLY,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      ownerField(),
      { name: "rid", type: "text", required: true, max: 200 },
      { name: "t", type: "text", required: true, max: 40 },
      { name: "data", type: "json", maxSize: 131072 },
      { name: "rev", type: "number", required: true, min: 1, onlyInt: true },
      { name: "client_updated_at", type: "text", max: 64 },
      { name: "device_id", type: "text", max: 80 },
      { name: "deleted", type: "bool" },
      { name: "server_seq", type: "number", required: true, min: 1, onlyInt: true },
      { name: "origin_op", type: "text", max: 80 },
      createdField(),
      updatedField()
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_gf_records_owner_rid ON gf_records (owner, rid)",
      "CREATE INDEX idx_gf_records_owner_seq ON gf_records (owner, server_seq)"
    ]
  });
  app.save(records);

  // ---------------------------------------------------------------------------------------------
  // gf_conflicts
  // updateRule is owner-only; the hook in gardenforge_sync.pb.js rejects any change except
  // "resolved". create/delete are locked: conflict copies are created only by the push route and
  // are never deleted through the API.
  // ---------------------------------------------------------------------------------------------
  const conflicts = new Collection({
    type: "base",
    name: "gf_conflicts",
    listRule: OWNER_ONLY,
    viewRule: OWNER_ONLY,
    createRule: null,
    updateRule: OWNER_ONLY,
    deleteRule: null,
    fields: [
      ownerField(),
      { name: "rid", type: "text", required: true, max: 200 },
      { name: "t", type: "text", max: 40 },
      { name: "op_id", type: "text", max: 80 },
      { name: "loser_data", type: "json", maxSize: 131072 },
      { name: "loser_rev", type: "number", min: 0, onlyInt: true },
      { name: "loser_deleted", type: "bool" },
      { name: "loser_device_id", type: "text", max: 80 },
      { name: "loser_client_updated_at", type: "text", max: 64 },
      { name: "winner_rev", type: "number", required: true, min: 1, onlyInt: true },
      { name: "server_seq", type: "number", required: true, min: 1, onlyInt: true },
      { name: "resolved", type: "bool" },
      createdField(),
      updatedField()
    ],
    indexes: [
      "CREATE INDEX idx_gf_conflicts_owner_seq ON gf_conflicts (owner, server_seq)",
      "CREATE INDEX idx_gf_conflicts_owner_resolved ON gf_conflicts (owner, resolved)"
    ]
  });
  app.save(conflicts);

  // ---------------------------------------------------------------------------------------------
  // gf_applied_ops - one stored result per (owner, opId). A retried push returns it unchanged.
  // Not pruned yet (docs/SYNC-ARCHITECTURE.md suggests pruning after 90 days; not implemented).
  // ---------------------------------------------------------------------------------------------
  const appliedOps = new Collection({
    type: "base",
    name: "gf_applied_ops",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      ownerField(),
      { name: "op_id", type: "text", required: true, max: 80 },
      { name: "result", type: "json", maxSize: 524288 },
      createdField()
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_gf_applied_ops_owner_op ON gf_applied_ops (owner, op_id)"
    ]
  });
  app.save(appliedOps);

  // ---------------------------------------------------------------------------------------------
  // gf_counters - per-owner sequence number for the pull cursor, plus an epoch string that is
  // rotated after a restore (POST /api/gf/admin/rotate-epoch). "seq" is not required because a
  // new counter starts at 0 and PocketBase's required check rejects 0 (types.d.ts NumberField).
  // ---------------------------------------------------------------------------------------------
  const counters = new Collection({
    type: "base",
    name: "gf_counters",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      ownerField(),
      { name: "seq", type: "number", min: 0, onlyInt: true },
      { name: "epoch", type: "text", max: 40 },
      createdField(),
      updatedField()
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_gf_counters_owner ON gf_counters (owner)"
    ]
  });
  app.save(counters);

  // ---------------------------------------------------------------------------------------------
  // gf_photos - content-addressed image files.
  // "protected": the file is served only with a short-lived file token AND only to requests that
  // satisfy the view rule (files-handling, "Protected files").
  // create rule: signed in, and the submitted owner must be the caller. The create hook in
  // gardenforge_sync.pb.js re-checks the owner, verifies sha256 against the bytes and sets
  // "bytes" and "mime". update/delete are locked: photos are immutable.
  // maxSize 25 MiB (26,214,400 bytes) covers docs/DATA-MODEL.md's limit of 25,000,000 bytes.
  // ---------------------------------------------------------------------------------------------
  const photos = new Collection({
    type: "base",
    name: "gf_photos",
    listRule: OWNER_ONLY,
    viewRule: OWNER_ONLY,
    createRule: '@request.auth.id != "" && @request.body.owner = @request.auth.id',
    updateRule: null,
    deleteRule: null,
    fields: [
      ownerField(),
      { name: "sha256", type: "text", required: true, min: 64, max: 64, pattern: "^[0-9a-f]{64}$" },
      {
        name: "file",
        type: "file",
        required: true,
        maxSelect: 1,
        maxSize: 26214400,
        mimeTypes: ["image/jpeg", "image/png", "image/webp"],
        protected: true
      },
      { name: "bytes", type: "number", min: 0, max: 26214400, onlyInt: true },
      { name: "width", type: "number", min: 0, max: 10000, onlyInt: true },
      { name: "height", type: "number", min: 0, max: 10000, onlyInt: true },
      { name: "mime", type: "text", max: 40 },
      createdField()
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_gf_photos_owner_sha ON gf_photos (owner, sha256)"
    ]
  });
  app.save(photos);

  // ---------------------------------------------------------------------------------------------
  // users (built-in auth collection)
  // createRule = null: only a superuser can create accounts, so public sign-up is closed
  //   (api-rules-and-filters: "locked" rules answer 403 to everyone but superusers).
  //   gardenforge_sync.pb.js also rejects non-superuser creates in a hook.
  // deleteRule = null: a stolen session token cannot delete the account, which would cascade-
  //   delete every gf_* row. The superuser can still delete accounts from the dashboard.
  // ---------------------------------------------------------------------------------------------
  // unmarshal(data, dst) merges JSON-style data onto a model (types.d.ts example:
  // "unmarshal({ authAlert: { enabled: true } }, collection)"); it is the form PocketBase's own
  // autogenerated migrations use, and it sets the nullable rule fields to null reliably.
  unmarshal({ createRule: null, deleteRule: null }, users);
  app.save(users);
}, (app) => {
  // Revert: drop the gf_* collections, but ONLY if they are empty. A "migrate down" must never
  // delete garden data; export or back up first, then empty the collections by hand if you
  // really mean it. The users rules are left closed on purpose (re-opening sign-ups is never a
  // safe default).
  const names = ["gf_photos", "gf_conflicts", "gf_applied_ops", "gf_counters", "gf_records"];
  for (const name of names) {
    const n = app.countRecords(name);
    if (n > 0) {
      throw new Error("Refusing to drop " + name + ": it holds " + n + " record(s). Back up and empty it first.");
    }
  }
  for (const name of names) {
    app.delete(app.findCollectionByNameOrId(name));
  }
});
