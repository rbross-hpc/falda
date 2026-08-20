/**
 * Tests for the `falda stats` interrogation tool (src/stats.ts).
 * Fully offline: temp root on disk, deterministic local embedder, no
 * network, no buildRuntime()/token file/embedding-lock enforcement.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PoolManager } from "../src/pools.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { initQueueSchema, enqueue } from "../src/distill/queue.js";
import { initRecallTraceSchema } from "../src/recall/schema.js";
import { createRecallTrace } from "../src/recall/traces.js";
import {
  buildStatsReport, listAllStores, inspectStore, renderHuman,
} from "../src/stats.js";

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "falda-stats-"));
}

describe("stats: store enumeration + inspection", () => {
  let root: string;
  let pools: PoolManager;

  before(async () => {
    root = makeTempRoot();
    pools = new PoolManager({ root, embed: makeLocalEmbedder(32), dim: 32 });

    const kukla = pools.resolve("kukla", undefined, true);
    await kukla.addStream("sess-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi!" },
    ]);
    await kukla.upsertAtom({ id: "a1", type: "fact", content: "Fact one.", pinned: true });
    await kukla.upsertAtom({ id: "a2", type: "fact", content: "Fact two." });
    kukla.archiveAtom("a2");
    kukla.writeCore("# Kukla core\npersona text");

    pools.declarePool("shared-corpus", { kukla: "readwrite" }, "test pool");
    const shared = pools.resolve("kukla", "shared-corpus", true);
    await shared.upsertAtom({ type: "fact", content: "Shared fact." });

    pools.closeAll();
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test("listAllStores finds self stores and declared pools", () => {
    const stores = listAllStores(root);
    const labels = stores.map((s) => s.label).sort();
    assert.deepEqual(labels, ["kukla:self", "shared-corpus:pool"]);
  });

  test("inspectStore reports correct tier counts for a self store", () => {
    const stores = listAllStores(root);
    const kuklaRef = stores.find((s) => s.label === "kukla:self")!;
    const report = inspectStore(kuklaRef);
    assert.ok(report.ok, "store opened cleanly");
    if (!report.ok) return;
    assert.equal(report.stream_total, 2);
    assert.equal(report.stream_head_seq, 2);
    assert.equal(report.atoms.active, 1);
    assert.equal(report.atoms.archived, 1);
    assert.equal(report.atoms_pinned, 1);
    assert.equal(report.core_present, true);
    assert.ok(report.core_chars > 0);
  });

  test("inspectStore on a declared-but-materialized pool store", () => {
    const stores = listAllStores(root);
    const poolRef = stores.find((s) => s.label === "shared-corpus:pool")!;
    const report = inspectStore(poolRef);
    assert.ok(report.ok);
    if (!report.ok) return;
    assert.equal(report.atoms.active, 1);
    assert.equal(report.stream_total, 0);
    assert.equal(report.core_present, false);
  });

  test("inspectStore on a nonexistent db path returns zeroed ok report, not an error", () => {
    const report = inspectStore({
      label: "ghost:pool", scope: "pool", name: "ghost",
      dbPath: path.join(root, "pools", "ghost", "falda.db"),
      blobDir: path.join(root, "pools", "ghost", "blobs"),
    });
    assert.ok(report.ok);
    if (!report.ok) return;
    assert.equal(report.stream_total, 0);
    assert.equal(report.atoms.active, 0);
  });

  test("buildStatsReport --tenant filter scopes to one self store", async () => {
    const report = await buildStatsReport({ root, tenant: "kukla" });
    assert.equal(report.stores.length, 1);
    assert.equal(report.stores[0].store.label, "kukla:self");
  });

  test("buildStatsReport --pool filter scopes to one pool store", async () => {
    const report = await buildStatsReport({ root, pool: "shared-corpus" });
    assert.equal(report.stores.length, 1);
    assert.equal(report.stores[0].store.label, "shared-corpus:pool");
  });

  test("buildStatsReport --section limits which sections run", async () => {
    const report = await buildStatsReport({ root, sections: ["stores"] });
    assert.equal(report.stores.length, 2);
    assert.equal(report.queue.present, false);
    assert.deepEqual(report.sections, ["stores"]);
  });

  test("renderHuman only prints requested sections", async () => {
    const report = await buildStatsReport({ root, sections: ["queue"] });
    const text = renderHuman(report);
    assert.ok(text.includes("## Distillation queue"));
    assert.ok(!text.includes("## Stores"));
    assert.ok(!text.includes("## Recall metrics"));
    assert.ok(!text.includes("## Layout"));
  });
});

describe("stats: distillation queue health", () => {
  let root: string;

  before(() => { root = makeTempRoot(); });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test("reports counts by status and flags dead jobs as an error warning", async () => {
    const queueDb = new Database(path.join(root, "distill_queue.db"));
    queueDb.pragma("busy_timeout = 5000");
    initQueueSchema(queueDb);
    enqueue(queueDb, "proj-a:self");
    const deadId = enqueue(queueDb, "proj-b:self");
    queueDb.prepare("UPDATE distill_jobs SET status='dead', attempts=8, error=? WHERE id=?")
      .run("boom", deadId);
    queueDb.close();

    const report = await buildStatsReport({ root });
    assert.equal(report.queue.present, true);
    assert.equal(report.queue.by_status.pending, 1);
    assert.equal(report.queue.by_status.dead, 1);
    assert.equal(report.queue.dead_jobs.length, 1);
    assert.equal(report.queue.dead_jobs[0].store_key, "proj-b:self");
    assert.ok(
      report.warnings.some((w) => w.level === "error" && w.message.includes("dead-lettered")),
      "dead job surfaces as an error-level warning",
    );
  });

  test("stale pending job surfaces a warn-level warning", async () => {
    const staleRoot = makeTempRoot();
    try {
      const queueDb = new Database(path.join(staleRoot, "distill_queue.db"));
      initQueueSchema(queueDb);
      const id = enqueue(queueDb, "proj-c:self");
      const oldTs = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
      queueDb.prepare("UPDATE distill_jobs SET created_at=? WHERE id=?").run(oldTs, id);
      queueDb.close();

      const report = await buildStatsReport({ root: staleRoot });
      assert.ok(
        report.warnings.some((w) => w.level === "warn" && w.message.includes("waiting")),
        "stale pending job surfaces a warning",
      );
    } finally {
      fs.rmSync(staleRoot, { recursive: true, force: true });
    }
  });

  test("no queue db present is reported cleanly, not an error", async () => {
    const emptyRoot = makeTempRoot();
    try {
      const report = await buildStatsReport({ root: emptyRoot, sections: ["queue"] });
      assert.equal(report.queue.present, false);
      assert.deepEqual(report.queue.by_status, {});
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe("stats: recall metrics", () => {
  test("aggregates trace/item counts per store_key", async () => {
    const root = makeTempRoot();
    try {
      const db = new Database(path.join(root, "recall_traces.db"));
      initRecallTraceSchema(db);
      createRecallTrace(db, {
        store_key: "kukla:self",
        tenant: "kukla",
        pool: null,
        query: "cryostat temperature",
        requested_budget: 6000,
        used_budget: 400,
        policy_snapshot: {
          weights: { recency: 1, priority: 1, confidence: 1 },
          budgets: { pinned: 500, atoms: 2000, scenes: 2000, core: 1500 },
          recency_half_life_days: 30,
          version: "v1",
        },
        items: [{ tier: "T1", id: "a1", kind: "atom", source: "ranked", score: 1, chars: 100 }],
      });
      db.close();

      const report = await buildStatsReport({ root, sections: ["recall"] });
      assert.equal(report.recall.present, true);
      assert.equal(report.recall.by_store.length, 1);
      assert.equal(report.recall.by_store[0].store_key, "kukla:self");
      assert.equal(report.recall.by_store[0].trace_count, 1);
      assert.equal(report.recall.by_store[0].item_count, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("no recall_traces.db present is reported cleanly", async () => {
    const root = makeTempRoot();
    try {
      const report = await buildStatsReport({ root, sections: ["recall"] });
      assert.equal(report.recall.present, false);
      assert.deepEqual(report.recall.by_store, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("stats: layout + embedding lock", () => {
  test("flags a dim mismatch between EMBEDDING.json and current env as an error", async () => {
    const root = makeTempRoot();
    try {
      fs.writeFileSync(
        path.join(root, "EMBEDDING.json"),
        JSON.stringify({ model: "nomic-embed-text", dim: 768, locked: true, locked_at: "2024-01-01" }),
      );
      const prevDim = process.env.FALDA_DIM;
      process.env.FALDA_DIM = "32";
      try {
        const report = await buildStatsReport({ root, sections: ["layout"] });
        assert.equal(report.layout.embedding_lock.present, true);
        assert.equal(report.layout.embedding_lock.dim, 768);
        assert.ok(
          report.warnings.some((w) => w.level === "error" && w.message.includes("dim=768")),
          "dim mismatch surfaces as an error-level warning",
        );
      } finally {
        if (prevDim === undefined) delete process.env.FALDA_DIM; else process.env.FALDA_DIM = prevDim;
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing token file surfaces a warn-level warning with the resolved path", async () => {
    const root = makeTempRoot();
    try {
      const prevTokens = process.env.FALDA_TOKENS;
      process.env.FALDA_TOKENS = path.join(root, "does-not-exist-tokens.json");
      try {
        const report = await buildStatsReport({ root, sections: ["layout"] });
        assert.equal(report.layout.tokens_file.present, false);
        assert.ok(report.warnings.some((w) => w.level === "warn" && w.message.includes("no token file found")));
      } finally {
        if (prevTokens === undefined) delete process.env.FALDA_TOKENS; else process.env.FALDA_TOKENS = prevTokens;
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty root: no stores found surfaces a warn-level warning, exit stays non-error", async () => {
    const root = makeTempRoot();
    try {
      const report = await buildStatsReport({ root });
      assert.ok(report.warnings.some((w) => w.level === "warn" && w.message.includes("no stores found")));
      assert.ok(!report.warnings.some((w) => w.level === "error"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
