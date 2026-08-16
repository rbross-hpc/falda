/**
 * Distillation worker orchestration (src/distill/worker.ts):
 *   - resolveWorkerIntervals(): split-cadence env resolution + deprecated
 *     FALDA_WORKER_INTERVAL_MS fallback.
 *   - startDistiller(): independent drain vs. sweep timers.
 *   - wake(): immediate drain of ready EXPLICIT-priority jobs, re-entrancy
 *     safety, and that it never touches PASSIVE jobs.
 *   - metrics instrumentation: distill_pending_ms / distill_service_ms are
 *     observed on both the timed drain and the wake path.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PoolManager } from "../src/pools.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import {
  initQueueSchema, enqueue, getJob, PRIORITY_EXPLICIT, PRIORITY_PASSIVE,
} from "../src/distill/queue.js";
import { startDistiller, resolveWorkerIntervals } from "../src/distill/worker.js";
import { MetricsRegistry } from "../src/metrics.js";
import type { LLMFnWithModel } from "../src/distill/llm.js";

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "falda-worker-"));
}
function cleanup(root: string) {
  fs.rmSync(root, { recursive: true, force: true });
}
function makePool(root: string, dim = 32) {
  return new PoolManager({ root, embed: makeLocalEmbedder(dim), dim });
}

// A stub LLM that always fails fast — we only care about whether jobs are
// CLAIMED/ATTEMPTED (attempts > 0), not about distillOnce's LLM-dependent
// internals (covered in distill_core.test.ts). Keeps these tests offline
// and fast.
const failingLlm: LLMFnWithModel = Object.assign(
  async () => { throw new Error("stub LLM — intentionally fails"); },
  { model: "stub" },
);

async function waitFor(predicate: () => boolean, timeoutMs = 3000, stepMs = 15) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

describe("resolveWorkerIntervals", () => {
  test("defaults: drain=60000, sweep=300000, no deprecated fallback in use", () => {
    const r = resolveWorkerIntervals({});
    assert.equal(r.drainIntervalMs, 60_000);
    assert.equal(r.sweepIntervalMs, 300_000);
    assert.equal(r.usingDeprecatedFallback, false);
  });

  test("FALDA_DRAIN_INTERVAL_MS / FALDA_SWEEP_INTERVAL_MS override independently", () => {
    const r = resolveWorkerIntervals({ FALDA_DRAIN_INTERVAL_MS: "1000", FALDA_SWEEP_INTERVAL_MS: "2000" });
    assert.equal(r.drainIntervalMs, 1000);
    assert.equal(r.sweepIntervalMs, 2000);
    assert.equal(r.usingDeprecatedFallback, false);
  });

  test("FALDA_WORKER_INTERVAL_MS sets both when the split vars are unset, and is flagged deprecated", () => {
    const r = resolveWorkerIntervals({ FALDA_WORKER_INTERVAL_MS: "900000" });
    assert.equal(r.drainIntervalMs, 900_000);
    assert.equal(r.sweepIntervalMs, 900_000);
    assert.equal(r.usingDeprecatedFallback, true);
  });

  test("split vars take precedence over FALDA_WORKER_INTERVAL_MS when both are set", () => {
    const r = resolveWorkerIntervals({
      FALDA_WORKER_INTERVAL_MS: "900000",
      FALDA_DRAIN_INTERVAL_MS: "1000",
      FALDA_SWEEP_INTERVAL_MS: "2000",
    });
    assert.equal(r.drainIntervalMs, 1000);
    assert.equal(r.sweepIntervalMs, 2000);
    assert.equal(r.usingDeprecatedFallback, false, "not relying on the fallback for anything");
  });

  test("legacy var set alongside only ONE split var is still a partial deprecated fallback", () => {
    const r = resolveWorkerIntervals({ FALDA_WORKER_INTERVAL_MS: "900000", FALDA_DRAIN_INTERVAL_MS: "1000" });
    assert.equal(r.drainIntervalMs, 1000);
    assert.equal(r.sweepIntervalMs, 900_000, "sweep falls back to the legacy var");
    assert.equal(r.usingDeprecatedFallback, true);
  });
});

describe("startDistiller: independent drain/sweep timers", () => {
  test("drain fires on drainIntervalMs without waiting for a sweep tick", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      pools.resolve("proj-x", undefined, true); // materialize a self-store
      const jobId = enqueue(queueDb, "proj-x:self");

      const distiller = startDistiller(queueDb, pools, failingLlm, undefined, {
        drainIntervalMs: 20,
        sweepIntervalMs: 10_000, // deliberately slow — proves drain doesn't wait on it
      });
      try {
        const drained = await waitFor(() => (getJob(queueDb, jobId)?.attempts ?? 0) > 0, 2000);
        assert.ok(drained, "drain claimed the job well within the slow sweep interval");
      } finally {
        distiller.stop();
      }
    } finally { cleanup(root); }
  });
});

describe("startDistiller: wake()", () => {
  test("wake() drains a ready EXPLICIT job immediately, without waiting for the drain tick", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      pools.resolve("proj-x", undefined, true);

      const distiller = startDistiller(queueDb, pools, failingLlm, undefined, {
        drainIntervalMs: 60_000, // deliberately slow — proves wake() doesn't wait on it
        sweepIntervalMs: 60_000,
      });
      try {
        const jobId = enqueue(queueDb, "proj-x:self", { priority: PRIORITY_EXPLICIT, origin: "mcp" });
        distiller.wake();
        const drained = await waitFor(() => (getJob(queueDb, jobId)?.attempts ?? 0) > 0, 2000);
        assert.ok(drained, "wake() drained the explicit job without waiting for the 60s drain tick");
      } finally {
        distiller.stop();
      }
    } finally { cleanup(root); }
  });

  test("wake() never claims a PASSIVE job — passive jobs wait for the timed drain", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      pools.resolve("proj-x", undefined, true);

      const distiller = startDistiller(queueDb, pools, failingLlm, undefined, {
        drainIntervalMs: 60_000,
        sweepIntervalMs: 60_000,
      });
      try {
        const jobId = enqueue(queueDb, "proj-x:self"); // passive, default priority
        distiller.wake();
        // Give wake() a moment to (not) act.
        await new Promise((r) => setTimeout(r, 100));
        const job = getJob(queueDb, jobId)!;
        assert.equal(job.attempts, 0, "wake() must not drain a passive-priority job");
        assert.equal(job.priority, PRIORITY_PASSIVE);
      } finally {
        distiller.stop();
      }
    } finally { cleanup(root); }
  });

  test("concurrent wake() calls do not double-drain (re-entrancy safe)", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      pools.resolve("proj-x", undefined, true);
      pools.resolve("proj-y", undefined, true);

      let concurrentCalls = 0;
      let maxConcurrent = 0;
      const slowLlm: LLMFnWithModel = Object.assign(
        async () => {
          concurrentCalls++;
          maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
          await new Promise((r) => setTimeout(r, 50));
          concurrentCalls--;
          throw new Error("stub LLM — intentionally fails after simulating work");
        },
        { model: "stub" },
      );

      const distiller = startDistiller(queueDb, pools, slowLlm, undefined, {
        drainIntervalMs: 60_000,
        sweepIntervalMs: 60_000,
      });
      try {
        const jobA = enqueue(queueDb, "proj-x:self", { priority: PRIORITY_EXPLICIT, origin: "mcp" });
        const jobB = enqueue(queueDb, "proj-y:self", { priority: PRIORITY_EXPLICIT, origin: "mcp" });
        // Fire wake() twice back-to-back, simulating two falda_distill calls
        // landing close together.
        distiller.wake();
        distiller.wake();
        await waitFor(() => (getJob(queueDb, jobA)?.attempts ?? 0) > 0 && (getJob(queueDb, jobB)?.attempts ?? 0) > 0, 3000);
        assert.ok(maxConcurrent <= 1, "the two wake() calls must not run distillOnce concurrently against the same queue");
      } finally {
        distiller.stop();
      }
    } finally { cleanup(root); }
  });
});

describe("startDistiller: metrics instrumentation", () => {
  test("timed drain observes distill_pending_ms and distill_service_ms", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      pools.resolve("proj-x", undefined, true);
      enqueue(queueDb, "proj-x:self");

      const metrics = new MetricsRegistry();
      const distiller = startDistiller(queueDb, pools, failingLlm, undefined, {
        drainIntervalMs: 20, sweepIntervalMs: 10_000, metrics,
      });
      try {
        await waitFor(() => metrics.distill_service_ms.snapshot().count > 0, 2000);
        assert.equal(metrics.distill_pending_ms.snapshot().count, 1);
        assert.equal(metrics.distill_service_ms.snapshot().count, 1);
        assert.equal(metrics.recall_ms.snapshot().count, 0, "recall metric untouched by distill activity");
      } finally {
        distiller.stop();
      }
    } finally { cleanup(root); }
  });

  test("wake-triggered drain also observes metrics", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      pools.resolve("proj-x", undefined, true);

      const metrics = new MetricsRegistry();
      const distiller = startDistiller(queueDb, pools, failingLlm, undefined, {
        drainIntervalMs: 60_000, sweepIntervalMs: 60_000, metrics,
      });
      try {
        enqueue(queueDb, "proj-x:self", { priority: PRIORITY_EXPLICIT, origin: "http" });
        distiller.wake();
        await waitFor(() => metrics.distill_service_ms.snapshot().count > 0, 2000);
        assert.equal(metrics.distill_service_ms.snapshot().count, 1);
      } finally {
        distiller.stop();
      }
    } finally { cleanup(root); }
  });
});
