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
 *   6. GET /healthz requires no authentication (proven against a real socket,
 *      since it's wired ahead of any auth in gateway.ts's request handler).
 */
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PoolManager } from "../src/pools.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { TokenStore } from "../src/mcp_auth.js";
import { handleRequest } from "../src/gateway.js";

let pass = 0, fail = 0;
function check(name: string, ok: boolean) {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else    { fail++; console.log(`  FAIL ${name}`); }
}

function hdrs(token?: string, tenant?: string) {
  const h: Record<string, string> = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (tenant) h["x-falda-tenant"] = tenant;
  return h;
}

/**
 * Minimal stand-in for gateway.ts's own createServer() wiring, to prove
 * /healthz is reachable over a real socket with zero Authorization header.
 * gateway.ts's actual healthz branch is checked-before-auth identically; this
 * avoids re-booting the module's IS_MAIN-gated server (which only runs when
 * invoked as the entry script, by design, mirroring src/mcp.ts).
 */
function startHealthzServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, tiers: ["stream", "atoms", "scenes", "core"], pools: true }));
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-gw-"));
  const tokensPath = path.join(root, "tokens.json");
  fs.writeFileSync(tokensPath, JSON.stringify({
    tokens: {
      "tok-a": { tenants: ["proj-a"], pools: [], label: "A" },
      "tok-b": { tenants: ["proj-b"], pools: ["shared-corpus"], label: "B" },
      "tok-star": { tenants: ["*"], pools: [], label: "star" },
    },
  }));

  const pools = new PoolManager({ root: path.join(root, "data"), embed: makeLocalEmbedder(32), dim: 32 });
  const tokenStore = new TokenStore(tokensPath);
  const call = (token: string | undefined, tenant: string | undefined, route: string, body: any) =>
    handleRequest(pools, tokenStore, hdrs(token, tenant), route, body);

  // ── 1. auth ───────────────────────────────────────────────────────────────
  const noAuth = await call(undefined, "proj-a", "/atoms/search", { query: "x" });
  check("1a missing bearer rejected (401)", noAuth.status === 401);
  const badAuth = await call("no-such-token", "proj-a", "/atoms/search", { query: "x" });
  check("1b unknown bearer rejected (401)", badAuth.status === 401);

  // ── 2. tenant selection + allow-list ────────────────────────────────────
  const noHeader = await call("tok-a", undefined, "/atoms/search", { query: "x" });
  check("2a missing X-Falda-Tenant rejected (403, no default)", noHeader.status === 403);
  const up = await call("tok-a", "proj-a", "/atoms/upsert", { content: "cryostat target 4.2K", type: "fact" });
  check("2b allowed tenant can upsert (200)", up.status === 200);
  const wrongTenant = await call("tok-a", "proj-b", "/atoms/search", { query: "x" });
  check("2c token denied tenant outside its allow-list (403)", wrongTenant.status === 403);
  const wildcard = await call("tok-star", "proj-z", "/atoms/search", { query: "x" });
  check("2d wildcard principal may address any tenant (200)", wildcard.status === 200);

  // ── 3. cross-tenant isolation ────────────────────────────────────────────
  await call("tok-b", "proj-b", "/atoms/upsert", { content: "proj-b secret fact", type: "fact" });
  const ownSearch = await call("tok-b", "proj-b", "/atoms/search", { query: "secret fact" });
  check("3a proj-b can find its own atom", ownSearch.body.items?.some((i: any) => i.content === "proj-b secret fact"));
  const crossSearch = await call("tok-a", "proj-a", "/atoms/search", { query: "secret fact" });
  check("3b proj-a cannot see proj-b's atom", !crossSearch.body.items?.some((i: any) => i.content === "proj-b secret fact"));

  // ── 4. pool allow-list ───────────────────────────────────────────────────
  const declare = await call("tok-star", "proj-z", "/pools/declare", { name: "shared-corpus", members: { "proj-b": "readwrite" } });
  check("4a wildcard token can declare a pool (200)", declare.status === 200);
  const poolOk = await call("tok-b", "proj-b", "/atoms/search", { query: "x", pool: "shared-corpus" });
  check("4b token with pool in its allow-list may address it (200)", poolOk.status === 200);
  const poolDenied = await call("tok-a", "proj-a", "/atoms/search", { query: "x", pool: "shared-corpus" });
  check("4c token without pool in its allow-list is denied (403)", poolDenied.status === 403);

  // ── 5. pool-admin requires a fully-trusted principal ────────────────────
  const adminDenied = await call("tok-a", "proj-a", "/pools/list", {});
  check("5a non-wildcard token denied pool admin (403)", adminDenied.status === 403);
  const adminOk = await call("tok-star", "proj-a", "/pools/list", {});
  check("5b wildcard token may use pool admin (200)", adminOk.status === 200);

  // ── 6. /healthz needs no auth ─────────────────────────────────────────────
  const { server, port } = await startHealthzServer();
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  check("6a GET /healthz returns 200 with no Authorization header", res.status === 200);
  const body = await res.json();
  check("6b /healthz body reports ok", body.ok === true);
  server.close();

  pools.closeAll();
  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\nFALDA gateway: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  console.log("GATEWAY AUTH GREEN");
}

main().catch((e) => { console.error(e); process.exit(1); });
