/**
 * FALDA MCP server — remote (Streamable HTTP) MCP transport exposing FALDA's
 * memory API to MCP clients (opencode and others), over a network, for many
 * agents sharing one FALDA deployment.
 *
 * Tool surface (§ simplify-mcp-surface):
 *   Default (FALDA_MCP_TOOLSET unset or "default"): a compact,
 *   intention-level API — falda_recall, falda_remember, falda_forget,
 *   falda_distill, falda_distill_status, falda_whoami, plus
 *   falda_stream_add (machine/harness ingestion — see tools/capture.ts).
 *   Agents ask Falda to recall/remember/forget/distill; they do not choose
 *   which memory tier (T0/T1/T2/T3) to read or write.
 *
 *   Full (FALDA_MCP_TOOLSET=full): default + the tier-specific storage
 *   primitives (stream/atoms/scenes/core search/query/upsert) for
 *   diagnostics, migrations, and advanced workflows. See
 *   tools/advanced/*.ts and registry.ts.
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
 * Atom type enum (§3.1): fact | pattern | preference | constraint | instruction.
 * Out-of-set values are rejected as errors (no coercion).
 *
 * Prefer `falda serve` (src/server.ts) for new deployments — it starts this
 * same MCP endpoint alongside the HTTP API (src/gateway.ts) from one shared
 * runtime (src/runtime.ts), with one canonical token file and one
 * distillation worker for both surfaces. src/mcp.ts's own IS_MAIN entry
 * point (`node dist/mcp.js`) is kept for backward compatibility; it runs
 * MCP only, with no distillation worker of its own (falda_distill still
 * enqueues into the shared queue — nothing will drain it unless a gateway
 * or `falda serve` process elsewhere owns that queue db).
 *
 * Env: see src/runtime.ts for the canonical set (FALDA_ROOT, FALDA_DIM,
 * FALDA_EMBED*, FALDA_TOKENS, FALDA_LLM_*). MCP-specific:
 *   FALDA_MCP_PORT     Port to listen on (default 8079).
 *   FALDA_MCP_TOOLSET  "default" (compact, recommended) or "full"
 *                      (adds tier-specific storage tools). Default: "default".
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type Database from "better-sqlite3";
import type { PoolManager } from "../pools.js";
import { TokenStore, AuthError, parseBearer } from "../mcp_auth.js";
import { toolsFor, resolveToolset, type ToolsetName } from "./registry.js";
import type { ToolDeps } from "./context.js";

export interface McpServerOpts {
  toolset?: ToolsetName;
  /** Recall-trace store (src/recall/). Omit to disable trace capture for
   *  this server instance — falda_recall still works, just untraced. */
  recallTraceDb?: Database.Database;
}

export function makeFaldaMcpServer(
  pools: PoolManager,
  tokenStore: TokenStore,
  queueDb?: Database.Database,
  opts?: McpServerOpts,
): McpServer {
  const server = new McpServer({ name: "falda", version: "0.1.0" });
  const deps: ToolDeps = { pools, tokenStore, queueDb, recallTraceDb: opts?.recallTraceDb };
  const toolset = resolveToolset(opts?.toolset);
  for (const register of toolsFor(toolset)) register(server, deps);
  return server;
}

export async function handleFaldaMcpRequest(
  pools: PoolManager,
  tokenStore: TokenStore,
  req: IncomingMessage,
  res: ServerResponse,
  queueDb?: Database.Database,
  opts?: McpServerOpts,
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
  const server = makeFaldaMcpServer(pools, tokenStore, queueDb, opts);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
