/**
 * Background distillation worker — the canonical owner of the distillation
 * queue's drain loop. Runs inside the unified `falda serve` process
 * (src/server.ts) against the shared runtime (src/runtime.ts), so a job
 * enqueued via MCP's falda_distill or the HTTP /distill route is always
 * processed by the same process that accepted it — no separate "gateway
 * worker" process required.
 *
 * Three responsibilities, on TWO independent timers:
 *   1. Enqueue (sweep): discover every self-store on disk and enqueue, at
 *      PASSIVE priority, only those with an undistilled turn — i.e.
 *      streamHeadSeq() > the store's distillation watermark (never-
 *      distilled stores have no watermark row, treated as 0, so a store
 *      with any turns at all enqueues once; a backlogged store whose
 *      watermark trails its head stays enqueued across sweeps until it
 *      catches up). A store with nothing new since its last pass is
 *      skipped entirely — no queue row, no wasted drain tick (coalescing
 *      also dedups, so a tenant with a pending job is never double-queued).
 *      This makes distillation happen automatically with no external
 *      trigger, without enqueuing idle stores. Runs on sweepIntervalMs —
 *      deliberately slower than the drain, since sweeping is cheap
 *      discovery, not work.
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
 *   startDistiller() takes already-resolved millisecond values):
 *   FALDA_DRAIN_INTERVAL_MS  Drain cadence (default 60000).
 *   FALDA_SWEEP_INTERVAL_MS  Passive-enqueue + prune cadence (default 300000).
 *   FALDA_WORKER_INTERVAL_MS Deprecated: sets both when the above are unset.
 *   FALDA_DISTILL_LEASE_MS   Claim lease duration (default 600000 / 10min) —
 *                            how long a claimed job may run before a crashed
 *                            worker's claim is considered abandoned and the
 *                            job becomes reclaimable (src/distill/queue.ts's
 *                            claimNext/recoverStaleJobs). See
 *                            docs/future/reliability-hardening.md finding 3.
 *
 * Crash recovery: on startup, before the first sweep/drain tick, this module
 * resets any 'running' job whose lease has already expired back to
 * 'pending' (recoverStaleJobs) — a job orphaned by a previous process crash
 * or kill -9 is picked up again instead of remaining stuck forever. Every
 * claim (drain and wake alike) stamps a fresh lease_until and this process's
 * worker_id; a job outliving its lease without completeJob()/failJob() is
 * itself reclaimable by the next claimNext() call, so recovery does not
 * strictly require the startup pass to run — it just avoids waiting out a
 * long-idle sweep interval before an orphaned job becomes visible again.
 */
import type { Database as DatabaseType } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { PoolManager } from "../pools.js";
import type { LLMFnWithModel } from "./llm.js";
import {
  claimNext, completeJob, failJob, enqueue, storeKeyFor, recoverStaleJobs,
  type DistillJob, PRIORITY_EXPLICIT, DEFAULT_LEASE_MS,
} from "./queue.js";
import { distillOnce } from "./core.js";
import { PROMPT_VERSION } from "./prompts.js";
import { getWatermark, initWatermarkSchema } from "./watermark.js";
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
  /** Drain cadence, ms. Defaults to 60000 when omitted. */
  drainIntervalMs?: number;
  /** Passive-enqueue-sweep + prune cadence, ms. Defaults to 300000 when
   *  omitted. */
  sweepIntervalMs?: number;
  /** Shared timing histograms (src/metrics.ts). Omit to disable
   *  instrumentation (e.g. in tests that don't care about timing). */
  metrics?: MetricsRegistry;
  /** Claim lease duration, ms. Defaults to FALDA_DISTILL_LEASE_MS or
   *  DEFAULT_LEASE_MS (10min) when omitted. See src/distill/queue.ts. */
  leaseMs?: number;
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
  opts: DistillerOptions = {},
): DistillerHandle {
  const drainIntervalMs = opts.drainIntervalMs ?? DEFAULT_INTERVAL_MS;
  const sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const retentionDays = opts.recallTraceRetentionDays
    ?? resolveRetentionDays(process.env.FALDA_RECALL_TRACE_RETENTION_DAYS);
  const leaseMs = opts.leaseMs
    ?? Number(process.env.FALDA_DISTILL_LEASE_MS ?? DEFAULT_LEASE_MS);
  // One id per process boot — recorded on claimed jobs for observability
  // (falda distill inspect / stats), not used for ownership enforcement.
  const workerId = randomUUID();

  // Recover jobs orphaned by a previous crash (stuck 'running' past their
  // lease) before the first sweep/drain tick — see the module doc comment.
  const recovered = recoverStaleJobs(queueDb);
  if (recovered > 0) {
    console.log(`[falda-worker] recovered ${recovered} job(s) stranded 'running' by a previous crash`);
  }

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
    // distillStarted/distillFinished bracket the one place a distillation
    // pass actually runs — this is the source of truth every foreground
    // http_request_ms/mcp_request_ms/stream_add_ms observation tags itself
    // against (MetricsRegistry.distillActive(), src/metrics.ts).
    opts.metrics?.distillStarted();
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
      opts.metrics?.distillFinished();
    }
  };

  // Timed drain: claim and run exactly one ready job per tick, highest
  // priority first. This is the passive-backlog throughput ceiling — a
  // multi-tenant sweep backlog drains at one tenant per drainIntervalMs.
  const drain = async () => {
    const job = claimNext(queueDb, { leaseMs, workerId });
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
        const job = claimNext(queueDb, { minPriority: PRIORITY_EXPLICIT, leaseMs, workerId });
        if (!job) break;
        await runJob(job);
      }
    } finally {
      waking = false;
    }
  };

  // Enqueue: discover every self-store on disk and enqueue, at passive
  // priority (see src/distill/queue.ts's PRIORITY_PASSIVE), only those with
  // an undistilled turn (streamHeadSeq() > watermark). A store with nothing
  // new since its last pass is skipped — no queue row, no wasted drain
  // tick. Fail-open on a read error for one store: enqueue it rather than
  // risk silently stranding it (the coalescing enqueue() below is cheap and
  // idempotent, so a false-positive enqueue costs at most one no-op drain).
  const enqueueAll = () => {
    const tenants = pools.listSelfTenants();
    let enqueued = 0;
    for (const tenant of tenants) {
      const storeKey = storeKeyFor(tenant, undefined);
      try {
        const store = pools.resolve(tenant, undefined, false);
        let hasNewTurns: boolean;
        try {
          const db = (store as any).db as import("better-sqlite3").Database;
          // A store that has never been distilled has no distill_watermark
          // table yet — initialize it (idempotent, matches distillOnce's own
          // call) rather than treating "table missing" as a read failure.
          initWatermarkSchema(db);
          const head = store.streamHeadSeq();
          const wm = getWatermark(db, storeKey);
          hasNewTurns = head > (wm?.last_processed_seq ?? 0);
        } catch (e) {
          console.error(`[falda-worker] sweep gate check failed for ${tenant}, enqueuing anyway:`, e);
          hasNewTurns = true;
        }
        if (hasNewTurns) {
          enqueue(queueDb, storeKey);
          enqueued++;
        }
      } catch (e) {
        console.error(`[falda-worker] enqueue failed for tenant ${tenant}:`, e);
      }
    }
    if (tenants.length > 0) {
      console.log(
        `[falda-worker] swept ${tenants.length} self-store(s): ${enqueued} enqueued, ` +
        `${tenants.length - enqueued} up-to-date`,
      );
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
