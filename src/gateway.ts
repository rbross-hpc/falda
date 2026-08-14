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
 *   /distill         (reserved for Branch B)
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
 *   /healthz         (GET, unauthenticated)                        -> {ok, tiers}
 *
 * Env:
 *   FALDA_PORT         Port to listen on (default 8077).
 *   FALDA_TOKENS       Path to token file (default ./falda_gateway_tokens.json).
 *   FALDA_ROOT         Pool root dir (default ./falda-data).
 *   FALDA_DIM          Embedding dimensionality (default 768).
 */
import { createServer } from "node:http";
import { join as pathJoin } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { PoolManager, PoolError } from "./pools.js";
import { selectEmbedder, enforceEmbeddingLock } from "./boot.js";
import { TokenStore, AuthError, parseBearer, requireTokenFile, type Principal } from "./mcp_auth.js";
import { StreamConflictError, AtomImmutabilityError, AtomTypeError } from "./falda.js";
import { initQueueSchema, enqueue, claimNext, completeJob, failJob, storeKeyFor, getJobAuthorized } from "./distill/queue.js";
import { distillOnce } from "./distill/core.js";

/** Module-level gateway queue database (set when IS_MAIN). */
let gatewayQueueDb: Database.Database | null = null;

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

async function handleData(pools: PoolManager, principal: Principal, headers: Headers, route: string, b: any) {
  const tenant = TokenStore.requireTenant(principal, headerValue(headers, "x-falda-tenant"));
  const pool = TokenStore.requirePool(principal, b.pool);
  const store = pools.resolve(tenant, pool, WRITE_ROUTES.has(route));
  switch (route) {
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
    case "/atoms/delete":    return { deleted_count: store.deleteAtoms(b.ids ?? []) };
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
      if (!gatewayQueueDb) return { error: "distillation queue not initialized" };
      const jobId = enqueue(gatewayQueueDb, storeKey);
      return { job_id: jobId, store_key: storeKey };
    }
    case "/distill/status": {
      if (!gatewayQueueDb) return { error: "distillation queue not initialized" };
      const callerKey = storeKeyFor(tenant, pool ?? undefined);
      // getJobAuthorized returns null for both missing and unauthorized jobs
      // so the caller cannot distinguish the two (no existence oracle).
      const job = getJobAuthorized(gatewayQueueDb, b.job_id, callerKey);
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
): Promise<{ status: number; body: any }> {
  try {
    const principal = tokenStore.authenticate(parseBearer(headers["authorization"]));
    if (route.startsWith("/pools/")) {
      const out = handlePool(pools, principal, route, b);
      if (out === undefined) return { status: 404, body: { error: "unknown route" } };
      return { status: 200, body: out };
    }
    const out = await handleData(pools, principal, headers, route, b);
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
    return { status: 500, body: { error: String(e?.message ?? e) } };
  }
}

/** Start the in-process background distillation worker. Drains the queue
 *  by calling distillOnce() directly against the store via PoolManager.
 *  Only distills 'self' stores in this initial implementation (§2, §13). */
function startWorker(
  queueDb: Database.Database,
  pools: PoolManager,
  llm: (prompt: string) => Promise<string>,
  intervalMs = 60_000,
) {
  const tick = async () => {
    const job = claimNext(queueDb);
    if (!job) return;
    const [tenant, poolName] = job.store_key.split(":", 2);
    try {
      const store = pools.resolve(tenant, poolName === "self" ? undefined : poolName, true);
      await distillOnce(store, llm, { storeKey: job.store_key, verbose: false });
      completeJob(queueDb, job.id);
    } catch (e: any) {
      failJob(queueDb, job.id, String(e?.message ?? e));
    }
  };
  setInterval(() => { tick().catch(console.error); }, intervalMs);
  // Also self-enqueue an interval trigger for self stores (operator enqueues, or timer fires).
  setInterval(() => {
    // Placeholder: actual tenant enumeration comes when pool distillation lands (§13).
  }, intervalMs * 5);
}

const IS_MAIN = process.argv[1]?.endsWith("gateway.js") || process.argv[1]?.endsWith("gateway.ts");
if (IS_MAIN) {
  const PORT = Number(process.env.FALDA_PORT ?? 8077);
  const DIM = Number(process.env.FALDA_DIM ?? 768);
  const ROOT = process.env.FALDA_ROOT ?? "./falda-data";
  const TOKENS_PATH = process.env.FALDA_TOKENS ?? "./falda_gateway_tokens.json";
  const WORKER_INTERVAL_MS = Number(process.env.FALDA_WORKER_INTERVAL_MS ?? 60_000);
  const LLM_BASE = process.env.FALDA_LLM_BASE_URL ?? "http://localhost:11434/v1";
  const LLM_KEY = process.env.FALDA_LLM_API_KEY ?? "x";
  const LLM_MODEL = process.env.FALDA_LLM_MODEL ?? "gpt-4o-mini";

  enforceEmbeddingLock(ROOT, DIM, "FALDA gateway");
  requireTokenFile(TOKENS_PATH, "FALDA gateway");

  const pools = new PoolManager({ root: ROOT, embed: selectEmbedder(DIM, "FALDA gateway"), dim: DIM });
  const tokenStore = new TokenStore(TOKENS_PATH);

  // Gateway-level queue db (separate from per-store dbs).
  const queueDbPath = pathJoin(ROOT, "distill_queue.db");
  mkdirSync(ROOT, { recursive: true });
  gatewayQueueDb = new Database(queueDbPath);
  initQueueSchema(gatewayQueueDb);

  const llm = async (prompt: string): Promise<string> => {
    const resp = await fetch(`${LLM_BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify({ model: LLM_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0 }),
    });
    if (!resp.ok) throw new Error(`LLM ${resp.status}: ${await resp.text()}`);
    const j = (await resp.json()) as any;
    return j.choices[0].message.content as string;
  };

  startWorker(gatewayQueueDb, pools, llm, WORKER_INTERVAL_MS);

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
        const { status, body: out } = await handleRequest(pools, tokenStore, req.headers, req.url ?? "", parsed);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e: any) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      }
    });
  }).listen(PORT, () => console.log(`FALDA gateway listening on :${PORT} (root=${ROOT}, tokens=${TOKENS_PATH})`));
}
