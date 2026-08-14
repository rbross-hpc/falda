/**
 * Unified server / shared runtime tests (src/runtime.ts, src/server.ts).
 *
 * Proves the acceptance criteria for "merge the daemon, not the APIs":
 *   1. buildRuntime() builds exactly one PoolManager / queue db / LLM client.
 *   2. HTTP and MCP resolve the same tenant/pool store from that one runtime.
 *   3. HTTP and MCP authenticate against the same TokenStore (one token file).
 *   4. An MCP-enqueued falda_distill job is drained by the in-process worker
 *      (no separate gateway process required).
 *   5. HTTP API and MCP each serve /healthz on their own port, from one process.
 *   6. `serve({ noMcp: true })` starts HTTP + the worker without an MCP listener.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildRuntime, type FaldaRuntime } from "../src/runtime.js";
import { handleRequest } from "../src/gateway.js";
import { serve, startHttpApi, startMcp, type ServeHandle } from "../src/server.js";
import { getJob } from "../src/distill/queue.js";

function makeTokenFile(root: string, tokens: Record<string, any>): string {
  const p = path.join(root, "tokens.json");
  fs.writeFileSync(p, JSON.stringify({ tokens }));
  return p;
}

function makeTestRuntime(overrides: { tokens?: Record<string, any> } = {}): { runtime: FaldaRuntime; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-runtime-"));
  const tokensPath = makeTokenFile(root, overrides.tokens ?? {
    "tok-shared": { tenants: ["proj-x"], pools: [], label: "shared" },
    "tok-star": { tenants: ["*"], pools: [], label: "star" },
  });
  process.env.FALDA_EMBED = "local";
  process.env.FALDA_DIM = "32";
  const runtime = buildRuntime({
    root: path.join(root, "data"),
    dim: 32,
    tokensPath,
    label: "test-runtime",
  });
  return { runtime, root };
}

function cleanupRuntime(runtime: FaldaRuntime, root: string) {
  runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
}

// ─── 1. buildRuntime: single shared resources ─────────────────────────────────

describe("buildRuntime", () => {
  test("builds one PoolManager, one queueDb, one LLM client, one TokenStore", () => {
    const { runtime, root } = makeTestRuntime();
    try {
      assert.ok(runtime.pools, "pools present");
      assert.ok(runtime.tokenStore, "tokenStore present");
      assert.ok(runtime.queueDb, "queueDb present");
      assert.equal(typeof runtime.llm, "function", "llm is a callable client");
      // Identity check: calling buildRuntime again produces distinct instances
      // (proving each call is a fresh, independent bootstrap — no hidden
      // module-level singleton leaking across runtimes).
    } finally { cleanupRuntime(runtime, root); }
  });

  test("two buildRuntime() calls do not share state (no hidden singleton)", () => {
    const a = makeTestRuntime();
    const b = makeTestRuntime();
    try {
      assert.notEqual(a.runtime.pools, b.runtime.pools);
      assert.notEqual(a.runtime.queueDb, b.runtime.queueDb);
    } finally {
      cleanupRuntime(a.runtime, a.root);
      cleanupRuntime(b.runtime, b.root);
    }
  });
});

// ─── 2 & 3. HTTP and MCP share the same runtime: same store, same auth ────────

describe("HTTP and MCP share one runtime", () => {
  let runtime: FaldaRuntime;
  let root: string;
  let httpServer: ReturnType<typeof startHttpApi>;
  let mcpServer: ReturnType<typeof startMcp>;
  let httpPort: number;
  let mcpPort: number;

  before(() => {
    ({ runtime, root } = makeTestRuntime());
    httpServer = startHttpApi(runtime, 0);
    mcpServer = startMcp(runtime, 0);
    httpPort = (httpServer.address() as any).port;
    mcpPort = (mcpServer.address() as any).port;
  });

  after(() => {
    httpServer.close();
    mcpServer.close();
    cleanupRuntime(runtime, root);
  });

  async function withMcpClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer tok-shared", "X-Falda-Tenant": "proj-x" } },
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    try { return await fn(client); } finally { await client.close(); }
  }

  test("HTTP write is visible via MCP read (same store, same runtime)", async () => {
    // Write an atom via the HTTP API.
    const writeRes = await handleRequest(
      runtime.pools, runtime.tokenStore,
      { authorization: "Bearer tok-shared", "x-falda-tenant": "proj-x" },
      "/atoms/upsert",
      { type: "fact", content: "The unified runtime shares one store." },
      runtime.queueDb,
    );
    assert.equal(writeRes.status, 200, "HTTP write succeeded");

    // Read it back via MCP.
    const searchResult = await withMcpClient((client) =>
      client.callTool({ name: "falda_atoms_search", arguments: { query: "unified runtime shares" } })
    );
    const content = (searchResult as any).content[0].text;
    const parsed = JSON.parse(content);
    assert.ok(parsed.items.length > 0, "MCP search finds the atom written via HTTP");
    assert.ok(
      parsed.items.some((i: any) => i.content.includes("unified runtime")),
      "the specific atom is present",
    );
  });

  test("both surfaces authenticate against the same TokenStore", async () => {
    // A bad token fails on HTTP.
    const httpBad = await handleRequest(
      runtime.pools, runtime.tokenStore,
      { authorization: "Bearer nonexistent", "x-falda-tenant": "proj-x" },
      "/atoms/search", { query: "x" }, runtime.queueDb,
    );
    assert.equal(httpBad.status, 401, "HTTP rejects unknown token");

    // The same bad token fails on MCP.
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer nonexistent", "X-Falda-Tenant": "proj-x" } },
    });
    const client = new Client({ name: "test-bad", version: "0.0.0" });
    await assert.rejects(() => client.connect(transport), "MCP rejects the same unknown token");

    // The good token works on both (already proven by the previous test for
    // MCP; confirm HTTP here too).
    const httpGood = await handleRequest(
      runtime.pools, runtime.tokenStore,
      { authorization: "Bearer tok-shared", "x-falda-tenant": "proj-x" },
      "/atoms/search", { query: "x" }, runtime.queueDb,
    );
    assert.equal(httpGood.status, 200, "HTTP accepts the shared token");
  });

  test("HTTP and MCP each answer /healthz on their own port", async () => {
    const httpHealth = await fetch(`http://127.0.0.1:${httpPort}/healthz`);
    assert.equal(httpHealth.status, 200);
    const httpBody = await httpHealth.json() as any;
    assert.equal(httpBody.ok, true);
    assert.ok(Array.isArray(httpBody.tiers));

    const mcpHealth = await fetch(`http://127.0.0.1:${mcpPort}/healthz`);
    assert.equal(mcpHealth.status, 200);
    const mcpBody = await mcpHealth.json() as any;
    assert.equal(mcpBody.ok, true);
    assert.equal(mcpBody.mcp, true);
  });

  test("MCP-enqueued falda_distill job is processed by the in-process worker", async () => {
    // Seed a turn so the distill pass has something to do (and doesn't
    // fail on an empty window).
    const store = runtime.pools.resolve("proj-x", undefined, true);
    await store.addStream("sess-runtime-test", [{ role: "user", content: "unified server test turn" }]);

    // Enqueue via the MCP tool (the actual agent-facing path).
    const enqueueResult = await withMcpClient((client) =>
      client.callTool({ name: "falda_distill", arguments: {} })
    );
    const { job_id } = JSON.parse((enqueueResult as any).content[0].text);
    assert.ok(job_id, "falda_distill returns a job_id");

    // Start the in-process worker against this same runtime and let it drain.
    const { startDistiller } = await import("../src/distill/worker.js");
    // Use a real (if unreachable) LLM only if a pass actually needs it —
    // to keep this test offline/deterministic, stub the LLM to fail fast;
    // the goal here is only to prove the *job transitions off pending*,
    // not to prove distillOnce's LLM-dependent internals (covered elsewhere).
    const stubLlm = async () => { throw new Error("no LLM in this test — distillOnce may fail, that's fine"); };
    const distiller = startDistiller(runtime.queueDb, runtime.pools, stubLlm, 20);
    try {
      // The stub LLM makes distillOnce fail, so failJob() reschedules the job
      // back to 'pending' with backoff rather than leaving it in a terminal
      // state — so "processed" is proven by attempts > 0 / error set, not by
      // status leaving 'pending'.
      let job = getJob(runtime.queueDb, job_id);
      const deadline = Date.now() + 2000;
      while (job && job!.attempts === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        job = getJob(runtime.queueDb, job_id);
      }
      assert.ok(job, "job still exists");
      assert.ok(job!.attempts > 0, "worker claimed and attempted the job at least once");
      assert.ok(job!.error, "worker recorded the (expected) failure from the stub LLM");
    } finally {
      distiller.stop();
    }
  });
});

// ─── 4. serve({ noMcp: true }) ─────────────────────────────────────────────────

describe("serve() with --no-mcp", () => {
  test("starts HTTP API + worker, no MCP listener", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-serve-nomcp-"));
    const tokensPath = makeTokenFile(root, {
      "tok-star": { tenants: ["*"], pools: [], label: "star" },
    });
    let handle: ServeHandle | undefined;
    try {
      handle = serve({
        httpPort: 0,
        mcpPort: 0,
        noMcp: true,
        runtimeConfig: { root: path.join(root, "data"), dim: 32, tokensPath, label: "no-mcp-test" },
      });
      assert.equal(handle.mcpServer, null, "no MCP server started");
      assert.ok(handle.httpServer.listening, "HTTP server is listening");
      assert.ok(handle.distiller, "distiller worker started");

      const port = (handle.httpServer.address() as any).port;
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(health.status, 200, "HTTP API reachable");
    } finally {
      handle?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
