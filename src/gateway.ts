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
 *   /stream/add      {session_id, messages[]}            -> {accepted_ids, total_count}
 *   /stream/query    {session_id?, limit?, ...}          -> {messages, total}
 *   /stream/search   {query, limit?}                     -> {messages: hits}
 *   /stream/delete   {ids?|session_id}                   -> {deleted_count}
 *   /atoms/upsert    {id?, type?, content, background?}  -> Atom
 *   /atoms/query     {type?, limit?, ...}                -> {items, total}
 *   /atoms/search    {query, limit?}                     -> {items: hits}
 *   /atoms/delete    {ids[]}                             -> {deleted_count}
 *   /scenes/ls       {prefix?}                           -> {entries, total}
 *   /scenes/read     {path}                              -> {path, content}
 *   /scenes/write    {path, content}                     -> {path}
 *   /scenes/rm       {path}                              -> {path}
 *   /core/read       {}                                  -> {content}
 *   /core/write      {content}                           -> {ok}
 *
 * Pool admin routes (POST) — cross-tenant management, restricted to
 * fully-trusted (`tenants: ["*"]`) principals regardless of X-Falda-Tenant:
 *   /pools/declare   {name, members:{tenant:access}, description?}  -> PoolDecl
 *   /pools/update    {name, members?, description?}                 -> PoolDecl
 *   /pools/grant     {name, tenant, access}                        -> PoolDecl
 *   /pools/get       {name}                                        -> {pool}
 *   /pools/list      {}                                            -> {pools}
 *   /pools/mine      {tenant}                                      -> {pools}  (reachable by tenant)
 *
 *   /healthz         (GET, unauthenticated)                        -> {ok, tiers}
 *
 * Env:
 *   FALDA_TOKENS       Path to token file, same shape as the MCP server's
 *                      FALDA_MCP_TOKENS (default ./falda_gateway_tokens.json).
 *                      Required — the gateway refuses to boot without a valid,
 *                      non-empty token file (see mcp_auth.ts requireTokenFile).
 */
import { createServer } from "node:http";
import { PoolManager, PoolError } from "./pools.js";
import { selectEmbedder, enforceEmbeddingLock } from "./boot.js";
import { TokenStore, AuthError, parseBearer, requireTokenFile, type Principal } from "./mcp_auth.js";

/** Routes that mutate the addressed store (need readwrite on a shared pool). */
const WRITE_ROUTES = new Set([
  "/stream/add", "/stream/delete", "/atoms/upsert", "/atoms/delete",
  "/scenes/write", "/scenes/rm", "/core/write",
]);

type Headers = Record<string, string | string[] | undefined>;

function headerValue(headers: Headers, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

async function handleData(pools: PoolManager, principal: Principal, headers: Headers, route: string, b: any) {
  const tenant = TokenStore.requireTenant(principal, headerValue(headers, "x-falda-tenant"));
  const pool = TokenStore.requirePool(principal, b.pool); // undefined => "self"
  const store = pools.resolve(tenant, pool, WRITE_ROUTES.has(route));
  switch (route) {
    case "/stream/add":    return { accepted_ids: await store.addStream(b.session_id, b.messages ?? []), total_count: (b.messages ?? []).length };
    case "/stream/query":  return store.queryStream(b);
    case "/stream/search": return { messages: await store.searchStream(b.query, b.limit) };
    case "/stream/delete": return { deleted_count: store.deleteStream(b) };
    case "/atoms/upsert":
      if (Array.isArray(b.atoms)) {
        const items = [];
        for (const atom of b.atoms) items.push(await store.upsertAtom(atom));
        return { items, total_count: items.length };
      }
      return await store.upsertAtom(b);
    case "/atoms/query":   return store.queryAtoms(b);
    case "/atoms/search":  return { items: await store.searchAtoms(b.query, b.limit) };
    case "/atoms/delete":  return { deleted_count: store.deleteAtoms(b.ids ?? []) };
    case "/scenes/ls":     return store.listScenes(b.prefix ?? "");
    case "/scenes/read":   return { path: b.path, content: store.readScene(b.path) };
    case "/scenes/write":  return (store.writeScene(b.path, b.content ?? ""), { path: b.path });
    case "/scenes/rm":     return (store.removeScene(b.path), { path: b.path });
    case "/core/read":     return { content: store.readCore() };
    case "/core/write":    return (store.writeCore(b.content ?? ""), { ok: true });
    default: return undefined;
  }
}

/** Pool admin routes are cross-tenant management, restricted to fully-trusted principals. */
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

/**
 * Handle one gateway request end-to-end: authenticate, then dispatch.
 * Exported (rather than only wired at module scope) so it can be exercised
 * directly in tests without booting a real HTTP server/socket.
 */
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
      // 404 for missing pool, 403 for access denial, 400 for malformed input.
      const status = e.code === "no_such_pool" ? 404
        : (e.code === "not_a_member" || e.code === "read_only") ? 403
        : 400;
      return { status, body: { error: e.message, code: e.code } };
    }
    return { status: 500, body: { error: String(e?.message ?? e) } };
  }
}

const IS_MAIN = process.argv[1]?.endsWith("gateway.js") || process.argv[1]?.endsWith("gateway.ts");
if (IS_MAIN) {
  const PORT = Number(process.env.FALDA_PORT ?? 8077);
  const DIM = Number(process.env.FALDA_DIM ?? 768);
  const ROOT = process.env.FALDA_ROOT ?? "./falda-data";
  const TOKENS_PATH = process.env.FALDA_TOKENS ?? "./falda_gateway_tokens.json";

  enforceEmbeddingLock(ROOT, DIM, "FALDA gateway");
  requireTokenFile(TOKENS_PATH, "FALDA gateway");

  const pools = new PoolManager({ root: ROOT, embed: selectEmbedder(DIM, "FALDA gateway"), dim: DIM });
  const tokenStore = new TokenStore(TOKENS_PATH);

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
