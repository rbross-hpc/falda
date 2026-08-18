/**
 * Legacy-schema migration tests (docs/future/reliability-hardening.md
 * finding 6).
 *
 * `initSchema()` used to create indexes on columns that only migrate()
 * would add (stream.seq, stream.turn_index/turn_id, atoms.status/pinned).
 * Against a genuinely old on-disk store — one whose tables already exist
 * without those columns, so `CREATE TABLE IF NOT EXISTS` is a no-op —
 * `CREATE INDEX` on a nonexistent column throws at construction, before
 * migrate() ever runs. The only prior migration test reopened a database
 * already created by the *current* schema, so it never exercised this.
 *
 * These tests build real historical layouts directly with better-sqlite3
 * + sqlite-vec (bypassing Falda's constructor entirely), close that raw
 * handle, and then open the same file with `new Falda(...)` — the exact
 * upgrade path a real deployment would hit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Falda, LegacyMigrationError } from "../src/falda.js";
import { makeLocalEmbedder } from "../src/embedder.js";

const DIM = 32;

function tmpDbPath(prefix: string) {
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), `falda-legacy-${prefix}-`));
  const dbPath = path.join(blobDir, "test.db");
  return { blobDir, dbPath };
}

/** Opens a raw (non-Falda) handle for building a historical fixture. */
function rawOpen(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  return db;
}

function openFalda(dbPath: string, blobDir: string) {
  return new Falda({ dbPath, blobDir, embed: makeLocalEmbedder(DIM), dim: DIM });
}

function indexExists(db: any, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name);
}

// ─── Fixture 1: original / pre-Branch-A layout ─────────────────────────────

test("legacy migration: pre-Branch-A store (no turn_index/turn_id/seq, no atom lifecycle columns) opens cleanly", async () => {
  const { blobDir, dbPath } = tmpDbPath("prebrancha");
  try {
    const raw = rawOpen(dbPath);
    raw.exec(`
      CREATE TABLE stream (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE stream_fts
        USING fts5(content, id UNINDEXED, tokenize='porter unicode61');
      CREATE VIRTUAL TABLE stream_vec
        USING vec0(id TEXT PRIMARY KEY, embedding float[${DIM}]);

      CREATE TABLE atoms (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        background TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE atoms_fts
        USING fts5(content, id UNINDEXED, tokenize='porter unicode61');
      CREATE VIRTUAL TABLE atoms_vec
        USING vec0(id TEXT PRIMARY KEY, embedding float[${DIM}]);
    `);
    const now = new Date().toISOString();
    raw.prepare(
      "INSERT INTO stream(id,session_id,role,content,ts) VALUES(?,?,?,?,?)"
    ).run("s-old-1", "sess-legacy", "user", "first legacy turn", now);
    raw.prepare(
      "INSERT INTO stream(id,session_id,role,content,ts) VALUES(?,?,?,?,?)"
    ).run("s-old-2", "sess-legacy", "assistant", "second legacy turn", now);
    raw.prepare("INSERT INTO stream_fts(content,id) VALUES(?,?)").run("first legacy turn", "s-old-1");
    raw.prepare("INSERT INTO stream_fts(content,id) VALUES(?,?)").run("second legacy turn", "s-old-2");

    raw.prepare(
      "INSERT INTO atoms(id,type,content,created_at,updated_at) VALUES(?,?,?,?,?)"
    ).run("a-old-1", "fact", "a legacy fact", now, now);
    raw.close();

    // This must not throw. Before the fix, CREATE INDEX idx_stream_seq (etc.)
    // in initSchema() would fail here because `seq`/`turn_index`/etc. don't
    // exist on this table and initSchema() cannot add them.
    const s = openFalda(dbPath, blobDir);
    try {
      const db = (s as any).db;

      // historical rows survive unchanged
      const streamRows = db.prepare("SELECT * FROM stream ORDER BY rowid").all() as any[];
      assert.equal(streamRows.length, 2);
      assert.equal(streamRows[0].id, "s-old-1");
      assert.equal(streamRows[0].content, "first legacy turn");

      // added columns exist with sane values; seq backfilled in rowid order
      assert.equal(streamRows[0].seq, 1);
      assert.equal(streamRows[1].seq, 2);
      assert.equal(streamRows[0].turn_index, null);
      assert.equal(streamRows[0].turn_id, null);

      const atomRow = db.prepare("SELECT * FROM atoms WHERE id=?").get("a-old-1") as any;
      assert.equal(atomRow.priority, 100);
      assert.equal(atomRow.confidence, "medium");
      assert.equal(atomRow.pinned, 0);
      assert.equal(atomRow.status, "active");
      assert.equal(atomRow.tags, "[]");

      // every dependent index exists post-open
      for (const idx of [
        "idx_stream_seq", "idx_stream_session", "idx_stream_turn_index", "idx_stream_turn_id",
        "idx_atoms_status", "idx_atoms_type", "idx_atoms_pinned",
      ]) {
        assert.ok(indexExists(db, idx), `${idx} should exist after migration`);
      }

      // a live write + search works afterward
      await s.addStream("sess-legacy", [{ role: "user", content: "brand new turn after upgrade" }]);
      const hits = await s.searchStream("brand new turn", 5);
      assert.ok(hits.length >= 1);

      const { items } = s.queryAtoms({});
      assert.equal(items.length, 1);
      assert.equal(items[0].content, "a legacy fact");
    } finally {
      s.close();
    }

    // second reopen is a no-op
    const s2 = openFalda(dbPath, blobDir);
    try {
      const db2 = (s2 as any).db;
      const rows = db2.prepare("SELECT * FROM stream ORDER BY seq").all() as any[];
      assert.equal(rows.length, 3);
      assert.equal(rows[0].seq, 1);
      assert.equal(rows[1].seq, 2);
    } finally {
      s2.close();
    }
  } finally {
    fs.rmSync(blobDir, { recursive: true, force: true });
  }
});

// ─── Fixture 2: Branch-A / pre-seq layout ──────────────────────────────────

test("legacy migration: pre-seq store (turn idempotency + atom lifecycle columns present, no stream.seq) opens cleanly", async () => {
  const { blobDir, dbPath } = tmpDbPath("preseq");
  try {
    const raw = rawOpen(dbPath);
    raw.exec(`
      CREATE TABLE stream (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        ts TEXT NOT NULL,
        turn_index INTEGER,
        turn_id TEXT
      );
      CREATE INDEX idx_stream_session ON stream(session_id);
      CREATE UNIQUE INDEX idx_stream_turn_index
        ON stream(session_id, turn_index) WHERE turn_index IS NOT NULL;
      CREATE UNIQUE INDEX idx_stream_turn_id
        ON stream(session_id, turn_id) WHERE turn_id IS NOT NULL;
      CREATE VIRTUAL TABLE stream_fts
        USING fts5(content, id UNINDEXED, tokenize='porter unicode61');
      CREATE VIRTUAL TABLE stream_vec
        USING vec0(id TEXT PRIMARY KEY, embedding float[${DIM}]);

      CREATE TABLE atoms (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        background TEXT,
        priority INTEGER NOT NULL DEFAULT 100,
        confidence TEXT NOT NULL DEFAULT 'medium',
        pinned INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        tags TEXT NOT NULL DEFAULT '[]',
        supersedes TEXT,
        source_turn_ids TEXT NOT NULL DEFAULT '[]',
        source_session_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_atoms_status ON atoms(status);
      CREATE INDEX idx_atoms_type ON atoms(type);
      CREATE INDEX idx_atoms_pinned ON atoms(pinned) WHERE pinned=1;
      CREATE VIRTUAL TABLE atoms_fts
        USING fts5(content, id UNINDEXED, tokenize='porter unicode61');
      CREATE VIRTUAL TABLE atoms_vec
        USING vec0(id TEXT PRIMARY KEY, embedding float[${DIM}]);
    `);
    const now = new Date().toISOString();
    raw.prepare(
      `INSERT INTO stream(id,session_id,role,content,ts,turn_index,turn_id)
       VALUES(?,?,?,?,?,?,?)`
    ).run("s-b-1", "sess-b", "user", "branch-a turn one", now, 0, "t-1");
    raw.prepare(
      `INSERT INTO stream(id,session_id,role,content,ts,turn_index,turn_id)
       VALUES(?,?,?,?,?,?,?)`
    ).run("s-b-2", "sess-b", "assistant", "branch-a turn two", now, 1, "t-2");
    raw.close();

    const s = openFalda(dbPath, blobDir);
    try {
      const db = (s as any).db;
      const rows = db.prepare("SELECT * FROM stream ORDER BY rowid").all() as any[];
      assert.equal(rows[0].seq, 1);
      assert.equal(rows[1].seq, 2);
      assert.equal(rows[0].turn_index, 0);
      assert.equal(rows[1].turn_id, "t-2");

      assert.ok(indexExists(db, "idx_stream_seq"));
      assert.ok(indexExists(db, "idx_stream_turn_index"));
      assert.ok(indexExists(db, "idx_stream_turn_id"));

      // post-migration turn-idempotency invariant still enforced
      await assert.rejects(() => s.addStream("sess-b", [
        { role: "user", content: "dup", turn_index: 0 },
      ]));
    } finally {
      s.close();
    }
  } finally {
    fs.rmSync(blobDir, { recursive: true, force: true });
  }
});

// ─── Fixture 3: pre-render_hash / pre-candidate-audit layout ───────────────

test("legacy migration: pre-render_hash scenes + pre-candidate consolidation_decisions open cleanly", async () => {
  const { blobDir, dbPath } = tmpDbPath("prehash");
  try {
    const raw = rawOpen(dbPath);
    raw.exec(`
      CREATE TABLE stream (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, ts TEXT NOT NULL, turn_index INTEGER, turn_id TEXT, seq INTEGER
      );
      CREATE VIRTUAL TABLE stream_fts USING fts5(content, id UNINDEXED, tokenize='porter unicode61');
      CREATE VIRTUAL TABLE stream_vec USING vec0(id TEXT PRIMARY KEY, embedding float[${DIM}]);

      CREATE TABLE atoms (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL, background TEXT,
        priority INTEGER NOT NULL DEFAULT 100, confidence TEXT NOT NULL DEFAULT 'medium',
        pinned INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
        tags TEXT NOT NULL DEFAULT '[]', supersedes TEXT,
        source_turn_ids TEXT NOT NULL DEFAULT '[]', source_session_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE atoms_fts USING fts5(content, id UNINDEXED, tokenize='porter unicode61');
      CREATE VIRTUAL TABLE atoms_vec USING vec0(id TEXT PRIMARY KEY, embedding float[${DIM}]);

      CREATE TABLE consolidation_decisions (
        id TEXT PRIMARY KEY, pass_id TEXT NOT NULL, action TEXT NOT NULL,
        atom_id TEXT, target_ids TEXT, rationale TEXT, decided_at TEXT NOT NULL
      );

      CREATE TABLE scenes (
        scene_id TEXT PRIMARY KEY, scene_kind TEXT NOT NULL, title TEXT NOT NULL,
        atom_ids TEXT NOT NULL DEFAULT '[]', summary TEXT, content_hash TEXT,
        status TEXT NOT NULL DEFAULT 'active', derived_from TEXT, superseded_by TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE scenes_fts USING fts5(title, summary, scene_id UNINDEXED, tokenize='porter unicode61');
      CREATE VIRTUAL TABLE scenes_vec USING vec0(scene_id TEXT PRIMARY KEY, embedding float[${DIM}]);

      CREATE TABLE scene_atoms (
        scene_id TEXT NOT NULL REFERENCES scenes(scene_id),
        atom_id TEXT NOT NULL REFERENCES atoms(id),
        PRIMARY KEY (scene_id, atom_id)
      );
    `);
    const now = new Date().toISOString();
    raw.prepare(
      "INSERT INTO consolidation_decisions(id,pass_id,action,decided_at) VALUES(?,?,?,?)"
    ).run("dec-1", "pass-1", "skip", now);
    raw.prepare(
      `INSERT INTO scenes(scene_id,scene_kind,title,created_at,updated_at)
       VALUES(?,?,?,?,?)`
    ).run("scene-1", "topic", "legacy topic", now, now);
    raw.close();

    const s = openFalda(dbPath, blobDir);
    try {
      const db = (s as any).db;
      assert.ok(indexExists(db, "idx_scenes_kind"));
      assert.ok(indexExists(db, "idx_scenes_status"));
      assert.ok(indexExists(db, "idx_decisions_pass"));

      const dec = db.prepare("SELECT * FROM consolidation_decisions WHERE id=?").get("dec-1") as any;
      assert.equal(dec.candidate_type, null);
      assert.equal(dec.candidate_content, null);
      assert.equal(dec.candidate_confidence, null);

      const scene = db.prepare("SELECT * FROM scenes WHERE scene_id=?").get("scene-1") as any;
      assert.equal(scene.render_hash, null);
      assert.equal(scene.title, "legacy topic");
    } finally {
      s.close();
    }
  } finally {
    fs.rmSync(blobDir, { recursive: true, force: true });
  }
});

// ─── Fixture 4: duplicate historical keys fail loudly, not silently ───────

test("legacy migration: duplicate (session_id, turn_index) rows fail loudly with LegacyMigrationError", async () => {
  const { blobDir, dbPath } = tmpDbPath("duptidx");
  try {
    const raw = rawOpen(dbPath);
    raw.exec(`
      CREATE TABLE stream (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, ts TEXT NOT NULL, turn_index INTEGER, turn_id TEXT
      );
      CREATE VIRTUAL TABLE stream_fts USING fts5(content, id UNINDEXED, tokenize='porter unicode61');
      CREATE VIRTUAL TABLE stream_vec USING vec0(id TEXT PRIMARY KEY, embedding float[${DIM}]);
    `);
    const now = new Date().toISOString();
    // Two rows sharing (session_id, turn_index) — would violate the new
    // unique index. Only possible on a pre-constraint store.
    raw.prepare(
      "INSERT INTO stream(id,session_id,role,content,ts,turn_index) VALUES(?,?,?,?,?,?)"
    ).run("dup-1", "sess-dup", "user", "first", now, 0);
    raw.prepare(
      "INSERT INTO stream(id,session_id,role,content,ts,turn_index) VALUES(?,?,?,?,?,?)"
    ).run("dup-2", "sess-dup", "user", "duplicate turn_index", now, 0);
    raw.close();

    await assert.rejects(
      async () => openFalda(dbPath, blobDir),
      (err: unknown) => {
        assert.ok(err instanceof LegacyMigrationError, "must throw LegacyMigrationError");
        assert.match((err as Error).message, /turn_index/);
        assert.match((err as Error).message, /sess-dup/);
        return true;
      }
    );

    // The failed open must not leave a half-migrated store behind: the raw
    // table state (and, critically, no dependent index) should be exactly
    // as it was before the failed upgrade attempt.
    const raw2 = new Database(dbPath);
    try {
      assert.equal(
        raw2.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_stream_turn_index'").get(),
        undefined,
        "no partial index left behind after a failed upgrade"
      );
      const rows = raw2.prepare("SELECT id FROM stream ORDER BY rowid").all() as any[];
      assert.equal(rows.length, 2, "original rows untouched");
    } finally {
      raw2.close();
    }
  } finally {
    fs.rmSync(blobDir, { recursive: true, force: true });
  }
});

test("legacy migration: duplicate (session_id, turn_id) rows fail loudly with LegacyMigrationError", async () => {
  const { blobDir, dbPath } = tmpDbPath("duptid");
  try {
    const raw = rawOpen(dbPath);
    raw.exec(`
      CREATE TABLE stream (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, ts TEXT NOT NULL, turn_index INTEGER, turn_id TEXT
      );
      CREATE VIRTUAL TABLE stream_fts USING fts5(content, id UNINDEXED, tokenize='porter unicode61');
      CREATE VIRTUAL TABLE stream_vec USING vec0(id TEXT PRIMARY KEY, embedding float[${DIM}]);
    `);
    const now = new Date().toISOString();
    raw.prepare(
      "INSERT INTO stream(id,session_id,role,content,ts,turn_id) VALUES(?,?,?,?,?,?)"
    ).run("dup-1", "sess-dup2", "user", "first", now, "turn-x");
    raw.prepare(
      "INSERT INTO stream(id,session_id,role,content,ts,turn_id) VALUES(?,?,?,?,?,?)"
    ).run("dup-2", "sess-dup2", "user", "duplicate turn_id", now, "turn-x");
    raw.close();

    await assert.rejects(
      async () => openFalda(dbPath, blobDir),
      (err: unknown) => {
        assert.ok(err instanceof LegacyMigrationError, "must throw LegacyMigrationError");
        assert.match((err as Error).message, /turn_id/);
        assert.match((err as Error).message, /sess-dup2/);
        return true;
      }
    );
  } finally {
    fs.rmSync(blobDir, { recursive: true, force: true });
  }
});
