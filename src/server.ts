/**
 * FALDA unified server — `falda serve`.
 *
 * Merges the daemon, not the APIs: one process, one shared runtime
 * (src/runtime.ts), three independent surfaces layered on top of it —
 * the HTTP/JSON API, the MCP endpoint, and the distillation worker. Each
 * surface is started by its own function and could be disabled
 * independently (only --no-mcp is wired today; the separation exists so
 * --no-api or similar could be added later without restructuring).
 *
 *   buildRuntime()      — one PoolManager, one TokenStore, one queue db,
 *                         one LLM client (src/runtime.ts)
 *   startHttpApi(rt)    — src/gateway.ts's handleRequest, on its own port
 *   startMcp(rt)        — src/mcp.ts's handleFaldaMcpRequest, on its own port
 *   startDistiller(rt)  — src/distill/worker.ts, draining the same queue db
 *                         both surfaces enqueue into
 *
 * This is what eliminates the failure mode where MCP accepts a
 * falda_distill call but no process is running to drain it: the worker
 * started here shares runtime.queueDb with both protocol adapters.
 *
 * Networking: two ports, one process (not one shared listener) — the MCP
 * SDK's StreamableHTTPServerTransport is happiest owning its own request
 * lifecycle, and keeping ports separate avoids any path-routing fragility
 * between the two protocols while still satisfying "one daemon lifecycle".
 *
 *   FALDA_PORT          HTTP JSON API port (default 8077)
 *   FALDA_MCP_PORT       MCP port (default 8079)
 *   FALDA_MCP_TOOLSET    "default" (compact agent API, recommended) or
 *                        "full" (adds tier-specific storage tools) — see
 *                        src/mcp/registry.ts.
 *
 * Config (see src/runtime.ts for the full list): FALDA_ROOT, FALDA_DIM,
 *   FALDA_EMBED*, FALDA_TOKENS (canonical — one token file for both
 *   surfaces), FALDA_LLM_*, FALDA_DRAIN_INTERVAL_MS, FALDA_SWEEP_INTERVAL_MS
 *   (FALDA_WORKER_INTERVAL_MS is a deprecated fallback for both — see
 *   src/distill/worker.ts's resolveWorkerIntervals).
 *
 * CLI flags:
 *   falda serve             HTTP API + MCP + distillation worker (default)
 *   falda serve --no-mcp    HTTP API + distillation worker only
 */
import { createServer } from "node:http";
import { PoolError } from "./pools.js";
import { AuthError, parseBearer } from "./mcp_auth.js";
import { handleRequest } from "./gateway.js";
import { handleFaldaMcpRequest } from "./mcp.js";
import { startDistiller, resolveWorkerIntervals, type DistillerHandle } from "./distill/worker.js";
import { buildRuntime, type FaldaRuntime, type RuntimeConfig } from "./runtime.js";
import type { ToolsetName } from "./mcp/registry.js";
import type { Server } from "node:http";

export interface ServeOptions {
  httpPort?: number;
  mcpPort?: number;
  /** Deprecated: sets both drain and sweep cadence when the split options
   *  below are omitted. Prefer drainIntervalMs/sweepIntervalMs. */
  workerIntervalMs?: number;
  drainIntervalMs?: number;
  sweepIntervalMs?: number;
  noMcp?: boolean;
  mcpToolset?: ToolsetName;
  runtimeConfig?: RuntimeConfig;
}

export interface ServeHandle {
  runtime: FaldaRuntime;
  httpServer: Server;
  mcpServer: Server | null;
  distiller: DistillerHandle;
  close(): void;
}

/** Start the HTTP/JSON API on its own listener, against the shared runtime. */
export function startHttpApi(runtime: FaldaRuntime, port: number): Server {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, tiers: ["stream", "atoms", "scenes", "core"], pools: true }));
    }
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        const { status, body: out } = await handleRequest(
          runtime.pools, runtime.tokenStore, req.headers, req.url ?? "", parsed,
          runtime.queueDb, runtime.recallTraceDb, runtime.metrics, runtime.wakeDistiller,
        );
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e: any) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      }
    });
  });
  server.listen(port, () => console.log(`FALDA HTTP API listening on :${port} (root=${runtime.root})`));
  return server;
}

/** Start the MCP endpoint on its own listener, against the shared runtime. */
export function startMcp(runtime: FaldaRuntime, port: number, toolset?: ToolsetName): Server {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, mcp: true }));
      return;
    }
    if (req.url !== "/mcp" && req.url !== "/") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    handleFaldaMcpRequest(runtime.pools, runtime.tokenStore, req, res, runtime.queueDb, {
      toolset, recallTraceDb: runtime.recallTraceDb,
      metrics: runtime.metrics, wakeDistiller: runtime.wakeDistiller,
    }).catch((e) => {
      console.error("[falda-mcp] fatal:", e);
      if (!res.headersSent) {
        res.writeHead(e instanceof PoolError ? 400 : 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      }
    });
  });
  server.listen(port, () => console.log(`FALDA MCP listening on :${port} (root=${runtime.root})`));
  return server;
}

/**
 * Bring up the unified server: one runtime, HTTP API always, MCP unless
 * --no-mcp, and the distillation worker always (it is the canonical owner
 * of the queue regardless of which protocol surfaces are enabled).
 *
 * The distiller is started BEFORE the HTTP/MCP listeners so that
 * runtime.wakeDistiller is populated before any request could possibly rely
 * on it (an explicit falda_distill/POST /distill landing before the worker
 * exists would otherwise silently fall back to the timed drain for that one
 * call — starting order-of-operations avoids that race entirely).
 */
export async function serve(opts: ServeOptions = {}): Promise<ServeHandle> {
  const httpPort = opts.httpPort ?? Number(process.env.FALDA_PORT ?? 8077);
  const mcpPort = opts.mcpPort ?? Number(process.env.FALDA_MCP_PORT ?? 8079);
  const resolvedEnv = resolveWorkerIntervals();
  if (resolvedEnv.usingDeprecatedFallback) {
    console.warn(
      "falda serve: FALDA_WORKER_INTERVAL_MS is deprecated — set FALDA_DRAIN_INTERVAL_MS " +
      "(drain cadence, default 60000) and FALDA_SWEEP_INTERVAL_MS (passive-enqueue cadence, " +
      "default 300000) instead. FALDA_WORKER_INTERVAL_MS still sets both until removed.",
    );
  }
  const drainIntervalMs = opts.drainIntervalMs ?? opts.workerIntervalMs ?? resolvedEnv.drainIntervalMs;
  const sweepIntervalMs = opts.sweepIntervalMs ?? opts.workerIntervalMs ?? resolvedEnv.sweepIntervalMs;

  const runtime = await buildRuntime({ label: "FALDA", ...opts.runtimeConfig });

  const distiller = startDistiller(runtime.queueDb, runtime.pools, runtime.llm, {
    drainIntervalMs, sweepIntervalMs,
    recallTraceDb: runtime.recallTraceDb,
    metrics: runtime.metrics,
  });
  runtime.wakeDistiller = () => distiller.wake();

  const httpServer = startHttpApi(runtime, httpPort);
  const mcpServer = opts.noMcp ? null : startMcp(runtime, mcpPort, opts.mcpToolset);

  return {
    runtime,
    httpServer,
    mcpServer,
    distiller,
    close() {
      distiller.stop();
      httpServer.close();
      mcpServer?.close();
      runtime.close();
    },
  };
}

const IS_MAIN = process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts");
if (IS_MAIN) {
  const args = process.argv.slice(2);
  const noMcp = args.includes("--no-mcp");
  serve({ noMcp }).catch((e) => { console.error(e); process.exit(1); });
}
