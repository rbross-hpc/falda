/**
 * FALDA gateway test — proves token-based auth + tenant/pool selection
 * semantics on the JSON gateway (src/gateway.ts), mirroring the guarantees
 * already proven for the MCP server in test/mcp.test.ts.
 * Fully offline (deterministic local embedder, temp root + temp token file).
 * Exercises gateway.ts's exported `handleRequest` directly against a real
 * PoolManager + TokenStore — no live socket needed for the auth/dispatch path.
 *
 * Guarantees under test:
 *   1. Unknown/missing bearer token is rejected (401).
 *   2. X-Falda-Tenant selects the tenant; a token may only select a tenant in
 *      its `tenants` allow-list (or any tenant for a wildcard ["*"] principal).
 *      Missing header is 403 (no default-tenant fallback).
 *   3. Cross-tenant isolation on the gateway's own data routes.
 *   4. A `pool` body field outside the token's `pools` allow-list is denied.
 *   5. Pool-admin routes (/pools/*) require a fully-trusted (["*"]) principal;
 *      any other principal is denied even for a tenant it owns.
 *
 * GET /healthz's no-auth-required behavior is proven against the real
 * src/server.ts HTTP listener in test/server_runtime.test.ts ("HTTP and MCP
 * each answer /healthz on their own port"), not here — gateway.ts itself
 * only exports the pure handleRequest and never opens a socket, so a
 * same-guarantee test here would need its own stand-in listener rather than
 * exercising the actual production code path.
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

function hdrs(token?: string, tenant?: string) {
  const h: Record<string, string> = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (tenant) h["x-falda-tenant"] = tenant;
  return h;
}

let root: string;
let pools: PoolManager;
let tokenStore: TokenStore;
let call: (token: string | undefined, tenant: string | undefined, route: string, body: any) => Promise<any>;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-gw-"));
  const tokensPath = path.join(root, "tokens.json");
  fs.writeFileSync(tokensPath, JSON.stringify({
    tokens: {
      "tok-a": { tenants: ["proj-a"], pools: [], label: "A" },
      "tok-b": { tenants: ["proj-b"], pools: ["shared-corpus"], label: "B" },
      "tok-star": { tenants: ["*"], pools: [], label: "star" },
    },
  }));
  pools = new PoolManager({ root: path.join(root, "data"), embed: makeLocalEmbedder(32), dim: 32 });
  tokenStore = new TokenStore(tokensPath);
  call = (token, tenant, route, body) => handleRequest(pools, tokenStore, hdrs(token, tenant), route, body);
});

after(() => {
  pools.closeAll();
  fs.rmSync(root, { recursive: true, force: true });
});

test("1. auth", async () => {
  const noAuth = await call(undefined, "proj-a", "/atoms/search", { query: "x" });
  assert.equal(noAuth.status, 401, "missing bearer rejected (401)");
  const badAuth = await call("no-such-token", "proj-a", "/atoms/search", { query: "x" });
  assert.equal(badAuth.status, 401, "unknown bearer rejected (401)");
});

test("2. tenant selection + allow-list", async () => {
  const noHeader = await call("tok-a", undefined, "/atoms/search", { query: "x" });
  assert.equal(noHeader.status, 403, "missing X-Falda-Tenant rejected (403, no default)");
  const up = await call("tok-a", "proj-a", "/atoms/upsert", { content: "cryostat target 4.2K", type: "fact" });
  assert.equal(up.status, 200, "allowed tenant can upsert (200)");
  const wrongTenant = await call("tok-a", "proj-b", "/atoms/search", { query: "x" });
  assert.equal(wrongTenant.status, 403, "token denied tenant outside its allow-list (403)");
  const wildcard = await call("tok-star", "proj-z", "/atoms/search", { query: "x" });
  assert.equal(wildcard.status, 200, "wildcard principal may address any tenant (200)");
});

test("3. cross-tenant isolation", async () => {
  await call("tok-b", "proj-b", "/atoms/upsert", { content: "proj-b secret fact", type: "fact" });
  const ownSearch = await call("tok-b", "proj-b", "/atoms/search", { query: "secret fact" });
  assert.ok(
    ownSearch.body.items?.some((i: any) => i.content === "proj-b secret fact"),
    "proj-b can find its own atom",
  );
  const crossSearch = await call("tok-a", "proj-a", "/atoms/search", { query: "secret fact" });
  assert.ok(
    !crossSearch.body.items?.some((i: any) => i.content === "proj-b secret fact"),
    "proj-a cannot see proj-b's atom",
  );
});

test("4. pool allow-list", async () => {
  const declare = await call("tok-star", "proj-z", "/pools/declare", { name: "shared-corpus", members: { "proj-b": "readwrite" } });
  assert.equal(declare.status, 200, "wildcard token can declare a pool (200)");
  const poolOk = await call("tok-b", "proj-b", "/atoms/search", { query: "x", pool: "shared-corpus" });
  assert.equal(poolOk.status, 200, "token with pool in its allow-list may address it (200)");
  const poolDenied = await call("tok-a", "proj-a", "/atoms/search", { query: "x", pool: "shared-corpus" });
  assert.equal(poolDenied.status, 403, "token without pool in its allow-list is denied (403)");
});

test("5. pool-admin requires a fully-trusted principal", async () => {
  const adminDenied = await call("tok-a", "proj-a", "/pools/list", {});
  assert.equal(adminDenied.status, 403, "non-wildcard token denied pool admin (403)");
  const adminOk = await call("tok-star", "proj-a", "/pools/list", {});
  assert.equal(adminOk.status, 200, "wildcard token may use pool admin (200)");
});

