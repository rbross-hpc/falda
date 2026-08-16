/**
 * FALDA unified runtime — the single canonical bootstrap for all server
 * processes (src/server.ts's `falda serve`, and the legacy standalone
 * src/gateway.ts / src/mcp.ts entry points, which now delegate here).
 *
 * Builds every shared resource exactly once:
 *   - PoolManager (embedder + store resolution)
 *   - TokenStore (auth, shared by HTTP and MCP)
 *   - distillation queue db (shared by both protocol adapters and the worker)
 *   - distillation LLM client
 *
 * Both the HTTP JSON API (src/gateway.ts's handleRequest) and the MCP server
 * (src/mcp.ts's makeFaldaMcpServer / handleFaldaMcpRequest) are handed this
 * same runtime rather than constructing their own copies of these resources.
 * This is what makes "one falda process = one embedder, one LLM client, one
 * queue, one worker" true regardless of how many protocol surfaces are started.
 *
 * Config consolidation: one canonical FALDA_TOKENS path is used for both
 * HTTP and MCP auth (previously the gateway read FALDA_TOKENS and the MCP
 * server read a separate FALDA_MCP_TOKENS — an unintentional credential
 * split with no security rationale). FALDA_MCP_TOKENS is still honored as a
 * deprecated fallback (with a startup warning) for one release, so an
 * existing deployment's token file keeps working until it migrates its env.
 *
 * Env:
 *   FALDA_ROOT           Pool root dir (default ./falda-data)
 *   FALDA_DIM            Embedding dimensionality (default 768)
 *   FALDA_EMBED*         Embedder selection — see src/boot.ts
 *   FALDA_TOKENS         Path to the token file (default ./falda_tokens.json)
 *   FALDA_MCP_TOKENS     Deprecated fallback for FALDA_TOKENS (warns if used)
 *   FALDA_LLM_*          Distillation LLM client — see src/distill/llm.ts
 *   FALDA_RECALL_TRACE_RETENTION_DAYS
 *                        Days to retain recall_traces.db rows before the
 *                        distillation worker prunes them (default 90; <=0
 *                        disables pruning — see src/recall/retention.ts).
 */
import { join as pathJoin } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { PoolManager } from "./pools.js";
import { selectEmbedder, enforceEmbeddingLock, probeEmbedder } from "./boot.js";
import { TokenStore, requireTokenFile } from "./mcp_auth.js";
import { initQueueSchema } from "./distill/queue.js";
import { makeLLM, type LLMFnWithModel } from "./distill/llm.js";
import { initRecallTraceSchema } from "./recall/schema.js";
import { MetricsRegistry } from "./metrics.js";

export interface RuntimeConfig {
  root?: string;
  dim?: number;
  tokensPath?: string;
  label?: string;
}

export interface FaldaRuntime {
  root: string;
  dim: number;
  pools: PoolManager;
  tokenStore: TokenStore;
  queueDb: Database.Database;
  recallTraceDb: Database.Database;
  llm: LLMFnWithModel;
  /** Since-startup timing histograms (src/metrics.ts) — shared by every
   *  surface (HTTP, MCP, distillation worker) so /metrics reflects the
   *  whole process's activity, not one surface's. */
  metrics: MetricsRegistry;
  /** Set by src/server.ts (and the legacy gateway.ts entry point) once the
   *  distillation worker has started, since the worker itself is
   *  constructed AFTER the runtime (it needs runtime.queueDb). Calling it
   *  drains ready explicit-priority distill jobs immediately rather than
   *  waiting for the next timed drain tick — see src/distill/worker.ts's
   *  wake(). Undefined if no worker is running in this process (e.g. a
   *  bare MCP-only or HTTP-only legacy entry point) — callers must treat
   *  it as optional and simply fall back to the timed drain in that case. */
  wakeDistiller?: () => void;
  close(): void;
}

/** Resolve the canonical token file path, honoring the deprecated
 *  FALDA_MCP_TOKENS fallback with a one-time startup warning. */
function resolveTokensPath(explicit: string | undefined, label: string): string {
  if (explicit) return explicit;
  if (process.env.FALDA_TOKENS) return process.env.FALDA_TOKENS;
  if (process.env.FALDA_MCP_TOKENS) {
    console.warn(
      `${label}: FALDA_MCP_TOKENS is deprecated — both HTTP and MCP now share one token ` +
        `file via FALDA_TOKENS. Rename the env var; the file format is unchanged.`,
    );
    return process.env.FALDA_MCP_TOKENS;
  }
  return "./falda_tokens.json";
}

/**
 * Build the shared runtime once. Call this exactly once per process
 * (src/server.ts does); every protocol adapter and the distillation worker
 * receive the same instance.
 *
 * Async since it probes the embedder over the network before locking in
 * EMBEDDING.json (src/boot.ts probeEmbedder) — a down endpoint or dim
 * mismatch fails boot here rather than corrupting recall silently later.
 */
export async function buildRuntime(cfg: RuntimeConfig = {}): Promise<FaldaRuntime> {
  const label = cfg.label ?? "FALDA";
  const root = cfg.root ?? process.env.FALDA_ROOT ?? "./falda-data";
  const dim = cfg.dim ?? Number(process.env.FALDA_DIM ?? 768);
  const tokensPath = resolveTokensPath(cfg.tokensPath, label);

  const embed = selectEmbedder(dim, label);
  await probeEmbedder(embed, dim, label);
  enforceEmbeddingLock(root, dim, label);
  requireTokenFile(tokensPath, label);

  const pools = new PoolManager({ root, embed, dim });
  const tokenStore = new TokenStore(tokensPath);

  mkdirSync(root, { recursive: true });
  const queueDbPath = pathJoin(root, "distill_queue.db");
  const queueDb = new Database(queueDbPath);
  // busy_timeout: HTTP/MCP enqueue writes and the worker's claim/drain writes
  // all share this one connection's underlying file — wait rather than throw
  // SQLITE_BUSY under concurrent access.
  queueDb.pragma("busy_timeout = 5000");
  initQueueSchema(queueDb);

  const recallTraceDbPath = pathJoin(root, "recall_traces.db");
  const recallTraceDb = new Database(recallTraceDbPath);
  recallTraceDb.pragma("busy_timeout = 5000");
  initRecallTraceSchema(recallTraceDb);

  const llm = makeLLM();
  const metrics = new MetricsRegistry();

  const runtime: FaldaRuntime = {
    root,
    dim,
    pools,
    tokenStore,
    queueDb,
    recallTraceDb,
    llm,
    metrics,
    wakeDistiller: undefined,
    close() {
      pools.closeAll();
      queueDb.close();
      recallTraceDb.close();
    },
  };
  return runtime;
}
