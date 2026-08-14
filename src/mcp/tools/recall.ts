import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assembleContext } from "../../distill/context.js";
import { ctxFromExtra, errorResult, poolArg, storeFor, textResult, type ToolDeps } from "../context.js";

const DEFAULT_BUDGET = 6000;
const MIN_BUDGET = 500;
const MAX_BUDGET = 20000;

function renderContext(ctx: Awaited<ReturnType<typeof assembleContext>>): string {
  const sections: string[] = [];
  if (ctx.pinned_atoms.length) sections.push(["## Pinned", ...ctx.pinned_atoms].join("\n"));
  if (ctx.ranked_atoms.length) sections.push(["## Relevant facts/preferences/rules", ...ctx.ranked_atoms].join("\n"));
  if (ctx.scenes.length) sections.push(["## Related episodes/topics", ...ctx.scenes].join("\n"));
  if (ctx.core) sections.push(["## Project/persona core", ctx.core].join("\n"));
  return sections.join("\n\n");
}

export function registerRecall(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "falda_recall",
    {
      description:
        "Search your long-term Falda memory for information relevant to the current task. " +
        "Use this when prior conversations, project facts, preferences, constraints, instructions, " +
        "or related episodes may help. This assembles the best available context across all memory " +
        "tiers for you — you do not need to decide which tier to query.",
      inputSchema: {
        query: z.string(),
        budget: z.number().int().min(MIN_BUDGET).max(MAX_BUDGET).optional()
          .describe(`Approximate character budget for the assembled context (default ${DEFAULT_BUDGET}).`),
        pool: poolArg,
      },
    },
    async ({ query, budget, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(deps.tokenStore, extra);
        const store = storeFor(deps, ctx, pool, false);
        const assembled = await assembleContext(store, query, budget ?? DEFAULT_BUDGET);
        return textResult({
          context: renderContext(assembled),
          hits: assembled.hits,
          truncated: assembled.truncated,
        });
      } catch (e) { return errorResult(e); }
    },
  );
}
