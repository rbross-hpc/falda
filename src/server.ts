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
import { handleRequest } from "./gateway.js";
import { handleFaldaMcpRequest } from "./mcp.js";
import { startDistiller, resolveWorkerIntervals, type DistillerHandle } from "./distill/worker.js";
import { buildRuntime, type FaldaRuntime, type RuntimeConfig } from "./runtime.js";
import type { ToolsetName } from "./mcp/registry.js";
import type { Server } from "node:http";

export interface ServeOptions {
  httpPort?: number;
  mcpPort?: number;
  /** Bind host for the HTTP API. Default 127.0.0.1 (or FALDA_BIND) — see
   *  docs/future/reliability-hardening.md finding 11. */
  httpHost?: string;
  /** Bind host for the MCP endpoint. Default 127.0.0.1 (or FALDA_MCP_BIND). */
  mcpHost?: string;
  /** Max HTTP request body size in bytes, enforced before parsing/auth.
   *  Default 1 MiB (or FALDA_MAX_BODY_BYTES); <= 0 disables the cap. */
  maxBodyBytes?: number;
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
  /**
   * Graceful shutdown: stop accepting new HTTP connections, await in-flight
   * HTTP request handlers and any in-flight distillation job (each bounded
   * by FALDA_SHUTDOWN_GRACE_MS, default 10s), then close storage. Safe to
   * call once. See docs/future/reliability-hardening.md finding 4.
   */
  close(): Promise<void>;
}

/**
 * Tracks in-flight request handler promises for a listener, so
 * ServeHandle.close() can await them (bounded by a grace period) before
 * closing storage — see docs/future/reliability-hardening.md finding 4.
 * Exported for use by both startHttpApi and (in principle) other listeners
 * this module might add.
 */
export class InFlightTracker {
  private readonly inFlight = new Set<Promise<unknown>>();

  /** Wrap a request-handling promise so it's tracked until it settles. */
  track<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    const clear = () => this.inFlight.delete(p);
    p.then(clear, clear);
    return p;
  }

  get size(): number {
    return this.inFlight.size;
  }

  /** Await all currently-tracked promises, bounded by graceMs. Returns true
   *  if everything settled within the grace period, false if it timed out. */
  async drain(graceMs: number): Promise<boolean> {
    if (this.inFlight.size === 0) return true;
    const snapshot = [...this.inFlight];
    let timedOut = false;
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => { timedOut = true; resolve(); }, graceMs);
    });
    await Promise.race([Promise.allSettled(snapshot), timeout]);
    return !timedOut;
  }
}

/**
 * Default bind host for both listeners: loopback-only, not all-interfaces.
 * See docs/future/reliability-hardening.md finding 11 / docs/future/
 * auth-hardening.md Option C. Override with FALDA_BIND (HTTP) /
 * FALDA_MCP_BIND (MCP) — e.g. "0.0.0.0" for a containerized deployment
 * that needs `docker -p` to reach the listener from outside the container
 * (binding loopback *inside* a container defeats port publishing, since
 * the Docker proxy connects to the container's own address, not its
 * loopback interface).
 */
const DEFAULT_BIND_HOST = "127.0.0.1";

/**
 * Default cap on a single HTTP request body, in bytes. Enforced before
 * JSON parsing and before auth (src/gateway.ts's handleRequest only
 * authenticates after the full body is available), so an unauthenticated
 * caller can't force unbounded memory growth by streaming an oversized
 * body. Override with FALDA_MAX_BODY_BYTES; <= 0 disables the cap. Does
 * not apply to the MCP listener — src/mcp/server.ts's
 * handleFaldaMcpRequest authenticates *before* the SDK's
 * StreamableHTTPServerTransport reads any body, so the pre-auth-flood gap
 * this closes doesn't exist there, and the SDK (not this module) owns
 * that request's body stream. See docs/future/reliability-hardening.md
 * finding 11.
 */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

function resolveBindHost(envVar: string, override?: string): string {
  return override ?? process.env[envVar] ?? DEFAULT_BIND_HOST;
}

function resolveMaxBodyBytes(override?: number): number {
  const raw = override ?? Number(process.env.FALDA_MAX_BODY_BYTES ?? DEFAULT_MAX_BODY_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : Infinity;
}

export interface StartHttpApiOpts {
  host?: string;
  maxBodyBytes?: number;
}

/**
 * Start the HTTP/JSON API on its own listener, against the shared runtime.
 *
 * Returns a promise that resolves once the listener is actually bound
 * (server.address() is populated) rather than the Server synchronously:
 * passing an explicit host to net.Server#listen() makes Node resolve it
 * via an async DNS lookup even for a literal IP like "127.0.0.1", unlike
 * the previous host-less `listen(port, cb)` form, which bound
 * synchronously. Awaiting "listening" keeps that guarantee for callers
 * (serve(), tests) that read .address() right after starting.
 */
export function startHttpApi(
  runtime: FaldaRuntime, port: number, inFlight = new InFlightTracker(), opts: StartHttpApiOpts = {},
): Promise<Server & { inFlight: InFlightTracker }> {
  const host = resolveBindHost("FALDA_BIND", opts.host);
  const maxBodyBytes = resolveMaxBodyBytes(opts.maxBodyBytes);
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, tiers: ["stream", "atoms", "scenes", "core"], pools: true }));
    }
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    // Reject an oversized body before it's even fully read, and before
    // handleRequest's auth check — see DEFAULT_MAX_BODY_BYTES doc comment
    // and finding 11. Content-Length is a fast-path rejection (a caller
    // that honestly declares an oversized body never has to be streamed
    // at all); the running-total check below is the real defense against
    // a missing/lying Content-Length with a chunked flood.
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "request body too large", limit: maxBodyBytes }));
      req.destroy();
      return;
    }
    let body = "";
    let rejected = false;
    let received = 0;
    req.on("data", (c) => {
      if (rejected) return;
      received += c.length;
      if (received > maxBodyBytes) {
        rejected = true;
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "request body too large", limit: maxBodyBytes }));
        req.destroy();
        return;
      }
      body += c;
    });
    req.on("end", () => {
      if (rejected) return;
      const handled = (async () => {
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
      })();
      inFlight.track(handled);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`FALDA HTTP API listening on ${host}:${port} (root=${runtime.root})`);
      resolve(Object.assign(server, { inFlight }));
    });
  });
}

export interface StartMcpOpts {
  host?: string;
}

/**
 * Start the MCP endpoint on its own listener, against the shared runtime.
 * See startHttpApi's doc comment for why this returns a promise (the
 * explicit host argument makes .listen() bind asynchronously).
 */
export function startMcp(runtime: FaldaRuntime, port: number, toolset?: ToolsetName, opts: StartMcpOpts = {}): Promise<Server> {
  const host = resolveBindHost("FALDA_MCP_BIND", opts.host);
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
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`FALDA MCP listening on ${host}:${port} (root=${runtime.root})`);
      resolve(server);
    });
  });
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
  const shutdownGraceMs = Number(process.env.FALDA_SHUTDOWN_GRACE_MS ?? 10_000);

  const runtime = await buildRuntime({ label: "FALDA", ...opts.runtimeConfig });

  const distiller = startDistiller(runtime.queueDb, runtime.pools, runtime.llm, {
    drainIntervalMs, sweepIntervalMs,
    recallTraceDb: runtime.recallTraceDb,
    metrics: runtime.metrics,
    shutdownGraceMs,
  });
  runtime.wakeDistiller = () => distiller.wake();

  const httpServer = await startHttpApi(runtime, httpPort, undefined, { host: opts.httpHost, maxBodyBytes: opts.maxBodyBytes });
  const mcpServer = opts.noMcp ? null : await startMcp(runtime, mcpPort, opts.mcpToolset, { host: opts.mcpHost });

  let closed = false;
  return {
    runtime,
    httpServer,
    mcpServer,
    distiller,
    // Order: stop accepting new HTTP connections and stop the distiller
    // claiming new work FIRST (in parallel — neither depends on the
    // other), then await whatever was already in flight on each, THEN
    // close storage. This avoids the failure mode where an in-flight
    // request or distillation pass hits a closed SQLite handle mid-write.
    // MCP relies on its own listener close (the MCP SDK owns that
    // request's lifecycle) rather than the same in-flight tracking used
    // for HTTP — see docs/future/reliability-hardening.md finding 4.
    async close() {
      if (closed) return;
      closed = true;
      const httpClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      const mcpClosed = mcpServer
        ? new Promise<void>((resolve) => mcpServer.close(() => resolve()))
        : Promise.resolve();
      const [, , inFlightOk] = await Promise.all([
        httpClosed,
        mcpClosed,
        (httpServer as any).inFlight?.drain(shutdownGraceMs) ?? Promise.resolve(true),
        distiller.stop(),
      ]);
      if (inFlightOk === false) {
        console.error(
          `[falda-server] close(): one or more in-flight HTTP requests did not ` +
          `finish within ${shutdownGraceMs}ms grace period — closing storage anyway.`,
        );
      }
      runtime.close();
    },
  };
}

async function shutdown(handle: ServeHandle, signal: string): Promise<void> {
  console.log(`falda serve: received ${signal}, shutting down gracefully...`);
  try {
    await handle.close();
    process.exit(0);
  } catch (e) {
    console.error("falda serve: error during shutdown:", e);
    process.exit(1);
  }
}

const IS_MAIN = process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts");
if (IS_MAIN) {
  const args = process.argv.slice(2);
  const noMcp = args.includes("--no-mcp");
  serve({ noMcp }).then((handle) => {
    let shuttingDown = false;
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        if (shuttingDown) {
          // Second signal: the operator wants out now, not a graceful wait.
          console.log(`falda serve: received ${signal} again, forcing immediate exit`);
          process.exit(1);
        }
        shuttingDown = true;
        shutdown(handle, signal);
      });
    }
  }).catch((e) => { console.error(e); process.exit(1); });
}
