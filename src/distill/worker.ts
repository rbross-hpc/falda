/**
 * Background distillation worker — the canonical owner of the distillation
 * queue's drain loop. Runs inside the unified `falda serve` process
 * (src/server.ts) against the shared runtime (src/runtime.ts), so a job
 * enqueued via MCP's falda_distill or the HTTP /distill route is always
 * processed by the same process that accepted it — no separate "gateway
 * worker" process required.
 *
 * Three responsibilities, on TWO independent timers:
 *   1. Enqueue (sweep): discover every self-store on disk and enqueue it at
 *      PASSIVE priority (coalescing dedups so a tenant with a pending job is
 *      never double-queued). This makes distillation happen automatically
 *      with no external trigger. Runs on sweepIntervalMs — deliberately
 *      slower than the drain, since sweeping is cheap discovery, not work.
 *   2. Drain: claim the next ready job (highest priority first — see
 *      src/distill/queue.ts) and run distillOnce() against its store. Runs
 *      on drainIntervalMs, ONE job per tick — this is the passive-backlog
 *      throughput knob.
 *   3. Wake: an explicit enqueue (falda_distill / POST /distill) calls
 *      handle.wake() instead of waiting for the next drainIntervalMs tick.
 *      wake() drains ALL currently-ready EXPLICIT-priority jobs in a loop
 *      (bounded, re-entrancy-guarded) so a burst of on-demand requests isn't
 *      throttled to one-per-drain-tick the way passive jobs are. Passive
 *      jobs are untouched by wake() — they still only drain on the timed
 *      tick, preserving the sweep/drain cadence as the throttle on
 *      background load.
 *
 * Only 'self' stores are auto-enqueued (pools deferred, §13). A pool store
 * can still be distilled via an explicit /distill or falda_distill call,
 * which the drain loop (or a wake) will pick up regardless of store kind.
 *
 * A fourth responsibility piggybacks the sweep timer rather than running its
 * own: pruning recall_traces.db down to FALDA_RECALL_TRACE_RETENTION_DAYS
 * (default 90, see src/recall/retention.ts) when a recallTraceDb is
 * supplied. Telemetry retention is low-frequency housekeeping, so it rides
 * along with the slow sweep tick rather than the fast drain tick.
 *
 * Env (resolved by callers — src/server.ts, src/gateway.ts — not here;
 * startDistiller() takes already-resolved millisecond values):
 *   FALDA_DRAIN_INTERVAL_MS  Drain cadence (default 60000).
 *   FALDA_SWEEP_INTERVAL_MS  Passive-enqueue + prune cadence (default 300000).
 *   FALDA_WORKER_INTERVAL_MS Deprecated: sets both when the above are unset.
 */
import type { Database as DatabaseType } from "better-sqlite3";
import type { PoolManager } from "../pools.js";
import type { LLMFnWithModel } from "./llm.js";
import { claimNext, completeJob, failJob, enqueue, storeKeyFor, type DistillJob, PRIORITY_EXPLICIT } from "./queue.js";
import { distillOnce } from "./core.js";
import { PROMPT_VERSION } from "./prompts.js";
import { pruneRecallTraces, resolveRetentionDays } from "../recall/retention.js";
import type { MetricsRegistry } from "../metrics.js";

// package.json version, read once at module load — attached to every pass
// this worker runs as distiller_version (falda distill inspect provenance).
import pkg from "../../package.json" with { type: "json" };
const DISTILLER_VERSION = (pkg as { version?: string }).version ?? "unknown";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 300_000;
/** Upper bound on jobs drained by a single wake() call — a burst of explicit
 *  requests should not be able to hog the event loop indefinitely. Passive
 *  jobs are never claimed here (minPriority filters them out), so this only
 *  bounds explicit-priority backlogs, which should be rare and small. */
const MAX_WAKE_DRAIN_PER_CALL = 50;

export interface DistillerHandle {
  stop(): void;
  /** Immediately drain all currently-ready EXPLICIT-priority jobs, without
   *  waiting for the next drainIntervalMs tick. Safe to call redundantly —
   *  concurrent wake() calls collapse into one in-flight drain loop. Never
   *  throws (drain failures are logged, matching the timed drain's
   *  failJob()-based error handling). */
  wake(): void;
}

export interface DistillerOptions {
  recallTraceDb?: DatabaseType;
  recallTraceRetentionDays?: number;
  /** Drain cadence, ms. Falls back to the 4th positional `intervalMs` arg
   *  when omitted (back-compat with the pre-split single-interval API). */
  drainIntervalMs?: number;
  /** Passive-enqueue-sweep + prune cadence, ms. Falls back to the 4th
   *  positional `intervalMs` arg when omitted. */
  sweepIntervalMs?: number;
  /** Shared timing histograms (src/metrics.ts). Omit to disable
   *  instrumentation (e.g. in tests that don't care about timing). */
  metrics?: MetricsRegistry;
}

/**
 * Resolve the two worker cadences from environment variables, honoring
 * FALDA_WORKER_INTERVAL_MS as a deprecated fallback for both when the
 * split-cadence vars are unset. Pure — callers (src/server.ts,
 * src/gateway.ts) are responsible for actually reading process.env and
 * emitting the deprecation warning exactly once per process.
 */
export function resolveWorkerIntervals(env: NodeJS.ProcessEnv = process.env): {
  drainIntervalMs: number;
  sweepIntervalMs: number;
  /** True only when FALDA_WORKER_INTERVAL_MS is set AND is actually being
   *  relied upon (i.e. at least one of the split vars is unset) — this is
   *  exactly the condition callers should warn on, since a deployment that
   *  sets FALDA_WORKER_INTERVAL_MS alongside both split vars isn't relying
   *  on the deprecated fallback for anything. */
  usingDeprecatedFallback: boolean;
} {
  const legacyRaw = env.FALDA_WORKER_INTERVAL_MS;
  const legacy = legacyRaw !== undefined && legacyRaw !== "" ? Number(legacyRaw) : undefined;
  const drainRaw = env.FALDA_DRAIN_INTERVAL_MS;
  const sweepRaw = env.FALDA_SWEEP_INTERVAL_MS;
  const drainSet = drainRaw !== undefined && drainRaw !== "";
  const sweepSet = sweepRaw !== undefined && sweepRaw !== "";
  const drainIntervalMs = drainSet ? Number(drainRaw) : (legacy ?? DEFAULT_INTERVAL_MS);
  const sweepIntervalMs = sweepSet ? Number(sweepRaw) : (legacy ?? DEFAULT_SWEEP_INTERVAL_MS);
  return { drainIntervalMs, sweepIntervalMs, usingDeprecatedFallback: legacy !== undefined && (!drainSet || !sweepSet) };
}

export function startDistiller(
  queueDb: DatabaseType,
  pools: PoolManager,
  llm: LLMFnWithModel,
  intervalMs = DEFAULT_INTERVAL_MS,
  opts: DistillerOptions = {},
): DistillerHandle {
  const drainIntervalMs = opts.drainIntervalMs ?? intervalMs;
  const sweepIntervalMs = opts.sweepIntervalMs ?? intervalMs;
  const retentionDays = opts.recallTraceRetentionDays
    ?? resolveRetentionDays(process.env.FALDA_RECALL_TRACE_RETENTION_DAYS);

  // Run one claimed job to completion: distillOnce + completeJob/failJob,
  // observing pending/service time into the shared histograms. Shared by
  // both the timed drain and the wake-triggered high-priority drain so
  // metrics/error-handling never drift between the two paths.
  const runJob = async (job: DistillJob) => {
    if (opts.metrics) {
      const pendingMs = Date.now() - Date.parse(job.created_at);
      opts.metrics.distill_pending_ms.observe(pendingMs);
    }
    const [tenant, poolName] = job.store_key.split(":", 2);
    const startedAt = Date.now();
    try {
      const store = pools.resolve(tenant, poolName === "self" ? undefined : poolName, true);
      await distillOnce(store, llm, {
        storeKey: job.store_key, verbose: false,
        model: llm.model, promptVersion: PROMPT_VERSION, distillerVersion: DISTILLER_VERSION,
      });
      completeJob(queueDb, job.id);
    } catch (e: any) {
      failJob(queueDb, job.id, String(e?.message ?? e));
    } finally {
      opts.metrics?.distill_service_ms.observe(Date.now() - startedAt);
    }
  };

  // Timed drain: claim and run exactly one ready job per tick, highest
  // priority first. This is the passive-backlog throughput ceiling — a
  // multi-tenant sweep backlog drains at one tenant per drainIntervalMs.
  const drain = async () => {
    const job = claimNext(queueDb);
    if (!job) return;
    await runJob(job);
  };

  // Wake: drain every currently-ready EXPLICIT-priority job immediately,
  // bounded and re-entrancy-guarded so overlapping wake() calls (e.g. two
  // falda_distill calls landing close together) collapse into one loop
  // rather than running concurrently against the same queue.
  let waking = false;
  const drainHighPriority = async () => {
    if (waking) return;
    waking = true;
    try {
      for (let i = 0; i < MAX_WAKE_DRAIN_PER_CALL; i++) {
        const job = claimNext(queueDb, { minPriority: PRIORITY_EXPLICIT });
        if (!job) break;
        await runJob(job);
      }
    } finally {
      waking = false;
    }
  };

  // Enqueue: discover every self-store on disk and enqueue it at passive
  // priority (the default — see src/distill/queue.ts's PRIORITY_PASSIVE).
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

  // Prune recall_traces.db on the sweep interval (best-effort — telemetry
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

  // Enqueue immediately on startup, then on every sweep interval.
  enqueueAll();
  const enqueueTimer = setInterval(enqueueAll, sweepIntervalMs);
  // Drain on every drain interval.
  const drainTimer = setInterval(() => { drain().catch(console.error); }, drainIntervalMs);
  // Prune on every sweep interval.
  const pruneTimer = setInterval(prune, sweepIntervalMs);

  return {
    stop() {
      clearInterval(enqueueTimer);
      clearInterval(drainTimer);
      clearInterval(pruneTimer);
    },
    wake() {
      drainHighPriority().catch((e) => console.error("[falda-worker] wake drain failed:", e));
    },
  };
}
