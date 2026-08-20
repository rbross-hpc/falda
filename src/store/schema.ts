/**
 * Per-store (falda.db) base schema — tables and virtual tables only, no
 * ordinary indexes.
 *
 * Extracted from src/falda.ts (originally Falda.initSchema/createIndexes)
 * to separate schema/migration plumbing from tier-repository logic, without
 * changing behavior. Falda still owns the single init transaction and calls
 * initSchema() -> migrate() -> createIndexes() in that order — see
 * docs/future/reliability-hardening.md finding 6 for why that order matters.
 */
import type Database from "better-sqlite3";
import { assertNoDuplicateTurnKeys } from "./migrations.js";

/** Creates base tables and virtual tables only — no indexes. Indexes are
 *  created later by createIndexes(), after migrate() has added any missing
 *  columns, so that opening a genuinely old store never tries to index a
 *  column that doesn't exist yet
 *  (docs/future/reliability-hardening.md finding 6). */
export function initSchema(db: Database.Database, dim: number): void {
  const d = dim;
  db.exec(`
    CREATE TABLE IF NOT EXISTS stream (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts TEXT NOT NULL,
      turn_index INTEGER,
      turn_id TEXT,
      seq INTEGER
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS stream_fts
      USING fts5(content, id UNINDEXED, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS stream_vec
      USING vec0(id TEXT PRIMARY KEY, embedding float[${d}]);

    CREATE TABLE IF NOT EXISTS atoms (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('fact','pattern','preference','constraint','instruction')),
      content TEXT NOT NULL,
      background TEXT,
      priority INTEGER NOT NULL DEFAULT 100,
      confidence TEXT NOT NULL DEFAULT 'medium' CHECK(confidence IN ('high','medium','low')),
      pinned INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','merged','archived')),
      tags TEXT NOT NULL DEFAULT '[]',
      supersedes TEXT,
      source_turn_ids TEXT NOT NULL DEFAULT '[]',
      source_session_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS atoms_fts
      USING fts5(content, id UNINDEXED, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS atoms_vec
      USING vec0(id TEXT PRIMARY KEY, embedding float[${d}]);

    CREATE TABLE IF NOT EXISTS atom_evidence (
      atom_id TEXT NOT NULL REFERENCES atoms(id),
      stream_id TEXT NOT NULL REFERENCES stream(id),
      added_at TEXT NOT NULL,
      PRIMARY KEY (atom_id, stream_id)
    );

    CREATE TABLE IF NOT EXISTS consolidation_decisions (
      id TEXT PRIMARY KEY,
      pass_id TEXT NOT NULL,
      action TEXT NOT NULL,
      atom_id TEXT,
      target_ids TEXT,
      rationale TEXT,
      decided_at TEXT NOT NULL,
      candidate_type TEXT,
      candidate_content TEXT,
      candidate_confidence TEXT
    );

    CREATE TABLE IF NOT EXISTS distillation_passes (
      pass_id TEXT PRIMARY KEY,
      store_key TEXT NOT NULL,
      watermark_start INTEGER,
      watermark_end INTEGER,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed')),
      input_turn_count INTEGER,
      candidate_count INTEGER,
      error TEXT,
      model TEXT,
      prompt_version TEXT,
      distiller_version TEXT
    );

    CREATE TABLE IF NOT EXISTS pass_scene_effects (
      pass_id TEXT NOT NULL,
      scene_id TEXT NOT NULL,
      scene_kind TEXT NOT NULL,
      title TEXT,
      effect TEXT NOT NULL CHECK(effect IN ('created','updated','retired','unchanged')),
      members_before INTEGER NOT NULL DEFAULT 0,
      members_after INTEGER NOT NULL DEFAULT 0,
      added_json TEXT NOT NULL DEFAULT '[]',
      removed_json TEXT NOT NULL DEFAULT '[]',
      summary_regenerated INTEGER NOT NULL DEFAULT 0,
      embedding_regenerated INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (pass_id, scene_id)
    );

    CREATE TABLE IF NOT EXISTS pass_core_effects (
      pass_id TEXT PRIMARY KEY,
      effect TEXT NOT NULL CHECK(effect IN ('unchanged','regenerated','deleted','failed')),
      old_input_hash TEXT,
      new_input_hash TEXT,
      old_chars INTEGER,
      new_chars INTEGER
    );

    CREATE TABLE IF NOT EXISTS scenes (
      scene_id TEXT PRIMARY KEY,
      scene_kind TEXT NOT NULL CHECK(scene_kind IN ('episode','topic')),
      title TEXT NOT NULL,
      atom_ids TEXT NOT NULL DEFAULT '[]',
      summary TEXT,
      content_hash TEXT,
      render_hash TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
      derived_from TEXT,
      superseded_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS scenes_fts
      USING fts5(title, summary, scene_id UNINDEXED, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS scenes_vec
      USING vec0(scene_id TEXT PRIMARY KEY, embedding float[${d}]);

    CREATE TABLE IF NOT EXISTS scene_atoms (
      scene_id TEXT NOT NULL REFERENCES scenes(scene_id),
      atom_id TEXT NOT NULL REFERENCES atoms(id),
      PRIMARY KEY (scene_id, atom_id)
    );
  `);
}

/** Creates every ordinary (non-virtual) index. Runs after migrate() so
 *  every column an index depends on is guaranteed to already exist —
 *  including on a store that started out as a genuinely old schema
 *  (docs/future/reliability-hardening.md finding 6). All ordinary indexes
 *  live here, not just the ones currently known to depend on a migrated
 *  column, so a future migration that adds a new indexed column can't
 *  reintroduce this bug by mistake. Idempotent (IF NOT EXISTS). */
export function createIndexes(db: Database.Database): void {
  assertNoDuplicateTurnKeys(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_stream_seq ON stream(seq);
    CREATE INDEX IF NOT EXISTS idx_stream_session ON stream(session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_turn_index
      ON stream(session_id, turn_index) WHERE turn_index IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_turn_id
      ON stream(session_id, turn_id) WHERE turn_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_atoms_status ON atoms(status);
    CREATE INDEX IF NOT EXISTS idx_atoms_type ON atoms(type);
    CREATE INDEX IF NOT EXISTS idx_atoms_pinned ON atoms(pinned) WHERE pinned=1;

    CREATE INDEX IF NOT EXISTS idx_evidence_stream ON atom_evidence(stream_id);

    CREATE INDEX IF NOT EXISTS idx_decisions_pass ON consolidation_decisions(pass_id);

    CREATE INDEX IF NOT EXISTS idx_passes_store ON distillation_passes(store_key);
    CREATE INDEX IF NOT EXISTS idx_passes_started ON distillation_passes(started_at);

    CREATE INDEX IF NOT EXISTS idx_pass_scene_effects_pass ON pass_scene_effects(pass_id);

    CREATE INDEX IF NOT EXISTS idx_scenes_kind ON scenes(scene_kind);
    CREATE INDEX IF NOT EXISTS idx_scenes_status ON scenes(status);

    CREATE INDEX IF NOT EXISTS idx_scene_atoms_atom ON scene_atoms(atom_id);
  `);
}
