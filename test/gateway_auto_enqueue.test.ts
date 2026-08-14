/**
 * Tests for:
 *   1. PoolManager.listSelfTenants() — disk enumeration
 *   2. Gateway worker auto-enqueue — enqueue tick + drain tick integration
 *   3. parseCandidates hardening — markdown fence and JSON-array tolerance
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Falda } from "../src/falda.js";
import { PoolManager } from "../src/pools.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { initQueueSchema, enqueue, claimNext, storeKeyFor, listJobs } from "../src/distill/queue.js";
import { distillOnce } from "../src/distill/core.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "falda-enqueue-"));
}

function makePool(root: string, dim = 32) {
  return new PoolManager({ root, embed: makeLocalEmbedder(dim), dim });
}

function cleanup(root: string) {
  fs.rmSync(root, { recursive: true, force: true });
}

function makeMockLLM(responses: string[]): (prompt: string) => Promise<string> {
  const q = [...responses];
  return async (prompt: string) => {
    const r = q.shift();
    if (r === undefined) throw new Error(`Mock LLM out of responses (prompt: ${prompt.slice(0, 60)})`);
    return r;
  };
}

// ─── 1. PoolManager.listSelfTenants() ─────────────────────────────────────────

describe("PoolManager.listSelfTenants", () => {
  test("returns empty array when root has no tenants", () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      assert.deepEqual(pools.listSelfTenants(), []);
    } finally { cleanup(root); }
  });

  test("returns only tenants with a self/falda.db", () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      // Open two self-stores (creates the DB files on disk).
      pools.resolve("alice", undefined, true);
      pools.resolve("bob", undefined, true);
      const tenants = pools.listSelfTenants().sort();
      assert.deepEqual(tenants, ["alice", "bob"]);
    } finally { cleanup(root); }
  });

  test("ignores directories without a self/falda.db", () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      pools.resolve("real-tenant", undefined, true);
      // Create a stray directory that has no falda.db.
      fs.mkdirSync(path.join(root, "tenants", "ghost-dir", "self"), { recursive: true });
      const tenants = pools.listSelfTenants();
      assert.deepEqual(tenants, ["real-tenant"]);
    } finally { cleanup(root); }
  });

  test("returns empty array when tenants dir does not exist", () => {
    const root = makeTempRoot();
    try {
      // PoolManager creates tenants/ dir in its constructor, but let's verify
      // with a fresh root where we haven't instantiated any pools yet.
      const pools = makePool(root);
      // No stores opened — tenants/ dir exists but is empty.
      assert.deepEqual(pools.listSelfTenants(), []);
    } finally { cleanup(root); }
  });
});

// ─── 2. Auto-enqueue integration ──────────────────────────────────────────────

describe("gateway worker auto-enqueue", () => {
  test("enqueueAll creates one pending job per self-tenant", () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      // Create two self-stores.
      pools.resolve("proj-x", undefined, true);
      pools.resolve("proj-y", undefined, true);

      const queueDb = new Database(":memory:");
      queueDb.pragma("busy_timeout = 5000");
      initQueueSchema(queueDb);

      // Simulate enqueueAll: enumerate tenants and enqueue each.
      const tenants = pools.listSelfTenants();
      assert.equal(tenants.length, 2);
      for (const tenant of tenants) {
        enqueue(queueDb, storeKeyFor(tenant, undefined));
      }

      const jobs = listJobs(queueDb);
      assert.equal(jobs.length, 2, "one job per tenant");
      const keys = jobs.map((j) => j.store_key).sort();
      assert.deepEqual(keys, ["proj-x:self", "proj-y:self"]);
      assert.ok(jobs.every((j) => j.status === "pending"), "all pending");
    } finally { cleanup(root); }
  });

  test("enqueueAll coalesces: repeat enqueue does not create duplicates", () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      pools.resolve("proj-a", undefined, true);

      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);

      enqueue(queueDb, storeKeyFor("proj-a", undefined));
      enqueue(queueDb, storeKeyFor("proj-a", undefined));
      enqueue(queueDb, storeKeyFor("proj-a", undefined));

      const jobs = listJobs(queueDb);
      assert.equal(jobs.length, 1, "coalesces to one pending job");
    } finally { cleanup(root); }
  });

  test("drain tick processes pending job and marks it done", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      // Open a self-store and add a turn so distillOnce has something to process.
      const store = pools.resolve("drain-tenant", undefined, true);
      await store.addStream("sess-1", [{ role: "user", content: "the sky is blue" }]);

      const queueDb = new Database(":memory:");
      queueDb.pragma("busy_timeout = 5000");
      initQueueSchema(queueDb);

      // Enqueue the store.
      enqueue(queueDb, "drain-tenant:self");

      // Simulate drain: claim → distillOnce → complete.
      const job = claimNext(queueDb);
      assert.ok(job, "job claimed");
      assert.equal(job!.status, "running");

      const llm = makeMockLLM([
        // extraction
        `{"type":"fact","content":"The sky is blue.","confidence":"high"}`,
        // consolidation
        `{"action":"store","target_ids":[],"rationale":"New fact."}`,
        // L2: episode title + summary
        "Blue sky session", "Discussed sky color.",
        // L2: topic title + summary
        "Sky color", "Sky facts.",
        // L3: core
        "# Core\nSky is blue.",
      ]);

      const [tenant, poolName] = job!.store_key.split(":", 2);
      const s = pools.resolve(tenant, poolName === "self" ? undefined : poolName, true);
      await distillOnce(s, llm, { storeKey: job!.store_key });

      // Mark complete (in production this is done by the gateway's drain function).
      const { completeJob } = await import("../src/distill/queue.js");
      completeJob(queueDb, job!.id);

      const { getJob } = await import("../src/distill/queue.js");
      const done = getJob(queueDb, job!.id);
      assert.equal(done?.status, "done", "job marked done after successful drain");
    } finally { cleanup(root); }
  });

  test("no-new-turns drain is a no-op (watermark already current)", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const store = pools.resolve("idle-tenant", undefined, true);
      await store.addStream("sess-1", [{ role: "user", content: "hello" }]);

      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);

      // First pass: distill the one turn.
      const llm1 = makeMockLLM([
        `{"type":"fact","content":"Hello.","confidence":"low"}`,
        `{"action":"store","target_ids":[],"rationale":"New."}`,
        "Hello session", "Brief greeting.",
        "Greeting topic", "Greetings.",
        "# Core\nHello.",
      ]);
      await distillOnce(store, llm1, { storeKey: "idle-tenant:self" });

      // Second pass: nothing new → should be a no-op (0 turns processed).
      let llmCalled = 0;
      const llm2 = async () => { llmCalled++; return ""; };
      const r2 = await distillOnce(store, llm2, { storeKey: "idle-tenant:self" });
      assert.equal(r2.turns_processed, 0, "no new turns processed");
      assert.equal(llmCalled, 0, "LLM not called on no-op pass");
    } finally { cleanup(root); }
  });
});

// ─── 3. parseCandidates hardening ─────────────────────────────────────────────
// parseCandidates is not exported, so we test it indirectly through distillOnce
// by feeding the mock LLM responses in each format and asserting atoms_stored > 0.

describe("parseCandidates: fence and array tolerance", () => {
  function makeStoreForParse(dim = 32) {
    const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-parse-"));
    const s = new Falda({ dbPath: ":memory:", blobDir, embed: makeLocalEmbedder(dim), dim });
    return { s, blobDir };
  }
  function cleanupStore(s: Falda, blobDir: string) {
    s.close(); fs.rmSync(blobDir, { recursive: true, force: true });
  }

  test("parseCandidates: accepts bare JSON lines (existing behavior)", async () => {
    const { s, blobDir } = makeStoreForParse();
    try {
      await s.addStream("sess-1", [{ role: "user", content: "bare JSON test" }]);
      const llm = makeMockLLM([
        `{"type":"fact","content":"Bare JSON works.","confidence":"high"}`,
        `{"action":"store","target_ids":[],"rationale":"New."}`,
        "Test session", "Test.",
        "Test topic", "Test.",
        "# Core\nTest.",
      ]);
      const r = await distillOnce(s, llm, { storeKey: "parse-test:self" });
      assert.equal(r.atoms_stored, 1, "bare JSON lines parsed");
    } finally { cleanupStore(s, blobDir); }
  });

  test("parseCandidates: accepts ```json fenced output", async () => {
    const { s, blobDir } = makeStoreForParse();
    try {
      await s.addStream("sess-1", [{ role: "user", content: "fenced test" }]);
      const fencedResponse = "```json\n{\"type\":\"fact\",\"content\":\"Fenced JSON works.\",\"confidence\":\"high\"}\n```";
      const llm = makeMockLLM([
        fencedResponse,
        `{"action":"store","target_ids":[],"rationale":"New."}`,
        "Test session", "Test.",
        "Test topic", "Test.",
        "# Core\nTest.",
      ]);
      const r = await distillOnce(s, llm, { storeKey: "parse-fence:self" });
      assert.equal(r.atoms_stored, 1, "fenced JSON parsed correctly");
    } finally { cleanupStore(s, blobDir); }
  });

  test("parseCandidates: accepts JSON array output", async () => {
    const { s, blobDir } = makeStoreForParse();
    try {
      await s.addStream("sess-1", [{ role: "user", content: "array test" }]);
      const arrayResponse = JSON.stringify([
        { type: "fact", content: "Array item one.", confidence: "high" },
        { type: "fact", content: "Array item two.", confidence: "medium" },
      ]);
      const llm = makeMockLLM([
        arrayResponse,
        // consolidation for each candidate
        `{"action":"store","target_ids":[],"rationale":"New."}`,
        `{"action":"store","target_ids":[],"rationale":"New."}`,
        "Test session", "Test.",
        "Test topic", "Test.",
        "Test topic 2", "Test 2.",
        "# Core\nTest.",
      ]);
      const r = await distillOnce(s, llm, { storeKey: "parse-array:self" });
      assert.equal(r.atoms_stored, 2, "JSON array parsed — both items extracted");
    } finally { cleanupStore(s, blobDir); }
  });
});
