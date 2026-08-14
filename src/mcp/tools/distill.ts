import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TokenStore } from "../../mcp_auth.js";
import { enqueue, storeKeyFor, getJobAuthorized } from "../../distill/queue.js";
import { ctxFromExtra, errorResult, poolArg, textResult, type ToolDeps } from "../context.js";

export function registerDistill(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "falda_distill",
    {
      description:
        "Enqueue a distillation job for the addressed store — turns raw conversation (T0) into durable " +
        "memories (T1 atoms, T2 scenes, T3 core). Returns a job_id for status polling. Asynchronous — " +
        "does not wait for distillation to complete. Usually not needed: a background worker already " +
        "distills stores periodically; call this to request an out-of-cycle run.",
      inputSchema: { pool: poolArg },
    },
    async ({ pool }, extra) => {
      try {
        const ctx = ctxFromExtra(deps.tokenStore, extra);
        const checkedPool = TokenStore.requirePool(ctx.principal, pool);
        const callerKey = storeKeyFor(ctx.tenant, checkedPool ?? undefined);
        if (!deps.queueDb) return errorResult(new Error("distillation queue not available on this server"));
        const jobId = enqueue(deps.queueDb, callerKey);
        return textResult({ job_id: jobId, store_key: callerKey });
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    "falda_distill_status",
    {
      description: "Poll the status of a distillation job by job_id (returned by falda_distill). " +
        "Returns pending, running, done, or failed/dead.",
      inputSchema: { job_id: z.string(), pool: poolArg },
    },
    async ({ job_id, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(deps.tokenStore, extra);
        const checkedPool = TokenStore.requirePool(ctx.principal, pool);
        const callerKey = storeKeyFor(ctx.tenant, checkedPool ?? undefined);
        if (!deps.queueDb) return errorResult(new Error("distillation queue not available on this server"));
        // getJobAuthorized returns null for both missing and unauthorized jobs —
        // the caller cannot distinguish the two (no existence oracle).
        const job = getJobAuthorized(deps.queueDb, job_id, callerKey);
        if (!job) return errorResult(new Error("job not found"));
        return textResult(job);
      } catch (e) { return errorResult(e); }
    },
  );
}
