/**
 * FALDA core store — clustered hierarchical memory for scientific agents.
 *
 * Four tiers, layered like atmospheric strata:
 *   T0  Stream    — raw conversation / observation log
 *   T1  Atoms     — distilled atomic memories (facts, patterns, preferences, constraints, instructions)
 *   T2  Scenes    — id-addressed organizational units (episodes, topics), populated by distillation
 *   T3  Core      — long-lived persona / project core
 *
 * Storage is fully local and open:
 *   - SQLite + sqlite-vec   dense vector recall (cosine)
 *   - SQLite FTS5           BM25 lexical recall
 *   - local filesystem      core (T3) blob; scenes markdown mirror (best-effort)
 *
 * Recall fuses dense + lexical via reciprocal-rank fusion with a parameterized
 * blended re-rank (recency, priority, confidence). Status filtering, character
 * budgets, and pinned-first recall are all enforced here.
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveLegacyAtomBudget } from "./recall/budgets.js";
import { initDirtySchema, markDirty } from "./distill/watermark.js";

export type Embedder = (text: string) => Promise<number[]>;

// ─── Public types ──────────────────────────────────────────────────────────────

export type AtomType = "fact" | "pattern" | "preference" | "constraint" | "instruction";
export type AtomStatus = "active" | "superseded" | "merged" | "archived";
export type AtomConfidence = "high" | "medium" | "low";
export type SceneKind = "episode" | "topic";
export type SceneStatus = "active" | "retired";

export const VALID_ATOM_TYPES: AtomType[] = ["fact", "pattern", "preference", "constraint", "instruction"];
export const VALID_CONFIDENCE: AtomConfidence[] = ["high", "medium", "low"];

export interface FaldaOptions {
  dbPath: string;
  blobDir: string;
  embed: Embedder;
  dim?: number;
  recallWeights?: Partial<RecallWeights>;
  /** The distillation store key this instance corresponds to (e.g.
   *  "<tenant>:self" or "<tenant>:<pool>", matching
   *  src/distill/queue.ts's storeKeyFor()). Used only to mark this store
   *  dirty (docs/future/reliability-hardening.md finding 2) when a
   *  lifecycle mutation happens outside distillOnce() — see
   *  markStoreDirty(). Defaults to "default" when omitted, matching
   *  distillOnce()'s own default storeKey, so existing callers/tests that
   *  never set this still behave identically to before this option
   *  existed (dirty-marking still works, just under a shared generic key
   *  rather than a per-tenant one — harmless for tests that don't check
   *  it, but production callers should supply the real key). */
  storeKey?: string;
}

export interface RecallWeights {
  wRecency: number;
  wPriority: number;
  wConfidence: number;
  recencyHalfLifeDays: number;
}

const DEFAULT_WEIGHTS: RecallWeights = {
  wRecency: 0.10,
  wPriority: 0.15,
  wConfidence: 0.05,
  recencyHalfLifeDays: 30,
};

const PER_HIT_CHAR_LIMIT = 2000;
// recallAtoms() below is a legacy T1-only recall path, superseded by
// assembleContext() (src/distill/context.ts) for both falda_recall and
// POST /recall (see src/recall/budgets.ts for that path's env-driven
// budgets). recallAtoms() is exercised only by tests today — kept for
// that coverage, not on the live recall surface. FALDA_LEGACY_ATOM_BUDGET
// lets it be tuned without a rebuild; default lowered from its old
// hardcoded 12000 to align with the new explicit-recall default (6000)
// rather than carry forward an oversized, unreviewed ceiling.
const TOTAL_CHAR_BUDGET = resolveLegacyAtomBudget();
const PINNED_BUDGET_FRACTION = 0.25;
const RRF_K = 60;

export interface StreamItem {
  id?: string;
  role: string;
  content: string;
  timestamp?: string;
  turn_index?: number | null;
  turn_id?: string | null;
}

export interface StreamHit {
  id: string; session_id: string; role: string; content: string; timestamp: string;
  turn_index: number | null; turn_id: string | null; score: number;
}

export interface StreamTurn {
  id: string; session_id: string; role: string; content: string;
  timestamp: string; turn_index: number | null; turn_id: string | null; seq: number;
}

export interface Atom {
  id: string;
  type: AtomType;
  content: string;
  background: string | null;
  priority: number;
  confidence: AtomConfidence;
  pinned: boolean;
  status: AtomStatus;
  tags: string[];
  supersedes: string | null;
  source_turn_ids: string[];
  source_session_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface AtomHit extends Atom { score: number; }

export interface Scene {
  scene_id: string;
  scene_kind: SceneKind;
  title: string;
  atom_ids: string[];
  summary: string | null;
  content_hash: string | null;
  render_hash: string | null;
  status: SceneStatus;
  derived_from: string[] | null;
  superseded_by: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface SceneHit extends Scene { score: number; }

/** @deprecated path-addressed API removed in Branch A. Use id-addressed scene methods. */
export interface SceneEntry { path: string; created_at: string; updated_at: string; }

export interface AddStreamResult {
  ids: string[];
  affected_atom_ids?: string[];
}

export interface EvidenceEdge {
  atom_id: string;
  stream_id: string;
  added_at: string;
}

export class StreamConflictError extends Error {
  constructor(
    public readonly kind: "index_conflict" | "turn_id_conflict",
    msg: string,
  ) {
    super(msg);
    this.name = "StreamConflictError";
  }
}

export class AtomImmutabilityError extends Error {
  constructor(msg: string) { super(msg); this.name = "AtomImmutabilityError"; }
}

export class AtomTypeError extends Error {
  constructor(msg: string) { super(msg); this.name = "AtomTypeError"; }
}

/** Thrown when a legacy store cannot be safely upgraded because it already
 *  violates an invariant a new unique index would enforce (e.g. duplicate
 *  (session_id, turn_index) rows created before that constraint existed).
 *  See docs/future/reliability-hardening.md finding 6 — we fail loudly
 *  rather than silently deduplicating historical data. */
export class LegacyMigrationError extends Error {
  constructor(msg: string) { super(msg); this.name = "LegacyMigrationError"; }
}

// ─── FTS sanitizer ─────────────────────────────────────────────────────────────

function toFtsQuery(raw: string): string {
  const tokens = (raw || "")
    .split(/[^0-9A-Za-z\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF]+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  return tokens.length ? tokens.join(" ") : '"__falda_no_match__"';
}

// ─── Recall scoring helpers ────────────────────────────────────────────────────

function recencyDecay(createdAt: string, halfLifeDays: number): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / 86400000;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

function priorityWeight(priority: number): number {
  return priority <= 0 ? 1.0 : Math.max(0, Math.min(1, 1 - priority / 100));
}

function confidenceWeight(confidence: AtomConfidence): number {
  return confidence === "high" ? 1.0 : confidence === "medium" ? 0.6 : 0.3;
}

function truncate(s: string): string {
  return s.length <= PER_HIT_CHAR_LIMIT ? s : s.slice(0, PER_HIT_CHAR_LIMIT - 3) + "...";
}

// ─── Row-to-type helpers ───────────────────────────────────────────────────────

function rowToAtom(row: any): Atom {
  return {
    id: row.id,
    type: row.type as AtomType,
    content: row.content,
    background: row.background ?? null,
    priority: row.priority ?? 100,
    confidence: (row.confidence ?? "medium") as AtomConfidence,
    pinned: !!(row.pinned ?? 0),
    status: (row.status ?? "active") as AtomStatus,
    tags: row.tags ? JSON.parse(row.tags) : [],
    supersedes: row.supersedes ?? null,
    source_turn_ids: row.source_turn_ids ? JSON.parse(row.source_turn_ids) : [],
    source_session_ids: row.source_session_ids ? JSON.parse(row.source_session_ids) : [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToScene(row: any): Scene {
  return {
    scene_id: row.scene_id,
    scene_kind: row.scene_kind as SceneKind,
    title: row.title,
    atom_ids: row.atom_ids ? JSON.parse(row.atom_ids) : [],
    summary: row.summary ?? null,
    content_hash: row.content_hash ?? null,
    render_hash: row.render_hash ?? null,
    status: (row.status ?? "active") as SceneStatus,
    derived_from: row.derived_from ? JSON.parse(row.derived_from) : null,
    superseded_by: row.superseded_by ? JSON.parse(row.superseded_by) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Stable render hash for embedding re-index gating.
 *  hash(title + "\n" + (summary ?? ""))
 *  Changes only when the text that gets embedded changes — title or summary.
 *  Distinct from content_hash (membership-based) to avoid re-embedding on
 *  every structural reconciliation where title/summary did not change. */
function computeRenderHash(title: string, summary: string | null): string {
  return createHash("sha256").update(`${title}\n${summary ?? ""}`).digest("hex");
}

// ─── Internal atom-write types (shared by upsertAtom() and the distiller) ──────
//
// Both the public HTTP/MCP atom-write path and distillation L1 (src/distill/
// core.ts) need to insert/repair an atom row plus its atoms_fts/atoms_vec
// index rows. They differ only in what happens when the id already exists:
// public upsert updates mutable metadata, while distillation replay must
// preserve existing metadata/status and only repair indexes (see
// docs/future/reliability-hardening.md finding 1). ExistingAtomPolicy makes
// that difference explicit at the call site rather than inferred.

type ExistingAtomPolicy = "update" | "preserve";

interface NormalizedAtomWrite {
  id: string;
  type: AtomType;
  content: string;
  background: string | null;
  priority: number;
  confidence: AtomConfidence;
  pinned: boolean;
  tags: string;
}

interface AtomWriteResult {
  atom: Atom;
  inserted: boolean;
}

// ─── Main store class ──────────────────────────────────────────────────────────

export class Falda {
  private db: Database.Database;
  private embed: Embedder;
  private blobDir: string;
  private dim: number;
  private weights: RecallWeights;
  private storeKey: string;

  constructor(opts: FaldaOptions) {
    this.embed = opts.embed;
    this.blobDir = opts.blobDir;
    this.dim = opts.dim ?? 768;
    this.weights = { ...DEFAULT_WEIGHTS, ...opts.recallWeights };
    this.storeKey = opts.storeKey ?? "default";
    fs.mkdirSync(this.blobDir, { recursive: true });
    this.db = new Database(opts.dbPath);
    sqliteVec.load(this.db);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    // Phased, atomic setup (docs/future/reliability-hardening.md finding 6):
    // base tables/virtual tables -> additive column migration -> indexes.
    // Indexes are created last so that opening a genuinely old store never
    // tries to CREATE INDEX on a column migrate() hasn't added yet. Wrapped
    // in one transaction so a failure partway through an upgrade (including
    // a duplicate-key LegacyMigrationError from createIndexes()) leaves the
    // on-disk store exactly as it was, not half-migrated.
    this.db.transaction(() => {
      this.initSchema();
      this.migrate();
      this.createIndexes();
    }).immediate();
  }

  private vecBuf(a: number[]): Buffer {
    const f = new Float32Array(a);
    return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
  }

  /**
   * Mark this store as needing L2/L3 reconciliation on its next
   * distillation pass, even if L1 has no new stream turns to process
   * (docs/future/reliability-hardening.md finding 2, docs/MODEL.md §8.7).
   * Called by every atom/stream lifecycle method that can leave a scene or
   * core stale relative to the current active-atom set: supersedeAtom,
   * mergeAtoms, archiveAtom, hardDeleteAtomsUnsafe, and deleteStream (when
   * it actually affected some atom's evidence).
   *
   * Deliberately NOT part of the same write as the lifecycle change itself
   * — this call is idempotent and safe to redo, so a crash between the
   * lifecycle write and this mark just means the flag might not be set
   * for one lifecycle change; the next explicit call to any of these
   * methods (or a future distillOnce pass whose hash-gating recomputes
   * differently) still catches any resulting inconsistency. A missed dirty
   * mark costs at most a stale scene/core until the next relevant event —
   * never corrupted or lost domain data — so this asymmetric tradeoff
   * (simplicity over perfect atomicity) is acceptable here, unlike
   * finding 1's L1 transaction where a missed write really did lose
   * evidence/index consistency.
   */
  private markStoreDirty(reason: string): void {
    initDirtySchema(this.db);
    markDirty(this.db, this.storeKey, reason);
  }

  /** Validate an embedding vector's shape before it's ever written to
   *  atoms_vec — catches a malformed/wrong-dimension vector (e.g. an
   *  embedder returning the wrong model's output) before it can corrupt an
   *  index row or, worse, be validated only after other L1 writes have
   *  already happened (see docs/future/reliability-hardening.md finding 1).
   *  Returns the same vector for convenient chaining. */
  private validateEmbedding(vector: number[]): number[] {
    if (!Array.isArray(vector)) {
      throw new Error(`Invalid embedding: expected an array, got ${typeof vector}`);
    }
    if (vector.length !== this.dim) {
      throw new Error(`Invalid embedding: expected dimension ${this.dim}, got ${vector.length}`);
    }
    for (const v of vector) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error("Invalid embedding: contains a non-finite value");
      }
    }
    return vector;
  }

  /**
   * @internal Compute and validate an embedding for atom content, without
   * performing any DB write. Used by upsertAtom() and by the distillation
   * pipeline (src/distill/core.ts) so both share one embedding-validation
   * path and distillation can precompute embeddings before opening its L1
   * transaction (better-sqlite3 transactions must be fully synchronous).
   */
  async prepareAtomEmbedding(content: string): Promise<number[]> {
    return this.validateEmbedding(await this.embed(content));
  }

  /** Normalize/validate raw atom-write input into the shape
   *  writeAtomWithEmbeddingSync() expects, applying the same defaults as
   *  the historical upsertAtom() implementation (type='fact',
   *  confidence='medium', priority=100, pinned=false, tags=[]). Shared by
   *  the public upsertAtom() path and the distiller's internal path so
   *  both validate identically. */
  private normalizeAtomWrite(a: {
    id?: string;
    type?: string;
    content: string;
    background?: unknown;
    priority?: number;
    confidence?: string;
    pinned?: boolean;
    tags?: string[];
  }): NormalizedAtomWrite {
    const type = (a.type ?? "fact") as AtomType;
    if (!VALID_ATOM_TYPES.includes(type)) {
      throw new AtomTypeError(
        `Invalid atom type '${a.type}'. Must be one of: ${VALID_ATOM_TYPES.join(", ")}`
      );
    }
    const confidence = (a.confidence ?? "medium") as AtomConfidence;
    if (!VALID_CONFIDENCE.includes(confidence)) {
      throw new AtomTypeError(
        `Invalid confidence '${a.confidence}'. Must be one of: ${VALID_CONFIDENCE.join(", ")}`
      );
    }
    const id = a.id ?? randomUUID();
    const background: string | null =
      a.background == null ? null
      : typeof a.background === "string" ? a.background
      : typeof a.background === "object" ? JSON.stringify(a.background)
      : String(a.background);
    const priority = a.priority ?? 100;
    const pinned = a.pinned ?? false;
    const tags = JSON.stringify(a.tags ?? []);
    return { id, type, content: a.content, background, priority, confidence, pinned, tags };
  }

  /**
   * Insert-or-repair one atom row plus its atoms_fts/atoms_vec index rows,
   * given a precomputed (already-validated) embedding. Fully synchronous —
   * safe to call from inside a db.transaction() callback (see
   * docs/future/reliability-hardening.md finding 1).
   *
   * existingPolicy governs behavior when `input.id` already exists:
   *   - "update":   (public upsertAtom() semantics) immutable type/content
   *                 are enforced, but mutable metadata (background,
   *                 priority, confidence, pinned, tags) is overwritten.
   *   - "preserve": (distillation replay semantics) immutable type/content
   *                 are still enforced, but existing metadata/status/
   *                 timestamps are left untouched — only the FTS/vector
   *                 index rows are repaired. This lets a replayed pass
   *                 fix a historical partial write (e.g. a row with no
   *                 vector) without silently reverting metadata a caller
   *                 changed out-of-band.
   * Either way, exactly one atoms_fts row and one atoms_vec row exist for
   * this id afterward — delete-then-insert, not INSERT OR IGNORE, because
   * atoms_fts.id is UNINDEXED (not unique) and a naive insert could leave
   * duplicate FTS rows behind.
   */
  private writeAtomWithEmbeddingSync(
    input: NormalizedAtomWrite,
    embedding: number[],
    existingPolicy: ExistingAtomPolicy,
  ): AtomWriteResult {
    this.validateEmbedding(embedding);
    const now = new Date().toISOString();
    const existing = this.db.prepare(
      "SELECT id,type,content,created_at FROM atoms WHERE id=?"
    ).get(input.id) as any;

    if (existing) {
      // Content/type are immutable regardless of policy: reject changes to either.
      if (existing.content !== input.content) {
        throw new AtomImmutabilityError(
          `Atom '${input.id}' content is immutable. To change the proposition, record a new atom with supersedes='${input.id}'.`
        );
      }
      if (existing.type !== input.type) {
        throw new AtomImmutabilityError(
          `Atom '${input.id}' type is immutable. To change the type, record a new atom with supersedes='${input.id}'.`
        );
      }
      if (existingPolicy === "update") {
        this.db.prepare(
          "UPDATE atoms SET background=?,priority=?,confidence=?,pinned=?,tags=?,updated_at=? WHERE id=?"
        ).run(input.background, input.priority, input.confidence, input.pinned ? 1 : 0, input.tags, now, input.id);
      }
      // "preserve": metadata/status/timestamps are left exactly as they are.
      this.db.prepare("DELETE FROM atoms_fts WHERE id=?").run(input.id);
      this.db.prepare("DELETE FROM atoms_vec WHERE id=?").run(input.id);
      this.db.prepare("INSERT INTO atoms_fts(content,id) VALUES(?,?)").run(input.content, input.id);
      this.db.prepare("INSERT INTO atoms_vec(id,embedding) VALUES(?,?)").run(input.id, this.vecBuf(embedding));
      const row = this.db.prepare("SELECT * FROM atoms WHERE id=?").get(input.id);
      return { atom: rowToAtom(row), inserted: false };
    }

    this.db.prepare(
      `INSERT INTO atoms(id,type,content,background,priority,confidence,pinned,status,tags,
       source_turn_ids,source_session_ids,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      input.id, input.type, input.content, input.background, input.priority, input.confidence,
      input.pinned ? 1 : 0, "active", input.tags, "[]", "[]", now, now
    );
    this.db.prepare("INSERT INTO atoms_fts(content,id) VALUES(?,?)").run(input.content, input.id);
    this.db.prepare("INSERT INTO atoms_vec(id,embedding) VALUES(?,?)").run(input.id, this.vecBuf(embedding));
    const row = this.db.prepare("SELECT * FROM atoms WHERE id=?").get(input.id);
    return { atom: rowToAtom(row), inserted: true };
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  }

  private tableExists(name: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
    ).get(name);
    return !!row;
  }

  private vtableExists(name: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
    ).get(name);
    return !!row;
  }

  /** Creates base tables and virtual tables only — no indexes. Indexes are
   *  created later by createIndexes(), after migrate() has added any
   *  missing columns, so that opening a genuinely old store never tries to
   *  index a column that doesn't exist yet
   *  (docs/future/reliability-hardening.md finding 6). */
  private initSchema() {
    const d = this.dim;
    this.db.exec(`
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

  /** Additive migration: adds columns to pre-existing tables for stores that
   *  were created before Branch A. Safe to call multiple times (idempotent). */
  private migrate() {
    const now = new Date().toISOString();

    // stream: add turn_index, turn_id if missing (dependent unique indexes
    // are created afterward by createIndexes(), once the columns exist).
    if (this.tableExists("stream") && !this.hasColumn("stream", "turn_index")) {
      this.db.exec("ALTER TABLE stream ADD COLUMN turn_index INTEGER");
    }
    if (this.tableExists("stream") && !this.hasColumn("stream", "turn_id")) {
      this.db.exec("ALTER TABLE stream ADD COLUMN turn_id TEXT");
    }
    // stream: add monotonic seq column for cross-session distillation ordering.
    // Backfill existing rows in rowid order (preserves original insertion order).
    if (this.tableExists("stream") && !this.hasColumn("stream", "seq")) {
      this.db.exec("ALTER TABLE stream ADD COLUMN seq INTEGER");
      this.db.exec(`
        WITH ranked AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY rowid) AS rn FROM stream
        )
        UPDATE stream SET seq = (SELECT rn FROM ranked WHERE ranked.id = stream.id)
      `);
    }

    // scenes: add render_hash column for embedding re-index gating (Branch 4).
    if (this.tableExists("scenes") && !this.hasColumn("scenes", "render_hash")) {
      this.db.exec("ALTER TABLE scenes ADD COLUMN render_hash TEXT");
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
    if (this.tableExists("atoms")) {
      for (const [col, def] of atomCols) {
        if (!this.hasColumn("atoms", col)) {
          this.db.exec(`ALTER TABLE atoms ADD COLUMN ${col} ${def}`);
        }
      }
      // Backfill existing rows that were inserted before the new columns existed.
      // Only rows that still have the old defaults need updating.
      this.db.exec(`
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
    if (this.tableExists("consolidation_decisions")) {
      for (const col of ["candidate_type", "candidate_content", "candidate_confidence"]) {
        if (!this.hasColumn("consolidation_decisions", col)) {
          this.db.exec(`ALTER TABLE consolidation_decisions ADD COLUMN ${col} TEXT`);
        }
      }
    }

    // One-time repair for stores that ran deleteStream() before it cleaned
    // up stream_fts/stream_vec (docs/future/reliability-hardening.md
    // finding 5): remove any index rows whose id has no matching primary
    // stream row. Idempotent — a store where deleteStream always cleaned
    // up properly has nothing to remove here.
    if (this.tableExists("stream") && this.tableExists("stream_fts")) {
      this.db.exec("DELETE FROM stream_fts WHERE id NOT IN (SELECT id FROM stream)");
    }
    if (this.tableExists("stream") && this.tableExists("stream_vec")) {
      this.db.exec("DELETE FROM stream_vec WHERE id NOT IN (SELECT id FROM stream)");
    }
  }

  /** Creates every ordinary (non-virtual) index. Runs after migrate() so
   *  every column an index depends on is guaranteed to already exist —
   *  including on a store that started out as a genuinely old schema
   *  (docs/future/reliability-hardening.md finding 6). All ordinary
   *  indexes live here, not just the ones currently known to depend on a
   *  migrated column, so a future migration that adds a new indexed column
   *  can't reintroduce this bug by mistake. Idempotent (IF NOT EXISTS). */
  private createIndexes() {
    this.assertNoDuplicateTurnKeys();

    this.db.exec(`
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

  /** Guards the two UNIQUE indexes created in createIndexes(). A legacy
   *  store that predates those constraints could in principle already
   *  contain duplicate (session_id, turn_index) or (session_id, turn_id)
   *  rows; silently deduplicating would destroy data, so we fail loudly
   *  with a clear, actionable error instead
   *  (docs/future/reliability-hardening.md finding 6). */
  private assertNoDuplicateTurnKeys(): void {
    if (!this.tableExists("stream")) return;
    if (this.hasColumn("stream", "turn_index")) {
      const dup = this.db.prepare(`
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
    if (this.hasColumn("stream", "turn_id")) {
      const dup = this.db.prepare(`
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

  // ─── T0 Stream ──────────────────────────────────────────────────────────────

  async addStream(sessionId: string, items: StreamItem[]): Promise<string[]> {
    const ids: string[] = [];
    const ins = this.db.prepare(
      `INSERT INTO stream(id,session_id,role,content,ts,turn_index,turn_id,seq)
       VALUES(?,?,?,?,?,?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM stream))`
    );
    const insF = this.db.prepare("INSERT INTO stream_fts(content,id) VALUES(?,?)");
    const insV = this.db.prepare("INSERT INTO stream_vec(id,embedding) VALUES(?,?)");

    const checkIdx = this.db.prepare(
      "SELECT id,content FROM stream WHERE session_id=? AND turn_index=?"
    );
    const checkTid = this.db.prepare(
      "SELECT id,turn_index FROM stream WHERE session_id=? AND turn_id=?"
    );

    for (const m of items) {
      const id = m.id ?? randomUUID();
      const ts = m.timestamp ?? new Date().toISOString();
      const turnIndex = m.turn_index ?? null;
      const turnId = m.turn_id ?? null;

      // Idempotency: check for an exact-match duplicate before inserting.
      // Invariant 1: same (session_id, turn_index) must not exist with different content.
      if (turnIndex !== null) {
        const existing = checkIdx.get(sessionId, turnIndex) as any;
        if (existing) {
          if (existing.content === m.content) {
            // Exact duplicate → no-op, return existing id.
            ids.push(existing.id);
            continue;
          }
          throw new StreamConflictError(
            "index_conflict",
            `Turn index conflict: session=${sessionId} turn_index=${turnIndex} already exists with different content`,
          );
        }
      }

      // Invariant 2: same (session_id, turn_id) must not be reused at a different index.
      if (turnId !== null) {
        const existing = checkTid.get(sessionId, turnId) as any;
        if (existing) {
          if (existing.turn_index === turnIndex) {
            // Exact duplicate → no-op, return existing id.
            ids.push(existing.id);
            continue;
          }
          throw new StreamConflictError(
            "turn_id_conflict",
            `Turn id conflict: session=${sessionId} turn_id=${turnId} already recorded at turn_index=${existing.turn_index}, cannot reuse at ${turnIndex}`,
          );
        }
      }

      ins.run(id, sessionId, m.role, m.content, ts, turnIndex, turnId);
      insF.run(m.content, id);
      insV.run(id, this.vecBuf(await this.embed(m.content)));
      ids.push(id);
    }
    return ids;
  }

  queryStream(p: {
    session_id?: string; limit?: number; offset?: number;
    time_start?: string; time_end?: string;
  } = {}) {
    const where: string[] = []; const args: unknown[] = [];
    if (p.session_id) { where.push("session_id=?"); args.push(p.session_id); }
    if (p.time_start) { where.push("ts>=?"); args.push(p.time_start); }
    if (p.time_end)   { where.push("ts<=?"); args.push(p.time_end); }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    // Order deterministically: turn_index when present, else ts.
    const order = "ORDER BY session_id, COALESCE(turn_index, 999999999), ts DESC";
    const total = (this.db.prepare(`SELECT COUNT(*) c FROM stream ${w}`).get(...args) as any).c;
    const messages = this.db.prepare(
      `SELECT id,session_id,role,content,ts AS timestamp,turn_index,turn_id FROM stream ${w} ${order} LIMIT ? OFFSET ?`
    ).all(...args, p.limit ?? 50, p.offset ?? 0);
    return { messages, total };
  }

  /**
   * Read new turns in global insertion order, starting after `afterSeq`.
   * Use this for the distillation watermark cursor — it is safe across
   * concurrent sessions because `seq` is monotonic store-globally.
   */
  queryStreamSeq(p: { afterSeq?: number | null; limit?: number } = {}): StreamTurn[] {
    const afterSeq = p.afterSeq ?? 0;
    return this.db.prepare(
      `SELECT id,session_id,role,content,ts AS timestamp,turn_index,turn_id,seq
       FROM stream WHERE seq > ? ORDER BY seq LIMIT ?`
    ).all(afterSeq, p.limit ?? 50) as StreamTurn[];
  }

  /**
   * The highest `seq` in the stream (0 for an empty store). Cheap indexed
   * aggregate — used to decide whether a store has ANY undistilled turn by
   * comparing against the distillation watermark, without reading the
   * turns themselves (src/distill/worker.ts's sweep gate).
   */
  streamHeadSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq),0) AS m FROM stream").get() as { m: number };
    return row.m;
  }

  async searchStream(query: string, limit = 10): Promise<StreamHit[]> {
    return this.hybridStream(query, limit);
  }

  /**
   * Delete stream turns. Removes the primary row, its FTS and vector index
   * rows, and its evidence edges atomically (docs/future/reliability-
   * hardening.md finding 5) — deleteStream is the caller-invoked mechanism
   * for physically removing raw turn content (retraction, correction, or
   * privacy erasure; docs/MODEL.md §5.4), so leaving stale index rows
   * behind would mean the "deleted" text is still recoverable and still
   * occupies hybridStream's candidate slots. Returns the set of atom ids
   * whose evidence was affected; per §5.4 the affected atoms themselves are
   * never auto-deleted/archived.
   */
  deleteStream(p: { ids?: string[]; session_id?: string }): { deleted_count: number; affected_atom_ids: string[] } {
    const affectedSet = new Set<string>();

    const removeIndexAndEvidence = (streamIds: string[]) => {
      if (!streamIds.length) return;
      const placeholders = streamIds.map(() => "?").join(",");
      const rows = this.db.prepare(
        `SELECT DISTINCT atom_id FROM atom_evidence WHERE stream_id IN (${placeholders})`
      ).all(...streamIds) as Array<{ atom_id: string }>;
      rows.forEach((r) => affectedSet.add(r.atom_id));
      // Remove evidence edges before stream rows (FK constraint).
      this.db.prepare(
        `DELETE FROM atom_evidence WHERE stream_id IN (${placeholders})`
      ).run(...streamIds);
      this.db.prepare(
        `DELETE FROM stream_fts WHERE id IN (${placeholders})`
      ).run(...streamIds);
      this.db.prepare(
        `DELETE FROM stream_vec WHERE id IN (${placeholders})`
      ).run(...streamIds);
    };

    const run = this.db.transaction(() => {
      let deleted_count = 0;
      if (p.ids?.length) {
        removeIndexAndEvidence(p.ids);
        const del = this.db.prepare("DELETE FROM stream WHERE id=?");
        for (const id of p.ids) deleted_count += del.run(id).changes;
      } else if (p.session_id) {
        const rows = this.db.prepare("SELECT id FROM stream WHERE session_id=?")
          .all(p.session_id) as Array<{ id: string }>;
        removeIndexAndEvidence(rows.map((r) => r.id));
        deleted_count = this.db.prepare("DELETE FROM stream WHERE session_id=?").run(p.session_id).changes;
      }
      return deleted_count;
    });
    const deleted_count = run.immediate();

    if (affectedSet.size > 0) {
      this.markStoreDirty(`deleteStream affected ${affectedSet.size} atom(s)' evidence`);
    }
    return { deleted_count, affected_atom_ids: [...affectedSet] };
  }

  // ─── T1 Atoms ───────────────────────────────────────────────────────────────

  async upsertAtom(a: {
    id?: string;
    type?: string;
    content: string;
    background?: unknown;
    priority?: number;
    confidence?: string;
    pinned?: boolean;
    tags?: string[];
  }): Promise<Atom> {
    // Normalize/validate input, then embed BEFORE any DB write. Previously
    // the atom row + FTS row were written first and only the vector insert
    // awaited the embedding — an embed failure could leave a new atom with
    // no vector, or an existing atom's indexes deleted with nothing to
    // replace them. Precomputing the embedding first and writing
    // atom+FTS+vector together inside one local transaction closes that
    // gap (docs/future/reliability-hardening.md finding 1).
    const normalized = this.normalizeAtomWrite(a);
    const embedding = await this.prepareAtomEmbedding(a.content);
    const write = this.db.transaction(() => {
      return this.writeAtomWithEmbeddingSync(normalized, embedding, "update");
    });
    return write.immediate().atom;
  }

  /**
   * @internal Distillation L1 only (src/distill/core.ts). Performs no
   * async work and opens no transaction of its own — the caller must
   * supply an already-validated embedding (from prepareAtomEmbedding())
   * and must invoke this from inside its own db.transaction() so the atom
   * write commits atomically with evidence/lifecycle/decision/watermark
   * writes for the same pass (docs/future/reliability-hardening.md
   * finding 1). Uses "preserve" existing-atom semantics: replaying a
   * deterministic atom id that already exists repairs its FTS/vector
   * index rows without touching its metadata/status/timestamps — a
   * distillation pass reproducing the same candidate must not silently
   * revert priority/pinned/tags/confidence a caller changed out-of-band.
   * Not exposed via any HTTP route or MCP tool.
   */
  upsertDistilledAtomSync(
    input: { id: string; type: AtomType; content: string; confidence: AtomConfidence },
    embedding: number[],
  ): AtomWriteResult {
    const normalized = this.normalizeAtomWrite(input);
    return this.writeAtomWithEmbeddingSync(normalized, embedding, "preserve");
  }

  /** Mark an atom as superseded by a new atom. */
  supersedeAtom(oldId: string, newId: string): void {
    this.db.prepare("UPDATE atoms SET status='superseded',updated_at=? WHERE id=?")
      .run(new Date().toISOString(), oldId);
    // Scene/core regeneration is handled lazily by the next distillOnce() pass
    // via hash-gating (docs/MODEL.md §3.3, §8.3) — markStoreDirty() ensures
    // that pass actually happens even with no new stream turns (finding 2).
    this.markStoreDirty(`supersedeAtom ${oldId} -> ${newId}`);
  }

  /** Merge multiple atoms into a winner (losers become 'merged'). */
  mergeAtoms(loserIds: string[], winnerId: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare("UPDATE atoms SET status='merged',updated_at=? WHERE id=?");
    for (const id of loserIds) {
      stmt.run(now, id);
    }
    // Scene/core regeneration handled lazily by next distillOnce() pass;
    // markStoreDirty() ensures that pass runs even with no new turns.
    if (loserIds.length > 0) this.markStoreDirty(`mergeAtoms ${loserIds.length} loser(s) -> ${winnerId}`);
  }

  /**
   * Archive an atom (logical forgetting — retire without replacement).
   * Returns the number of rows changed (0 or 1): 0 means no *active* atom
   * matched `id` (already archived/superseded/merged, or unknown) — this is
   * not an existence oracle since the store handle is already tenant-scoped.
   */
  archiveAtom(id: string): number {
    const res = this.db.prepare("UPDATE atoms SET status='archived',updated_at=? WHERE id=? AND status='active'")
      .run(new Date().toISOString(), id);
    // Scene/core regeneration handled lazily by next distillOnce() pass;
    // markStoreDirty() ensures that pass runs even with no new turns. Only
    // mark dirty if an atom was actually archived (changes > 0) — a no-op
    // call (unknown/already-archived id) has nothing to reconcile.
    if (res.changes > 0) this.markStoreDirty(`archiveAtom ${id}`);
    return res.changes;
  }

  updateConfidence(id: string, confidence: AtomConfidence): void {
    if (!VALID_CONFIDENCE.includes(confidence)) throw new AtomTypeError(`Invalid confidence: ${confidence}`);
    this.db.prepare("UPDATE atoms SET confidence=?,updated_at=? WHERE id=?")
      .run(confidence, new Date().toISOString(), id);
    // Confidence change does NOT dirty scenes (§3.3 resolution).
  }

  updateTags(id: string, tags: string[]): void {
    this.db.prepare("UPDATE atoms SET tags=?,updated_at=? WHERE id=?")
      .run(JSON.stringify(tags), new Date().toISOString(), id);
  }

  updatePinned(id: string, pinned: boolean): void {
    this.db.prepare("UPDATE atoms SET pinned=?,updated_at=? WHERE id=?")
      .run(pinned ? 1 : 0, new Date().toISOString(), id);
  }

  /** Fetch one atom by id regardless of status (active/superseded/merged/
   *  archived) — unlike queryAtoms()/searchAtoms(), which only see active
   *  atoms. Used by callers that need to resolve a specific id already in
   *  hand (e.g. reconstructing a past recall trace's items, src/gateway.ts's
   *  /recalls/reconstruct) and must distinguish "still active" from
   *  "existed once, since superseded/merged/archived" rather than treating
   *  both as "not found". Returns null only if no atom with this id was
   *  ever recorded. */
  getAtom(id: string): Atom | null {
    const row = this.db.prepare("SELECT * FROM atoms WHERE id=?").get(id) as any;
    return row ? rowToAtom(row) : null;
  }

  queryAtoms(p: {
    type?: string; status?: AtomStatus; limit?: number; offset?: number;
    time_start?: string; time_end?: string;
  } = {}) {
    const where: string[] = ["status='active'"]; const args: unknown[] = [];
    if (p.type)       { where.push("type=?"); args.push(p.type); }
    if (p.status)     { where[0] = "status=?"; args.unshift(p.status); }
    if (p.time_start) { where.push("updated_at>=?"); args.push(p.time_start); }
    if (p.time_end)   { where.push("updated_at<=?"); args.push(p.time_end); }
    const w = "WHERE " + where.join(" AND ");
    const total = (this.db.prepare(`SELECT COUNT(*) c FROM atoms ${w}`).get(...args) as any).c;
    const items = this.db.prepare(
      `SELECT * FROM atoms ${w} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    ).all(...args, p.limit ?? 50, p.offset ?? 0).map(rowToAtom);
    return { items, total };
  }

  async searchAtoms(query: string, limit = 10): Promise<AtomHit[]> {
    return this.hybridAtoms(query, limit);
  }

  /**
   * Hard-delete atoms by id — physically removes rows, evidence edges, index
   * entries, and scene membership. NOT the same as logical forgetting
   * (supersedeAtom/archiveAtom). Does NOT produce an audit record. NOT safe
   * to call on atoms that should be traceable. Use only in tests or internal
   * tooling. For audited erasure see docs/future/open-questions.md.
   */
  hardDeleteAtomsUnsafe(ids: string[]): number {
    let n = 0;
    for (const id of ids) {
      this.db.prepare("DELETE FROM atom_evidence WHERE atom_id=?").run(id);
      this.db.prepare("DELETE FROM scene_atoms WHERE atom_id=?").run(id);
      this.db.prepare("DELETE FROM atoms_fts WHERE id=?").run(id);
      this.db.prepare("DELETE FROM atoms_vec WHERE id=?").run(id);
      n += this.db.prepare("DELETE FROM atoms WHERE id=?").run(id).changes;
    }
    if (n > 0) this.markStoreDirty(`hardDeleteAtomsUnsafe removed ${n} atom(s)`);
    return n;
  }

  // ─── Provenance (atom_evidence) ──────────────────────────────────────────────

  addEvidence(atomId: string, streamIds: string[]): void {
    const now = new Date().toISOString();
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO atom_evidence(atom_id,stream_id,added_at) VALUES(?,?,?)"
    );
    for (const sid of streamIds) ins.run(atomId, sid, now);
    this.refreshDenormalized(atomId);
  }

  evidenceForAtom(atomId: string): EvidenceEdge[] {
    return this.db.prepare(
      "SELECT atom_id,stream_id,added_at FROM atom_evidence WHERE atom_id=?"
    ).all(atomId) as EvidenceEdge[];
  }

  atomsFromStream(streamId: string): string[] {
    return (this.db.prepare(
      "SELECT DISTINCT atom_id FROM atom_evidence WHERE stream_id=?"
    ).all(streamId) as Array<{ atom_id: string }>).map((r) => r.atom_id);
  }

  atomsFromSession(sessionId: string): string[] {
    return (this.db.prepare(
      `SELECT DISTINCT ae.atom_id FROM atom_evidence ae
       JOIN stream s ON s.id = ae.stream_id
       WHERE s.session_id=?`
    ).all(sessionId) as Array<{ atom_id: string }>).map((r) => r.atom_id);
  }

  sessionsForAtom(atomId: string): string[] {
    return (this.db.prepare(
      `SELECT DISTINCT s.session_id FROM atom_evidence ae
       JOIN stream s ON s.id = ae.stream_id
       WHERE ae.atom_id=?`
    ).all(atomId) as Array<{ session_id: string }>).map((r) => r.session_id);
  }

  private refreshDenormalized(atomId: string): void {
    const rows = this.db.prepare(
      `SELECT s.id AS turn_id_col, s.turn_id, s.session_id
       FROM atom_evidence ae JOIN stream s ON s.id=ae.stream_id
       WHERE ae.atom_id=?`
    ).all(atomId) as Array<{ turn_id_col: string; turn_id: string | null; session_id: string }>;
    const turnIds = [...new Set(rows.filter((r) => r.turn_id).map((r) => r.turn_id!))] as string[];
    const sessionIds = [...new Set(rows.map((r) => r.session_id))];
    this.db.prepare(
      "UPDATE atoms SET source_turn_ids=?,source_session_ids=? WHERE id=?"
    ).run(JSON.stringify(turnIds), JSON.stringify(sessionIds), atomId);
  }

  // ─── Consolidation decisions ──────────────────────────────────────────────────

  recordDecision(d: {
    id: string; pass_id: string; action: string;
    atom_id?: string; target_ids?: string[]; rationale?: string;
    candidate_type?: string; candidate_content?: string; candidate_confidence?: string;
  }): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO consolidation_decisions
       (id,pass_id,action,atom_id,target_ids,rationale,decided_at,
        candidate_type,candidate_content,candidate_confidence)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(
      d.id, d.pass_id, d.action,
      d.atom_id ?? null,
      d.target_ids ? JSON.stringify(d.target_ids) : null,
      d.rationale ?? null,
      new Date().toISOString(),
      d.candidate_type ?? null,
      d.candidate_content ?? null,
      d.candidate_confidence ?? null,
    );
  }

  // ─── Distillation pass metadata / effect log (inspect surface) ────────────

  recordPassStart(p: {
    pass_id: string; store_key: string;
    watermark_start: number | null; watermark_end: number | null;
    input_turn_count: number;
    model?: string; prompt_version?: string; distiller_version?: string;
  }): void {
    // INSERT ... ON CONFLICT DO UPDATE (upsert on primary key) so that a
    // retry of the same deterministic pass_id refreshes the row with the
    // latest attempt's provenance (model, prompt_version, distiller_version,
    // started_at) and clears stale completion data. Without this, a
    // successful retry run under a different model or prompt version would
    // still display the original failed attempt's provenance in
    // `falda distill inspect`.
    this.db.prepare(
      `INSERT INTO distillation_passes
       (pass_id,store_key,watermark_start,watermark_end,started_at,status,
        input_turn_count,candidate_count,error,model,prompt_version,distiller_version)
       VALUES(?,?,?,?,?,'running',?,NULL,NULL,?,?,?)
       ON CONFLICT(pass_id) DO UPDATE SET
         store_key=excluded.store_key,
         watermark_start=excluded.watermark_start,
         watermark_end=excluded.watermark_end,
         started_at=excluded.started_at,
         completed_at=NULL,
         status='running',
         input_turn_count=excluded.input_turn_count,
         candidate_count=NULL,
         error=NULL,
         model=excluded.model,
         prompt_version=excluded.prompt_version,
         distiller_version=excluded.distiller_version`
    ).run(
      p.pass_id, p.store_key, p.watermark_start, p.watermark_end,
      new Date().toISOString(), p.input_turn_count,
      p.model ?? null, p.prompt_version ?? null, p.distiller_version ?? null,
    );
  }

  recordPassComplete(p: {
    pass_id: string; status: "done" | "failed";
    candidate_count?: number; error?: string;
  }): void {
    this.db.prepare(
      `UPDATE distillation_passes SET completed_at=?,status=?,candidate_count=?,error=?
       WHERE pass_id=?`
    ).run(
      new Date().toISOString(), p.status,
      p.candidate_count ?? null, p.error ?? null,
      p.pass_id,
    );
  }

  recordSceneEffect(e: {
    pass_id: string; scene_id: string; scene_kind: SceneKind; title: string;
    effect: "created" | "updated" | "retired" | "unchanged";
    members_before: number; members_after: number;
    added?: string[]; removed?: string[];
    summary_regenerated?: boolean; embedding_regenerated?: boolean;
  }): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO pass_scene_effects
       (pass_id,scene_id,scene_kind,title,effect,members_before,members_after,
        added_json,removed_json,summary_regenerated,embedding_regenerated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      e.pass_id, e.scene_id, e.scene_kind, e.title, e.effect,
      e.members_before, e.members_after,
      JSON.stringify(e.added ?? []), JSON.stringify(e.removed ?? []),
      e.summary_regenerated ? 1 : 0, e.embedding_regenerated ? 1 : 0,
    );
  }

  recordCoreEffect(e: {
    pass_id: string; effect: "unchanged" | "regenerated" | "deleted" | "failed";
    old_input_hash?: string | null; new_input_hash?: string | null;
    old_chars?: number | null; new_chars?: number | null;
  }): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO pass_core_effects
       (pass_id,effect,old_input_hash,new_input_hash,old_chars,new_chars)
       VALUES(?,?,?,?,?,?)`
    ).run(
      e.pass_id, e.effect,
      e.old_input_hash ?? null, e.new_input_hash ?? null,
      e.old_chars ?? null, e.new_chars ?? null,
    );
  }

  // ─── T2 Scenes (id-addressed, SQLite-backed) ─────────────────────────────────

  async upsertScene(s: {
    scene_id?: string;
    scene_kind: SceneKind;
    title: string;
    atom_ids?: string[];
    summary?: string | null;
    content_hash?: string | null;
    status?: SceneStatus;
    derived_from?: string[] | null;
    superseded_by?: string[] | null;
  }): Promise<Scene> {
    const scene_id = s.scene_id ?? randomUUID();
    // Phase 1: persist structural fields (membership, status, lifecycle columns).
    // The effective persisted Scene — including inherited fields (e.g. existing
    // summary when s.summary is omitted) — is read back after the write and
    // used as the single source of truth for all derived indexes.
    const scene = this.syncSceneStructure(scene_id, s);
    // Phase 2: sync FTS, vector index, and markdown mirror from the persisted row.
    await this.syncSceneRendering(scene);
    return scene;
  }

  /**
   * Write structural scene fields to SQLite and return the persisted Scene.
   * On update, fields omitted from `s` preserve their existing values.
   * The returned Scene is read from the database — it is authoritative.
   */
  private syncSceneStructure(scene_id: string, s: {
    scene_kind: SceneKind;
    title: string;
    atom_ids?: string[];
    summary?: string | null;
    content_hash?: string | null;
    status?: SceneStatus;
    derived_from?: string[] | null;
    superseded_by?: string[] | null;
  }): Scene {
    const now = new Date().toISOString();
    const atomIds = s.atom_ids ?? [];
    const existing = this.db.prepare("SELECT * FROM scenes WHERE scene_id=?").get(scene_id) as any;

    if (existing) {
      this.db.prepare(
        `UPDATE scenes SET scene_kind=?,title=?,atom_ids=?,summary=?,content_hash=?,
         status=?,derived_from=?,superseded_by=?,updated_at=? WHERE scene_id=?`
      ).run(
        s.scene_kind,
        s.title,
        JSON.stringify(atomIds),
        s.summary !== undefined ? s.summary : existing.summary,
        s.content_hash !== undefined ? s.content_hash : existing.content_hash,
        s.status ?? existing.status,
        s.derived_from !== undefined ? (s.derived_from ? JSON.stringify(s.derived_from) : null) : existing.derived_from,
        s.superseded_by !== undefined ? (s.superseded_by ? JSON.stringify(s.superseded_by) : null) : existing.superseded_by,
        now, scene_id,
      );
    } else {
      this.db.prepare(
        `INSERT INTO scenes(scene_id,scene_kind,title,atom_ids,summary,content_hash,
         status,derived_from,superseded_by,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        scene_id, s.scene_kind, s.title, JSON.stringify(atomIds),
        s.summary ?? null,
        s.content_hash ?? null,
        s.status ?? "active",
        s.derived_from ? JSON.stringify(s.derived_from) : null,
        s.superseded_by ? JSON.stringify(s.superseded_by) : null,
        now, now,
      );
    }

    // Sync the scene_atoms join table to match the persisted atom_ids.
    this.db.prepare("DELETE FROM scene_atoms WHERE scene_id=?").run(scene_id);
    const insJoin = this.db.prepare("INSERT OR IGNORE INTO scene_atoms(scene_id,atom_id) VALUES(?,?)");
    for (const aid of atomIds) insJoin.run(scene_id, aid);

    // Read back the effective persisted row — this is the single source of truth.
    return rowToScene(this.db.prepare("SELECT * FROM scenes WHERE scene_id=?").get(scene_id) as any);
  }

  /**
   * Sync FTS index, vector embedding, and markdown mirror from the persisted Scene.
   * All three derive from the Scene object returned by syncSceneStructure(), so
   * they always reflect what is actually stored — never the raw upsert input.
   *
   * FTS and mirror are always kept in sync (cheap, synchronous).
   * Embeddings are gated on render_hash — sha256(title + "\n" + summary).
   * This distinguishes two separate concerns:
   *   content_hash  → member atom set changed; LLM may regenerate title/summary
   *   render_hash   → title or summary changed; embedding must be regenerated
   * A structural membership-only upsert (same title/summary) never triggers
   * an embed call.
   */
  private async syncSceneRendering(scene: Scene): Promise<void> {
    const { scene_id, title, summary } = scene;

    // FTS: always sync title+summary from the persisted scene (cheap).
    this.db.prepare("DELETE FROM scenes_fts WHERE scene_id=?").run(scene_id);
    this.db.prepare("INSERT INTO scenes_fts(title,summary,scene_id) VALUES(?,?,?)")
      .run(title, summary ?? "", scene_id);

    // Vector: re-embed only when title or summary changed (render_hash differs).
    const newRenderHash = computeRenderHash(title, summary);
    const existingVec = this.db.prepare("SELECT 1 FROM scenes_vec WHERE scene_id=?").get(scene_id);
    const needsEmbed = !existingVec || scene.render_hash !== newRenderHash;
    if (needsEmbed) {
      const embedText = summary ? `${title}\n${summary}` : title;
      this.db.prepare("DELETE FROM scenes_vec WHERE scene_id=?").run(scene_id);
      this.db.prepare("INSERT INTO scenes_vec(scene_id,embedding) VALUES(?,?)")
        .run(scene_id, this.vecBuf(await this.embed(embedText)));
      // Persist the render_hash so subsequent passes can skip the embed call.
      this.db.prepare("UPDATE scenes SET render_hash=? WHERE scene_id=?")
        .run(newRenderHash, scene_id);
    }

    // Best-effort markdown mirror from the persisted scene.
    this.writeSceneMirror(scene);
  }

  getScene(scene_id: string): Scene | null {
    const row = this.db.prepare("SELECT * FROM scenes WHERE scene_id=?").get(scene_id) as any;
    return row ? rowToScene(row) : null;
  }

  listScenes(p: {
    scene_kind?: SceneKind; status?: SceneStatus; limit?: number; offset?: number;
  } = {}): { items: Scene[]; total: number } {
    const where: string[] = []; const args: unknown[] = [];
    if (p.scene_kind) { where.push("scene_kind=?"); args.push(p.scene_kind); }
    if (p.status)     { where.push("status=?"); args.push(p.status); }
    else              { where.push("status='active'"); }
    const w = "WHERE " + where.join(" AND ");
    const total = (this.db.prepare(`SELECT COUNT(*) c FROM scenes ${w}`).get(...args) as any).c;
    const items = (this.db.prepare(
      `SELECT * FROM scenes ${w} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    ).all(...args, p.limit ?? 50, p.offset ?? 0) as any[]).map(rowToScene);
    return { items, total };
  }

  removeScene(scene_id: string): void {
    this.db.prepare("DELETE FROM scene_atoms WHERE scene_id=?").run(scene_id);
    this.db.prepare("DELETE FROM scenes_fts WHERE scene_id=?").run(scene_id);
    this.db.prepare("DELETE FROM scenes_vec WHERE scene_id=?").run(scene_id);
    this.db.prepare("DELETE FROM scenes WHERE scene_id=?").run(scene_id);
    const mirror = path.join(this.blobDir, "scenes", `${scene_id}.md`);
    if (fs.existsSync(mirror)) fs.unlinkSync(mirror);
  }

  scenesForAtom(atom_id: string, scene_kind?: SceneKind): Scene[] {
    const kindClause = scene_kind ? "AND sc.scene_kind=?" : "";
    const args: unknown[] = [atom_id];
    if (scene_kind) args.push(scene_kind);
    const rows = this.db.prepare(
      `SELECT sc.* FROM scenes sc
       JOIN scene_atoms sa ON sa.scene_id=sc.scene_id
       WHERE sa.atom_id=? ${kindClause} AND sc.status='active'`
    ).all(...args) as any[];
    return rows.map(rowToScene);
  }

  async searchScenes(query: string, limit = 10): Promise<SceneHit[]> {
    return this.hybridScenes(query, limit);
  }

  private writeSceneMirror(scene: Scene): void {
    try {
      const dir = path.join(this.blobDir, "scenes");
      fs.mkdirSync(dir, { recursive: true });
      const content = `# ${scene.title}\n\nKind: ${scene.scene_kind}\n\n${scene.summary ?? ""}`;
      fs.writeFileSync(path.join(dir, `${scene.scene_id}.md`), content, "utf8");
    } catch {
      // Best-effort: never fail a scene write because the mirror failed.
    }
  }

  // ─── T3 Core (local FS) ─────────────────────────────────────────────────────

  readCore(): string {
    const fp = path.join(this.blobDir, "core.md");
    return fs.existsSync(fp) ? fs.readFileSync(fp, "utf8") : "";
  }

  writeCore(content: string): void {
    fs.writeFileSync(path.join(this.blobDir, "core.md"), content, "utf8");
  }

  // ─── Recall: pinned-first + hybrid re-rank ────────────────────────────────────

  /** Effective recall re-rank weights (defaults merged with any FaldaOptions
   *  override at construction). Exposed read-only so callers (e.g. recall
   *  trace policy snapshots) can record what was actually applied without
   *  duplicating the defaults. */
  getRecallWeights(): RecallWeights {
    return { ...this.weights };
  }

  /** Return all active pinned atoms. Public primitive — avoids callers reaching into .db. */
  getPinnedAtoms(): Atom[] {
    return (this.db.prepare(
      "SELECT * FROM atoms WHERE status='active' AND pinned=1"
    ).all() as any[]).map(rowToAtom);
  }

  async recallAtoms(query: string, limit = 10): Promise<AtomHit[]> {
    const pinnedBudget = Math.floor(TOTAL_CHAR_BUDGET * PINNED_BUDGET_FRACTION);
    let usedChars = 0;
    const results: AtomHit[] = [];

    // Pinned-first pass: all active pinned atoms, unconditionally.
    for (const a of this.getPinnedAtoms()) {
      const truncated = truncate(a.content);
      if (usedChars + truncated.length > pinnedBudget) break;
      usedChars += truncated.length;
      results.push({ ...a, content: truncated, score: Infinity });
    }
    const pinnedIds = new Set(results.map((r) => r.id));

    // Query-ranked recall for the remainder of the budget.
    const ranked = await this.hybridAtoms(query, (limit - pinnedIds.size) * 3);
    for (const hit of ranked) {
      if (pinnedIds.has(hit.id)) continue;
      const truncated = truncate(hit.content);
      if (usedChars + truncated.length > TOTAL_CHAR_BUDGET) break;
      usedChars += truncated.length;
      results.push({ ...hit, content: truncated });
      if (results.length >= limit) break;
    }
    return results;
  }

  private async hybridAtoms(query: string, limit: number): Promise<AtomHit[]> {
    const w = this.weights;
    const qvec = this.vecBuf(await this.embed(query));
    const vecRowsActual = this.db.prepare(
      "SELECT id, distance FROM atoms_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?"
    ).all(qvec, limit * 3) as Array<{ id: string; distance: number }>;
    const ftsRows = this.db.prepare(
      "SELECT id, bm25(atoms_fts) AS rank FROM atoms_fts WHERE atoms_fts MATCH ? ORDER BY rank LIMIT ?"
    ).all(toFtsQuery(query), limit * 3) as Array<{ id: string; rank: number }>;

    const rrfScore = new Map<string, number>();
    vecRowsActual.forEach((r, i) => rrfScore.set(r.id, (rrfScore.get(r.id) ?? 0) + 1 / (RRF_K + i)));
    ftsRows.forEach((r, i) => rrfScore.set(r.id, (rrfScore.get(r.id) ?? 0) + 1 / (RRF_K + i)));

    const top = [...rrfScore.entries()].sort((a, z) => z[1] - a[1]).slice(0, limit);
    const hits: AtomHit[] = [];
    for (const [id, rrf] of top) {
      const row = this.db.prepare("SELECT * FROM atoms WHERE id=? AND status='active'").get(id) as any;
      if (!row) continue;
      const a = rowToAtom(row);
      const blended = rrf
        + w.wRecency * recencyDecay(a.created_at, w.recencyHalfLifeDays)
        + w.wPriority * priorityWeight(a.priority)
        + w.wConfidence * confidenceWeight(a.confidence);
      hits.push({ ...a, score: blended });
    }
    return hits.sort((a, z) => z.score - a.score);
  }

  private async hybridStream(query: string, limit: number): Promise<StreamHit[]> {
    const qvec = this.vecBuf(await this.embed(query));
    const vecRows = this.db.prepare(
      "SELECT id, distance FROM stream_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?"
    ).all(qvec, limit * 2) as Array<{ id: string }>;
    const ftsRows = this.db.prepare(
      "SELECT id, bm25(stream_fts) AS rank FROM stream_fts WHERE stream_fts MATCH ? ORDER BY rank LIMIT ?"
    ).all(toFtsQuery(query), limit * 2) as Array<{ id: string }>;
    const score = new Map<string, number>();
    vecRows.forEach((r, i) => score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + i)));
    ftsRows.forEach((r, i) => score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + i)));
    const top = [...score.entries()].sort((a, z) => z[1] - a[1]).slice(0, limit);
    return top.map(([id, s]) => {
      const row = this.db.prepare(
        "SELECT id,session_id,role,content,ts AS timestamp,turn_index,turn_id FROM stream WHERE id=?"
      ).get(id) as any;
      return { ...row, score: s };
    }).filter(Boolean) as StreamHit[];
  }

  private async hybridScenes(query: string, limit: number): Promise<SceneHit[]> {
    const qvec = this.vecBuf(await this.embed(query));
    const vecRows = this.db.prepare(
      "SELECT scene_id, distance FROM scenes_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?"
    ).all(qvec, limit * 2) as Array<{ scene_id: string }>;
    const ftsRows = this.db.prepare(
      "SELECT scene_id, bm25(scenes_fts) AS rank FROM scenes_fts WHERE scenes_fts MATCH ? ORDER BY rank LIMIT ?"
    ).all(toFtsQuery(query), limit * 2) as Array<{ scene_id: string }>;
    const score = new Map<string, number>();
    vecRows.forEach((r, i) => score.set(r.scene_id, (score.get(r.scene_id) ?? 0) + 1 / (RRF_K + i)));
    ftsRows.forEach((r, i) => score.set(r.scene_id, (score.get(r.scene_id) ?? 0) + 1 / (RRF_K + i)));
    const top = [...score.entries()].sort((a, z) => z[1] - a[1]).slice(0, limit);
    return top.map(([id, s]) => {
      const row = this.db.prepare("SELECT * FROM scenes WHERE scene_id=? AND status='active'").get(id) as any;
      if (!row) return null;
      return { ...rowToScene(row), score: s };
    }).filter(Boolean) as SceneHit[];
  }

  /** Stable content hash for scene re-generation gating (§6.4).
   *  hash(scene_kind + sorted(active member atom id+content)) */
  computeSceneHash(scene_kind: SceneKind, atomIds: string[]): string {
    const sorted = [...atomIds].sort();
    const atoms = sorted.map((id) => {
      const row = this.db.prepare("SELECT id,content FROM atoms WHERE id=? AND status='active'").get(id) as any;
      return row ? `${row.id}:${row.content}` : "";
    }).filter(Boolean);
    const input = scene_kind + "|" + atoms.join("|");
    return createHash("sha256").update(input).digest("hex");
  }

  /** Stable content hash for core re-generation gating (§8.4).
   *  hash(for each active scene sorted by scene_id: scene_kind+title+sorted(member atom id+content)) */
  computeCoreHash(): string {
    const scenes = (this.db.prepare(
      "SELECT * FROM scenes WHERE status='active' ORDER BY scene_id"
    ).all() as any[]).map(rowToScene);
    const parts: string[] = [];
    for (const sc of scenes) {
      const sorted = [...sc.atom_ids].sort();
      const atoms = sorted.map((id) => {
        const row = this.db.prepare("SELECT id,content FROM atoms WHERE id=? AND status='active'").get(id) as any;
        return row ? `${row.id}:${row.content}` : "";
      }).filter(Boolean);
      parts.push(`${sc.scene_kind}|${sc.title}|${atoms.join("|")}`);
    }
    return createHash("sha256").update(parts.join("||")).digest("hex");
  }

  /**
   * Rebuild every dense-vector index (T0 stream, T1 atoms, T2 scenes) from
   * scratch using this store's currently configured embedder and dimension
   * (this.embed / this.dim). Used by `falda reembed` when switching
   * embedding models/dimensions (docs/OPERATIONS.md).
   *
   * Dimension is baked into the vec0 schema (`embedding float[${dim}]` —
   * see initSchema above), so a dim change can't be done as a row rewrite:
   * the *_vec tables are dropped and recreated at `this.dim` before
   * repopulating. Safe to call even when only the model (not the dim)
   * changed — the drop/recreate is just extra I/O in that case.
   *
   * Does not touch FTS indexes, content, or metadata — only the *_vec
   * tables (plus scenes' render_hash, refreshed so a subsequent
   * syncSceneRendering call doesn't immediately think another re-embed is
   * needed). Not transactional across the whole store: if interrupted
   * partway, re-run it — every step is idempotent (DROP/CREATE + full
   * repopulation from the source-of-truth tables).
   */
  async reembedAll(onProgress?: (tier: "stream" | "atoms" | "scenes", done: number, total: number) => void): Promise<{
    stream: number; atoms: number; scenes: number; dim: number;
  }> {
    const d = this.dim;
    this.db.exec("DROP TABLE IF EXISTS atoms_vec");
    this.db.exec("DROP TABLE IF EXISTS scenes_vec");
    this.db.exec("DROP TABLE IF EXISTS stream_vec");
    this.db.exec(`CREATE VIRTUAL TABLE atoms_vec USING vec0(id TEXT PRIMARY KEY, embedding float[${d}])`);
    this.db.exec(`CREATE VIRTUAL TABLE scenes_vec USING vec0(scene_id TEXT PRIMARY KEY, embedding float[${d}])`);
    this.db.exec(`CREATE VIRTUAL TABLE stream_vec USING vec0(id TEXT PRIMARY KEY, embedding float[${d}])`);

    const atoms = this.db.prepare("SELECT id, content FROM atoms").all() as Array<{ id: string; content: string }>;
    const insA = this.db.prepare("INSERT INTO atoms_vec(id,embedding) VALUES(?,?)");
    for (let i = 0; i < atoms.length; i++) {
      insA.run(atoms[i].id, this.vecBuf(await this.embed(atoms[i].content)));
      onProgress?.("atoms", i + 1, atoms.length);
    }

    const scenes = this.db.prepare("SELECT scene_id, title, summary FROM scenes").all() as
      Array<{ scene_id: string; title: string; summary: string | null }>;
    const insS = this.db.prepare("INSERT INTO scenes_vec(scene_id,embedding) VALUES(?,?)");
    const updRenderHash = this.db.prepare("UPDATE scenes SET render_hash=? WHERE scene_id=?");
    for (let i = 0; i < scenes.length; i++) {
      const sc = scenes[i];
      const text = sc.summary ? `${sc.title}\n${sc.summary}` : sc.title;
      insS.run(sc.scene_id, this.vecBuf(await this.embed(text)));
      updRenderHash.run(computeRenderHash(sc.title, sc.summary), sc.scene_id);
      onProgress?.("scenes", i + 1, scenes.length);
    }

    const turns = this.db.prepare("SELECT id, content FROM stream").all() as Array<{ id: string; content: string }>;
    const insT = this.db.prepare("INSERT INTO stream_vec(id,embedding) VALUES(?,?)");
    for (let i = 0; i < turns.length; i++) {
      insT.run(turns[i].id, this.vecBuf(await this.embed(turns[i].content)));
      onProgress?.("stream", i + 1, turns.length);
    }

    return { stream: turns.length, atoms: atoms.length, scenes: scenes.length, dim: d };
  }

  close() { this.db.close(); }
}
