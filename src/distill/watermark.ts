/**
 * Per-store watermark table and deterministic pass-id derivation.
 * The watermark tracks which stream turns have been processed by L1 extraction.
 * All operations are synchronous (better-sqlite3).
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";

export interface Watermark {
  store_key: string;
  last_processed_id: string | null;
  last_processed_ts: string | null;
  last_processed_seq: number | null;
  updated_at: string;
}

export function initWatermarkSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS distill_watermark (
      store_key TEXT PRIMARY KEY,
      last_processed_id TEXT,
      last_processed_ts TEXT,
      last_processed_seq INTEGER,
      updated_at TEXT NOT NULL
    )
  `);
  // Migration: add last_processed_seq to pre-existing watermark tables.
  const cols = (db.prepare("PRAGMA table_info(distill_watermark)").all() as any[]).map((r: any) => r.name);
  if (!cols.includes("last_processed_seq")) {
    db.exec("ALTER TABLE distill_watermark ADD COLUMN last_processed_seq INTEGER");
  }
}

export function getWatermark(db: Database.Database, storeKey: string): Watermark | null {
  const row = db.prepare("SELECT * FROM distill_watermark WHERE store_key=?").get(storeKey);
  return (row ?? null) as Watermark | null;
}

export function setWatermark(
  db: Database.Database,
  storeKey: string,
  lastProcessedId: string | null,
  lastProcessedTs: string | null,
  lastProcessedSeq: number | null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO distill_watermark(store_key,last_processed_id,last_processed_ts,last_processed_seq,updated_at)
     VALUES(?,?,?,?,?)
     ON CONFLICT(store_key) DO UPDATE SET
       last_processed_id=excluded.last_processed_id,
       last_processed_ts=excluded.last_processed_ts,
       last_processed_seq=excluded.last_processed_seq,
       updated_at=excluded.updated_at`
  ).run(storeKey, lastProcessedId, lastProcessedTs, lastProcessedSeq, now);
}

/** Deterministic pass id from (storeKey, seqStart, seqEnd).
 *  Re-running the same window always produces the same pass id. */
export function passId(storeKey: string, seqStart: number | null, seqEnd: number | string): string {
  const input = `${storeKey}|${seqStart ?? ""}|${seqEnd}`;
  return "pass-" + createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// ─── Core state: persist L3 input hash for correct hash-gating ────────────────

/**
 * Initialize the core_state table (idempotent).
 * Persists the last input hash used to synthesize core, keyed by store_key.
 * Without this, distillOnce would compare the input hash (computeCoreHash)
 * against the output hash (sha256(readCore())) which can never match.
 */
export function initCoreStateSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS core_state (
      store_key TEXT PRIMARY KEY,
      input_hash TEXT NOT NULL,
      generated_at TEXT NOT NULL
    )
  `);
}

export interface CoreState {
  store_key: string;
  input_hash: string;
  generated_at: string;
}

export function getCoreState(db: Database.Database, storeKey: string): CoreState | null {
  const row = db.prepare("SELECT * FROM core_state WHERE store_key=?").get(storeKey);
  return (row ?? null) as CoreState | null;
}

export function setCoreState(db: Database.Database, storeKey: string, inputHash: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_state(store_key,input_hash,generated_at) VALUES(?,?,?)
     ON CONFLICT(store_key) DO UPDATE SET input_hash=excluded.input_hash, generated_at=excluded.generated_at`
  ).run(storeKey, inputHash, now);
}

export function clearCoreState(db: Database.Database, storeKey: string): void {
  db.prepare("DELETE FROM core_state WHERE store_key=?").run(storeKey);
}

// ─── Store dirty flag: L2/L3 reconciliation needed independent of L1 ──────────
//
// (docs/future/reliability-hardening.md finding 2, docs/MODEL.md §8.5/§8.7)
// L1's watermark only tracks "have all T0 turns been extracted/consolidated".
// It says nothing about whether T2/T3 are still an accurate function of the
// CURRENT active atom/scene set — an out-of-band lifecycle change
// (supersede/archive/merge/hard-delete/evidence-affecting stream deletion)
// or a previous pass's L2/L3 failure can leave scenes/core stale with no new
// stream turn ever arriving to trigger a fresh pass. This table is a second,
// independent cursor: its mere presence for a store_key means "L2/L3 must
// run on the next pass even if L1 has nothing new to extract." It is cleared
// only once a pass's L2/L3 phase completes with zero failures (see
// src/distill/core.ts). Like distill_watermark/core_state, this is
// operational state, not domain knowledge (docs/MODEL.md §14.2) — losing it
// only costs an extra reconciliation pass, never data.

export function initDirtySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_dirty (
      store_key TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      marked_at TEXT NOT NULL
    )
  `);
}

/** Mark a store as needing L2/L3 reconciliation on its next pass, even if
 *  L1 has no new turns. Idempotent — repeated calls just refresh the reason
 *  and timestamp. `reason` is informational only (falda distill
 *  inspect/debugging), never read for control flow. */
export function markDirty(db: Database.Database, storeKey: string, reason: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO store_dirty(store_key,reason,marked_at) VALUES(?,?,?)
     ON CONFLICT(store_key) DO UPDATE SET reason=excluded.reason, marked_at=excluded.marked_at`
  ).run(storeKey, reason, now);
}

export function isDirty(db: Database.Database, storeKey: string): boolean {
  return !!db.prepare("SELECT 1 FROM store_dirty WHERE store_key=?").get(storeKey);
}

/** Clear the dirty flag. Only call this once L2/L3 reconciliation has
 *  actually completed with no failures for this pass — see
 *  src/distill/core.ts's L2/L3 failure-counting logic. */
export function clearDirty(db: Database.Database, storeKey: string): void {
  db.prepare("DELETE FROM store_dirty WHERE store_key=?").run(storeKey);
}
