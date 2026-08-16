/**
 * FALDA HTTP gateway — exposes the four-tier memory store over a small JSON API.
 *
 * Authentication (see src/mcp_auth.ts for the full rationale):
 *   Every request (except GET /healthz) requires `Authorization: Bearer <token>`,
 *   identifying a PRINCIPAL with an explicit `tenants` allow-list (or `["*"]`
 *   for a fully-trusted principal). This is the same TokenStore/Principal
 *   model used by the MCP server (src/mcp.ts) — one auth story for both front
 *   doors onto the pool layer. Auth is defense-in-depth on top of whatever
 *   network exposure the operator chooses (e.g. binding to localhost); it does
 *   not itself change the bind address.
 *
 * Multi-tenant + opt-in shared pools (see docs/POOLS.md):
 *   Every data route is addressed by {tenant, pool}.
 *     tenant : SELECTED per request via the `X-Falda-Tenant` header (not the
 *              request body). The token authorizes the selection — it does
 *              not fix a single tenant — so one token can drive several
 *              projects (each project = a tenant) by varying the header.
 *              Missing/unauthorized header -> 403. There is no default tenant.
 *     pool   : "self" (private, default) or a declared shared-pool name the
 *              token is authorized for (`self` always implicitly allowed).
 *
 * Data routes (all POST, JSON in/out) — each also accepts {pool?} in the body:
 *   /stream/add      {session_id, messages[{role,content,id?,timestamp?,turn_index?,turn_id?}]}
 *                                                        -> {accepted_ids, total_count}
 *   /stream/query    {session_id?, limit?, ...}          -> {messages, total}
 *   /stream/search   {query, limit?}                     -> {messages: hits}
 *   /stream/delete   {ids?|session_id}                   -> {deleted_count, affected_atom_ids}
 *   /atoms/upsert    {id?, type, content, background?, priority?, confidence?, pinned?, tags?}
 *                                                        -> Atom
 *   /atoms/query     {type?, limit?, ...}                -> {items, total}
 *   /atoms/search    {query, limit?}                     -> {items: hits}
 *   /atoms/delete    {ids[]}                             -> {deleted_count}
 *   /atoms/supersede {old_id, new_id}                   -> {ok}
 *   /atoms/merge     {loser_ids[], winner_id}            -> {ok}
 *   /atoms/archive   {id}                               -> {ok}
 *   /scenes/upsert   {scene_id?,scene_kind,title,atom_ids?,summary?,content_hash?,status?,
 *                     derived_from?,superseded_by?}      -> Scene
 *   /scenes/get      {scene_id}                          -> Scene | null
 *   /scenes/list     {scene_kind?,status?,limit?,offset?}-> {items, total}
 *   /scenes/remove   {scene_id}                          -> {ok}
 *   /scenes/search   {query, limit?}                     -> {items: hits}
 *   /scenes/for-atom {atom_id, scene_kind?}              -> {items}
 *   /core/read       {}                                  -> {content}
 *   /core/write      {content}                           -> {ok}
 *   /distill         {}                                  -> {job_id, store_key}
 *   /distill/status  {job_id}                             -> DistillJob | {error}
 *   /recall          {query?, topic?, budget?, mode?}      -> {recall_id?, context, items, truncated, total_chars}
 *                       Cross-tier context assembly (assembleContext(), src/distill/context.ts).
 *                       Exactly one of {query, topic} is required: `topic` resolves to an
 *                       active topic scene (exact scene_id, else a title substring match —
 *                       src/recall/topic.ts) and uses its title as the query, for "show me
 *                       a recall from the appropriate topic" callers (falda show recall
 *                       --topic=...) that don't want to guess a query string themselves.
 *                       `context` is the same rendered text the falda_recall MCP tool
 *                       returns (src/recall/render.ts) — added so the HTTP surface is not
 *                       limited to structured item metadata alone.
 *                       mode: "explicit" (default) or "auto" — selects which of
 *                       FALDA_RECALL_BUDGET/FALDA_AUTO_RECALL_BUDGET is used when budget
 *                       is omitted (see src/recall/budgets.ts). budget is always clamped
 *                       to FALDA_RECALL_MAX_BUDGET regardless of mode.
 *                       Best-effort persists a recall_traces.db trace (src/recall/) — recall_id
 *                       is omitted, never errors, if trace persistence fails.
 *
 * Recall-trace routes (POST) — telemetry attached to a prior /recall, not memory
 * mutation (see src/recall/ and docs/RECALL_TRACES.md):
 *   /recall/usage    {recall_id, used?:[{tier,id}], unused?:[{tier,id}]}
 *                                                        -> {updated:[{tier,id}], unchanged:[{tier,id}]}
 *   /recalls/get     {recall_id}                          -> RecallTraceView | 404
 *   /recalls/metrics {}                                   -> RecallMetrics for the caller's store_key
 *   /recalls/reconstruct {recall_id}                      -> {trace, context, stale_items} | 404
 *                       recall_id may be the literal string "latest" to mean "the most
 *                       recent trace for my store" (falda show recall's default, no-query
 *                       invocation) rather than requiring a known recall_id up front.
 *                       Re-renders that trace's items against CURRENT memory — NOT a
 *                       byte-faithful replay of what was originally returned, since traces
 *                       never stored rendered text (src/recall/reconstruct.ts). Items no
 *                       longer resolvable as they did at recall time (superseded, merged,
 *                       archived, retired, deleted) are listed in `stale_items` rather than
 *                       silently omitted or shown stale. Read-only — writes no new trace.
 *
 * Pool admin routes (POST) — cross-tenant management, restricted to
 * fully-trusted (`tenants: ["*"]`) principals regardless of X-Falda-Tenant:
 *   /pools/declare   {name, members:{tenant:access}, description?}  -> PoolDecl
 *   /pools/update    {name, members?, description?}                 -> PoolDecl
 *   /pools/grant     {name, tenant, access}                        -> PoolDecl
 *   /pools/get       {name}                                        -> {pool}
 *   /pools/list      {}                                            -> {pools}
 *   /pools/mine      {tenant}                                      -> {pools}
 *
 *   /metrics         {}                                             -> MetricsSnapshot
 *                       Since-process-startup timing histograms (src/metrics.ts):
 *                       distill_pending_ms, distill_service_ms, recall_ms. Fixed
 *                       predetermined bins, no raw samples retained, resets on
 *                       restart. Process-global — not addressed by {tenant, pool} —
 *                       any authenticated token may read it. Backs
 *                       `falda stats --section=timing` (src/stats.ts).
 *
 *   /healthz         (GET, unauthenticated)                        -> {ok, tiers}
 *
 * Prefer `falda serve` (src/server.ts) for new deployments — it starts this
 * same HTTP API alongside the MCP endpoint (src/mcp.ts) from one shared
 * runtime (src/runtime.ts), with one canonical token file and one
 * distillation worker for both surfaces. This module's own IS_MAIN entry
 * point (`node dist/gateway.js`) is kept for backward compatibility and is
 * equivalent to `falda serve --no-mcp`.
 *
 * Env: see src/runtime.ts for the canonical set (FALDA_ROOT, FALDA_DIM,
 *   FALDA_EMBED*, FALDA_TOKENS, FALDA_LLM_*). Gateway-specific:
 *   FALDA_PORT               Port to listen on (default 8077).
 *   FALDA_DRAIN_INTERVAL_MS  Distillation drain cadence, ms (default 60000).
 *   FALDA_SWEEP_INTERVAL_MS  Passive-enqueue-sweep cadence, ms (default 300000).
 *   FALDA_WORKER_INTERVAL_MS Deprecated fallback for both of the above — see
 *                            src/distill/worker.ts's resolveWorkerIntervals.
 *   FALDA_RECALL_BUDGET       Default /recall budget, explicit mode (default 6000).
 *   FALDA_AUTO_RECALL_BUDGET  Default /recall budget, auto mode (default 3500).
 *   FALDA_RECALL_MAX_BUDGET   Hard ceiling on any requested budget (default 20000).
 *   See src/recall/budgets.ts for the two-tier rationale.
 */
import { createServer } from "node:http";
import Database from "better-sqlite3";
import { PoolManager, PoolError } from "./pools.js";
import { TokenStore, AuthError, parseBearer, type Principal } from "./mcp_auth.js";
import { StreamConflictError, AtomImmutabilityError, AtomTypeError } from "./falda.js";
import { enqueue, storeKeyFor, getJobAuthorized, PRIORITY_EXPLICIT } from "./distill/queue.js";
import { buildRuntime } from "./runtime.js";
import { startDistiller, resolveWorkerIntervals } from "./distill/worker.js";
import { assembleContext, DEFAULT_TIER_BUDGETS } from "./distill/context.js";
import type { MetricsRegistry } from "./metrics.js";
import { resolveAutoRecallBudget, resolveMaxRecallBudget, resolveRecallBudget } from "./recall/budgets.js";
import { buildPolicySnapshot } from "./recall/policy.js";
import { createRecallTrace, getRecallTraceAuthorized, getLatestRecallTraceForStore } from "./recall/traces.js";
import { reportRecallUsage } from "./recall/usage.js";
import { computeRecallMetrics } from "./recall/metrics.js";
import { RecallTraceError } from "./recall/types.js";
import { renderContext } from "./recall/render.js";
import { reconstructRecallTrace } from "./recall/reconstruct.js";
import { resolveTopicQuery, TopicNotFoundError } from "./recall/topic.js";

// Recall budgets — see src/recall/budgets.ts for the two-tier rationale
// (explicit vs. auto) and FALDA_RECALL_BUDGET/FALDA_AUTO_RECALL_BUDGET/
// FALDA_RECALL_MAX_BUDGET env vars. Resolved once at module load.
const RECALL_DEFAULT_BUDGET = resolveRecallBudget();
const RECALL_AUTO_DEFAULT_BUDGET = resolveAutoRecallBudget();
const RECALL_MAX_BUDGET = resolveMaxRecallBudget();

/** Routes that mutate the addressed store (need readwrite on a shared pool). */
const WRITE_ROUTES = new Set([
  "/stream/add", "/stream/delete",
  "/atoms/upsert", "/atoms/delete", "/atoms/supersede", "/atoms/merge", "/atoms/archive",
  "/scenes/upsert", "/scenes/remove",
  "/core/write",
  "/distill",
]);

type Headers = Record<string, string | string[] | undefined>;

function headerValue(headers: Headers, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

async function handleData(
  pools: PoolManager,
  principal: Principal,
  headers: Headers,
  route: string,
  b: any,
  queueDb: Database.Database | undefined,
  recallTraceDb: Database.Database | undefined,
  metrics: MetricsRegistry | undefined,
  wakeDistiller: (() => void) | undefined,
) {
  const tenant = TokenStore.requireTenant(principal, headerValue(headers, "x-falda-tenant"));
  const pool = TokenStore.requirePool(principal, b.pool);
  const storeKey = storeKeyFor(tenant, pool ?? undefined);

  // /recall* routes address the recall_traces store, not the tenant's
  // memory store directly for usage/inspection/metrics (only /recall
  // itself also reads the memory store, to run assembleContext).
  if (route === "/recall/usage") {
    if (!recallTraceDb) return { error: "recall trace store not initialized" };
    return reportRecallUsage(recallTraceDb, b.recall_id, storeKey, b.used ?? [], b.unused ?? []);
  }
  if (route === "/recalls/get") {
    if (!recallTraceDb) return { error: "recall trace store not initialized" };
    const trace = getRecallTraceAuthorized(recallTraceDb, b.recall_id, storeKey);
    if (!trace) throw new RecallTraceError("not_found", `recall trace not found: ${b.recall_id}`);
    return trace;
  }
  if (route === "/recalls/metrics") {
    if (!recallTraceDb) return { error: "recall trace store not initialized" };
    return computeRecallMetrics(recallTraceDb, storeKey);
  }
  if (route === "/recalls/reconstruct") {
    if (!recallTraceDb) return { error: "recall trace store not initialized" };
    const trace = b.recall_id === "latest"
      ? getLatestRecallTraceForStore(recallTraceDb, storeKey)
      : getRecallTraceAuthorized(recallTraceDb, b.recall_id, storeKey);
    if (!trace) {
      throw new RecallTraceError(
        "not_found",
        b.recall_id === "latest"
          ? `no recall traces recorded yet for this store`
          : `recall trace not found: ${b.recall_id}`,
      );
    }
    const store = pools.resolve(tenant, pool, false);
    return reconstructRecallTrace(store, trace);
  }

  const store = pools.resolve(tenant, pool, WRITE_ROUTES.has(route));
  switch (route) {
    case "/recall": {
      if (!b.query && !b.topic) {
        return { error: "one of {query, topic} is required" };
      }
      const query = b.topic ? resolveTopicQuery(store, b.topic) : b.query;
      const mode: "explicit" | "auto" = b.mode === "auto" ? "auto" : "explicit";
      const defaultBudget = mode === "auto" ? RECALL_AUTO_DEFAULT_BUDGET : RECALL_DEFAULT_BUDGET;
      const budget = Math.min(b.budget ?? defaultBudget, RECALL_MAX_BUDGET);
      const recallStartedAt = Date.now();
      const assembled = await assembleContext(store, query, budget);
      metrics?.recall_ms.observe(Date.now() - recallStartedAt);
      let recall_id: string | undefined;
      if (recallTraceDb) {
        try {
          recall_id = createRecallTrace(recallTraceDb, {
            store_key: storeKey,
            tenant,
            pool: pool ?? null,
            query,
            requested_budget: budget,
            used_budget: assembled.total_chars,
            mode,
            policy_snapshot: buildPolicySnapshot(store.getRecallWeights(), DEFAULT_TIER_BUDGETS),
            items: assembled.items,
          });
        } catch (e) {
          // Best-effort telemetry — a trace-write failure must never fail
          // the recall itself. recall_id is simply omitted.
          console.error("[gateway] /recall trace persistence failed (non-fatal):", e);
        }
      }
      return {
        recall_id, context: renderContext(assembled),
        items: assembled.items, truncated: assembled.truncated, total_chars: assembled.total_chars,
      };
    }
    case "/stream/add":
      return store.addStream(b.session_id, b.messages ?? []).then((ids) => ({
        accepted_ids: ids, total_count: (b.messages ?? []).length,
      }));
    case "/stream/query":    return store.queryStream(b);
    case "/stream/search":   return { messages: await store.searchStream(b.query, b.limit) };
    case "/stream/delete":   return store.deleteStream(b);
    case "/atoms/upsert":
      if (Array.isArray(b.atoms)) {
        const items = [];
        for (const atom of b.atoms) items.push(await store.upsertAtom(atom));
        return { items, total_count: items.length };
      }
      return store.upsertAtom(b);
    case "/atoms/query":     return store.queryAtoms(b);
    case "/atoms/search":    return { items: await store.searchAtoms(b.query, b.limit) };
    case "/atoms/delete":    return { deleted_count: store.hardDeleteAtomsUnsafe(b.ids ?? []) };
    case "/atoms/supersede": return (store.supersedeAtom(b.old_id, b.new_id), { ok: true });
    case "/atoms/merge":     return (store.mergeAtoms(b.loser_ids ?? [], b.winner_id), { ok: true });
    case "/atoms/archive":   return (store.archiveAtom(b.id), { ok: true });
    case "/scenes/upsert":   return store.upsertScene(b);
    case "/scenes/get":      return store.getScene(b.scene_id);
    case "/scenes/list":     return store.listScenes(b);
    case "/scenes/remove":   return (store.removeScene(b.scene_id), { ok: true });
    case "/scenes/search":   return { items: await store.searchScenes(b.query, b.limit) };
    case "/scenes/for-atom": return { items: store.scenesForAtom(b.atom_id, b.scene_kind) };
    case "/core/read":       return { content: store.readCore() };
    case "/core/write":      return (store.writeCore(b.content ?? ""), { ok: true });
    case "/distill": {
      // store_key is always derived from the authenticated tenant+pool — never
      // from the request body, to prevent cross-tenant enqueue.
      const storeKey = storeKeyFor(tenant, pool ?? undefined);
      if (!queueDb) return { error: "distillation queue not initialized" };
      const jobId = enqueue(queueDb, storeKey, { priority: PRIORITY_EXPLICIT, origin: "http" });
      // Immediately drain, rather than waiting for the next timed tick —
      // see src/distill/worker.ts's wake(). Undefined only for the legacy
      // standalone gateway entry point if it somehow starts without a
      // worker (it always does today), or a future surface that enqueues
      // without owning a worker.
      wakeDistiller?.();
      return { job_id: jobId, store_key: storeKey };
    }
    case "/distill/status": {
      if (!queueDb) return { error: "distillation queue not initialized" };
      const callerKey = storeKeyFor(tenant, pool ?? undefined);
      // getJobAuthorized returns null for both missing and unauthorized jobs
      // so the caller cannot distinguish the two (no existence oracle).
      const job = getJobAuthorized(queueDb, b.job_id, callerKey);
      return job ?? { error: "job not found" };
    }
    default: return undefined;
  }
}

function requireAdmin(principal: Principal) {
  if (!principal.tenants.includes("*")) {
    throw new AuthError(403, "pool admin routes require a fully-trusted (tenants: [\"*\"]) token");
  }
}

function handlePool(pools: PoolManager, principal: Principal, route: string, b: any) {
  requireAdmin(principal);
  switch (route) {
    case "/pools/declare": return pools.declarePool(b.name, b.members ?? {}, b.description ?? "");
    case "/pools/update":  return pools.updatePool(b.name, { members: b.members, description: b.description });
    case "/pools/grant":   return pools.grant(b.name, b.tenant, b.access);
    case "/pools/get":     return { pool: pools.getPool(b.name) };
    case "/pools/list":    return { pools: pools.listPools() };
    case "/pools/mine":    return { pools: pools.poolsForTenant(b.tenant ?? "default") };
    default: return undefined;
  }
}

export async function handleRequest(
  pools: PoolManager,
  tokenStore: TokenStore,
  headers: Headers,
  route: string,
  b: any,
  queueDb?: Database.Database,
  recallTraceDb?: Database.Database,
  metrics?: MetricsRegistry,
  wakeDistiller?: () => void,
): Promise<{ status: number; body: any }> {
  try {
    const principal = tokenStore.authenticate(parseBearer(headers["authorization"]));
    if (route.startsWith("/pools/")) {
      const out = handlePool(pools, principal, route, b);
      if (out === undefined) return { status: 404, body: { error: "unknown route" } };
      return { status: 200, body: out };
    }
    // /metrics is process-global (not addressed by {tenant, pool}) — any
    // authenticated principal may read it (auth already enforced above by
    // tokenStore.authenticate), matching /healthz's "up or not" spirit but
    // requiring a token since these are operational timing numbers, not a
    // public liveness probe. See src/metrics.ts.
    if (route === "/metrics") {
      return { status: 200, body: metrics?.snapshot() ?? { error: "metrics not initialized" } };
    }
    const out = await handleData(pools, principal, headers, route, b, queueDb, recallTraceDb, metrics, wakeDistiller);
    if (out === undefined) return { status: 404, body: { error: "unknown route" } };
    return { status: 200, body: out };
  } catch (e: any) {
    if (e instanceof AuthError) {
      return { status: e.status, body: { error: e.message } };
    }
    if (e instanceof PoolError) {
      const status = e.code === "no_such_pool" ? 404
        : (e.code === "not_a_member" || e.code === "read_only") ? 403
        : 400;
      return { status, body: { error: e.message, code: e.code } };
    }
    if (e instanceof StreamConflictError) {
      return { status: 409, body: { error: e.message, kind: e.kind } };
    }
    if (e instanceof AtomImmutabilityError) {
      return { status: 409, body: { error: e.message } };
    }
    if (e instanceof AtomTypeError) {
      return { status: 400, body: { error: e.message } };
    }
    if (e instanceof RecallTraceError) {
      const status = e.code === "not_found" ? 404 : e.code === "conflict" ? 409 : 400;
      return { status, body: { error: e.message, code: e.code } };
    }
    if (e instanceof TopicNotFoundError) {
      return { status: 404, body: { error: e.message } };
    }
    return { status: 500, body: { error: String(e?.message ?? e) } };
  }
}

/**
 * Standalone entry point (legacy): `node dist/gateway.js` starts the HTTP
 * API + distillation worker only, no MCP endpoint — equivalent to
 * `falda serve --no-mcp`. Delegates to the same buildRuntime() the unified
 * server uses (src/runtime.ts), so there is exactly one runtime bootstrap
 * path regardless of which entry point is invoked. The HTTP listener here
 * is intentionally self-contained (not imported from src/server.ts) to
 * avoid a circular module dependency, since server.ts imports handleRequest
 * from this file.
 *
 * FALDA_TOKENS is the canonical token file for both HTTP and MCP; see
 * src/runtime.ts. Prefer `falda serve` for new deployments — this entry
 * point is kept for backward compatibility with existing deployments that
 * invoke dist/gateway.js directly.
 */
const IS_MAIN = process.argv[1]?.endsWith("gateway.js") || process.argv[1]?.endsWith("gateway.ts");
if (IS_MAIN) {
  (async () => {
  const PORT = Number(process.env.FALDA_PORT ?? 8077);
  const resolvedEnv = resolveWorkerIntervals();
  if (resolvedEnv.usingDeprecatedFallback) {
    console.warn(
      "falda gateway: FALDA_WORKER_INTERVAL_MS is deprecated — set FALDA_DRAIN_INTERVAL_MS " +
      "and FALDA_SWEEP_INTERVAL_MS instead (see src/distill/worker.ts).",
    );
  }

  const runtime = await buildRuntime({ label: "FALDA gateway" });
  const distiller = startDistiller(runtime.queueDb, runtime.pools, runtime.llm, undefined, {
    drainIntervalMs: resolvedEnv.drainIntervalMs,
    sweepIntervalMs: resolvedEnv.sweepIntervalMs,
    recallTraceDb: runtime.recallTraceDb,
    metrics: runtime.metrics,
  });
  runtime.wakeDistiller = () => distiller.wake();

  createServer((req, res) => {
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
  }).listen(PORT, () => console.log(`FALDA gateway listening on :${PORT} (root=${runtime.root})`));
  })().catch((e) => { console.error(e); process.exit(1); });
}
