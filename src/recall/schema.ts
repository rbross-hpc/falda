/**
 * Recall trace SQLite schema. Lives in its own DB file (recall_traces.db,
 * see src/runtime.ts) — separate from both the per-store falda.db files and
 * distill_queue.db, so telemetry has its own retention/growth profile and
 * never competes with durable-memory schema migrations.
 */
import type Database from "better-sqlite3";

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

export function initRecallTraceSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recall_traces (
      recall_id TEXT PRIMARY KEY,
      store_key TEXT NOT NULL,
      tenant TEXT NOT NULL,
      pool TEXT,
      query TEXT NOT NULL,
      requested_budget INTEGER,
      used_budget INTEGER,
      policy_snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recall_traces_store ON recall_traces(store_key);
    CREATE INDEX IF NOT EXISTS idx_recall_traces_created ON recall_traces(created_at);

    CREATE TABLE IF NOT EXISTS recall_trace_items (
      recall_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      tier TEXT NOT NULL,
      item_id TEXT NOT NULL,
      source TEXT NOT NULL,
      score REAL,
      chars INTEGER,
      usage TEXT NOT NULL DEFAULT 'unknown' CHECK(usage IN ('unknown','used','unused')),
      PRIMARY KEY (recall_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_recall_trace_items_lookup ON recall_trace_items(recall_id, tier, item_id);
  `);

  // mode: "explicit" (a deliberate falda_recall/POST /recall call) vs "auto"
  // (an unattended per-task recall fired by a harness integration) — lets
  // recall metrics distinguish the two budget tiers (src/recall/budgets.ts).
  // Added after initial release; migrated in rather than a fresh column in
  // CREATE TABLE so existing recall_traces.db files upgrade in place.
  if (!hasColumn(db, "recall_traces", "mode")) {
    db.exec(`ALTER TABLE recall_traces ADD COLUMN mode TEXT NOT NULL DEFAULT 'explicit'`);
  }
}
