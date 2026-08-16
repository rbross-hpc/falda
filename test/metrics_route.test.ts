/**
 * /metrics HTTP route (src/gateway.ts) — process-global timing snapshot.
 *
 * Guarantees under test:
 *   1. Requires authentication (any valid token; not tenant-scoped).
 *   2. Returns a well-formed MetricsSnapshot reflecting observations made
 *      via the passed-in MetricsRegistry.
 *   3. Returns a soft error body (not a 500/crash) when no metrics registry
 *      is wired at all.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PoolManager } from "../src/pools.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { TokenStore } from "../src/mcp_auth.js";
import { handleRequest } from "../src/gateway.js";
import { MetricsRegistry } from "../src/metrics.js";

let root: string;
let pools: PoolManager;
let tokenStore: TokenStore;
let metrics: MetricsRegistry;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-metrics-route-"));
  const tokensPath = path.join(root, "tokens.json");
  fs.writeFileSync(tokensPath, JSON.stringify({
    tokens: { "tok-a": { tenants: ["proj-a"], pools: [], label: "A" } },
  }));
  pools = new PoolManager({ root: path.join(root, "data"), embed: makeLocalEmbedder(32), dim: 32 });
  tokenStore = new TokenStore(tokensPath);
  metrics = new MetricsRegistry();
});

after(() => {
  pools.closeAll();
  fs.rmSync(root, { recursive: true, force: true });
});

test("GET /metrics without a bearer token is rejected", async () => {
  const res = await handleRequest(pools, tokenStore, {}, "/metrics", {}, undefined, undefined, metrics);
  assert.equal(res.status, 401);
});

test("/metrics with a valid token (no tenant header needed -- process-global) returns a snapshot", async () => {
  metrics.recall_ms.observe(42);
  const res = await handleRequest(
    pools, tokenStore, { authorization: "Bearer tok-a" }, "/metrics", {}, undefined, undefined, metrics,
  );
  assert.equal(res.status, 200);
  assert.ok(res.body.started_at);
  assert.equal(res.body.recall_ms.count, 1);
  assert.equal(res.body.distill_pending_ms.count, 0);
  assert.equal(res.body.distill_service_ms.count, 0);
});

test("/metrics with no registry wired returns a soft error body, not a crash", async () => {
  const res = await handleRequest(
    pools, tokenStore, { authorization: "Bearer tok-a" }, "/metrics", {}, undefined, undefined, undefined,
  );
  assert.equal(res.status, 200);
  assert.ok(res.body.error);
});
