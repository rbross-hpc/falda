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

let pass = 0, fail = 0;
function check(name: string, ok: boolean) {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else    { fail++; console.log(`  FAIL ${name}`); }
}

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

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-mcp-"));
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
  const { server, port } = await startTestServer(pools, tokenStore);

  // ── 1. auth ───────────────────────────────────────────────────────────────
  await withClient(port, "no-such-token", "proj-a", async () => {}).then(
    () => check("1a unknown token rejected", false),
    (e) => check("1a unknown token rejected", /unauthorized/.test(String(e))),
  );

  // ── 2. tenant allow-list ─────────────────────────────────────────────────
  await withClient(port, "tok-a", "proj-a", async (client) => {
    const up = await client.callTool({ name: "falda_atoms_upsert", arguments: { content: "cryostat target 4.2K", type: "fact" } });
    check("2a allowed tenant can upsert", !(up as any).isError);
  });
  await withClient(port, "tok-a", "proj-b", async (client) => {
    const r: any = await client.callTool({ name: "falda_atoms_search", arguments: { query: "x" } });
    check("2b token denied tenant outside its allow-list", r.isError === true && /not authorized for tenant/.test(r.content[0].text));
  });
  await withClient(port, "tok-star", "proj-z", async (client) => {
    const r: any = await client.callTool({ name: "falda_atoms_search", arguments: { query: "x" } });
    check("2c wildcard principal may address any tenant", !r.isError);
  });

  // ── 3. cross-tenant isolation ────────────────────────────────────────────
  await withClient(port, "tok-b", "proj-b", async (client) => {
    await client.callTool({ name: "falda_atoms_upsert", arguments: { content: "proj-b secret fact", type: "fact" } });
    const own = textOf(await client.callTool({ name: "falda_atoms_search", arguments: { query: "secret fact" } }));
    check("3a proj-b can find its own atom", own.items.some((i: any) => i.content === "proj-b secret fact"));
  });
  await withClient(port, "tok-a", "proj-a", async (client) => {
    const cross = textOf(await client.callTool({ name: "falda_atoms_search", arguments: { query: "secret fact" } }));
    check("3b proj-a cannot see proj-b's atom", !cross.items.some((i: any) => i.content === "proj-b secret fact"));
  });

  // ── 4. pool allow-list ───────────────────────────────────────────────────
  pools.declarePool("shared-corpus", { "proj-b": "readwrite" });
  await withClient(port, "tok-b", "proj-b", async (client) => {
    const r: any = await client.callTool({ name: "falda_atoms_search", arguments: { query: "x", pool: "shared-corpus" } });
    check("4a token with pool in its allow-list may address it", !r.isError);
  });
  await withClient(port, "tok-a", "proj-a", async (client) => {
    const r: any = await client.callTool({ name: "falda_atoms_search", arguments: { query: "x", pool: "shared-corpus" } });
    check("4b token without pool in its allow-list is denied", r.isError === true && /not authorized for pool/.test(r.content[0].text));
  });

  // ── 5. scenes/core write tools not registered (checked against real server) ─
  await withClient(port, "tok-a", "proj-a", async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    check("5a no falda_scenes_write tool", !names.includes("falda_scenes_write"));
    check("5b no falda_scenes_rm tool", !names.includes("falda_scenes_rm"));
    check("5c no falda_core_write tool", !names.includes("falda_core_write"));
  });

  // ── 6. falda_whoami: echoes only the resolved tenant, nothing sensitive ────
  await withClient(port, "tok-a", "proj-a", async (client) => {
    const who = textOf(await client.callTool({ name: "falda_whoami", arguments: {} }));
    check("6a whoami reports the resolved tenant", who.tenant === "proj-a");
    check("6b whoami does not leak the token", !JSON.stringify(who).includes("tok-a"));
    check("6c whoami does not leak the tenants allow-list", !("tenants" in who));
    check("6d whoami does not leak the pools allow-list", !("pools" in who));
  });
  await withClient(port, "tok-star", "proj-z", async (client) => {
    const who = textOf(await client.callTool({ name: "falda_whoami", arguments: {} }));
    check("6e whoami reflects the selected tenant for a wildcard principal", who.tenant === "proj-z");
  });

  pools.closeAll();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\nFALDA MCP: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  console.log("MCP AUTH GREEN");
}
main().catch((e) => { console.error(e); process.exit(1); });
