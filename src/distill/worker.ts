/**
 * Background distillation worker — the canonical owner of the distillation
 * queue's drain loop. Runs inside the unified `falda serve` process
 * (src/server.ts) against the shared runtime (src/runtime.ts), so a job
 * enqueued via MCP's falda_distill or the HTTP /distill route is always
 * processed by the same process that accepted it — no separate "gateway
 * worker" process required.
 *
 * Two responsibilities, both driven by one interval timer:
 *   1. Enqueue: discover every self-store on disk and enqueue it (coalescing
 *      dedups so a tenant with a pending job is never double-queued). This
 *      makes distillation happen automatically with no external trigger.
 *   2. Drain: claim the next ready job and run distillOnce() against its
 *      store.
 *
 * Only 'self' stores are auto-enqueued (pools deferred, §13). A pool store
 * can still be distilled via an explicit /distill or falda_distill call,
 * which the drain loop will pick up regardless of store kind.
 *
 * A third responsibility piggybacks the same interval timer rather than
 * running its own: pruning recall_traces.db down to
 * FALDA_RECALL_TRACE_RETENTION_DAYS (default 90, see src/recall/retention.ts)
 * when a recallTraceDb is supplied. Telemetry retention intentionally rides
 * along with the existing worker tick instead of adding a second timer.
 */
import type { Database as DatabaseType } from "better-sqlite3";
import type { PoolManager } from "../pools.js";
import type { LLMFn } from "./llm.js";
import { claimNext, completeJob, failJob, enqueue, storeKeyFor } from "./queue.js";
import { distillOnce } from "./core.js";
import { pruneRecallTraces, resolveRetentionDays } from "../recall/retention.js";

export interface DistillerHandle {
  stop(): void;
}

export interface DistillerOptions {
  recallTraceDb?: DatabaseType;
  recallTraceRetentionDays?: number;
}

export function startDistiller(
  queueDb: DatabaseType,
  pools: PoolManager,
  llm: LLMFn,
  intervalMs = 60_000,
  opts: DistillerOptions = {},
): DistillerHandle {
  const retentionDays = opts.recallTraceRetentionDays
    ?? resolveRetentionDays(process.env.FALDA_RECALL_TRACE_RETENTION_DAYS);
  // Drain: claim the next ready job and run distillOnce against its store.
  const drain = async () => {
    const job = claimNext(queueDb);
    if (!job) return;
    const [tenant, poolName] = job.store_key.split(":", 2);
    try {
      const store = pools.resolve(tenant, poolName === "self" ? undefined : poolName, true);
      await distillOnce(store, llm, { storeKey: job.store_key, verbose: false });
      completeJob(queueDb, job.id);
    } catch (e: any) {
      failJob(queueDb, job.id, String(e?.message ?? e));
    }
  };

  // Enqueue: discover every self-store on disk and enqueue it.
  const enqueueAll = () => {
    const tenants = pools.listSelfTenants();
    for (const tenant of tenants) {
      try {
        enqueue(queueDb, storeKeyFor(tenant, undefined));
      } catch (e) {
        console.error(`[falda-worker] enqueue failed for tenant ${tenant}:`, e);
      }
    }
    if (tenants.length > 0) {
      console.log(`[falda-worker] enqueued ${tenants.length} self-store(s): ${tenants.join(", ")}`);
    }
  };

  // Prune recall_traces.db on the same interval (best-effort — telemetry
  // pruning must never take the worker down).
  const prune = () => {
    if (!opts.recallTraceDb) return;
    try {
      const n = pruneRecallTraces(opts.recallTraceDb, retentionDays);
      if (n > 0) console.log(`[falda-worker] pruned ${n} recall trace(s) older than ${retentionDays}d`);
    } catch (e) {
      console.error("[falda-worker] recall trace pruning failed:", e);
    }
  };

  // Enqueue immediately on startup, then on every interval.
  enqueueAll();
  const enqueueTimer = setInterval(enqueueAll, intervalMs);
  // Drain on every interval.
  const drainTimer = setInterval(() => { drain().catch(console.error); }, intervalMs);
  // Prune on every interval.
  const pruneTimer = setInterval(prune, intervalMs);

  return {
    stop() {
      clearInterval(enqueueTimer);
      clearInterval(drainTimer);
      clearInterval(pruneTimer);
    },
  };
}
