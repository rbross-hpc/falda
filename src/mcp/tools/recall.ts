import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assembleContext, DEFAULT_TIER_BUDGETS } from "../../distill/context.js";
import { storeKeyFor } from "../../distill/queue.js";
import { TokenStore } from "../../mcp_auth.js";
import { buildPolicySnapshot } from "../../recall/policy.js";
import { createRecallTrace } from "../../recall/traces.js";
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
        "tiers for you — you do not need to decide which tier to query. Returns a recall_id that " +
        "identifies this specific retrieval for later usage feedback (reported by the runtime, not " +
        "something you need to act on).",
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
        const checkedPool = TokenStore.requirePool(ctx.principal, pool);
        const store = storeFor(deps, ctx, pool, false);
        const effectiveBudget = budget ?? DEFAULT_BUDGET;
        const assembled = await assembleContext(store, query, effectiveBudget);

        let recall_id: string | undefined;
        if (deps.recallTraceDb) {
          try {
            recall_id = createRecallTrace(deps.recallTraceDb, {
              store_key: storeKeyFor(ctx.tenant, checkedPool),
              tenant: ctx.tenant,
              pool: checkedPool ?? null,
              query,
              requested_budget: effectiveBudget,
              used_budget: assembled.total_chars,
              policy_snapshot: buildPolicySnapshot(store.getRecallWeights(), DEFAULT_TIER_BUDGETS),
              items: assembled.items,
            });
          } catch (e) {
            // Best-effort telemetry: a trace-write failure must never fail
            // the recall itself (§ recall-feedback-loop, "successful recall
            // wins"). recall_id is simply omitted from the response.
            console.error("[falda_recall] trace persistence failed (non-fatal):", e);
          }
        }

        return textResult({
          recall_id,
          context: renderContext(assembled),
          items: assembled.items,
          truncated: assembled.truncated,
        });
      } catch (e) { return errorResult(e); }
    },
  );
}
