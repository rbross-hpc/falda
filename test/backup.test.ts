/**
 * Tests for `falda backup` / `falda restore` (src/backup.ts, src/restore.ts)
 * — docs/future/reliability-hardening.md finding 10.
 *
 * Fully offline: temp roots on disk, deterministic local embedder, no
 * network, no buildRuntime()/token file/embedding-lock enforcement. Builds
 * a populated multi-store root (self store + pool store + core.md +
 * distill_queue.db + recall_traces.db), backs it up, restores it into a
 * fresh root, and verifies parity via inspectStore + a live Falda read —
 * the actual backup/restore roundtrip a real deployment would perform.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PoolManager } from "../src/pools.js";
import { Falda } from "../src/falda.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { initQueueSchema, enqueue } from "../src/distill/queue.js";
import { initRecallTraceSchema } from "../src/recall/schema.js";
import { createRecallTrace } from "../src/recall/traces.js";
import { inspectStore, listAllStores } from "../src/stats.js";
import { runBackup, selectStores } from "../src/backup.js";
import { runRestore, readManifest, verifyManifestFiles, checkDimCompatibility } from "../src/restore.js";

function makeTempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `falda-${prefix}-`));
}

async function buildPopulatedRoot(): Promise<string> {
  const root = makeTempDir("backup-src");
  const pools = new PoolManager({ root, embed: makeLocalEmbedder(16), dim: 16 });

  const acme = pools.resolve("acme", undefined, true);
  await acme.addStream("sess-1", [
    { role: "user", content: "hello world" },
    { role: "assistant", content: "hi there" },
  ]);
  await acme.upsertAtom({ id: "a1", type: "fact", content: "Fact one.", pinned: true });
  await acme.upsertAtom({ id: "a2", type: "fact", content: "Fact two." });
  acme.archiveAtom("a2");
  acme.writeCore("# Acme core\npersona text");

  pools.declarePool("shared", { acme: "readwrite" }, "test pool");
  const shared = pools.resolve("acme", "shared", true);
  await shared.upsertAtom({ type: "fact", content: "Shared fact." });

  pools.closeAll();

  fs.writeFileSync(
    path.join(root, "EMBEDDING.json"),
    JSON.stringify({ model: "local", dim: 16, locked: true, locked_at: "2026-01-01" }, null, 2)
  );

  const queueDb = new Database(path.join(root, "distill_queue.db"));
  initQueueSchema(queueDb);
  enqueue(queueDb, "acme:self");
  queueDb.close();

  const traceDb = new Database(path.join(root, "recall_traces.db"));
  initRecallTraceSchema(traceDb);
  createRecallTrace(traceDb, {
    store_key: "acme:self", tenant: "acme", pool: null,
    query: "hello", requested_budget: 6000, used_budget: 400,
    policy_snapshot: {
      weights: { recency: 1, priority: 1, confidence: 1 },
      budgets: { pinned: 500, atoms: 2000, scenes: 2000, core: 1500 },
      recency_half_life_days: 30, version: "v1",
    },
    items: [{ tier: "T1", id: "a1", kind: "atom", source: "fts", score: 1, chars: 100 }],
  });
  traceDb.close();

  return root;
}

describe("backup: store selection", () => {
  let root: string;
  before(async () => { root = await buildPopulatedRoot(); });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test("no filter selects every store", () => {
    const stores = selectStores(root, {});
    assert.deepEqual(stores.map((s) => s.label).sort(), ["acme:self", "shared:pool"]);
  });

  test("--tenant filters to one self store", () => {
    assert.deepEqual(selectStores(root, { tenant: "acme" }).map((s) => s.label), ["acme:self"]);
  });

  test("--pool filters to one pool store", () => {
    assert.deepEqual(selectStores(root, { pool: "shared" }).map((s) => s.label), ["shared:pool"]);
  });
});

describe("backup: runBackup writes a checksummed, complete snapshot", () => {
  let srcRoot: string;
  let outDir: string;

  before(async () => {
    srcRoot = await buildPopulatedRoot();
    outDir = path.join(makeTempDir("backup-out-parent"), "out");
  });
  after(() => {
    fs.rmSync(srcRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outDir), { recursive: true, force: true });
  });

  test("manifest lists every store, top-level file, with correct checksums", () => {
    const manifest = runBackup({ root: srcRoot, outDir });
    assert.equal(manifest.root_dim, 16);
    assert.equal(manifest.embedding_model, "local");

    const labels = manifest.stores.map((s) => s.label).sort();
    assert.deepEqual(labels, ["acme:self", "shared:pool"]);

    const acmeEntry = manifest.stores.find((s) => s.label === "acme:self")!;
    assert.ok(acmeEntry.db, "acme falda.db captured");
    assert.equal(acmeEntry.blobs.length, 1, "core.md captured as the one blob");
    assert.match(acmeEntry.blobs[0].rel_path, /core\.md$/);

    const sharedEntry = manifest.stores.find((s) => s.label === "shared:pool")!;
    assert.ok(sharedEntry.db, "shared falda.db captured");
    assert.equal(sharedEntry.blobs.length, 0, "no core.md written for the pool store");

    const topNames = manifest.top_level.map((f) => f.rel_path).sort();
    assert.deepEqual(topNames, ["EMBEDDING.json", "distill_queue.db", "pools.json", "recall_traces.db"]);

    // Every file the manifest claims to have captured exists on disk with a
    // matching size + checksum (this is exactly what verifyManifestFiles
    // does on the restore side — exercise it here too).
    assert.doesNotThrow(() => verifyManifestFiles(outDir, manifest));

    // The manifest itself round-trips through readManifest().
    const reread = readManifest(outDir);
    assert.deepEqual(reread, manifest);
  });

  test("VACUUM INTO snapshots open cleanly as ordinary SQLite files", () => {
    const dbPath = path.join(outDir, "tenants", "acme", "self", "falda.db");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT COUNT(*) c FROM stream").get() as { c: number };
      assert.equal(row.c, 2);
    } finally {
      db.close();
    }
  });

  test("refuses to write into an already-populated --out directory", () => {
    assert.throws(() => runBackup({ root: srcRoot, outDir }), /already exists and is not empty/);
  });

  test("--tenant scoping backs up only that store plus top-level files", () => {
    const scopedOut = path.join(makeTempDir("backup-scoped-parent"), "out");
    try {
      const manifest = runBackup({ root: srcRoot, outDir: scopedOut, tenant: "acme" });
      assert.deepEqual(manifest.stores.map((s) => s.label), ["acme:self"]);
      assert.ok(manifest.top_level.length > 0, "top-level files still captured under --tenant scoping");
    } finally {
      fs.rmSync(path.dirname(scopedOut), { recursive: true, force: true });
    }
  });

  test("a declared-but-never-materialized pool store backs up with no db, no blobs, no error", () => {
    const root2 = makeTempDir("backup-ghost");
    const out2 = path.join(makeTempDir("backup-ghost-out-parent"), "out");
    try {
      const pools = new PoolManager({ root: root2, embed: makeLocalEmbedder(16), dim: 16 });
      pools.declarePool("never-written", {}, "declared, never opened for writes");
      pools.closeAll();

      const manifest = runBackup({ root: root2, outDir: out2 });
      const ghost = manifest.stores.find((s) => s.label === "never-written:pool");
      assert.ok(ghost);
      assert.equal(ghost!.db, undefined, "no db captured for an unmaterialized store");
      assert.deepEqual(ghost!.blobs, []);
    } finally {
      fs.rmSync(root2, { recursive: true, force: true });
      fs.rmSync(path.dirname(out2), { recursive: true, force: true });
    }
  });
});

describe("restore: full roundtrip parity", () => {
  let srcRoot: string;
  let backupDir: string;

  before(async () => {
    srcRoot = await buildPopulatedRoot();
    backupDir = path.join(makeTempDir("restore-backup-parent"), "out");
    runBackup({ root: srcRoot, outDir: backupDir });
  });
  after(() => {
    fs.rmSync(srcRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(backupDir), { recursive: true, force: true });
  });

  test("restoring into a fresh root reproduces every store's tier counts (inspectStore parity)", () => {
    const targetRoot = path.join(makeTempDir("restore-target-parent"), "root");
    try {
      const result = runRestore({ backupDir, targetRoot });
      assert.equal(result.verification.length, 2);
      for (const v of result.verification) assert.ok(v.ok, `${v.label} verified cleanly: ${v.error ?? ""}`);

      const acmeV = result.verification.find((v) => v.label === "acme:self")!;
      assert.equal(acmeV.stream_total, 2);
      assert.equal(acmeV.atoms_active, 1);

      const sharedV = result.verification.find((v) => v.label === "shared:pool")!;
      assert.equal(sharedV.stream_total, 0);
      assert.equal(sharedV.atoms_active, 1);

      // Cross-check against the original root's own inspectStore output, not
      // just hardcoded expectations.
      const originalReports = listAllStores(srcRoot).map((s) => inspectStore(s));
      for (const orig of originalReports) {
        if (!orig.ok) continue;
        const restored = result.verification.find((v) => v.label === orig.store.label)!;
        assert.equal(restored.stream_total, orig.stream_total);
        assert.equal(restored.atoms_active, orig.atoms.active);
      }
    } finally {
      fs.rmSync(path.dirname(targetRoot), { recursive: true, force: true });
    }
  });

  test("a restored store opens with a live Falda and returns the original content", async () => {
    const targetRoot = path.join(makeTempDir("restore-live-parent"), "root");
    try {
      runRestore({ backupDir, targetRoot });
      const s = new Falda({
        dbPath: path.join(targetRoot, "tenants", "acme", "self", "falda.db"),
        blobDir: path.join(targetRoot, "tenants", "acme", "self", "blobs"),
        embed: makeLocalEmbedder(16), dim: 16,
      });
      try {
        const hits = await s.searchStream("hello world", 5);
        assert.ok(hits.length >= 1);
        assert.equal(s.readCore(), "# Acme core\npersona text");
        const { items } = s.queryAtoms({});
        assert.equal(items.length, 1);
        assert.equal(items[0].content, "Fact one.");
      } finally {
        s.close();
      }
    } finally {
      fs.rmSync(path.dirname(targetRoot), { recursive: true, force: true });
    }
  });

  test("root-level distill_queue.db and recall_traces.db are restored and openable", () => {
    const targetRoot = path.join(makeTempDir("restore-toplevel-parent"), "root");
    try {
      runRestore({ backupDir, targetRoot });

      const queueDb = new Database(path.join(targetRoot, "distill_queue.db"), { readonly: true });
      const jobRow = queueDb.prepare("SELECT COUNT(*) c FROM distill_jobs").get() as { c: number };
      assert.equal(jobRow.c, 1);
      queueDb.close();

      const traceDb = new Database(path.join(targetRoot, "recall_traces.db"), { readonly: true });
      const traceRow = traceDb.prepare("SELECT COUNT(*) c FROM recall_traces").get() as { c: number };
      assert.equal(traceRow.c, 1);
      traceDb.close();

      const poolsJson = JSON.parse(fs.readFileSync(path.join(targetRoot, "pools.json"), "utf8"));
      assert.ok(poolsJson.pools?.shared);
    } finally {
      fs.rmSync(path.dirname(targetRoot), { recursive: true, force: true });
    }
  });

  test("refuses to restore into a non-empty target without force", () => {
    const targetRoot = path.join(makeTempDir("restore-nonempty-parent"), "root");
    try {
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(path.join(targetRoot, "sentinel.txt"), "pre-existing");
      assert.throws(() => runRestore({ backupDir, targetRoot }), /not empty/);
      // force=true proceeds despite the pre-existing file.
      const result = runRestore({ backupDir, targetRoot, force: true });
      assert.ok(result.verification.every((v) => v.ok));
    } finally {
      fs.rmSync(path.dirname(targetRoot), { recursive: true, force: true });
    }
  });

  test("checkDimCompatibility rejects a target root locked to a different dimension", () => {
    const targetRoot = path.join(makeTempDir("restore-dimcheck-parent"), "root");
    try {
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(path.join(targetRoot, "EMBEDDING.json"), JSON.stringify({ model: "local", dim: 32, locked: true }));
      const manifest = readManifest(backupDir);
      assert.throws(() => checkDimCompatibility(targetRoot, manifest), /dim=32.*dim=16|dim=16.*dim=32|dim mismatch|inconsistent/i);
      assert.throws(() => runRestore({ backupDir, targetRoot, force: true }), /inconsistent/);
    } finally {
      fs.rmSync(path.dirname(targetRoot), { recursive: true, force: true });
    }
  });

  test("checkDimCompatibility allows a target root with no EMBEDDING.json yet", () => {
    const targetRoot = path.join(makeTempDir("restore-nolock-parent"), "root");
    try {
      const manifest = readManifest(backupDir);
      assert.doesNotThrow(() => checkDimCompatibility(targetRoot, manifest));
    } finally {
      fs.rmSync(path.dirname(targetRoot), { recursive: true, force: true });
    }
  });

  test("verifyManifestFiles throws on a corrupted backup file (size/checksum mismatch)", () => {
    const corruptDir = path.join(makeTempDir("restore-corrupt-parent"), "out");
    try {
      fs.cpSync(backupDir, corruptDir, { recursive: true });
      fs.appendFileSync(path.join(corruptDir, "pools.json"), "\n// corrupted");
      const manifest = readManifest(corruptDir);
      assert.throws(() => verifyManifestFiles(corruptDir, manifest), /size mismatch|checksum mismatch/);

      const targetRoot = path.join(makeTempDir("restore-corrupt-target-parent"), "root");
      assert.throws(() => runRestore({ backupDir: corruptDir, targetRoot }), /size mismatch|checksum mismatch/);
      fs.rmSync(path.dirname(targetRoot), { recursive: true, force: true });
    } finally {
      fs.rmSync(path.dirname(corruptDir), { recursive: true, force: true });
    }
  });

  test("readManifest throws a clear error when backup-manifest.json is missing", () => {
    const notABackup = makeTempDir("restore-not-a-backup");
    try {
      assert.throws(() => readManifest(notABackup), /no backup-manifest\.json found/);
    } finally {
      fs.rmSync(notABackup, { recursive: true, force: true });
    }
  });
});
