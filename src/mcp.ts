/**
 * FALDA MCP server — remote (Streamable HTTP) MCP transport exposing FALDA's
 * recall + write tools to MCP clients (opencode and others), over a network,
 * for many agents sharing one FALDA deployment.
 *
 * Why this exists alongside the JSON gateway (src/gateway.ts):
 *   Both servers share the same TokenStore/Principal auth model
 *   (src/mcp_auth.ts) and authenticate every request. This server speaks the
 *   MCP protocol for MCP clients (opencode and others); the gateway is a
 *   small JSON/HTTP surface for direct programmatic callers and also exposes
 *   pool-admin routes this server intentionally omits.
 *
 * Auth model (see src/mcp_auth.ts for the full rationale):
 *   - `Authorization: Bearer <token>` identifies a PRINCIPAL.
 *   - `X-Falda-Tenant: <tenant>` SELECTS which tenant this request addresses.
 *   - A `pool` tool argument is checked against the principal's `pools`
 *     allow-list (`self` always implicitly allowed).
 *
 * Tools exposed:
 *   - T0 stream: search, query, add (write)
 *   - T1 atoms: search, query, upsert (write)
 *   - T2 scenes: search, query/list, get — READ-ONLY for agents; distillation
 *     pipeline writes scenes via the internal distillOnce() path in Branch B.
 *   - T3 core: read — READ-ONLY for agents.
 *   - falda_whoami: echo resolved tenant.
 *
 * Atom type enum (§3.1): fact | pattern | preference | constraint | instruction.
 * Out-of-set values are rejected as errors (no coercion).
 *
 * Env:
 *   FALDA_MCP_PORT     Port to listen on (default 8079)
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
import { TokenStore, AuthError, parseBearer, requireTokenFile, type Principal } from "./mcp_auth.js";

interface RequestCtx { tenant: string; principal: Principal; }

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function errorResult(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function makeFaldaMcpServer(pools: PoolManager, tokenStore: TokenStore): McpServer {
  const server = new McpServer({ name: "falda", version: "0.1.0" });
  const poolArg = z.string().optional().describe(
    "Named shared pool to address instead of the tenant's private store. Must be one this token is authorized for."
  );

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

  // ── T0 Stream ────────────────────────────────────────────────────────────────

  server.registerTool(
    "falda_stream_search",
    {
      description: "Hybrid (dense + lexical) search over the raw conversation/observation stream (T0). Use for recalling specific past turns.",
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional(), pool: poolArg },
    },
    async ({ query, limit, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        return textResult({ messages: await storeFor(ctx, pool, false).searchStream(query, limit ?? 10) });
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    "falda_stream_query",
    {
      description: "List raw stream (T0) turns by session/time window (no search ranking).",
      inputSchema: {
        session_id: z.string().optional(), limit: z.number().int().optional(),
        offset: z.number().int().optional(),
        time_start: z.string().optional(), time_end: z.string().optional(), pool: poolArg,
      },
    },
    async ({ pool, ...p }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        return textResult(storeFor(ctx, pool, false).queryStream(p));
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    "falda_stream_add",
    {
      description: "Append raw turns to the conversation stream (T0). Used for capturing conversation history for later distillation into atoms.",
      inputSchema: {
        session_id: z.string(),
        messages: z.array(z.object({
          role: z.string(), content: z.string(),
          id: z.string().optional(), timestamp: z.string().optional(),
          turn_index: z.number().int().optional(), turn_id: z.string().optional(),
        })),
        pool: poolArg,
      },
    },
    async ({ session_id, messages, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        const accepted_ids = await storeFor(ctx, pool, true).addStream(session_id, messages);
        return textResult({ accepted_ids, total_count: messages.length });
      } catch (e) { return errorResult(e); }
    },
  );

  // ── T1 Atoms ─────────────────────────────────────────────────────────────────

  server.registerTool(
    "falda_atoms_search",
    {
      description: "Hybrid (dense + lexical) search over distilled atomic memories (T1: facts, preferences, rules, decisions). This is usually the best first place to recall durable project/persona context.",
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional(), pool: poolArg },
    },
    async ({ query, limit, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        return textResult({ items: await storeFor(ctx, pool, false).searchAtoms(query, limit ?? 10) });
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    "falda_atoms_query",
    {
      description: "List distilled atoms (T1) by type/time window (no search ranking).",
      inputSchema: {
        type: z.string().optional(), limit: z.number().int().optional(),
        offset: z.number().int().optional(),
        time_start: z.string().optional(), time_end: z.string().optional(), pool: poolArg,
      },
    },
    async ({ pool, ...p }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        return textResult(storeFor(ctx, pool, false).queryAtoms(p));
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    "falda_atoms_upsert",
    {
      description: "Create or update a distilled atomic memory (T1). Content and type are immutable once written — to change a proposition, record a new atom and set supersedes. NOTE: the field is `content`, not `text`.",
      inputSchema: {
        id: z.string().optional(),
        type: z.enum(["fact", "pattern", "preference", "constraint", "instruction"]).optional(),
        content: z.string(),
        background: z.string().optional(),
        priority: z.number().int().min(0).max(100).optional(),
        confidence: z.enum(["high", "medium", "low"]).optional(),
        pinned: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
        pool: poolArg,
      },
    },
    async ({ pool, ...atom }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        return textResult(await storeFor(ctx, pool, true).upsertAtom(atom));
      } catch (e) { return errorResult(e); }
    },
  );

  // ── T2 Scenes (read-only for agents; distillation pipeline writes) ────────────

  server.registerTool(
    "falda_scenes_search",
    {
      description: "Hybrid (dense + lexical) search over T2 scenes (episodes and topics). Returns active scenes matching the query.",
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional(), pool: poolArg },
    },
    async ({ query, limit, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        return textResult({ items: await storeFor(ctx, pool, false).searchScenes(query, limit ?? 10) });
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    "falda_scenes_query",
    {
      description: "List synthesized T2 scenes (episodes, topics) by kind and status. Read-only: T2 is maintained by the distillation pipeline.",
      inputSchema: {
        scene_kind: z.enum(["episode", "topic"]).optional(),
        status: z.enum(["active", "retired"]).optional(),
        limit: z.number().int().optional(), offset: z.number().int().optional(),
        pool: poolArg,
      },
    },
    async ({ pool, ...p }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        return textResult(storeFor(ctx, pool, false).listScenes(p));
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    "falda_scenes_get",
    {
      description: "Get a single T2 scene by id. Read-only.",
      inputSchema: { scene_id: z.string(), pool: poolArg },
    },
    async ({ scene_id, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        return textResult(storeFor(ctx, pool, false).getScene(scene_id));
      } catch (e) { return errorResult(e); }
    },
  );

  // ── T3 Core ──────────────────────────────────────────────────────────────────

  server.registerTool(
    "falda_core_read",
    {
      description: "Read the long-lived persona/project core document (T3) — who/what this agent is and the project it serves. Read-only: T3 is maintained by the distillation pipeline.",
      inputSchema: { pool: poolArg },
    },
    async ({ pool }, extra) => {
      try {
        const ctx = ctxFromExtra(extra);
        return textResult({ content: storeFor(ctx, pool, false).readCore() });
      } catch (e) { return errorResult(e); }
    },
  );

  // ── Meta ──────────────────────────────────────────────────────────────────────

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
  requireTokenFile(TOKENS_PATH, "FALDA MCP");
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
