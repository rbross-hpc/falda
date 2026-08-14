/**
 * FALDA MCP server test — proves token-based auth + tenant selection semantics
 * on top of the pool isolation already proven by test/pools.test.ts.
 * Fully offline (deterministic local embedder, temp root + temp token file).
 *
 * Guarantees under test:
 *   1. Unknown/missing bearer token is rejected (401) before any tool runs.
 *   2. A token may only select a tenant in its `tenants` allow-list; a
 *      wildcard (["*"]) principal may select any tenant.
 *   3. Cross-tenant isolation: one tenant's atoms are invisible under another.
 *   4. A `pool` argument outside the token's `pools` allow-list is denied.
 *   5. Scenes/core write tools are not registered (read-only tiers).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PoolManager } from "../src/pools.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { TokenStore } from "../src/mcp_auth.js";
import { handleFaldaMcpRequest } from "../src/mcp.js";

function startTestServer(pools: PoolManager, tokenStore: TokenStore): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const httpServer = createServer((req, res) => {
      handleFaldaMcpRequest(pools, tokenStore, req, res).catch((e) => {
        console.error(e);
        if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
      });
    });
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server: httpServer, port });
    });
  });
}

async function withClient<T>(port: number, token: string, tenant: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, "X-Falda-Tenant": tenant } },
  });
  const client = new Client({ name: "test-client", version: "1.0" });
  await client.connect(transport);
  try { return await fn(client); } finally { await client.close(); }
}
function textOf(result: any) { return JSON.parse(result.content[0].text); }

let root: string;
let pools: PoolManager;
let tokenStore: TokenStore;
let server: Server;
let port: number;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-mcp-"));
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
  ({ server, port } = await startTestServer(pools, tokenStore));
});

after(() => {
  pools.closeAll();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("1. auth: unknown token rejected", async () => {
  await assert.rejects(
    () => withClient(port, "no-such-token", "proj-a", async () => {}),
    /unauthorized/,
  );
});

test("2. tenant allow-list", async () => {
  await withClient(port, "tok-a", "proj-a", async (client) => {
    const up = await client.callTool({ name: "falda_atoms_upsert", arguments: { content: "cryostat target 4.2K", type: "fact" } });
    assert.ok(!(up as any).isError, "allowed tenant can upsert");
  });
  await withClient(port, "tok-a", "proj-b", async (client) => {
    const r: any = await client.callTool({ name: "falda_atoms_search", arguments: { query: "x" } });
    assert.ok(
      r.isError === true && /not authorized for tenant/.test(r.content[0].text),
      "token denied tenant outside its allow-list",
    );
  });
  await withClient(port, "tok-star", "proj-z", async (client) => {
    const r: any = await client.callTool({ name: "falda_atoms_search", arguments: { query: "x" } });
    assert.ok(!r.isError, "wildcard principal may address any tenant");
  });
});

test("3. cross-tenant isolation", async () => {
  await withClient(port, "tok-b", "proj-b", async (client) => {
    await client.callTool({ name: "falda_atoms_upsert", arguments: { content: "proj-b secret fact", type: "fact" } });
    const own = textOf(await client.callTool({ name: "falda_atoms_search", arguments: { query: "secret fact" } }));
    assert.ok(own.items.some((i: any) => i.content === "proj-b secret fact"), "proj-b can find its own atom");
  });
  await withClient(port, "tok-a", "proj-a", async (client) => {
    const cross = textOf(await client.callTool({ name: "falda_atoms_search", arguments: { query: "secret fact" } }));
    assert.ok(!cross.items.some((i: any) => i.content === "proj-b secret fact"), "proj-a cannot see proj-b's atom");
  });
});

test("4. pool allow-list", async () => {
  pools.declarePool("shared-corpus", { "proj-b": "readwrite" });
  await withClient(port, "tok-b", "proj-b", async (client) => {
    const r: any = await client.callTool({ name: "falda_atoms_search", arguments: { query: "x", pool: "shared-corpus" } });
    assert.ok(!r.isError, "token with pool in its allow-list may address it");
  });
  await withClient(port, "tok-a", "proj-a", async (client) => {
    const r: any = await client.callTool({ name: "falda_atoms_search", arguments: { query: "x", pool: "shared-corpus" } });
    assert.ok(
      r.isError === true && /not authorized for pool/.test(r.content[0].text),
      "token without pool in its allow-list is denied",
    );
  });
});

test("5. scenes/core write tools not registered (checked against real server)", async () => {
  await withClient(port, "tok-a", "proj-a", async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    assert.ok(!names.includes("falda_scenes_write"), "no falda_scenes_write tool");
    assert.ok(!names.includes("falda_scenes_rm"), "no falda_scenes_rm tool");
    assert.ok(!names.includes("falda_core_write"), "no falda_core_write tool");
  });
});

test("6. falda_whoami: echoes only the resolved tenant, nothing sensitive", async () => {
  await withClient(port, "tok-a", "proj-a", async (client) => {
    const who = textOf(await client.callTool({ name: "falda_whoami", arguments: {} }));
    assert.equal(who.tenant, "proj-a", "whoami reports the resolved tenant");
    assert.ok(!JSON.stringify(who).includes("tok-a"), "whoami does not leak the token");
    assert.ok(!("tenants" in who), "whoami does not leak the tenants allow-list");
    assert.ok(!("pools" in who), "whoami does not leak the pools allow-list");
  });
  await withClient(port, "tok-star", "proj-z", async (client) => {
    const who = textOf(await client.callTool({ name: "falda_whoami", arguments: {} }));
    assert.equal(who.tenant, "proj-z", "whoami reflects the selected tenant for a wildcard principal");
  });
});
