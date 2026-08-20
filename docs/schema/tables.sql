-- FALDA persisted schema — authoritative DDL reference.
--
-- This file is a human-readable mirror of the DDL FALDA actually creates at
-- runtime, across all three SQLite databases (docs/MODEL.md §14.1). It is
-- NOT executed by the application — the code in src/falda.ts,
-- src/distill/queue.ts, src/distill/watermark.ts, and src/recall/schema.ts
-- remains the single source of truth for what gets created.
--
-- It exists to be diffable and readable in one place, and is checked
-- against the live runtime schema (table + column set, not exact SQL text —
-- see the note at the bottom) by test/schema_doc_sync.test.ts. If you add,
-- rename, or remove a column in one of those source files, update this file
-- in the same change or the test will fail.
--
-- See docs/MODEL.md §14 for what each table means and docs/schema/ERD.md
-- for a diagram of how the domain tables (as opposed to pure-audit/
-- operational tables) relate to each other.

-- ============================================================================
-- DB 1 of 3: falda.db — one per (tenant, self) store or named pool (§2)
-- Created by: src/store/schema.ts (initSchema/createIndexes), src/store/migrations.ts
-- (migrate), invoked from Falda's constructor (src/falda.ts)
-- ============================================================================

-- T0 — Stream (docs/MODEL.md §4)
CREATE TABLE IF NOT EXISTS stream (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  ts TEXT NOT NULL,
  turn_index INTEGER,          -- per-session order (nullable, caller-supplied)
  turn_id TEXT,                -- per-session idempotency token (nullable, caller-supplied)
  seq INTEGER                  -- store-global order; nullable in DDL (SQLite can't add NOT NULL via
                                -- ALTER without a table rebuild), but backfilled non-null for every
                                -- row written by current code (fresh inserts and the seq-migration
                                -- backfill both always assign a value)
);
CREATE INDEX IF NOT EXISTS idx_stream_seq ON stream(seq);
CREATE INDEX IF NOT EXISTS idx_stream_session ON stream(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_turn_index
  ON stream(session_id, turn_index) WHERE turn_index IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_turn_id
  ON stream(session_id, turn_id) WHERE turn_id IS NOT NULL;
CREATE VIRTUAL TABLE IF NOT EXISTS stream_fts
  USING fts5(content, id UNINDEXED, tokenize='porter unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS stream_vec
  USING vec0(id TEXT PRIMARY KEY, embedding float[DIM]);  -- DIM = embedder dimension, fixed per store

-- T1 — Atoms (docs/MODEL.md §3)
CREATE TABLE IF NOT EXISTS atoms (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('fact','pattern','preference','constraint','instruction')),
  content TEXT NOT NULL,                     -- immutable once written (§3.3)
  background TEXT,                           -- free text only, never a structured-data sink (§3.5)
  priority INTEGER NOT NULL DEFAULT 100,     -- re-rank boost, 0-100, lower = higher boost (§3.2)
  confidence TEXT NOT NULL DEFAULT 'medium' CHECK(confidence IN ('high','medium','low')),
  pinned INTEGER NOT NULL DEFAULT 0,         -- boolean; pinned-first recall (§7.5)
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','merged','archived')),
  tags TEXT NOT NULL DEFAULT '[]',           -- JSON array, filter-only
  supersedes TEXT,                           -- id of the atom this one replaces, if any
  source_turn_ids TEXT NOT NULL DEFAULT '[]',     -- denormalized provenance summary (§5)
  source_session_ids TEXT NOT NULL DEFAULT '[]',  -- denormalized provenance summary (§5)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_atoms_status ON atoms(status);
CREATE INDEX IF NOT EXISTS idx_atoms_type ON atoms(type);
CREATE INDEX IF NOT EXISTS idx_atoms_pinned ON atoms(pinned) WHERE pinned=1;
CREATE VIRTUAL TABLE IF NOT EXISTS atoms_fts
  USING fts5(content, id UNINDEXED, tokenize='porter unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS atoms_vec
  USING vec0(id TEXT PRIMARY KEY, embedding float[DIM]);

-- Provenance: atom -> evidence edge (docs/MODEL.md §5)
CREATE TABLE IF NOT EXISTS atom_evidence (
  atom_id TEXT NOT NULL REFERENCES atoms(id),
  stream_id TEXT NOT NULL REFERENCES stream(id),  -- always references stream.id, never turn_id (§5.1)
  added_at TEXT NOT NULL,
  PRIMARY KEY (atom_id, stream_id)
);
CREATE INDEX IF NOT EXISTS idx_evidence_stream ON atom_evidence(stream_id);

-- Audit: why a distillation decision was made (docs/MODEL.md §5.5, §8.2)
CREATE TABLE IF NOT EXISTS consolidation_decisions (
  id TEXT PRIMARY KEY,
  pass_id TEXT NOT NULL,
  action TEXT NOT NULL,           -- 'store' | 'update' | 'merge' | 'skip'
  atom_id TEXT,                   -- the resulting/affected atom id, if any
  target_ids TEXT,                -- JSON array of merge/update targets, if any
  rationale TEXT,
  decided_at TEXT NOT NULL,
  candidate_type TEXT,            -- the proposed candidate, preserved even for 'skip' (§5.5)
  candidate_content TEXT,
  candidate_confidence TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_pass ON consolidation_decisions(pass_id);

-- Audit: one row per distillation pass (docs/MODEL.md §5.5, §8.5)
CREATE TABLE IF NOT EXISTS distillation_passes (
  pass_id TEXT PRIMARY KEY,       -- deterministic, derived from (store_key, watermark_start, watermark_end)
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
CREATE INDEX IF NOT EXISTS idx_passes_store ON distillation_passes(store_key);
CREATE INDEX IF NOT EXISTS idx_passes_started ON distillation_passes(started_at);

-- Audit: per-pass, per-scene L2 effect (docs/MODEL.md §5.5, §8.3)
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
CREATE INDEX IF NOT EXISTS idx_pass_scene_effects_pass ON pass_scene_effects(pass_id);

-- Audit: per-pass L3 effect (docs/MODEL.md §5.5, §8.4)
CREATE TABLE IF NOT EXISTS pass_core_effects (
  pass_id TEXT PRIMARY KEY,
  effect TEXT NOT NULL CHECK(effect IN ('unchanged','regenerated','deleted','failed')),
  old_input_hash TEXT,
  new_input_hash TEXT,
  old_chars INTEGER,
  new_chars INTEGER
);

-- T2 — Scenes (docs/MODEL.md §6)
CREATE TABLE IF NOT EXISTS scenes (
  scene_id TEXT PRIMARY KEY,
  scene_kind TEXT NOT NULL CHECK(scene_kind IN ('episode','topic')),
  title TEXT NOT NULL,                  -- never null; mechanical at creation, optionally LLM-replaced (§6.1)
  atom_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array; the primary artifact (§6.1)
  summary TEXT,                         -- secondary, optional, hash-gated on content_hash (§6.4)
  content_hash TEXT,                    -- gates title/summary regeneration (§6.4)
  render_hash TEXT,                     -- gates embedding regeneration only (§6.4) — distinct from content_hash
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
  derived_from TEXT,                    -- prior scene_id(s) across a split/reorg (§6.3)
  superseded_by TEXT,                   -- successor scene_id across a merge (§6.3)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scenes_kind ON scenes(scene_kind);
CREATE INDEX IF NOT EXISTS idx_scenes_status ON scenes(status);
CREATE VIRTUAL TABLE IF NOT EXISTS scenes_fts
  USING fts5(title, summary, scene_id UNINDEXED, tokenize='porter unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS scenes_vec
  USING vec0(scene_id TEXT PRIMARY KEY, embedding float[DIM]);

-- scene <-> atom membership edge (docs/MODEL.md §6.1)
CREATE TABLE IF NOT EXISTS scene_atoms (
  scene_id TEXT NOT NULL REFERENCES scenes(scene_id),
  atom_id TEXT NOT NULL REFERENCES atoms(id),
  PRIMARY KEY (scene_id, atom_id)
);
CREATE INDEX IF NOT EXISTS idx_scene_atoms_atom ON scene_atoms(atom_id);

-- Operational: this store's distillation cursor (docs/MODEL.md §8.5, §8.8)
-- Created by: src/distill/watermark.ts (initWatermarkSchema)
CREATE TABLE IF NOT EXISTS distill_watermark (
  store_key TEXT PRIMARY KEY,
  last_processed_id TEXT,
  last_processed_ts TEXT,
  last_processed_seq INTEGER,   -- the field the sweep gate (§8.8) actually compares against stream.seq
  updated_at TEXT NOT NULL
);

-- Operational: last L3 input hash, for correct hash-gating (docs/MODEL.md §8.4)
-- Created by: src/distill/watermark.ts (initCoreStateSchema)
CREATE TABLE IF NOT EXISTS core_state (
  store_key TEXT PRIMARY KEY,
  input_hash TEXT NOT NULL,
  generated_at TEXT NOT NULL
);

-- ============================================================================
-- DB 2 of 3: distill_queue.db — one per root, shared across every store (§14.3)
-- Created by: src/distill/queue.ts (initQueueSchema)
-- ============================================================================

CREATE TABLE IF NOT EXISTS distill_jobs (
  id TEXT PRIMARY KEY,
  store_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',       -- 'pending' | 'running' | 'done' | 'dead'
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,          -- PRIORITY_PASSIVE (0) | PRIORITY_EXPLICIT (10) (migrated in, additive)
  origin TEXT NOT NULL DEFAULT 'sweep',         -- 'sweep' | 'http' | 'mcp' (migrated in, additive)
  lease_until TEXT,                             -- claim lease expiry; NULL if never claimed or claim released (migrated in, additive)
  worker_id TEXT                                -- opaque id of the worker holding the current claim, observability only (migrated in, additive)
);
CREATE INDEX IF NOT EXISTS idx_jobs_store_status ON distill_jobs(store_key, status);
CREATE INDEX IF NOT EXISTS idx_jobs_pending ON distill_jobs(status, priority, next_attempt_at)
  WHERE status='pending';

-- ============================================================================
-- DB 3 of 3: recall_traces.db — one per root, shared across every store (§14.4)
-- Created by: src/recall/schema.ts (initRecallTraceSchema)
-- ============================================================================

CREATE TABLE IF NOT EXISTS recall_traces (
  recall_id TEXT PRIMARY KEY,
  store_key TEXT NOT NULL,
  tenant TEXT NOT NULL,
  pool TEXT,
  query TEXT NOT NULL,
  requested_budget INTEGER,
  used_budget INTEGER,
  policy_snapshot TEXT NOT NULL,    -- JSON: recall weights + tier budgets in effect for this call
  created_at TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'explicit'  -- 'explicit' | 'auto' (migrated in, additive)
);
CREATE INDEX IF NOT EXISTS idx_recall_traces_store ON recall_traces(store_key);
CREATE INDEX IF NOT EXISTS idx_recall_traces_created ON recall_traces(created_at);

CREATE TABLE IF NOT EXISTS recall_trace_items (
  recall_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  tier TEXT NOT NULL,               -- 'atom' | 'scene' | 'core' | ...
  item_id TEXT NOT NULL,
  source TEXT NOT NULL,             -- e.g. 'pinned' | 'ranked' | 'core-excerpt'
  score REAL,
  chars INTEGER,
  usage TEXT NOT NULL DEFAULT 'unknown' CHECK(usage IN ('unknown','used','unused')),
  PRIMARY KEY (recall_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_recall_trace_items_lookup ON recall_trace_items(recall_id, tier, item_id);

-- ============================================================================
-- Note on the drift guard (test/schema_doc_sync.test.ts)
-- ============================================================================
-- The test compares TABLE + COLUMN NAME sets between this file and the live
-- runtime schema (via PRAGMA table_info), not exact SQL text. Exact-text
-- comparison would be brittle against harmless differences (CHECK constraint
-- formatting, IF NOT EXISTS, the DIM placeholder above vs. a real integer,
-- ALTER-TABLE-appended columns landing at the end of PRAGMA table_info
-- instead of inline where they're documented above). What the test actually
-- guards against is the failure mode that motivated this file: a column
-- silently added to (or removed from) the runtime schema with nothing
-- written down about it anywhere.
