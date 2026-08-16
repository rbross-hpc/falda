/**
 * Per-store distillation job queue backed by SQLite.
 * Provides coalescing enqueue, claim, complete, and fail-with-backoff semantics.
 */
import Database from "better-sqlite3";

export type JobStatus = "pending" | "running" | "done" | "dead";

/** Origin of an enqueue call — informational only, surfaced by `falda distill
 *  inspect`/stats; does not affect drain order (priority does). */
export type JobOrigin = "sweep" | "http" | "mcp";

export interface DistillJob {
  id: string;
  store_key: string;
  status: JobStatus;
  attempts: number;
  next_attempt_at: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  priority: number;
  origin: JobOrigin;
}

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 900_000;
const MAX_ATTEMPTS = 8;

/** Priority of a job auto-enqueued by the worker's periodic sweep
 *  (src/distill/worker.ts's enqueueAll) — the default. */
export const PRIORITY_PASSIVE = 0;
/** Priority of a job enqueued on demand (falda_distill / POST /distill) —
 *  higher than passive so it's claimed first and can trigger an immediate
 *  wake (src/distill/worker.ts's wake()) rather than waiting for the next
 *  scheduled drain tick. */
export const PRIORITY_EXPLICIT = 10;

export function initQueueSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS distill_jobs (
      id TEXT PRIMARY KEY,
      store_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_store_status ON distill_jobs(store_key, status);
  `);

  // Migration: add priority/origin to pre-existing distill_jobs tables.
  // Additive only — existing rows default to passive-sweep semantics, which
  // matches how every job was enqueued before this feature existed.
  const cols = (db.prepare("PRAGMA table_info(distill_jobs)").all() as any[]).map((r: any) => r.name);
  if (!cols.includes("priority")) {
    db.exec(`ALTER TABLE distill_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT ${PRIORITY_PASSIVE}`);
  }
  if (!cols.includes("origin")) {
    db.exec(`ALTER TABLE distill_jobs ADD COLUMN origin TEXT NOT NULL DEFAULT 'sweep'`);
  }

  // Recreated (not IF NOT EXISTS-guarded at the old name) so upgrades from a
  // pre-priority schema pick up the new sort key without a separate DROP.
  db.exec(`
    DROP INDEX IF EXISTS idx_jobs_pending;
    CREATE INDEX IF NOT EXISTS idx_jobs_pending ON distill_jobs(status, priority, next_attempt_at)
      WHERE status='pending';
  `);
}

export interface EnqueueOptions {
  priority?: number;
  origin?: JobOrigin;
}

/**
 * Enqueue a distillation job for a store. Coalesces: if a pending job
 * already exists for this store_key, returns the existing id rather than
 * creating a duplicate — EXCEPT if the incoming priority is higher than the
 * existing pending job's, in which case the existing row is upgraded in
 * place (priority + origin) so an explicit request jumps ahead of a passive
 * one already queued, without creating a second row for the same store.
 */
export function enqueue(db: Database.Database, storeKey: string, opts: EnqueueOptions = {}): string {
  const priority = opts.priority ?? PRIORITY_PASSIVE;
  const origin = opts.origin ?? "sweep";

  const existing = db.prepare(
    "SELECT id, priority FROM distill_jobs WHERE store_key=? AND status='pending' LIMIT 1"
  ).get(storeKey) as { id: string; priority: number } | undefined;
  if (existing) {
    if (priority > existing.priority) {
      db.prepare(
        "UPDATE distill_jobs SET priority=?,origin=?,updated_at=? WHERE id=?"
      ).run(priority, origin, new Date().toISOString(), existing.id);
    }
    return existing.id;
  }

  const id = `job-${storeKey}-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO distill_jobs(id,store_key,status,attempts,next_attempt_at,error,created_at,updated_at,priority,origin)
     VALUES(?,?,'pending',0,?,null,?,?,?,?)`
  ).run(id, storeKey, now, now, now, priority, origin);
  return id;
}

export interface ClaimOptions {
  /** Only claim a job whose priority is >= this floor. Used by the wake path
   *  (src/distill/worker.ts) to drain explicit-priority jobs without also
   *  picking up passive-sweep jobs that should wait for the next tick. */
  minPriority?: number;
}

/** Claim the next ready job, highest priority first (ties broken by
 *  next_attempt_at). Returns null if none are available (or none meet
 *  opts.minPriority). */
export function claimNext(db: Database.Database, opts: ClaimOptions = {}): DistillJob | null {
  const now = new Date().toISOString();
  const where = opts.minPriority !== undefined
    ? "status='pending' AND next_attempt_at<=? AND priority>=?"
    : "status='pending' AND next_attempt_at<=?";
  const args = opts.minPriority !== undefined ? [now, opts.minPriority] : [now];
  const job = db.prepare(
    `SELECT * FROM distill_jobs WHERE ${where}
     ORDER BY priority DESC, next_attempt_at ASC, rowid ASC LIMIT 1`
  ).get(...args) as DistillJob | undefined;
  if (!job) return null;
  db.prepare(
    "UPDATE distill_jobs SET status='running',attempts=attempts+1,updated_at=? WHERE id=?"
  ).run(now, job.id);
  return { ...job, status: "running", attempts: job.attempts + 1 };
}

export function completeJob(db: Database.Database, jobId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE distill_jobs SET status='done',updated_at=? WHERE id=?"
  ).run(now, jobId);
}

/** Mark a job as failed. If below MAX_ATTEMPTS, reschedule with exponential backoff.
 *  After MAX_ATTEMPTS, transition to 'dead'. */
export function failJob(db: Database.Database, jobId: string, error: string): void {
  const now = new Date().toISOString();
  const job = db.prepare("SELECT * FROM distill_jobs WHERE id=?").get(jobId) as DistillJob | undefined;
  if (!job) return;

  if (job.attempts >= MAX_ATTEMPTS) {
    db.prepare(
      "UPDATE distill_jobs SET status='dead',error=?,updated_at=? WHERE id=?"
    ).run(error, now, jobId);
    return;
  }

  const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, job.attempts - 1), MAX_BACKOFF_MS);
  const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
  db.prepare(
    "UPDATE distill_jobs SET status='pending',error=?,next_attempt_at=?,updated_at=? WHERE id=?"
  ).run(error, nextAttemptAt, now, jobId);
}

export function getJob(db: Database.Database, jobId: string): DistillJob | null {
  const row = db.prepare("SELECT * FROM distill_jobs WHERE id=?").get(jobId);
  return (row ?? null) as DistillJob | null;
}

/**
 * Canonical store key for a (tenant, pool) pair. Matches the format used by
 * falda_distill / POST /distill when enqueuing: "<tenant>:<pool>".
 * pool=undefined/"self" → "<tenant>:self".
 */
export function storeKeyFor(tenant: string, pool: string | undefined): string {
  return `${tenant}:${pool ?? "self"}`;
}

/**
 * Retrieve a job only if its store_key matches the caller's authorized
 * (tenant, pool). Returns null for both missing jobs AND unauthorized access,
 * so the caller cannot distinguish the two — no existence oracle.
 */
export function getJobAuthorized(
  db: Database.Database,
  jobId: string,
  callerStoreKey: string,
): DistillJob | null {
  const job = getJob(db, jobId);
  if (!job || job.store_key !== callerStoreKey) return null;
  return job;
}

export function listJobs(
  db: Database.Database,
  storeKey?: string,
  status?: JobStatus,
): DistillJob[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (storeKey) { where.push("store_key=?"); args.push(storeKey); }
  if (status)   { where.push("status=?"); args.push(status); }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  return db.prepare(
    `SELECT * FROM distill_jobs ${w} ORDER BY created_at DESC`
  ).all(...args) as DistillJob[];
}
