import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assembleContext, DEFAULT_TIER_BUDGETS } from "../../distill/context.js";
import { storeKeyFor } from "../../distill/queue.js";
import { TokenStore } from "../../mcp_auth.js";
import { buildPolicySnapshot } from "../../recall/policy.js";
import { createRecallTrace } from "../../recall/traces.js";
import { renderContext } from "../../recall/render.js";
import {
  MIN_RECALL_BUDGET,
  resolveAutoRecallBudget,
  resolveMaxRecallBudget,
  resolveRecallBudget,
} from "../../recall/budgets.js";
import { ctxFromExtra, errorResult, poolArg, storeFor, textResult, type ToolDeps } from "../context.js";

const MIN_BUDGET = MIN_RECALL_BUDGET;

export function registerRecall(server: McpServer, deps: ToolDeps): void {
  const defaultBudget = resolveRecallBudget();
  const autoDefaultBudget = resolveAutoRecallBudget();
  const maxBudget = resolveMaxRecallBudget();

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
        budget: z.number().int().min(MIN_BUDGET).max(maxBudget).optional()
          .describe(`Approximate character budget for the assembled context (default ${defaultBudget}).`),
        mode: z.enum(["explicit", "auto"]).optional()
          .describe(
            "\"explicit\" (default) for a deliberate call; \"auto\" for an unattended per-task " +
            `recall fired by a harness integration — uses a smaller default budget (${autoDefaultBudget}) ` +
            "when budget is omitted.",
          ),
        pool: poolArg,
      },
    },
    async ({ query, budget, mode, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(deps.tokenStore, extra);
        const checkedPool = TokenStore.requirePool(ctx.principal, pool);
        const store = storeFor(deps, ctx, pool, false);
        const effectiveBudget = budget ?? (mode === "auto" ? autoDefaultBudget : defaultBudget);
        const recallStartedAt = Date.now();
        const assembled = await assembleContext(store, query, effectiveBudget);
        deps.metrics?.recall_ms.observe(Date.now() - recallStartedAt);

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
              mode: mode ?? "explicit",
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
