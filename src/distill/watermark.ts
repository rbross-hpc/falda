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
