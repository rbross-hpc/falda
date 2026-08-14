import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ctxFromExtra, errorResult, poolArg, storeFor, textResult, type ToolDeps } from "../../context.js";

export function registerStreamAdvanced(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "falda_stream_search",
    {
      description: "Hybrid (dense + lexical) search over the raw conversation/observation stream (T0). Use for recalling specific past turns.",
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional(), pool: poolArg },
    },
    async ({ query, limit, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(deps.tokenStore, extra);
        return textResult({ messages: await storeFor(deps, ctx, pool, false).searchStream(query, limit ?? 10) });
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
        const ctx = ctxFromExtra(deps.tokenStore, extra);
        return textResult(storeFor(deps, ctx, pool, false).queryStream(p));
      } catch (e) { return errorResult(e); }
    },
  );
}
