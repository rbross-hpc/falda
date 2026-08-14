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
const TOTAL_CHAR_BUDGET = 12000;
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
    status: (row.status ?? "active") as SceneStatus,
    derived_from: row.derived_from ? JSON.parse(row.derived_from) : null,
    superseded_by: row.superseded_by ? JSON.parse(row.superseded_by) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── Main store class ──────────────────────────────────────────────────────────

export class Falda {
  private db: Database.Database;
  private embed: Embedder;
  private blobDir: string;
  private dim: number;
  private weights: RecallWeights;

  constructor(opts: FaldaOptions) {
    this.embed = opts.embed;
    this.blobDir = opts.blobDir;
    this.dim = opts.dim ?? 768;
    this.weights = { ...DEFAULT_WEIGHTS, ...opts.recallWeights };
    fs.mkdirSync(this.blobDir, { recursive: true });
    this.db = new Database(opts.dbPath);
    sqliteVec.load(this.db);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
    this.migrate();
  }

  private vecBuf(a: number[]): Buffer {
    const f = new Float32Array(a);
    return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
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
        turn_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_stream_session ON stream(session_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_turn_index
        ON stream(session_id, turn_index) WHERE turn_index IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_turn_id
        ON stream(session_id, turn_id) WHERE turn_id IS NOT NULL;
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
      CREATE INDEX IF NOT EXISTS idx_atoms_status ON atoms(status);
      CREATE INDEX IF NOT EXISTS idx_atoms_type ON atoms(type);
      CREATE INDEX IF NOT EXISTS idx_atoms_pinned ON atoms(pinned) WHERE pinned=1;
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
      CREATE INDEX IF NOT EXISTS idx_evidence_stream ON atom_evidence(stream_id);

      CREATE TABLE IF NOT EXISTS consolidation_decisions (
        id TEXT PRIMARY KEY,
        pass_id TEXT NOT NULL,
        action TEXT NOT NULL,
        atom_id TEXT,
        target_ids TEXT,
        rationale TEXT,
        decided_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_pass ON consolidation_decisions(pass_id);

      CREATE TABLE IF NOT EXISTS scenes (
        scene_id TEXT PRIMARY KEY,
        scene_kind TEXT NOT NULL CHECK(scene_kind IN ('episode','topic')),
        title TEXT NOT NULL,
        atom_ids TEXT NOT NULL DEFAULT '[]',
        summary TEXT,
        content_hash TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
        derived_from TEXT,
        superseded_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scenes_kind ON scenes(scene_kind);
      CREATE INDEX IF NOT EXISTS idx_scenes_status ON scenes(status);
      CREATE VIRTUAL TABLE IF NOT EXISTS scenes_fts
        USING fts5(title, summary, scene_id UNINDEXED, tokenize='porter unicode61');
      CREATE VIRTUAL TABLE IF NOT EXISTS scenes_vec
        USING vec0(scene_id TEXT PRIMARY KEY, embedding float[${d}]);

      CREATE TABLE IF NOT EXISTS scene_atoms (
        scene_id TEXT NOT NULL REFERENCES scenes(scene_id),
        atom_id TEXT NOT NULL REFERENCES atoms(id),
        PRIMARY KEY (scene_id, atom_id)
      );
      CREATE INDEX IF NOT EXISTS idx_scene_atoms_atom ON scene_atoms(atom_id);
    `);
  }

  /** Additive migration: adds columns to pre-existing tables for stores that
   *  were created before Branch A. Safe to call multiple times (idempotent). */
  private migrate() {
    const now = new Date().toISOString();

    // stream: add turn_index, turn_id if missing (unique indexes already in initSchema IF NOT EXISTS)
    if (this.tableExists("stream") && !this.hasColumn("stream", "turn_index")) {
      this.db.exec("ALTER TABLE stream ADD COLUMN turn_index INTEGER");
    }
    if (this.tableExists("stream") && !this.hasColumn("stream", "turn_id")) {
      this.db.exec("ALTER TABLE stream ADD COLUMN turn_id TEXT");
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
  }

  // ─── T0 Stream ──────────────────────────────────────────────────────────────

  async addStream(sessionId: string, items: StreamItem[]): Promise<string[]> {
    const ids: string[] = [];
    const ins = this.db.prepare(
      "INSERT INTO stream(id,session_id,role,content,ts,turn_index,turn_id) VALUES(?,?,?,?,?,?,?)"
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

  async searchStream(query: string, limit = 10): Promise<StreamHit[]> {
    return this.hybridStream(query, limit);
  }

  /** Delete stream turns. Returns the set of atom ids whose evidence was affected. */
  deleteStream(p: { ids?: string[]; session_id?: string }): { deleted_count: number; affected_atom_ids: string[] } {
    const affectedSet = new Set<string>();

    const collectAndRemoveEvidence = (streamIds: string[]) => {
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
    };

    let deleted_count = 0;
    if (p.ids?.length) {
      collectAndRemoveEvidence(p.ids);
      const del = this.db.prepare("DELETE FROM stream WHERE id=?");
      for (const id of p.ids) deleted_count += del.run(id).changes;
    } else if (p.session_id) {
      const rows = this.db.prepare("SELECT id FROM stream WHERE session_id=?")
        .all(p.session_id) as Array<{ id: string }>;
      collectAndRemoveEvidence(rows.map((r) => r.id));
      deleted_count = this.db.prepare("DELETE FROM stream WHERE session_id=?").run(p.session_id).changes;
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

    const now = new Date().toISOString();
    const id = a.id ?? randomUUID();
    const bg: string | null =
      a.background == null ? null
      : typeof a.background === "string" ? a.background
      : typeof a.background === "object" ? JSON.stringify(a.background)
      : String(a.background);
    const priority = a.priority ?? 100;
    const pinned = a.pinned ?? false;
    const tags = JSON.stringify(a.tags ?? []);

    const existing = this.db.prepare(
      "SELECT id,type,content,created_at FROM atoms WHERE id=?"
    ).get(id) as any;

    if (existing) {
      // Content/type are immutable: reject changes to either.
      if (existing.content !== a.content) {
        throw new AtomImmutabilityError(
          `Atom '${id}' content is immutable. To change the proposition, record a new atom with supersedes='${id}'.`
        );
      }
      if (existing.type !== type) {
        throw new AtomImmutabilityError(
          `Atom '${id}' type is immutable. To change the type, record a new atom with supersedes='${id}'.`
        );
      }
      // Metadata-only update (background, priority, confidence, pinned, tags).
      this.db.prepare(
        "UPDATE atoms SET background=?,priority=?,confidence=?,pinned=?,tags=?,updated_at=? WHERE id=?"
      ).run(bg, priority, confidence, pinned ? 1 : 0, tags, now, id);
      // Update FTS and vector index (content unchanged but re-index for consistency).
      this.db.prepare("DELETE FROM atoms_fts WHERE id=?").run(id);
      this.db.prepare("DELETE FROM atoms_vec WHERE id=?").run(id);
      this.db.prepare("INSERT INTO atoms_fts(content,id) VALUES(?,?)").run(a.content, id);
      this.db.prepare("INSERT INTO atoms_vec(id,embedding) VALUES(?,?)")
        .run(id, this.vecBuf(await this.embed(a.content)));
      return rowToAtom(this.db.prepare("SELECT * FROM atoms WHERE id=?").get(id) as any);
    }

    // New atom.
    this.db.prepare(
      `INSERT INTO atoms(id,type,content,background,priority,confidence,pinned,status,tags,
       source_turn_ids,source_session_ids,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, type, a.content, bg, priority, confidence, pinned ? 1 : 0,
      "active", tags, "[]", "[]", now, now
    );
    this.db.prepare("INSERT INTO atoms_fts(content,id) VALUES(?,?)").run(a.content, id);
    this.db.prepare("INSERT INTO atoms_vec(id,embedding) VALUES(?,?)")
      .run(id, this.vecBuf(await this.embed(a.content)));
    return rowToAtom(this.db.prepare("SELECT * FROM atoms WHERE id=?").get(id) as any);
  }

  /** Mark an atom as superseded by a new atom. */
  supersedeAtom(oldId: string, newId: string): void {
    this.db.prepare("UPDATE atoms SET status='superseded',updated_at=? WHERE id=?")
      .run(new Date().toISOString(), oldId);
    this.markScenesDirty(oldId);
  }

  /** Merge multiple atoms into a winner (losers become 'merged'). */
  mergeAtoms(loserIds: string[], winnerId: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare("UPDATE atoms SET status='merged',updated_at=? WHERE id=?");
    for (const id of loserIds) {
      stmt.run(now, id);
      this.markScenesDirty(id);
    }
  }

  /** Archive an atom (retire without replacement). */
  archiveAtom(id: string): void {
    this.db.prepare("UPDATE atoms SET status='archived',updated_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
    this.markScenesDirty(id);
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

  /** Mark every scene that contains this atom as needing re-derivation. */
  private markScenesDirty(_atomId: string): void {
    // In Branch A the scenes table exists but derivation runs in Branch B.
    // When B writes scene_atoms rows, this path will cascade correctly because
    // scenesForAtom() and the hash-gated passes read scene_atoms. No-op here.
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

  /** @deprecated use supersedeAtom/mergeAtoms/archiveAtom for lifecycle management. */
  deleteAtoms(ids: string[]): number {
    let n = 0;
    for (const id of ids) {
      this.db.prepare("DELETE FROM atom_evidence WHERE atom_id=?").run(id);
      this.db.prepare("DELETE FROM scene_atoms WHERE atom_id=?").run(id);
      this.db.prepare("DELETE FROM atoms_fts WHERE id=?").run(id);
      this.db.prepare("DELETE FROM atoms_vec WHERE id=?").run(id);
      n += this.db.prepare("DELETE FROM atoms WHERE id=?").run(id).changes;
    }
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
  }): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO consolidation_decisions
       (id,pass_id,action,atom_id,target_ids,rationale,decided_at)
       VALUES(?,?,?,?,?,?,?)`
    ).run(
      d.id, d.pass_id, d.action,
      d.atom_id ?? null,
      d.target_ids ? JSON.stringify(d.target_ids) : null,
      d.rationale ?? null,
      new Date().toISOString(),
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
   * Re-embedding is gated on whether title or summary changed since the last
   * index pass (tracked via content_hash comparison). If unchanged, the embed
   * call and mirror write are skipped.
   */
  private async syncSceneRendering(scene: Scene): Promise<void> {
    const { scene_id, title, summary, scene_kind } = scene;

    // FTS: always sync title+summary from the persisted scene.
    this.db.prepare("DELETE FROM scenes_fts WHERE scene_id=?").run(scene_id);
    this.db.prepare("INSERT INTO scenes_fts(title,summary,scene_id) VALUES(?,?,?)")
      .run(title, summary ?? "", scene_id);

    // Vector: embed title + summary together if summary present, else title alone.
    // Check whether existing embedding was built from the same text to avoid
    // re-embedding when only structural fields (membership, status) changed.
    const embedText = summary ? `${title}\n${summary}` : title;
    const existingVec = this.db.prepare("SELECT 1 FROM scenes_vec WHERE scene_id=?").get(scene_id);
    // Always re-embed on insert; on update, only re-embed when the rendering
    // inputs (title/summary) may have changed. We use a simple sentinel: if
    // there's no existing vec row (new scene) or the scene was just written
    // with a new content_hash (caller-supplied), always embed. Otherwise skip
    // to avoid a network/compute call for a membership-only update.
    const needsEmbed = !existingVec || scene.content_hash !== null;
    if (needsEmbed) {
      this.db.prepare("DELETE FROM scenes_vec WHERE scene_id=?").run(scene_id);
      this.db.prepare("INSERT INTO scenes_vec(scene_id,embedding) VALUES(?,?)")
        .run(scene_id, this.vecBuf(await this.embed(embedText)));
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

  close() { this.db.close(); }
}
