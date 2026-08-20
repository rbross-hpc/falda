/**
 * Per-store (falda.db) additive schema migrations and legacy-upgrade guards.
 *
 * Extracted from src/falda.ts (originally Falda.migrate/hasColumn/
 * tableExists/assertNoDuplicateTurnKeys) to separate migration plumbing
 * from tier-repository logic, without changing behavior. Falda still owns
 * the single init transaction and calls initSchema() -> migrate() ->
 * createIndexes() in that order — see
 * docs/future/reliability-hardening.md finding 6 for why that order matters.
 */
import type Database from "better-sqlite3";

/** Thrown when a legacy store cannot be safely upgraded because it already
 *  violates an invariant a new unique index would enforce (e.g. duplicate
 *  (session_id, turn_index) rows created before that constraint existed).
 *  See docs/future/reliability-hardening.md finding 6 — we fail loudly
 *  rather than silently deduplicating historical data. */
export class LegacyMigrationError extends Error {
  constructor(msg: string) { super(msg); this.name = "LegacyMigrationError"; }
}

export function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

export function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
  return !!row;
}

/** Additive migration: adds columns to pre-existing tables for stores that
 *  were created before Branch A. Safe to call multiple times (idempotent). */
export function migrate(db: Database.Database): void {
  const now = new Date().toISOString();

  // stream: add turn_index, turn_id if missing (dependent unique indexes
  // are created afterward by createIndexes(), once the columns exist).
  if (tableExists(db, "stream") && !hasColumn(db, "stream", "turn_index")) {
    db.exec("ALTER TABLE stream ADD COLUMN turn_index INTEGER");
  }
  if (tableExists(db, "stream") && !hasColumn(db, "stream", "turn_id")) {
    db.exec("ALTER TABLE stream ADD COLUMN turn_id TEXT");
  }
  // stream: add monotonic seq column for cross-session distillation ordering.
  // Backfill existing rows in rowid order (preserves original insertion order).
  if (tableExists(db, "stream") && !hasColumn(db, "stream", "seq")) {
    db.exec("ALTER TABLE stream ADD COLUMN seq INTEGER");
    db.exec(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY rowid) AS rn FROM stream
      )
      UPDATE stream SET seq = (SELECT rn FROM ranked WHERE ranked.id = stream.id)
    `);
  }

  // scenes: add render_hash column for embedding re-index gating (Branch 4).
  if (tableExists(db, "scenes") && !hasColumn(db, "scenes", "render_hash")) {
    db.exec("ALTER TABLE scenes ADD COLUMN render_hash TEXT");
  }

  // atoms: add new columns if missing, then backfill
  const atomCols: Array<[string, string]> = [
    ["priority", "INTEGER NOT NULL DEFAULT 100"],
    ["confidence", "TEXT NOT NULL DEFAULT 'medium'"],
    ["pinned", "INTEGER NOT NULL DEFAULT 0"],
    ["status", "TEXT NOT NULL DEFAULT 'active'"],
    ["tags", "TEXT NOT NULL DEFAULT '[]'"],
    ["supersedes", "TEXT"],
    ["source_turn_ids", "TEXT NOT NULL DEFAULT '[]'"],
    ["source_session_ids", "TEXT NOT NULL DEFAULT '[]'"],
  ];
  if (tableExists(db, "atoms")) {
    for (const [col, def] of atomCols) {
      if (!hasColumn(db, "atoms", col)) {
        db.exec(`ALTER TABLE atoms ADD COLUMN ${col} ${def}`);
      }
    }
    // Backfill existing rows that were inserted before the new columns existed.
    // Only rows that still have the old defaults need updating.
    db.exec(`
      UPDATE atoms SET
        priority = COALESCE(priority, 100),
        confidence = COALESCE(confidence, 'medium'),
        pinned = COALESCE(pinned, 0),
        status = COALESCE(status, 'active'),
        tags = COALESCE(tags, '[]'),
        source_turn_ids = COALESCE(source_turn_ids, '[]'),
        source_session_ids = COALESCE(source_session_ids, '[]'),
        updated_at = COALESCE(updated_at, '${now}')
      WHERE priority IS NULL OR status IS NULL
    `);
  }

  // consolidation_decisions: add candidate_* columns for stores created
  // before candidate persistence (falda distill inspect). Nullable —
  // pre-existing rows (especially historical skip decisions) cannot be
  // backfilled; the candidate they described is already unrecoverable.
  if (tableExists(db, "consolidation_decisions")) {
    for (const col of ["candidate_type", "candidate_content", "candidate_confidence"]) {
      if (!hasColumn(db, "consolidation_decisions", col)) {
        db.exec(`ALTER TABLE consolidation_decisions ADD COLUMN ${col} TEXT`);
      }
    }
  }

  // One-time repair for stores that ran deleteStream() before it cleaned up
  // stream_fts/stream_vec (docs/future/reliability-hardening.md finding 5):
  // remove any index rows whose id has no matching primary stream row.
  // Idempotent — a store where deleteStream always cleaned up properly has
  // nothing to remove here.
  if (tableExists(db, "stream") && tableExists(db, "stream_fts")) {
    db.exec("DELETE FROM stream_fts WHERE id NOT IN (SELECT id FROM stream)");
  }
  if (tableExists(db, "stream") && tableExists(db, "stream_vec")) {
    db.exec("DELETE FROM stream_vec WHERE id NOT IN (SELECT id FROM stream)");
  }
}

/** Guards the two UNIQUE indexes created in createIndexes() (src/store/
 *  schema.ts). A legacy store that predates those constraints could in
 *  principle already contain duplicate (session_id, turn_index) or
 *  (session_id, turn_id) rows; silently deduplicating would destroy data,
 *  so we fail loudly with a clear, actionable error instead
 *  (docs/future/reliability-hardening.md finding 6). */
export function assertNoDuplicateTurnKeys(db: Database.Database): void {
  if (!tableExists(db, "stream")) return;
  if (hasColumn(db, "stream", "turn_index")) {
    const dup = db.prepare(`
      SELECT session_id, turn_index, COUNT(*) AS n FROM stream
      WHERE turn_index IS NOT NULL
      GROUP BY session_id, turn_index HAVING n > 1 LIMIT 1
    `).get() as { session_id: string; turn_index: number; n: number } | undefined;
    if (dup) {
      throw new LegacyMigrationError(
        `Cannot upgrade store: duplicate stream rows for session_id=${dup.session_id} ` +
        `turn_index=${dup.turn_index} (${dup.n} rows) would violate the new unique ` +
        `idx_stream_turn_index constraint. Resolve the duplicates manually before reopening.`
      );
    }
  }
  if (hasColumn(db, "stream", "turn_id")) {
    const dup = db.prepare(`
      SELECT session_id, turn_id, COUNT(*) AS n FROM stream
      WHERE turn_id IS NOT NULL
      GROUP BY session_id, turn_id HAVING n > 1 LIMIT 1
    `).get() as { session_id: string; turn_id: string; n: number } | undefined;
    if (dup) {
      throw new LegacyMigrationError(
        `Cannot upgrade store: duplicate stream rows for session_id=${dup.session_id} ` +
        `turn_id=${dup.turn_id} (${dup.n} rows) would violate the new unique ` +
        `idx_stream_turn_id constraint. Resolve the duplicates manually before reopening.`
      );
    }
  }
}
