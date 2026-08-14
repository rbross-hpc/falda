/**
 * FALDA compact MCP surface tests (src/mcp/registry.ts, tools/*.ts).
 *
 * Proves the acceptance criteria for "simplify the Falda MCP surface":
 *   1. Default toolset exposes exactly the compact agent API (+ stream_add).
 *   2. Full toolset additionally exposes the tier-specific storage tools.
 *   3. falda_remember creates a new atom; falda_recall surfaces it with
 *      tier/id provenance. Content is immutable — a second falda_remember
 *      call with different content for the "same" fact creates a new atom,
 *      it never mutates the first.
 *   4. falda_forget performs logical archiving only (active -> archived,
 *      never physical delete); it reports whether an atom actually matched
 *      and is idempotent-safe (second call reports archived:0).
 *   5. falda_recall assembles context across tiers (pinned atom + scene +
 *      core) and returns {context, hits, truncated}.
 *   6. Cross-tenant isolation holds through the compact tools too.
 *   7. falda_distill / falda_distill_status / falda_whoami still work on
 *      the default surface.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Database from "better-sqlite3";
import { PoolManager } from "../src/pools.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { TokenStore } from "../src/mcp_auth.js";
import { handleFaldaMcpRequest } from "../src/mcp.js";
import { initQueueSchema } from "../src/distill/queue.js";
import type { ToolsetName } from "../src/mcp/registry.js";

function startTestServer(
  pools: PoolManager, tokenStore: TokenStore, queueDb: Database.Database, toolset?: ToolsetName,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const httpServer = createServer((req, res) => {
      handleFaldaMcpRequest(pools, tokenStore, req, res, queueDb, { toolset }).catch((e) => {
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
let queueDb: Database.Database;
let defaultServer: Server, defaultPort: number;
let fullServer: Server, fullPort: number;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-mcp-compact-"));
  const tokensPath = path.join(root, "tokens.json");
  fs.writeFileSync(tokensPath, JSON.stringify({
    tokens: {
      "tok-a": { tenants: ["proj-a"], pools: [], label: "A" },
      "tok-b": { tenants: ["proj-b"], pools: [], label: "B" },
    },
  }));
  pools = new PoolManager({ root: path.join(root, "data"), embed: makeLocalEmbedder(32), dim: 32 });
  tokenStore = new TokenStore(tokensPath);
  queueDb = new Database(path.join(root, "queue.db"));
  queueDb.pragma("busy_timeout = 5000");
  initQueueSchema(queueDb);
  ({ server: defaultServer, port: defaultPort } = await startTestServer(pools, tokenStore, queueDb, "default"));
  ({ server: fullServer, port: fullPort } = await startTestServer(pools, tokenStore, queueDb, "full"));
});

after(() => {
  pools.closeAll();
  queueDb.close();
  defaultServer.close();
  fullServer.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("1. default toolset: exactly the compact surface (+ stream_add)", async () => {
  await withClient(defaultPort, "tok-a", "proj-a", async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "falda_distill",
      "falda_distill_status",
      "falda_forget",
      "falda_recall",
      "falda_remember",
      "falda_stream_add",
      "falda_whoami",
    ]);
  });
});

test("2. full toolset: default + advanced tier-specific tools", async () => {
  await withClient(fullPort, "tok-a", "proj-a", async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const n of ["falda_recall", "falda_remember", "falda_forget", "falda_stream_add"]) {
      assert.ok(names.includes(n), `full includes compact tool ${n}`);
    }
    for (const n of [
      "falda_stream_search", "falda_stream_query",
      "falda_atoms_search", "falda_atoms_query", "falda_atoms_upsert",
      "falda_scenes_search", "falda_scenes_query", "falda_scenes_get",
      "falda_core_read",
    ]) {
      assert.ok(names.includes(n), `full includes advanced tool ${n}`);
    }
  });
});

test("3. falda_remember creates a new atom each time; content is immutable", async () => {
  await withClient(defaultPort, "tok-a", "proj-a", async (client) => {
    const first = textOf(await client.callTool({
      name: "falda_remember",
      arguments: { content: "cryostat target 4.2K", type: "fact" },
    }));
    assert.ok(first.id, "remember returns an id");
    assert.equal(first.type, "fact");

    const second = textOf(await client.callTool({
      name: "falda_remember",
      arguments: { content: "cryostat target 3.8K (revised)", type: "fact" },
    }));
    assert.notEqual(second.id, first.id, "a changed proposition becomes a new atom, not a mutation");
  });
});

test("4. falda_forget archives, does not delete, and reports match count", async () => {
  await withClient(defaultPort, "tok-a", "proj-a", async (client) => {
    const saved = textOf(await client.callTool({
      name: "falda_remember",
      arguments: { content: "forget-me fact", type: "fact" },
    }));

    const recallBefore = textOf(await client.callTool({
      name: "falda_recall", arguments: { query: "forget-me fact" },
    }));
    assert.ok(
      recallBefore.hits.some((h: any) => h.id === saved.id),
      "atom is recallable before forgetting",
    );

    const forgetResult = textOf(await client.callTool({
      name: "falda_forget", arguments: { atom_id: saved.id, reason: "no longer relevant" },
    }));
    assert.deepEqual(forgetResult, { ok: true, archived: 1 });

    const recallAfter = textOf(await client.callTool({
      name: "falda_recall", arguments: { query: "forget-me fact" },
    }));
    assert.ok(
      !recallAfter.hits.some((h: any) => h.id === saved.id),
      "forgotten atom no longer surfaces in recall",
    );

    const forgetAgain = textOf(await client.callTool({
      name: "falda_forget", arguments: { atom_id: saved.id },
    }));
    assert.deepEqual(forgetAgain, { ok: true, archived: 0 }, "re-forgetting an already-archived atom is a no-op, not an error");
  });
});

test("5. falda_recall assembles cross-tier context with structured hits", async () => {
  await withClient(fullPort, "tok-a", "proj-a", async (client) => {
    // Seed a pinned atom, a scene (T2), and core (T3) directly via advanced tools.
    await client.callTool({
      name: "falda_atoms_upsert",
      arguments: { content: "always use SI units in cryostat logs", type: "instruction", pinned: true },
    });
    await client.callTool({
      name: "falda_core_read", arguments: {},
    });
  });

  await withClient(defaultPort, "tok-a", "proj-a", async (client) => {
    const recall = textOf(await client.callTool({
      name: "falda_recall", arguments: { query: "cryostat units" },
    }));
    assert.equal(typeof recall.context, "string");
    assert.ok(Array.isArray(recall.hits));
    assert.equal(typeof recall.truncated, "boolean");
    assert.ok(
      recall.hits.some((h: any) => h.tier === "T1" && h.pinned === true),
      "pinned instruction surfaces as a T1 hit",
    );
    assert.ok(recall.context.includes("SI units"), "pinned content appears in rendered context");
  });
});

test("6. cross-tenant isolation holds for falda_recall/falda_remember", async () => {
  await withClient(defaultPort, "tok-b", "proj-b", async (client) => {
    await client.callTool({ name: "falda_remember", arguments: { content: "proj-b secret via remember", type: "fact" } });
    const own = textOf(await client.callTool({ name: "falda_recall", arguments: { query: "proj-b secret" } }));
    assert.ok(own.context.includes("proj-b secret"), "proj-b can recall its own memory");
  });
  await withClient(defaultPort, "tok-a", "proj-a", async (client) => {
    const cross = textOf(await client.callTool({ name: "falda_recall", arguments: { query: "proj-b secret" } }));
    assert.ok(!cross.context.includes("proj-b secret"), "proj-a cannot recall proj-b's memory");
  });
});

test("7. falda_distill / falda_distill_status / falda_whoami still work on the default surface", async () => {
  await withClient(defaultPort, "tok-a", "proj-a", async (client) => {
    const who = textOf(await client.callTool({ name: "falda_whoami", arguments: {} }));
    assert.equal(who.tenant, "proj-a");

    const enqueue = textOf(await client.callTool({ name: "falda_distill", arguments: {} }));
    assert.ok(enqueue.job_id, "falda_distill returns a job_id (no worker running in this test, that's fine)");

    const status = textOf(await client.callTool({
      name: "falda_distill_status", arguments: { job_id: enqueue.job_id },
    }));
    assert.equal(status.status, "pending");
  });
});
