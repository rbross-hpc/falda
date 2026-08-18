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
  initQueueSchema, enqueue, getJob, listJobs, PRIORITY_EXPLICIT, PRIORITY_PASSIVE,
} from "../src/distill/queue.js";
import { startDistiller, resolveWorkerIntervals } from "../src/distill/worker.js";
import { initWatermarkSchema, setWatermark, initDirtySchema, markDirty } from "../src/distill/watermark.js";
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

describe("startDistiller: crash recovery on startup", () => {
  test("a job stranded 'running' by a previous crash is recovered and re-drained on this boot", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      pools.resolve("proj-x", undefined, true);

      // Simulate a job claimed by a previous process instance that then
      // crashed: 'running', lease already expired, attempts=1.
      const jobId = enqueue(queueDb, "proj-x:self");
      queueDb.prepare(
        "UPDATE distill_jobs SET status='running',attempts=1,lease_until=?,worker_id=? WHERE id=?"
      ).run(new Date(Date.now() - 1000).toISOString(), "worker-crashed", jobId);

      // startDistiller() must recover it (back to 'pending') before its
      // first drain tick, so this boot's worker picks it up rather than it
      // remaining stuck 'running' forever.
      const distiller = startDistiller(queueDb, pools, failingLlm, {
        drainIntervalMs: 20,
        sweepIntervalMs: 60_000,
      });
      try {
        const redrained = await waitFor(() => (getJob(queueDb, jobId)?.attempts ?? 0) > 1, 2000);
        assert.ok(redrained, "recovered job was reclaimed and attempted again on this boot");
      } finally {
        await distiller.stop();
      }
    } finally { cleanup(root); }
  });

  test("a job with a live (unexpired) lease from another still-running process is left untouched at startup", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      pools.resolve("proj-x", undefined, true);

      const jobId = enqueue(queueDb, "proj-x:self");
      queueDb.prepare(
        "UPDATE distill_jobs SET status='running',attempts=1,lease_until=?,worker_id=? WHERE id=?"
      ).run(new Date(Date.now() + 60_000).toISOString(), "worker-still-alive", jobId);

      const distiller = startDistiller(queueDb, pools, failingLlm, {
        drainIntervalMs: 20,
        sweepIntervalMs: 60_000,
      });
      try {
        // Give a few drain ticks a chance to run — the job must stay
        // untouched (still attempts=1, still running under the other
        // worker's lease) since its lease hasn't expired.
        await new Promise((r) => setTimeout(r, 100));
        const job = getJob(queueDb, jobId)!;
        assert.equal(job.status, "running");
        assert.equal(job.attempts, 1);
        assert.equal(job.worker_id, "worker-still-alive");
      } finally {
        await distiller.stop();
      }
    } finally { cleanup(root); }
  });
});

describe("startDistiller: graceful stop()", () => {
  test("stop() awaits an in-flight job before resolving", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      const store = pools.resolve("proj-x", undefined, true);
      // A pass with zero turns returns early WITHOUT calling the LLM
      // (src/distill/core.ts) — give it a real turn so the LLM is actually
      // invoked and stays in flight until resolveLlm() is called below.
      await store.addStream("sess-1", [{ role: "user", content: "hello" }]);

      let resolveLlm: (() => void) | undefined;
      const slowLlm: LLMFnWithModel = Object.assign(
        () => new Promise<string>((resolve) => {
          resolveLlm = () => resolve('{"atoms":[]}');
        }),
        { model: "stub" },
      );

      const jobId = enqueue(queueDb, "proj-x:self");
      const distiller = startDistiller(queueDb, pools, slowLlm, {
        drainIntervalMs: 20,
        sweepIntervalMs: 60_000,
      });

      // Wait for the job to actually be claimed (attempts > 0) before
      // calling stop() — otherwise we might race stop() against a drain
      // tick that hasn't fired yet.
      await waitFor(() => (getJob(queueDb, jobId)?.attempts ?? 0) > 0, 2000);
      assert.equal(getJob(queueDb, jobId)?.status, "running", "job is in flight");

      // Let the in-flight job resolve shortly after stop() is called, and
      // confirm stop() actually waited for it rather than returning
      // immediately while the job was still running.
      let stopResolved = false;
      const stopPromise = distiller.stop().then(() => { stopResolved = true; });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(stopResolved, false, "stop() must not resolve while the job is still in flight");

      resolveLlm?.();
      await stopPromise;
      assert.equal(stopResolved, true, "stop() resolved once the in-flight job finished");
    } finally { cleanup(root); }
  });

  test("stop() gives up after the shutdown grace period if the job never finishes", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      const store = pools.resolve("proj-x", undefined, true);
      await store.addStream("sess-1", [{ role: "user", content: "hello" }]);

      const hangingLlm: LLMFnWithModel = Object.assign(
        () => new Promise<string>(() => { /* never resolves */ }),
        { model: "stub" },
      );

      const jobId = enqueue(queueDb, "proj-x:self");
      const distiller = startDistiller(queueDb, pools, hangingLlm, {
        drainIntervalMs: 20,
        sweepIntervalMs: 60_000,
        shutdownGraceMs: 50,
      });

      await waitFor(() => (getJob(queueDb, jobId)?.attempts ?? 0) > 0, 2000);

      const start = Date.now();
      await distiller.stop();
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 2000, "stop() must return once the grace period elapses, not hang forever");
      assert.ok(elapsed >= 40, "stop() should have waited roughly the grace period");
    } finally { cleanup(root); }
  });

  test("stop() prevents new jobs from being claimed even if a drain tick fires during shutdown", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      pools.resolve("proj-x", undefined, true);

      const distiller = startDistiller(queueDb, pools, failingLlm, {
        drainIntervalMs: 10_000, // won't fire during this test
        sweepIntervalMs: 60_000,
      });
      await distiller.stop();

      // Enqueue AFTER stop() — a stopped worker's timers are cleared, so
      // nothing should claim this job.
      const jobId = enqueue(queueDb, "proj-x:self");
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(getJob(queueDb, jobId)?.status, "pending", "no claim after stop()");

      // wake() after stop() must also be a no-op.
      distiller.wake();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(getJob(queueDb, jobId)?.status, "pending", "wake() after stop() must not claim");
    } finally { cleanup(root); }
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

      const distiller = startDistiller(queueDb, pools, failingLlm, {
        drainIntervalMs: 20,
        sweepIntervalMs: 10_000, // deliberately slow — proves drain doesn't wait on it
      });
      try {
        const drained = await waitFor(() => (getJob(queueDb, jobId)?.attempts ?? 0) > 0, 2000);
        assert.ok(drained, "drain claimed the job well within the slow sweep interval");
      } finally {
        await distiller.stop();
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

      const distiller = startDistiller(queueDb, pools, failingLlm, {
        drainIntervalMs: 60_000, // deliberately slow — proves wake() doesn't wait on it
        sweepIntervalMs: 60_000,
      });
      try {
        const jobId = enqueue(queueDb, "proj-x:self", { priority: PRIORITY_EXPLICIT, origin: "mcp" });
        distiller.wake();
        const drained = await waitFor(() => (getJob(queueDb, jobId)?.attempts ?? 0) > 0, 2000);
        assert.ok(drained, "wake() drained the explicit job without waiting for the 60s drain tick");
      } finally {
        await distiller.stop();
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

      const distiller = startDistiller(queueDb, pools, failingLlm, {
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
        await distiller.stop();
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

      const distiller = startDistiller(queueDb, pools, slowLlm, {
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
        await distiller.stop();
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
      const distiller = startDistiller(queueDb, pools, failingLlm, {
        drainIntervalMs: 20, sweepIntervalMs: 10_000, metrics,
      });
      try {
        await waitFor(() => metrics.distill_service_ms.snapshot().count > 0, 2000);
        assert.equal(metrics.distill_pending_ms.snapshot().count, 1);
        assert.equal(metrics.distill_service_ms.snapshot().count, 1);
        assert.equal(metrics.recall_ms.snapshot().count, 0, "recall metric untouched by distill activity");
        assert.equal(metrics.distillActive(), false, "distillActive() must be false again once the pass has finished");
      } finally {
        await distiller.stop();
      }
    } finally { cleanup(root); }
  });

  test("distillActive() is true for the duration of a pass, observable by a concurrent foreground observation", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      const store = pools.resolve("proj-x", undefined, true);
      // distillOnce takes a "no new turns" early return (and never calls the
      // LLM at all) unless there's actually a turn to process — give it one.
      await store.addStream("sess-1", [{ role: "user", content: "hello world" }]);
      enqueue(queueDb, "proj-x:self");

      let sawActiveDuringPass = false;
      const metrics = new MetricsRegistry();
      const slowLlm: LLMFnWithModel = Object.assign(
        async () => {
          sawActiveDuringPass = metrics.distillActive();
          await new Promise((r) => setTimeout(r, 30));
          throw new Error("stub LLM — intentionally fails after a delay");
        },
        { model: "stub" },
      );
      const distiller = startDistiller(queueDb, pools, slowLlm, {
        drainIntervalMs: 20, sweepIntervalMs: 10_000, metrics,
      });
      try {
        await waitFor(() => metrics.distill_service_ms.snapshot().count > 0, 2000);
        assert.equal(sawActiveDuringPass, true, "distillActive() must be true while the pass's LLM call is in flight");
        assert.equal(metrics.distillActive(), false, "distillActive() must be false again once the pass has finished");
      } finally {
        await distiller.stop();
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
      const distiller = startDistiller(queueDb, pools, failingLlm, {
        drainIntervalMs: 60_000, sweepIntervalMs: 60_000, metrics,
      });
      try {
        enqueue(queueDb, "proj-x:self", { priority: PRIORITY_EXPLICIT, origin: "http" });
        distiller.wake();
        await waitFor(() => metrics.distill_service_ms.snapshot().count > 0, 2000);
        assert.equal(metrics.distill_service_ms.snapshot().count, 1);
      } finally {
        await distiller.stop();
      }
    } finally { cleanup(root); }
  });
});

describe("startDistiller: sweep gate (only enqueue stores with undistilled turns)", () => {
  test("a store with no turns at all is never enqueued by the sweep", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      pools.resolve("proj-empty", undefined, true); // materialize, zero turns

      const distiller = startDistiller(queueDb, pools, failingLlm, {
        drainIntervalMs: 60_000, sweepIntervalMs: 20,
      });
      try {
        // Give a couple of sweep ticks a chance to run.
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(listJobs(queueDb, "proj-empty:self").length, 0, "no job ever created for an empty store");
      } finally {
        await distiller.stop();
      }
    } finally { cleanup(root); }
  });

  test("a never-distilled store with turns is enqueued once (no watermark row = seq 0)", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      const store = pools.resolve("proj-new", undefined, true);
      await store.addStream("sess-1", [{ role: "user", content: "first turn ever" }]);

      const distiller = startDistiller(queueDb, pools, failingLlm, {
        drainIntervalMs: 60_000, sweepIntervalMs: 20,
      });
      try {
        const enqueuedOk = await waitFor(() => listJobs(queueDb, "proj-new:self").length > 0, 1000);
        assert.ok(enqueuedOk, "never-distilled store with turns is enqueued");
      } finally {
        await distiller.stop();
      }
    } finally { cleanup(root); }
  });

  test("a store fully caught up (watermark == head) is NOT re-enqueued by later sweeps", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      const store = pools.resolve("proj-caughtup", undefined, true);
      await store.addStream("sess-1", [{ role: "user", content: "already distilled turn" }]);
      // Simulate "already fully distilled": watermark == head seq.
      const db = (store as any).db;
      initWatermarkSchema(db);
      const head = store.streamHeadSeq();
      setWatermark(db, "proj-caughtup:self", "some-turn-id", new Date().toISOString(), head);

      const distiller = startDistiller(queueDb, pools, failingLlm, {
        drainIntervalMs: 60_000, sweepIntervalMs: 15,
      });
      try {
        // Let several sweep ticks pass.
        await new Promise((r) => setTimeout(r, 120));
        assert.equal(listJobs(queueDb, "proj-caughtup:self").length, 0, "caught-up store stays un-enqueued");
      } finally {
        await distiller.stop();
      }
    } finally { cleanup(root); }
  });

  test("a backlogged store (watermark behind head) stays enqueued across sweeps until caught up", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      const store = pools.resolve("proj-backlog", undefined, true);
      await store.addStream("sess-1", [
        { role: "user", content: "turn one" },
        { role: "user", content: "turn two" },
      ]);
      const db = (store as any).db;
      initWatermarkSchema(db);
      // Watermark behind head: only "turn one" processed so far.
      setWatermark(db, "proj-backlog:self", "turn-one-id", new Date().toISOString(), 1);

      const distiller = startDistiller(queueDb, pools, failingLlm, {
        drainIntervalMs: 60_000, sweepIntervalMs: 20,
      });
      try {
        const enqueuedOk = await waitFor(() => listJobs(queueDb, "proj-backlog:self").length > 0, 1000);
        assert.ok(enqueuedOk, "backlogged store is enqueued even though it has been distilled before");
      } finally {
        await distiller.stop();
      }
    } finally { cleanup(root); }
  });

  test("mixed fleet: only stores with undistilled turns are enqueued in one sweep", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);

      pools.resolve("proj-idle", undefined, true); // no turns at all

      const caughtUp = pools.resolve("proj-caught", undefined, true);
      await caughtUp.addStream("sess-1", [{ role: "user", content: "old news" }]);
      const caughtDb = (caughtUp as any).db;
      initWatermarkSchema(caughtDb);
      setWatermark(caughtDb, "proj-caught:self", "id", new Date().toISOString(), caughtUp.streamHeadSeq());

      const fresh = pools.resolve("proj-fresh", undefined, true);
      await fresh.addStream("sess-1", [{ role: "user", content: "brand new turn" }]);

      const distiller = startDistiller(queueDb, pools, failingLlm, {
        drainIntervalMs: 60_000, sweepIntervalMs: 20,
      });
      try {
        const ok = await waitFor(() => listJobs(queueDb, "proj-fresh:self").length > 0, 1000);
        assert.ok(ok, "fresh store gets enqueued");
        await new Promise((r) => setTimeout(r, 60)); // let a couple more ticks pass
        assert.equal(listJobs(queueDb, "proj-idle:self").length, 0, "idle store never enqueued");
        assert.equal(listJobs(queueDb, "proj-caught:self").length, 0, "caught-up store never enqueued");
      } finally {
        await distiller.stop();
      }
    } finally { cleanup(root); }
  });

  // docs/future/reliability-hardening.md finding 2: a store with NO
  // undistilled turns (watermark == head) but a set store_dirty flag must
  // still be enqueued by the sweep — dirty state is a second, independent
  // trigger alongside the watermark-vs-head comparison above.
  test("a store fully caught up on turns but flagged dirty IS enqueued by the sweep", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      const store = pools.resolve("proj-dirty", undefined, true);
      await store.addStream("sess-1", [{ role: "user", content: "already distilled turn" }]);
      const db = (store as any).db;
      initWatermarkSchema(db);
      const head = store.streamHeadSeq();
      setWatermark(db, "proj-dirty:self", "some-turn-id", new Date().toISOString(), head);
      // Caught up on turns (watermark == head) but flagged dirty directly,
      // simulating an out-of-band lifecycle mutation.
      initDirtySchema(db);
      markDirty(db, "proj-dirty:self", "test: simulated lifecycle mutation");

      const distiller = startDistiller(queueDb, pools, failingLlm, {
        drainIntervalMs: 60_000, sweepIntervalMs: 20,
      });
      try {
        const enqueuedOk = await waitFor(() => listJobs(queueDb, "proj-dirty:self").length > 0, 1000);
        assert.ok(enqueuedOk, "dirty store is enqueued despite having no undistilled turns");
      } finally {
        await distiller.stop();
      }
    } finally { cleanup(root); }
  });

  test("a store caught up on turns with NO dirty flag is still not enqueued (dirty gate doesn't over-fire)", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      const store = pools.resolve("proj-clean", undefined, true);
      await store.addStream("sess-1", [{ role: "user", content: "already distilled turn" }]);
      const db = (store as any).db;
      initWatermarkSchema(db);
      const head = store.streamHeadSeq();
      setWatermark(db, "proj-clean:self", "some-turn-id", new Date().toISOString(), head);
      // No markDirty call — store_dirty table doesn't even exist yet.

      const distiller = startDistiller(queueDb, pools, failingLlm, {
        drainIntervalMs: 60_000, sweepIntervalMs: 15,
      });
      try {
        await new Promise((r) => setTimeout(r, 120));
        assert.equal(listJobs(queueDb, "proj-clean:self").length, 0, "clean, caught-up store stays un-enqueued");
      } finally {
        await distiller.stop();
      }
    } finally { cleanup(root); }
  });
});

// docs/future/reliability-hardening.md finding 2: an L2/L3 failure inside
// distillOnce() must propagate as a thrown error so runJob's catch calls
// failJob() (existing backoff/dead-letter), not completeJob() — a silently
// "successful" job would defeat retry entirely for a broken narration/
// synthesis LLM.
describe("startDistiller: L2/L3 failure engages the existing job retry (finding 2)", () => {
  test("a job whose L2/L3 phase fails is left pending with attempts > 0, not marked done", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      const store = pools.resolve("proj-l2fail", undefined, true);
      await store.addStream("sess-1", [{ role: "user", content: "the sensor reads nominal" }]);

      // Extraction + consolidation succeed; every subsequent call (scene
      // title/summary, core synthesis) throws — isolates the failure to
      // L2/L3 without needing distill_core.test.ts's full mock-response
      // machinery in this worker-level test.
      let calls = 0;
      const l2FailingLlm: LLMFnWithModel = Object.assign(
        async (prompt: string) => {
          calls++;
          if (calls === 1) return `{"type":"fact","content":"The sensor reads nominal.","confidence":"high"}`;
          if (calls === 2) return `{"action":"store","target_ids":[],"rationale":"New fact."}`;
          throw new Error("stub LLM — L2/L3 intentionally fails");
        },
        { model: "stub" },
      );

      const jobId = enqueue(queueDb, "proj-l2fail:self");
      const distiller = startDistiller(queueDb, pools, l2FailingLlm, {
        drainIntervalMs: 20, sweepIntervalMs: 60_000,
      });
      try {
        const attempted = await waitFor(() => (getJob(queueDb, jobId)?.attempts ?? 0) > 0, 2000);
        assert.ok(attempted, "job was claimed and attempted");
        const job = getJob(queueDb, jobId)!;
        assert.equal(job.status, "pending", "job rescheduled via failJob, not completed");
        assert.ok(job.error?.includes("L2/L3"), "recorded error reflects the L2/L3 failure");
      } finally {
        await distiller.stop();
      }
    } finally { cleanup(root); }
  });
});
