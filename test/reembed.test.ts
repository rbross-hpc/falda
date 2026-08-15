/**
 * Tests for `falda reembed` (src/reembed.ts) — rebuilding dense-vector
 * indexes after a model/dimension change.
 *
 * Fully offline: temp root on disk, deterministic local embedder (FALDA_EMBED
 * forced to "local" so selectEmbedder inside reembedStore doesn't hit the
 * network), no buildRuntime()/token file involved.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PoolManager } from "../src/pools.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { selectStores, reembedStore, writeEmbeddingManifest } from "../src/reembed.js";

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "falda-reembed-"));
}

describe("reembed: store selection", () => {
  let root: string;

  before(async () => {
    root = makeTempRoot();
    const pools = new PoolManager({ root, embed: makeLocalEmbedder(16), dim: 16 });
    const a = pools.resolve("acme", undefined, true);
    await a.upsertAtom({ type: "fact", content: "acme fact" });
    const b = pools.resolve("beta", undefined, true);
    await b.upsertAtom({ type: "fact", content: "beta fact" });
    pools.declarePool("shared", { acme: "readwrite" }, "test pool");
    const shared = pools.resolve("acme", "shared", true);
    await shared.upsertAtom({ type: "fact", content: "shared fact" });
    pools.closeAll();
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test("no filter selects every store", () => {
    const stores = selectStores(root, {});
    const labels = stores.map((s) => s.label).sort();
    assert.deepEqual(labels, ["acme:self", "beta:self", "shared:pool"]);
  });

  test("--tenant filters to one self store", () => {
    const stores = selectStores(root, { tenant: "acme" });
    assert.deepEqual(stores.map((s) => s.label), ["acme:self"]);
  });

  test("--pool filters to one pool store", () => {
    const stores = selectStores(root, { pool: "shared" });
    assert.deepEqual(stores.map((s) => s.label), ["shared:pool"]);
  });
});

describe("reembed: rebuilding vec tables at a new dimension", () => {
  let root: string;
  const savedEmbed = process.env.FALDA_EMBED;
  const savedModel = process.env.FALDA_EMBED_MODEL;

  before(async () => {
    root = makeTempRoot();
    process.env.FALDA_EMBED = "local";

    const pools = new PoolManager({ root, embed: makeLocalEmbedder(16), dim: 16 });
    const store = pools.resolve("acme", undefined, true);
    await store.addStream("sess-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    await store.upsertAtom({ id: "a1", type: "fact", content: "The sky is blue." });
    await store.upsertAtom({ id: "a2", type: "fact", content: "Water boils at 100C." });
    await store.upsertScene({ scene_kind: "topic", title: "weather", atom_ids: ["a1"], summary: "notes about weather" });
    pools.closeAll();

    fs.writeFileSync(path.join(root, "EMBEDDING.json"), JSON.stringify({ model: "old-model", dim: 16, locked: true, locked_at: "2020-01-01" }));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (savedEmbed === undefined) delete process.env.FALDA_EMBED; else process.env.FALDA_EMBED = savedEmbed;
    if (savedModel === undefined) delete process.env.FALDA_EMBED_MODEL; else process.env.FALDA_EMBED_MODEL = savedModel;
  });

  test("reembedStore rewrites vec tables at the new dim and reports correct counts", async () => {
    const [storeRef] = selectStores(root, { tenant: "acme" });
    assert.ok(storeRef, "store found");

    const result = await reembedStore(storeRef, 32);
    assert.equal(result.dim, 32);
    assert.equal(result.atoms, 2);
    assert.equal(result.scenes, 1);
    assert.equal(result.stream, 2);

    // Vec tables are vec0 virtual tables — need the sqlite-vec extension
    // loaded even just to COUNT(*) them (see src/stats.ts's doc header,
    // which is why the read-only stats inspector deliberately avoids them).
    const db = new Database(storeRef.dbPath, { readonly: true, fileMustExist: true });
    sqliteVec.load(db);
    try {
      const atomVecCount = (db.prepare("SELECT COUNT(*) c FROM atoms_vec").get() as any).c;
      assert.equal(atomVecCount, 2, "atoms_vec repopulated");
      const sceneVecCount = (db.prepare("SELECT COUNT(*) c FROM scenes_vec").get() as any).c;
      assert.equal(sceneVecCount, 1, "scenes_vec repopulated");
      const streamVecCount = (db.prepare("SELECT COUNT(*) c FROM stream_vec").get() as any).c;
      assert.equal(streamVecCount, 2, "stream_vec repopulated");
    } finally {
      db.close();
    }
  });

  test("reembedded store is searchable at the new dimension", async () => {
    const [storeRef] = selectStores(root, { tenant: "acme" });
    const pools = new PoolManager({ root, embed: makeLocalEmbedder(32), dim: 32 });
    try {
      const reopened = pools.resolve("acme", undefined, false);
      const hits = await reopened.searchAtoms("sky color", 5);
      assert.ok(hits.some((h) => h.content.includes("sky")), "atom content still recallable after reembed");
    } finally {
      pools.closeAll();
    }
  });

  test("writeEmbeddingManifest overwrites EMBEDDING.json unconditionally", () => {
    process.env.FALDA_EMBED_MODEL = "new-model";
    writeEmbeddingManifest(root, 32);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "EMBEDDING.json"), "utf8"));
    assert.equal(manifest.model, "new-model");
    assert.equal(manifest.dim, 32);
  });
});
