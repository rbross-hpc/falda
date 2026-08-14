import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ctxFromExtra, errorResult, poolArg, storeFor, textResult, type ToolDeps } from "../../context.js";

export function registerAtomsAdvanced(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "falda_atoms_search",
    {
      description: "Hybrid (dense + lexical) search over distilled atomic memories (T1: facts, preferences, rules, decisions). This is usually the best first place to recall durable project/persona context.",
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional(), pool: poolArg },
    },
    async ({ query, limit, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(deps.tokenStore, extra);
        return textResult({ items: await storeFor(deps, ctx, pool, false).searchAtoms(query, limit ?? 10) });
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
        const ctx = ctxFromExtra(deps.tokenStore, extra);
        return textResult(storeFor(deps, ctx, pool, false).queryAtoms(p));
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
        const ctx = ctxFromExtra(deps.tokenStore, extra);
        return textResult(await storeFor(deps, ctx, pool, true).upsertAtom(atom));
      } catch (e) { return errorResult(e); }
    },
  );
}
