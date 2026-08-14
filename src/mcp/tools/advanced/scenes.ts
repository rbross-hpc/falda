import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ctxFromExtra, errorResult, poolArg, storeFor, textResult, type ToolDeps } from "../../context.js";

export function registerScenesAdvanced(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "falda_scenes_search",
    {
      description: "Hybrid (dense + lexical) search over T2 scenes (episodes and topics). Returns active scenes matching the query.",
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional(), pool: poolArg },
    },
    async ({ query, limit, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(deps.tokenStore, extra);
        return textResult({ items: await storeFor(deps, ctx, pool, false).searchScenes(query, limit ?? 10) });
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
        const ctx = ctxFromExtra(deps.tokenStore, extra);
        return textResult(storeFor(deps, ctx, pool, false).listScenes(p));
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
        const ctx = ctxFromExtra(deps.tokenStore, extra);
        return textResult(storeFor(deps, ctx, pool, false).getScene(scene_id));
      } catch (e) { return errorResult(e); }
    },
  );
}
