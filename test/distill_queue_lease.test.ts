/**
 * Crash recovery for the distillation job queue (src/distill/queue.ts):
 * claim leases and recoverStaleJobs(). A job claimed by a worker that
 * crashes before completeJob()/failJob() must not remain 'running' forever
 * — see docs/future/reliability-hardening.md finding 3.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  initQueueSchema, enqueue, claimNext, completeJob, failJob, getJob,
  recoverStaleJobs, PRIORITY_EXPLICIT, DEFAULT_LEASE_MS,
} from "../src/distill/queue.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  initQueueSchema(db);
  return db;
}

describe("claimNext: lease stamping", () => {
  test("claiming a job sets lease_until in the future and records worker_id", () => {
    const db = freshDb();
    enqueue(db, "tenant-a:self");
    const before = Date.now();
    const job = claimNext(db, { leaseMs: 5000, workerId: "worker-1" });
    assert.ok(job);
    assert.equal(job!.worker_id, "worker-1");
    assert.ok(job!.lease_until, "lease_until must be set on claim");
    const leaseUntilMs = Date.parse(job!.lease_until!);
    assert.ok(leaseUntilMs >= before + 4000, "lease_until should be ~leaseMs in the future");
    assert.ok(leaseUntilMs <= before + 6000, "lease_until should be ~leaseMs in the future");
  });

  test("default lease duration is DEFAULT_LEASE_MS when leaseMs is omitted", () => {
    const db = freshDb();
    enqueue(db, "tenant-a:self");
    const before = Date.now();
    const job = claimNext(db);
    const leaseUntilMs = Date.parse(job!.lease_until!);
    assert.ok(Math.abs(leaseUntilMs - (before + DEFAULT_LEASE_MS)) < 2000);
  });
});

describe("claimNext: reclaiming an expired lease", () => {
  test("a 'running' job with an expired lease is reclaimable", () => {
    const db = freshDb();
    const id = enqueue(db, "tenant-a:self");
    // Claim with an already-expired lease (negative ms) to simulate a stale claim.
    const job1 = claimNext(db, { leaseMs: -1000, workerId: "worker-crashed" });
    assert.equal(job1?.id, id);
    assert.equal(job1?.status, "running");

    // A second claim attempt should reclaim it, since its lease has expired.
    const job2 = claimNext(db, { leaseMs: 60000, workerId: "worker-2" });
    assert.ok(job2, "expired-lease job must be reclaimable");
    assert.equal(job2!.id, id);
    assert.equal(job2!.worker_id, "worker-2");
    // attempts increments on every claim (existing behavior, preserved).
    assert.equal(job2!.attempts, 2);
  });

  test("a 'running' job with a live (unexpired) lease is NOT reclaimable", () => {
    const db = freshDb();
    enqueue(db, "tenant-a:self");
    claimNext(db, { leaseMs: 60000, workerId: "worker-1" });

    const job2 = claimNext(db, { leaseMs: 60000, workerId: "worker-2" });
    assert.equal(job2, null, "a job with a live lease must not be claimable by another worker");
  });

  test("minPriority filter still applies when considering expired-lease reclaims", () => {
    const db = freshDb();
    const id = enqueue(db, "tenant-a:self"); // passive priority
    claimNext(db, { leaseMs: -1000 }); // expire immediately

    const job = claimNext(db, { minPriority: PRIORITY_EXPLICIT });
    assert.equal(job, null, "passive-priority stale job must not be reclaimed by an explicit-only claim");

    const job2 = claimNext(db);
    assert.equal(job2?.id, id, "unfiltered claim still reclaims it");
  });
});

describe("completeJob / failJob: lease release", () => {
  test("completeJob clears lease_until and worker_id", () => {
    const db = freshDb();
    const id = enqueue(db, "tenant-a:self");
    claimNext(db, { workerId: "worker-1" });
    completeJob(db, id);
    const job = getJob(db, id)!;
    assert.equal(job.status, "done");
    assert.equal(job.lease_until, null);
    assert.equal(job.worker_id, null);
  });

  test("failJob (rescheduled) clears lease_until and worker_id", () => {
    const db = freshDb();
    const id = enqueue(db, "tenant-a:self");
    claimNext(db, { workerId: "worker-1" });
    failJob(db, id, "boom");
    const job = getJob(db, id)!;
    assert.equal(job.status, "pending");
    assert.equal(job.lease_until, null);
    assert.equal(job.worker_id, null);
  });

  test("failJob (dead-lettered) clears lease_until and worker_id", () => {
    const db = freshDb();
    const id = enqueue(db, "tenant-a:self");
    // Directly set attempts to the limit (mirrors test/distill_core.test.ts's
    // "failJob transitions to dead after MAX_ATTEMPTS" pattern) rather than
    // looping claimNext/failJob, since backoff schedules next_attempt_at in
    // the future and would block a real reclaim loop.
    db.prepare("UPDATE distill_jobs SET attempts=8,status='running',lease_until=?,worker_id=? WHERE id=?")
      .run(new Date(Date.now() + 60000).toISOString(), "worker-1", id);
    failJob(db, id, "boom");
    const job = getJob(db, id)!;
    assert.equal(job.status, "dead");
    assert.equal(job.lease_until, null);
    assert.equal(job.worker_id, null);
  });
});

describe("recoverStaleJobs", () => {
  test("resets a 'running' job with an expired lease back to 'pending', preserving attempts", () => {
    const db = freshDb();
    const id = enqueue(db, "tenant-a:self");
    claimNext(db, { leaseMs: -1000, workerId: "worker-crashed" });
    const before = getJob(db, id)!;
    assert.equal(before.status, "running");
    assert.equal(before.attempts, 1);

    const recovered = recoverStaleJobs(db);
    assert.equal(recovered, 1);

    const after = getJob(db, id)!;
    assert.equal(after.status, "pending");
    assert.equal(after.attempts, 1, "attempts must be preserved across recovery");
    assert.equal(after.lease_until, null);
    assert.equal(after.worker_id, null);
  });

  test("does NOT touch a 'running' job with a live lease", () => {
    const db = freshDb();
    const id = enqueue(db, "tenant-a:self");
    claimNext(db, { leaseMs: 60000, workerId: "worker-1" });

    const recovered = recoverStaleJobs(db);
    assert.equal(recovered, 0);
    assert.equal(getJob(db, id)!.status, "running");
  });

  test("does NOT touch 'pending', 'done', or 'dead' jobs", () => {
    const db = freshDb();
    const pendingId = enqueue(db, "tenant-a:self");
    const doneId = enqueue(db, "tenant-b:self");
    // completeJob() sets status unconditionally by id, independent of
    // whatever claimNext() would otherwise pick — no need to actually claim
    // doneId first to exercise "recovery ignores a 'done' row".
    completeJob(db, doneId);

    const recovered = recoverStaleJobs(db);
    assert.equal(recovered, 0);
    assert.equal(getJob(db, pendingId)!.status, "pending");
    assert.equal(getJob(db, doneId)!.status, "done");
  });

  test("a recovered job's preserved attempts count still dead-letters via the normal fail path", () => {
    const db = freshDb();
    const id = enqueue(db, "tenant-a:self");
    claimNext(db, { leaseMs: -1000 }); // attempts=1, running, expired
    recoverStaleJobs(db); // -> pending, attempts=1 preserved

    // Simulate attempts having climbed to the limit across further
    // claim/fail cycles (mirrors distill_core.test.ts's direct-attempts
    // pattern rather than looping through backoff delays), then confirm
    // recovery's preserved attempts value still feeds the normal
    // MAX_ATTEMPTS check in failJob.
    db.prepare("UPDATE distill_jobs SET attempts=8,status='running' WHERE id=?").run(id);
    failJob(db, id, "boom");
    const job = getJob(db, id)!;
    assert.equal(job.status, "dead");
    assert.equal(job.attempts, 8);
  });

  test("running twice is a no-op the second time", () => {
    const db = freshDb();
    enqueue(db, "tenant-a:self");
    claimNext(db, { leaseMs: -1000 });
    assert.equal(recoverStaleJobs(db), 1);
    assert.equal(recoverStaleJobs(db), 0);
  });
});

describe("initQueueSchema: migration on a pre-lease table", () => {
  test("adds lease_until/worker_id columns, defaulting existing rows to null", () => {
    const db = new Database(":memory:");
    // Simulate the pre-lease schema (has priority/origin, no lease columns).
    db.exec(`
      CREATE TABLE distill_jobs (
        id TEXT PRIMARY KEY,
        store_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT 'sweep'
      );
    `);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO distill_jobs(id,store_key,status,attempts,next_attempt_at,error,created_at,updated_at,priority,origin)
       VALUES('job-old','tenant-a:self','running',1,?,null,?,?,0,'sweep')`
    ).run(now, now, now);

    initQueueSchema(db); // migration under test

    const job = getJob(db, "job-old")!;
    assert.equal(job.status, "running");
    assert.equal(job.lease_until, null);
    assert.equal(job.worker_id, null);

    // A pre-existing 'running' row with no lease_until is exactly the
    // orphan case this migration exists to fix: a job claimed by a
    // pre-lease binary that then crashed. recoverStaleJobs() must sweep it
    // rather than leaving it permanently unclaimable.
    assert.equal(recoverStaleJobs(db), 1);
    assert.equal(getJob(db, "job-old")!.status, "pending");

    // New claim/complete behavior works post-migration.
    enqueue(db, "tenant-b:self");
    const claimed = claimNext(db, { workerId: "w1" });
    assert.equal(claimed?.worker_id, "w1");
    assert.ok(claimed?.lease_until);
  });
});
