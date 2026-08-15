/**
 * Tests for `falda show recall` and the gateway support it relies on:
 *   - POST /recall now returns rendered `context` (src/recall/render.ts),
 *     not just structured `items` — closes the HTTP-vs-MCP rendering gap.
 *   - POST /recall accepts an optional `topic` (src/recall/topic.ts),
 *     resolved server-side to an active topic scene's title.
 *   - POST /recalls/reconstruct (src/recall/reconstruct.ts) re-renders a
 *     past trace against CURRENT memory, accepting the "latest" sentinel,
 *     and reports `stale_items` for content that changed since.
 *
 * Fully offline: temp root, deterministic local embedder, no network.
 * Exercises gateway.ts's exported `handleRequest` directly (same harness
 * as test/gateway.test.ts / test/recall_traces.test.ts).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { PoolManager } from "../src/pools.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { TokenStore } from "../src/mcp_auth.js";
import { handleRequest } from "../src/gateway.js";
import { initRecallTraceSchema } from "../src/recall/schema.js";

function hdrs(token?: string, tenant?: string) {
  const h: Record<string, string> = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (tenant) h["x-falda-tenant"] = tenant;
  return h;
}

describe("show recall: gateway support", () => {
  let root: string;
  let pools: PoolManager;
  let tokenStore: TokenStore;
  let traceDb: Database.Database;

  function call(token: string | undefined, tenant: string | undefined, route: string, body: any) {
    return handleRequest(pools, tokenStore, hdrs(token, tenant), route, body, undefined, traceDb);
  }

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-show-recall-"));
    const tokensPath = path.join(root, "tokens.json");
    fs.writeFileSync(tokensPath, JSON.stringify({
      tokens: {
        "tok-a": { tenants: ["acme"], pools: [], label: "A" },
        "tok-b": { tenants: ["beta"], pools: [], label: "B" },
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

  test("POST /recall returns rendered context, matching what items describe", async () => {
    await call("tok-a", "acme", "/atoms/upsert", { content: "the deploy script lives in bin/release", type: "fact" });
    await call("tok-a", "acme", "/atoms/upsert", { content: "always run tests before merging", type: "instruction", pinned: true });
    const res = await call("tok-a", "acme", "/recall", { query: "deploy script" });
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.context, "string");
    assert.ok(res.body.context.includes("deploy script"));
    assert.ok(res.body.context.includes("## Pinned"));
    assert.ok(Array.isArray(res.body.items));
  });

  test("POST /recall requires one of {query, topic}", async () => {
    const res = await call("tok-a", "acme", "/recall", {});
    assert.equal(res.status, 200); // handleData returns {error} rather than throwing here
    assert.ok(res.body.error);
  });

  test("POST /recall resolves topic by exact scene_id", async () => {
    const scene = await call("tok-a", "acme", "/scenes/upsert", {
      scene_kind: "topic", title: "Deployment tooling", summary: "Notes on deployment.",
    });
    const res = await call("tok-a", "acme", "/recall", { topic: scene.body.scene_id });
    assert.equal(res.status, 200);
    assert.ok(res.body.context.includes("Deployment tooling"));
  });

  test("POST /recall resolves topic by case-insensitive title substring", async () => {
    const res = await call("tok-a", "acme", "/recall", { topic: "deployment" });
    assert.equal(res.status, 200);
    assert.ok(res.body.context.includes("Deployment tooling"));
  });

  test("POST /recall with an unmatched topic returns 404, not a silent empty recall", async () => {
    const res = await call("tok-a", "acme", "/recall", { topic: "no-such-topic-xyz" });
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });

  test("POST /recalls/reconstruct with recall_id:'latest' returns the most recent trace for the store", async () => {
    const r1 = await call("tok-a", "acme", "/recall", { query: "deploy script" });
    const r2 = await call("tok-a", "acme", "/recall", { query: "run tests before merging" });
    const latest = await call("tok-a", "acme", "/recalls/reconstruct", { recall_id: "latest" });
    assert.equal(latest.status, 200);
    assert.equal(latest.body.trace.recall_id, r2.body.recall_id, "latest is the most recently created trace");
    assert.notEqual(latest.body.trace.recall_id, r1.body.recall_id);
  });

  test("POST /recalls/reconstruct with an explicit recall_id returns that trace", async () => {
    const res = await call("tok-a", "acme", "/recall", { query: "deploy script" });
    const recon = await call("tok-a", "acme", "/recalls/reconstruct", { recall_id: res.body.recall_id });
    assert.equal(recon.status, 200);
    assert.equal(recon.body.trace.recall_id, res.body.recall_id);
    assert.equal(typeof recon.body.context, "string");
    assert.deepEqual(recon.body.stale_items, []);
  });

  test("reconstruct flags a superseded atom as stale and drops it from the rendered context", async () => {
    const up = await call("tok-a", "acme", "/atoms/upsert", { content: "the old embedder is nomic-embed-text", type: "fact" });
    const res = await call("tok-a", "acme", "/recall", { query: "old embedder" });
    assert.ok(res.body.items.some((i: any) => i.id === up.body.id));

    await call("tok-a", "acme", "/atoms/upsert", { id: "new-embedder-atom", content: "the embedder is now Qwen3-Embedding-0.6B", type: "fact" });
    await call("tok-a", "acme", "/atoms/supersede", { old_id: up.body.id, new_id: "new-embedder-atom" });

    const recon = await call("tok-a", "acme", "/recalls/reconstruct", { recall_id: res.body.recall_id });
    assert.equal(recon.status, 200);
    assert.ok(recon.body.stale_items.some((s: any) => s.id === up.body.id && s.reason === "superseded"));
    assert.ok(!recon.body.context.includes("nomic-embed-text"), "superseded content dropped from reconstructed context");
  });

  test("reconstruct: 'latest' with no traces yet returns 404, not an error thrown", async () => {
    const res = await call("tok-b", "beta", "/recalls/reconstruct", { recall_id: "latest" });
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });

  test("reconstruct: cross-tenant recall_id is rejected (no existence oracle)", async () => {
    const res = await call("tok-a", "acme", "/recall", { query: "deploy script" });
    const cross = await call("tok-b", "beta", "/recalls/reconstruct", { recall_id: res.body.recall_id });
    assert.equal(cross.status, 404);
  });

  test("reconstruct: 'latest' is scoped per store — beta never sees acme's traces", async () => {
    await call("tok-a", "acme", "/recall", { query: "deploy script" });
    await call("tok-b", "beta", "/atoms/upsert", { content: "beta-only fact", type: "fact" });
    const betaRecall = await call("tok-b", "beta", "/recall", { query: "beta-only fact" });
    const betaLatest = await call("tok-b", "beta", "/recalls/reconstruct", { recall_id: "latest" });
    assert.equal(betaLatest.status, 200);
    assert.equal(betaLatest.body.trace.recall_id, betaRecall.body.recall_id);
    assert.ok(betaLatest.body.context.includes("beta-only fact"));
  });

  test("reconstruct performs no mutation (no new trace, no store write)", async () => {
    const res = await call("tok-a", "acme", "/recall", { query: "deploy script" });
    const before = await call("tok-a", "acme", "/recalls/metrics", {});
    await call("tok-a", "acme", "/recalls/reconstruct", { recall_id: res.body.recall_id });
    await call("tok-a", "acme", "/recalls/reconstruct", { recall_id: "latest" });
    const after = await call("tok-a", "acme", "/recalls/metrics", {});
    assert.equal(before.body.trace_count, after.body.trace_count, "reconstruct writes no new trace");
  });
});
