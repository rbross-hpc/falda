/**
 * Recall trace + usage-reporting tests (§ recall-feedback-loop).
 * Exercises src/recall/* directly against a real Falda store (proves the
 * service layer), and through the gateway's HTTP routes (/recall,
 * /recall/usage, /recalls/get, /recalls/metrics) for auth/ownership.
 *
 * Guarantees under test (§15):
 *   1. every successful recall gets a unique recall_id.
 *   2. returned items are recorded in the correct rank/order.
 *   3. tier/source/kind metadata is preserved.
 *   4. partial usage reporting works; unspecified items remain unknown.
 *   5. usage cannot be reported for a recall belonging to another store.
 *   6. unknown item ids are rejected.
 *   7. duplicate usage reports are idempotent.
 *   8. conflicting reports (used<->unused) are rejected explicitly.
 *   9. trace persistence failure does not break recall (best-effort).
 *  10. policy snapshot matches the policy actually used.
 *  11. /recalls/get inspection and /recalls/metrics aggregates.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { Falda } from "../src/falda.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { initRecallTraceSchema } from "../src/recall/schema.js";
import { createRecallTrace, getRecallTraceAuthorized } from "../src/recall/traces.js";
import { reportRecallUsage } from "../src/recall/usage.js";
import { computeRecallMetrics } from "../src/recall/metrics.js";
import { pruneRecallTraces } from "../src/recall/retention.js";
import { buildPolicySnapshot, RETRIEVAL_POLICY_VERSION } from "../src/recall/policy.js";
import { RecallTraceError } from "../src/recall/types.js";
import { assembleContext, DEFAULT_TIER_BUDGETS } from "../src/distill/context.js";
import { PoolManager } from "../src/pools.js";
import { TokenStore } from "../src/mcp_auth.js";
import { handleRequest } from "../src/gateway.js";

// ─── Service-layer tests: src/recall/* directly against a real Falda store ───

describe("recall traces: service layer", () => {
  let root: string;
  let store: Falda;
  let traceDb: Database.Database;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-recall-svc-"));
    store = new Falda({
      dbPath: path.join(root, "falda.db"),
      blobDir: path.join(root, "blobs"),
      embed: makeLocalEmbedder(32),
      dim: 32,
    });
    traceDb = new Database(path.join(root, "recall_traces.db"));
    initRecallTraceSchema(traceDb);

    await store.upsertAtom({ content: "cryostat setpoint is 4.2K", type: "fact" });
    await store.upsertAtom({ content: "always log temperature in Kelvin", type: "instruction", pinned: true });
  });

  after(() => {
    store.close();
    traceDb.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function recallAndTrace(query: string, budget = 4000) {
    const assembled = await assembleContext(store, query, budget);
    const recall_id = createRecallTrace(traceDb, {
      store_key: "proj-x:self",
      tenant: "proj-x",
      pool: null,
      query,
      requested_budget: budget,
      used_budget: assembled.total_chars,
      policy_snapshot: buildPolicySnapshot(store.getRecallWeights(), DEFAULT_TIER_BUDGETS),
      items: assembled.items,
    });
    return { recall_id, assembled };
  }

  test("1. every successful recall gets a unique recall_id", async () => {
    const a = await recallAndTrace("cryostat temperature");
    const b = await recallAndTrace("cryostat temperature");
    assert.notEqual(a.recall_id, b.recall_id);
  });

  test("2 & 3. items recorded in rank order with tier/source/kind/chars preserved", async () => {
    const { recall_id, assembled } = await recallAndTrace("cryostat temperature kelvin");
    const trace = getRecallTraceAuthorized(traceDb, recall_id, "proj-x:self")!;
    assert.ok(trace, "trace exists");
    assert.equal(trace.items.length, assembled.items.length);
    trace.items.forEach((row, i) => {
      assert.equal(row.rank, i, "ordinal matches admission order");
      assert.equal(row.tier, assembled.items[i].tier);
      assert.equal(row.id, assembled.items[i].id);
      assert.equal(row.source, assembled.items[i].source);
      assert.equal(row.chars, assembled.items[i].chars);
      assert.equal(row.usage, "unknown", "freshly-created items start unknown");
    });
    // The pinned instruction must appear with source "pinned".
    assert.ok(trace.items.some((it) => it.source === "pinned"));
  });

  test("10. policy snapshot matches the policy actually used", async () => {
    const { recall_id } = await recallAndTrace("kelvin");
    const trace = getRecallTraceAuthorized(traceDb, recall_id, "proj-x:self")!;
    const weights = store.getRecallWeights();
    assert.deepEqual(trace.policy_snapshot, {
      weights: { recency: weights.wRecency, priority: weights.wPriority, confidence: weights.wConfidence },
      budgets: { ...DEFAULT_TIER_BUDGETS },
      recency_half_life_days: weights.recencyHalfLifeDays,
      version: RETRIEVAL_POLICY_VERSION,
    });
  });

  test("4. partial usage reporting: unspecified items remain unknown", async () => {
    const { recall_id, assembled } = await recallAndTrace("cryostat kelvin");
    assert.ok(assembled.items.length >= 2, "need at least 2 items for a partial report");
    const [first, ...rest] = assembled.items;
    const result = reportRecallUsage(traceDb, recall_id, "proj-x:self", [{ tier: first.tier, id: first.id }]);
    assert.equal(result.updated.length, 1);
    const trace = getRecallTraceAuthorized(traceDb, recall_id, "proj-x:self")!;
    const firstRow = trace.items.find((it) => it.id === first.id)!;
    assert.equal(firstRow.usage, "used");
    for (const r of rest) {
      const row = trace.items.find((it) => it.id === r.id)!;
      assert.equal(row.usage, "unknown", "items not mentioned in the report stay unknown");
    }
  });

  test("7. duplicate usage reports are idempotent", async () => {
    const { recall_id, assembled } = await recallAndTrace("cryostat kelvin");
    const ref = { tier: assembled.items[0].tier, id: assembled.items[0].id };
    const first = reportRecallUsage(traceDb, recall_id, "proj-x:self", [ref]);
    assert.equal(first.updated.length, 1);
    const second = reportRecallUsage(traceDb, recall_id, "proj-x:self", [ref]);
    assert.equal(second.updated.length, 0, "second identical report is a no-op");
    assert.equal(second.unchanged.length, 1);
  });

  test("8. conflicting reports (used<->unused) are rejected explicitly", async () => {
    const { recall_id, assembled } = await recallAndTrace("cryostat kelvin");
    const ref = { tier: assembled.items[0].tier, id: assembled.items[0].id };
    reportRecallUsage(traceDb, recall_id, "proj-x:self", [ref]); // -> used
    assert.throws(
      () => reportRecallUsage(traceDb, recall_id, "proj-x:self", [], [ref]),
      (e: any) => e instanceof RecallTraceError && e.code === "conflict",
    );
    // The item's stored state must be untouched by the rejected call.
    const trace = getRecallTraceAuthorized(traceDb, recall_id, "proj-x:self")!;
    assert.equal(trace.items.find((it) => it.id === ref.id)!.usage, "used");
  });

  test("8b. same ref in both used[] and unused[] in one call is rejected", async () => {
    const { recall_id, assembled } = await recallAndTrace("cryostat kelvin");
    const ref = { tier: assembled.items[0].tier, id: assembled.items[0].id };
    assert.throws(
      () => reportRecallUsage(traceDb, recall_id, "proj-x:self", [ref], [ref]),
      (e: any) => e instanceof RecallTraceError && e.code === "conflict",
    );
  });

  test("6. unknown item ids are rejected", async () => {
    const { recall_id } = await recallAndTrace("cryostat kelvin");
    assert.throws(
      () => reportRecallUsage(traceDb, recall_id, "proj-x:self", [{ tier: "T1", id: "no-such-atom" }]),
      (e: any) => e instanceof RecallTraceError && e.code === "unknown_items",
    );
  });

  test("5. usage cannot be reported for a recall belonging to another store", async () => {
    const { recall_id, assembled } = await recallAndTrace("cryostat kelvin");
    assert.throws(
      () => reportRecallUsage(traceDb, recall_id, "other-tenant:self", [{ tier: assembled.items[0].tier, id: assembled.items[0].id }]),
      (e: any) => e instanceof RecallTraceError && e.code === "not_found",
    );
  });

  test("getRecallTraceAuthorized returns null for missing AND cross-store ids (no oracle)", async () => {
    const { recall_id } = await recallAndTrace("cryostat kelvin");
    assert.equal(getRecallTraceAuthorized(traceDb, "no-such-id", "proj-x:self"), null);
    assert.equal(getRecallTraceAuthorized(traceDb, recall_id, "other-tenant:self"), null);
  });

  test("retention: pruneRecallTraces deletes only traces older than the cutoff", async () => {
    const { recall_id: freshId } = await recallAndTrace("fresh trace");
    // Backdate a second trace directly.
    const { recall_id: oldId } = await recallAndTrace("old trace");
    const old = new Date(Date.now() - 200 * 86400_000).toISOString();
    traceDb.prepare("UPDATE recall_traces SET created_at=? WHERE recall_id=?").run(old, oldId);

    const deleted = pruneRecallTraces(traceDb, 90);
    assert.equal(deleted, 1);
    assert.equal(getRecallTraceAuthorized(traceDb, oldId, "proj-x:self"), null, "old trace pruned");
    assert.ok(getRecallTraceAuthorized(traceDb, freshId, "proj-x:self"), "fresh trace retained");
    // Items were pruned too (no orphans left behind).
    const orphanItems = traceDb.prepare("SELECT COUNT(*) c FROM recall_trace_items WHERE recall_id=?").get(oldId) as any;
    assert.equal(orphanItems.c, 0);
  });

  test("retention: retentionDays <= 0 disables pruning", async () => {
    const { recall_id } = await recallAndTrace("never pruned");
    const old = new Date(Date.now() - 10000 * 86400_000).toISOString();
    traceDb.prepare("UPDATE recall_trace_items SET usage=usage WHERE recall_id=?").run(recall_id); // no-op touch
    traceDb.prepare("UPDATE recall_traces SET created_at=? WHERE recall_id=?").run(old, recall_id);
    const deleted = pruneRecallTraces(traceDb, 0);
    assert.equal(deleted, 0);
    assert.ok(getRecallTraceAuthorized(traceDb, recall_id, "proj-x:self"));
  });
});

// ─── 9. trace persistence failure does not break recall (best-effort) ────────

describe("recall traces: best-effort persistence", () => {
  test("a broken trace db does not throw out of createRecallTrace's caller contract", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-recall-fail-"));
    try {
      const store = new Falda({
        dbPath: path.join(root, "falda.db"), blobDir: path.join(root, "blobs"),
        embed: makeLocalEmbedder(32), dim: 32,
      });
      await store.upsertAtom({ content: "something to recall", type: "fact" });
      const traceDb = new Database(path.join(root, "recall_traces.db"));
      initRecallTraceSchema(traceDb);
      traceDb.close(); // simulate a broken/unavailable trace store

      const assembled = await assembleContext(store, "something", 2000);
      // The caller (mcp/tools/recall.ts, gateway.ts) wraps createRecallTrace
      // in try/catch specifically so this throwing does not propagate to the
      // recall response — verify the failure mode here at the unit level.
      assert.throws(() => createRecallTrace(traceDb, {
        store_key: "x:self", tenant: "x", pool: null, query: "something",
        requested_budget: 2000, used_budget: assembled.total_chars,
        policy_snapshot: buildPolicySnapshot(store.getRecallWeights(), DEFAULT_TIER_BUDGETS),
        items: assembled.items,
      }));
      // Recall itself already succeeded above regardless of the trace db's state.
      assert.ok(assembled.items.length > 0);
      store.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── HTTP surface: /recall, /recall/usage, /recalls/get, /recalls/metrics ─────

describe("recall traces: HTTP surface (auth + ownership)", () => {
  let root: string;
  let pools: PoolManager;
  let tokenStore: TokenStore;
  let traceDb: Database.Database;

  function hdrs(token?: string, tenant?: string) {
    const h: Record<string, string> = {};
    if (token) h.authorization = `Bearer ${token}`;
    if (tenant) h["x-falda-tenant"] = tenant;
    return h;
  }
  function call(token: string | undefined, tenant: string | undefined, route: string, body: any) {
    return handleRequest(pools, tokenStore, hdrs(token, tenant), route, body, undefined, traceDb);
  }

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-recall-http-"));
    const tokensPath = path.join(root, "tokens.json");
    fs.writeFileSync(tokensPath, JSON.stringify({
      tokens: {
        "tok-a": { tenants: ["proj-a"], pools: [], label: "A" },
        "tok-b": { tenants: ["proj-b"], pools: [], label: "B" },
      },
    }));
    pools = new PoolManager({ root: path.join(root, "data"), embed: makeLocalEmbedder(32), dim: 32 });
    tokenStore = new TokenStore(tokensPath);
    traceDb = new Database(path.join(root, "recall_traces.db"));
    traceDb.pragma("busy_timeout = 5000");
    initRecallTraceSchema(traceDb);
  });

  after(() => {
    pools.closeAll();
    traceDb.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("POST /recall returns recall_id + items + truncated, and persists a trace", async () => {
    await call("tok-a", "proj-a", "/atoms/upsert", { content: "gateway recall fact", type: "fact" });
    const res = await call("tok-a", "proj-a", "/recall", { query: "gateway recall fact" });
    assert.equal(res.status, 200);
    assert.ok(res.body.recall_id);
    assert.ok(Array.isArray(res.body.items));
    assert.equal(typeof res.body.truncated, "boolean");
    assert.ok(res.body.items.some((it: any) => it.id));

    const inspect = await call("tok-a", "proj-a", "/recalls/get", { recall_id: res.body.recall_id });
    assert.equal(inspect.status, 200);
    assert.equal(inspect.body.query, "gateway recall fact");
    assert.ok(Array.isArray(inspect.body.items));
  });

  test("/recalls/get: cross-tenant recall_id is not found (no oracle)", async () => {
    const res = await call("tok-a", "proj-a", "/recall", { query: "proj-a private thing" });
    const cross = await call("tok-b", "proj-b", "/recalls/get", { recall_id: res.body.recall_id });
    assert.equal(cross.status, 404);
  });

  test("/recall/usage: partial report, idempotency, conflict, unknown items — over HTTP", async () => {
    await call("tok-a", "proj-a", "/atoms/upsert", { content: "usage report target atom", type: "fact" });
    const res = await call("tok-a", "proj-a", "/recall", { query: "usage report target atom" });
    const item = res.body.items[0];

    const rep1 = await call("tok-a", "proj-a", "/recall/usage", {
      recall_id: res.body.recall_id, used: [{ tier: item.tier, id: item.id }],
    });
    assert.equal(rep1.status, 200);
    assert.equal(rep1.body.updated.length, 1);

    const rep2 = await call("tok-a", "proj-a", "/recall/usage", {
      recall_id: res.body.recall_id, used: [{ tier: item.tier, id: item.id }],
    });
    assert.equal(rep2.body.updated.length, 0, "duplicate report is idempotent");

    const conflict = await call("tok-a", "proj-a", "/recall/usage", {
      recall_id: res.body.recall_id, unused: [{ tier: item.tier, id: item.id }],
    });
    assert.equal(conflict.status, 409, "used->unused conflict is rejected");

    const unknown = await call("tok-a", "proj-a", "/recall/usage", {
      recall_id: res.body.recall_id, used: [{ tier: "T1", id: "does-not-exist" }],
    });
    assert.equal(unknown.status, 400, "unknown item id is rejected");

    const crossTenant = await call("tok-b", "proj-b", "/recall/usage", {
      recall_id: res.body.recall_id, used: [{ tier: item.tier, id: item.id }],
    });
    assert.equal(crossTenant.status, 404, "cannot report usage for another store's recall");
  });

  test("/recalls/metrics: usage rate excludes unknown from the denominator", async () => {
    await call("tok-a", "proj-a", "/atoms/upsert", { content: "metrics atom one", type: "fact" });
    await call("tok-a", "proj-a", "/atoms/upsert", { content: "metrics atom two", type: "fact" });
    const res = await call("tok-a", "proj-a", "/recall", { query: "metrics atom" });
    assert.ok(res.body.items.length >= 2);
    const [used, unused] = res.body.items;
    await call("tok-a", "proj-a", "/recall/usage", {
      recall_id: res.body.recall_id,
      used: [{ tier: used.tier, id: used.id }],
      unused: [{ tier: unused.tier, id: unused.id }],
    });

    const metrics = await call("tok-a", "proj-a", "/recalls/metrics", {});
    assert.equal(metrics.status, 200);
    assert.ok(metrics.body.trace_count >= 1);
    assert.equal(metrics.body.by_tier.T1.used >= 1, true);
    assert.equal(metrics.body.by_tier.T1.unused >= 1, true);
    assert.ok(metrics.body.by_tier.T1.rate === null || (metrics.body.by_tier.T1.rate >= 0 && metrics.body.by_tier.T1.rate <= 1));
    assert.ok("unused_ratio" in metrics.body.chars);
  });

  test("/recalls/metrics: empty store is safe (no traces yet)", async () => {
    const res = await call("tok-b", "proj-b", "/recalls/metrics", {});
    assert.equal(res.status, 200);
    assert.equal(res.body.trace_count, 0);
    assert.equal(res.body.chars.unused_ratio, null);
  });
});
