/**
 * Priority queueing for the distillation job queue (src/distill/queue.ts).
 *
 * Covers: default (passive) priority, coalescing upgrade when an explicit
 * request lands on top of an already-pending passive job, priority-ordered
 * claiming, the minPriority claim filter (used by the wake path), migration
 * of a pre-existing distill_jobs table (no priority/origin columns), and
 * that backoff (failJob) preserves priority.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  initQueueSchema, enqueue, claimNext, failJob, getJob,
  PRIORITY_PASSIVE, PRIORITY_EXPLICIT,
} from "../src/distill/queue.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  initQueueSchema(db);
  return db;
}

describe("enqueue: default priority and origin", () => {
  test("enqueue() with no opts defaults to passive priority and 'sweep' origin", () => {
    const db = freshDb();
    const id = enqueue(db, "tenant-a:self");
    const job = getJob(db, id)!;
    assert.equal(job.priority, PRIORITY_PASSIVE);
    assert.equal(job.origin, "sweep");
  });

  test("enqueue() with explicit priority/origin is recorded", () => {
    const db = freshDb();
    const id = enqueue(db, "tenant-a:self", { priority: PRIORITY_EXPLICIT, origin: "mcp" });
    const job = getJob(db, id)!;
    assert.equal(job.priority, PRIORITY_EXPLICIT);
    assert.equal(job.origin, "mcp");
  });
});

describe("enqueue: coalescing upgrade", () => {
  test("a higher-priority enqueue upgrades an existing pending job in place (no duplicate row)", () => {
    const db = freshDb();
    const id1 = enqueue(db, "tenant-a:self"); // passive
    const id2 = enqueue(db, "tenant-a:self", { priority: PRIORITY_EXPLICIT, origin: "http" });
    assert.equal(id1, id2, "coalesced into the same row");
    const job = getJob(db, id1)!;
    assert.equal(job.priority, PRIORITY_EXPLICIT);
    assert.equal(job.origin, "http");

    const count = db.prepare("SELECT COUNT(*) c FROM distill_jobs WHERE store_key=?").get("tenant-a:self") as { c: number };
    assert.equal(count.c, 1);
  });

  test("a lower-or-equal-priority enqueue does NOT downgrade an existing pending job", () => {
    const db = freshDb();
    const id = enqueue(db, "tenant-a:self", { priority: PRIORITY_EXPLICIT, origin: "mcp" });
    enqueue(db, "tenant-a:self"); // passive sweep re-enqueues the same tenant
    const job = getJob(db, id)!;
    assert.equal(job.priority, PRIORITY_EXPLICIT, "sweep must not clobber an explicit job's priority");
    assert.equal(job.origin, "mcp");
  });

  test("equal priority does not rewrite origin", () => {
    const db = freshDb();
    const id = enqueue(db, "tenant-a:self", { priority: PRIORITY_EXPLICIT, origin: "mcp" });
    enqueue(db, "tenant-a:self", { priority: PRIORITY_EXPLICIT, origin: "http" });
    const job = getJob(db, id)!;
    assert.equal(job.origin, "mcp", "equal priority must not overwrite origin");
  });
});

describe("claimNext: priority ordering", () => {
  test("claims the highest-priority ready job first, regardless of enqueue order", () => {
    const db = freshDb();
    enqueue(db, "tenant-a:self"); // passive, enqueued first
    enqueue(db, "tenant-b:self", { priority: PRIORITY_EXPLICIT, origin: "mcp" }); // explicit, enqueued second

    const job = claimNext(db);
    assert.equal(job?.store_key, "tenant-b:self", "explicit job claimed first despite later enqueue");
  });

  test("ties broken by next_attempt_at (FIFO within the same priority)", () => {
    const db = freshDb();
    const idA = enqueue(db, "tenant-a:self");
    const idB = enqueue(db, "tenant-b:self");
    const job = claimNext(db);
    assert.equal(job?.id, idA);
    void idB;
  });

  test("minPriority filters out lower-priority ready jobs (wake path semantics)", () => {
    const db = freshDb();
    enqueue(db, "tenant-a:self"); // passive
    const job = claimNext(db, { minPriority: PRIORITY_EXPLICIT });
    assert.equal(job, null, "no explicit-or-higher job is ready");

    enqueue(db, "tenant-b:self", { priority: PRIORITY_EXPLICIT, origin: "http" });
    const job2 = claimNext(db, { minPriority: PRIORITY_EXPLICIT });
    assert.equal(job2?.store_key, "tenant-b:self");
  });
});

describe("failJob: backoff preserves priority", () => {
  test("a failed explicit job stays explicit-priority after rescheduling", () => {
    const db = freshDb();
    const id = enqueue(db, "tenant-a:self", { priority: PRIORITY_EXPLICIT, origin: "mcp" });
    claimNext(db); // -> running, attempts=1
    failJob(db, id, "boom");
    const job = getJob(db, id)!;
    assert.equal(job.status, "pending");
    assert.equal(job.priority, PRIORITY_EXPLICIT, "backoff must not silently downgrade priority");
    assert.equal(job.origin, "mcp");
  });
});

describe("initQueueSchema: migration on a pre-existing table without priority/origin", () => {
  test("adds priority/origin columns with correct defaults, preserving existing rows", () => {
    const db = new Database(":memory:");
    // Simulate the pre-priority schema (no priority/origin columns, no
    // priority-aware index) exactly as it shipped before this feature.
    db.exec(`
      CREATE TABLE distill_jobs (
        id TEXT PRIMARY KEY,
        store_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO distill_jobs(id,store_key,status,attempts,next_attempt_at,error,created_at,updated_at)
       VALUES('job-old','tenant-a:self','pending',0,?,null,?,?)`
    ).run(now, now, now);

    initQueueSchema(db); // migration under test

    const job = getJob(db, "job-old")!;
    assert.equal(job.priority, PRIORITY_PASSIVE);
    assert.equal(job.origin, "sweep");

    // New enqueue/claim behavior works post-migration.
    enqueue(db, "tenant-b:self", { priority: PRIORITY_EXPLICIT, origin: "http" });
    const claimed = claimNext(db);
    assert.equal(claimed?.store_key, "tenant-b:self", "post-migration priority ordering works");
  });

  test("running initQueueSchema twice is idempotent", () => {
    const db = freshDb();
    initQueueSchema(db);
    initQueueSchema(db);
    const id = enqueue(db, "tenant-a:self");
    assert.ok(getJob(db, id));
  });
});
