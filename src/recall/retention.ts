/**
 * Recall-trace retention. Telemetry can grow much faster than durable
 * memory (§16) — this deletes traces (and their items, via the same
 * transaction) older than a cutoff. Called on an interval piggybacking the
 * existing distillation worker tick (src/distill/worker.ts) rather than a
 * second timer.
 */
import type Database from "better-sqlite3";

export const DEFAULT_RETENTION_DAYS = 90;

/** 0 (or any non-positive value) means "retain indefinitely" — no pruning. */
export function resolveRetentionDays(envValue: string | undefined): number {
  if (envValue === undefined || envValue === "") return DEFAULT_RETENTION_DAYS;
  const n = Number(envValue);
  return Number.isFinite(n) ? n : DEFAULT_RETENTION_DAYS;
}

/** Delete traces (and their items) with created_at older than retentionDays.
 *  Returns the number of traces deleted. No-op if retentionDays <= 0. */
export function pruneRecallTraces(db: Database.Database, retentionDays: number): number {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
  const tx = db.transaction(() => {
    const ids = db.prepare("SELECT recall_id FROM recall_traces WHERE created_at < ?").all(cutoff) as Array<{ recall_id: string }>;
    if (!ids.length) return 0;
    const delItems = db.prepare("DELETE FROM recall_trace_items WHERE recall_id=?");
    const delTrace = db.prepare("DELETE FROM recall_traces WHERE recall_id=?");
    for (const { recall_id } of ids) { delItems.run(recall_id); delTrace.run(recall_id); }
    return ids.length;
  });
  return tx() as number;
}
