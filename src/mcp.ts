/**
 * FALDA MCP server — remote (Streamable HTTP) MCP transport exposing FALDA's
 * recall + write tools to MCP clients (opencode and others), over a network,
 * for many agents sharing one FALDA deployment.
 *
 * Why this exists alongside the JSON gateway (src/gateway.ts):
 *   The gateway trusts a `tenant` field straight from the request body — fine
 *   on a trusted loopback/tailnet (see docs/POOLS.md), but this server is
 *   meant to be reached by many containerized opencode agents over a shared
 *   network, so it authenticates every request.
 *
 * Auth model (see src/mcp_auth.ts for the full rationale):
 *   - `Authorization: Bearer <token>` identifies a PRINCIPAL (e.g. one
 *     container/host), mapped to an explicit `tenants` allow-list (or `["*"]`
 *     for a fully-trusted principal).
 *   - `X-Falda-Tenant: <tenant>` SELECTS which tenant this request addresses.
 *     The token authorizes the selection; it does not by itself fix a single
 *     tenant, so one container/token can drive several projects (each project
 *     = a different tenant) by varying the header per-project in opencode's
 *     `mcp.<name>.headers` config.
 *   - A `pool` tool argument is checked against the principal's `pools`
 *     allow-list (`self` always implicitly allowed).
 *
 * Tools exposed: recall/read across all four tiers, write for T0 Stream and
 * T1 Atoms only. T2 Scenes and T3 Core are intentionally READ-ONLY here —
 * those tiers stay curated by the distiller, not freehand agent edits.
 *
 * Env:
 *   FALDA_MCP_PORT     Port to listen on (default 8079; gateway is 8078/8077)
 *   FALDA_ROOT         Pool root dir (shared with the gateway)
 *   FALDA_MCP_TOKENS   Path to token file (default ./falda_mcp_tokens.json)
 *   FALDA_DIM / FALDA_EMBED*  As in the gateway
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { PoolManager, PoolError } from "./pools.js";
import { selectEmbedder, enforceEmbeddingLock } from "./boot.js";
import { TokenStore, AuthError, parseBearer, type Principal } from "./mcp_auth.js";

interface RequestCtx { tenant: string; principal: Principal; }

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function errorResult(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * Build the FALDA MCP tool set against the given pool manager + token store.
 * Exported (rather than only wired at module scope) so it can be exercised
 * directly in tests without booting the whole process against real env vars.
 */
export function makeFaldaMcpServer(pools: PoolManager, tokenStore: TokenStore): McpServer {
  const server = new McpServer({ name: "falda", version: "0.1.0" });
  const poolArg = z.string().optional().describe("Named shared pool to address instead of the tenant's private store. Must be one this token is authorized for.");

  function ctxFromExtra(extra: { requestInfo?: { headers: Record<string, unknown> } }): RequestCtx {
    const headers = (extra.requestInfo?.headers ?? {}) as Record<string, string | string[] | undefined>;
    const bearer = parseBearer(headers["authorization"]);
    const principal = tokenStore.authenticate(bearer);
    const tenantHeader = headers["x-falda-tenant"];
    const tenant = TokenStore.requireTenant(principal, Array.isArray(tenantHeader) ? tenantHeader[0] : tenantHeader);
    return { tenant, principal };
  }

  function storeFor(ctx: RequestCtx, pool: string | undefined, write: boolean) {
    const checkedPool = TokenStore.requirePool(ctx.principal, pool);
    return pools.resolve(ctx.tenant, checkedPool, write);
  }

  server.registerTool(
    "falda_stream_search",
    {
      description: "Hybrid (dense + lexical) search over the raw conversation/observation stream (T0). Use for recalling specific past turns.",
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional(), pool: poolArg },
    },
    async ({ query, limit, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        const store = storeFor(ctx, pool, false);
        const messages = await store.searchStream(query, limit ?? 10);
        return textResult({ messages });
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    "falda_stream_query",
    {
      description: "List raw stream (T0) turns by session/time window (no search ranking).",
      inputSchema: {
        session_id: z.string().optional(), limit: z.number().int().optional(), offset: z.number().int().optional(),
        time_start: z.string().optional(), time_end: z.string().optional(), pool: poolArg,
      },
    },
    async ({ pool, ...p }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        const store = storeFor(ctx, pool, false);
        return textResult(store.queryStream(p));
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    "falda_stream_add",
    {
      description: "Append raw turns to the conversation stream (T0). Used for capturing conversation history for later distillation into atoms.",
      inputSchema: {
        session_id: z.string(),
        messages: z.array(z.object({ role: z.string(), content: z.string(), id: z.string().optional(), timestamp: z.string().optional() })),
        pool: poolArg,
      },
    },
    async ({ session_id, messages, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        const store = storeFor(ctx, pool, true);
        const accepted_ids = await store.addStream(session_id, messages);
        return textResult({ accepted_ids, total_count: messages.length });
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    "falda_atoms_search",
    {
      description: "Hybrid (dense + lexical) search over distilled atomic memories (T1: facts, preferences, rules, decisions). This is usually the best first place to recall durable project/persona context.",
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional(), pool: poolArg },
    },
    async ({ query, limit, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        const store = storeFor(ctx, pool, false);
        const items = await store.searchAtoms(query, limit ?? 10);
        return textResult({ items });
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    "falda_atoms_query",
    {
      description: "List distilled atoms (T1) by type/time window (no search ranking).",
      inputSchema: {
        type: z.string().optional(), limit: z.number().int().optional(), offset: z.number().int().optional(),
        time_start: z.string().optional(), time_end: z.string().optional(), pool: poolArg,
      },
    },
    async ({ pool, ...p }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        const store = storeFor(ctx, pool, false);
        return textResult(store.queryAtoms(p));
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    "falda_atoms_upsert",
    {
      description: "Create or update a distilled atomic memory (T1): a durable fact, preference, rule, or decision worth remembering long-term. NOTE: the field is `content`, not `text`.",
      inputSchema: {
        id: z.string().optional(),
        type: z.enum(["fact", "preference", "rule", "decision", "episodic", "instruction"]).optional(),
        content: z.string(),
        background: z.string().optional(),
        pool: poolArg,
      },
    },
    async ({ pool, ...atom }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        const store = storeFor(ctx, pool, true);
        return textResult(await store.upsertAtom(atom));
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    "falda_core_read",
    {
      description: "Read the long-lived persona/project core document (T3) — who/what this agent is and the project it serves. Read-only: T3 is maintained by the distillation pipeline.",
      inputSchema: { pool: poolArg },
    },
    async ({ pool }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        const store = storeFor(ctx, pool, false);
        return textResult({ content: store.readCore() });
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    "falda_scenes_ls",
    {
      description: "List synthesized episodic scene summaries (T2) under an optional path prefix. Read-only: T2 is maintained by the distillation pipeline.",
      inputSchema: { prefix: z.string().optional(), pool: poolArg },
    },
    async ({ prefix, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        const store = storeFor(ctx, pool, false);
        return textResult(store.listScenes(prefix ?? ""));
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    "falda_scenes_read",
    {
      description: "Read a synthesized episodic scene summary (T2) by path (see falda_scenes_ls). Read-only.",
      inputSchema: { path: z.string(), pool: poolArg },
    },
    async ({ path, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        const store = storeFor(ctx, pool, false);
        return textResult({ path, content: store.readScene(path) });
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    "falda_whoami",
    {
      description: "Return the FALDA tenant this connection resolves to (from the X-Falda-Tenant header). Use to confirm which tenant your memory reads/writes address — does not disclose the bearer token or its full tenant/pool allow-lists.",
      inputSchema: {},
    },
    async (_args, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        return textResult({ tenant: ctx.tenant });
      } catch (e) { return errorResult(e); }
    },
  );

  return server;
}

/**
 * Handle one HTTP request end-to-end: reject unauthenticated requests before
 * any MCP handshake, otherwise spin up a fresh (stateless) server+transport
 * pair for this request.
 */
export async function handleFaldaMcpRequest(
  pools: PoolManager,
  tokenStore: TokenStore,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const bearer = parseBearer(req.headers["authorization"]);
    tokenStore.authenticate(bearer);
  } catch (e) {
    if (e instanceof AuthError) {
      res.writeHead(e.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
    throw e;
  }
  const server = makeFaldaMcpServer(pools, tokenStore);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

const IS_MAIN = process.argv[1]?.endsWith("mcp.js") || process.argv[1]?.endsWith("mcp.ts");
if (IS_MAIN) {
  const PORT = Number(process.env.FALDA_MCP_PORT ?? 8079);
  const DIM = Number(process.env.FALDA_DIM ?? 768);
  const ROOT = process.env.FALDA_ROOT ?? "./falda-data";
  const TOKENS_PATH = process.env.FALDA_MCP_TOKENS ?? "./falda_mcp_tokens.json";

  enforceEmbeddingLock(ROOT, DIM, "FALDA MCP");
  const pools = new PoolManager({ root: ROOT, embed: selectEmbedder(DIM, "FALDA MCP"), dim: DIM });
  const tokenStore = new TokenStore(TOKENS_PATH);

  createServer((req, res) => {
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
    handleFaldaMcpRequest(pools, tokenStore, req, res).catch((e) => {
      console.error("[falda-mcp] fatal:", e);
      if (!res.headersSent) {
        res.writeHead(e instanceof PoolError ? 400 : 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      }
    });
  }).listen(PORT, () => console.log(`FALDA MCP server listening on :${PORT} (root=${ROOT}, tokens=${TOKENS_PATH})`));
}
