/**
 * Drift guard for docs/schema/tables.sql (docs/MODEL.md §14.5).
 *
 * Boots a fresh in-memory instance of every schema this codebase creates —
 * falda.db (via Falda), distill_queue.db (initQueueSchema),
 * distill_watermark/core_state (initWatermarkSchema/initCoreStateSchema,
 * which live inside falda.db but are initialized separately by the distill
 * package), and recall_traces.db (initRecallTraceSchema) — and asserts that
 * every table + column name the runtime actually creates is documented in
 * docs/schema/tables.sql, and vice versa.
 *
 * This intentionally compares table/column NAME SETS, not exact SQL text.
 * Exact-text comparison would be brittle against harmless formatting
 * differences and against columns that runtime migrations ADD at the end of
 * a table rather than inline (e.g. distill_jobs.priority/origin,
 * scenes.render_hash, stream.seq, recall_traces.mode) — none of which
 * change what a caller needs to know a column exists and is documented.
 * What this guards against is the actual failure mode that motivated this
 * file: a column silently added to (or removed from) the runtime schema
 * with nothing written down about it anywhere (docs/MODEL.md §14).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { Falda } from "../src/falda.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { initQueueSchema } from "../src/distill/queue.js";
import { initWatermarkSchema, initCoreStateSchema } from "../src/distill/watermark.js";
import { initRecallTraceSchema } from "../src/recall/schema.js";

interface TableColumns {
  [table: string]: Set<string>;
}

function liveSchema(db: Database.Database): TableColumns {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string }>;
  const out: TableColumns = {};
  for (const { name } of tables) {
    // FTS5/vec0 shadow tables (e.g. atoms_fts_data, atoms_fts_idx) are
    // internal storage for the virtual table, not a distinct entity — skip
    // anything that isn't the virtual table's own declared name by checking
    // it appears in sqlite_master with type='table' AND has a vtab module,
    // OR is a plain table. Simplest robust filter: shadow tables always
    // start with "<vtab_name>_" and are not registered as their own
    // CREATE VIRTUAL TABLE — but the virtual table's declared name itself
    // must be kept. We keep everything sqlite_master reports as a table
    // whose columns we can read; shadow tables are excluded below by name
    // pattern since they duplicate their parent virtual table's role.
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>;
    out[name] = new Set(cols.map((c) => c.name));
  }
  return out;
}

function stripFtsVecShadowTables(schema: TableColumns): TableColumns {
  const virtualNames = new Set(Object.keys(schema).filter((n) => !n.includes("_fts_") && !n.includes("_vec_")));
  const out: TableColumns = {};
  for (const name of Object.keys(schema)) {
    if (!virtualNames.has(name)) continue; // drop *_fts_data, *_fts_idx, *_vec_*, etc.
    out[name] = schema[name];
  }
  return out;
}

/** Find the index of the ")" that closes the "(" at openIdx, respecting nesting. */
function findMatchingParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced parens starting at index ${openIdx}`);
}

/** Split a column-definition body on top-level commas only (not commas
 *  nested inside a CHECK(...) or REFERENCES(...) clause). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
    else if (body[i] === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** Parse docs/schema/tables.sql into { table: Set<column> }, tolerant of
 *  comments, CHECK/DEFAULT/REFERENCES clauses, and the DIM placeholder. */
function parseDocSchema(sqlText: string): TableColumns {
  const noLineComments = sqlText
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");

  const out: TableColumns = {};
  const headerRe = /CREATE (?:TABLE|VIRTUAL TABLE) IF NOT EXISTS (\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(noLineComments))) {
    const table = m[1];
    const openIdx = noLineComments.indexOf("(", m.index);
    const closeIdx = findMatchingParen(noLineComments, openIdx);
    const body = noLineComments.slice(openIdx + 1, closeIdx);
    const cols = new Set<string>();
    for (const rawPart of splitTopLevel(body)) {
      const line = rawPart.trim();
      if (!line) continue;
      if (/^(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY)\b/i.test(line)) continue;
      // fts5 table-level options (e.g. tokenize='porter unicode61') are not
      // columns.
      if (/^tokenize\s*=/i.test(line)) continue;
      // Most columns are "name TYPE ...", but fts5 declares bare column
      // names ("content", "id UNINDEXED") with no type at all.
      const colMatch = line.match(/^(\w+)/);
      if (colMatch) cols.add(colMatch[1]);
    }
    out[table] = cols;
  }
  return out;
}

function assertSchemaDocumented(label: string, live: TableColumns, documented: TableColumns) {
  for (const table of Object.keys(live)) {
    assert.ok(
      documented[table],
      `${label}: table "${table}" exists at runtime but is not documented in docs/schema/tables.sql`
    );
    const liveCols = live[table];
    const docCols = documented[table];
    for (const col of liveCols) {
      assert.ok(
        docCols.has(col),
        `${label}: column "${table}.${col}" exists at runtime but is not documented in docs/schema/tables.sql`
      );
    }
    for (const col of docCols) {
      assert.ok(
        liveCols.has(col),
        `${label}: docs/schema/tables.sql documents "${table}.${col}" but the runtime schema does not have it ` +
          `(stale doc — remove or fix the column name)`
      );
    }
  }
}

const docSchemaPath = path.join(import.meta.dirname, "..", "docs", "schema", "tables.sql");
const documentedSchema = parseDocSchema(fs.readFileSync(docSchemaPath, "utf8"));

test("docs/schema/tables.sql matches falda.db's runtime schema", () => {
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-schema-sync-"));
  const store = new Falda({ dbPath: ":memory:", blobDir, embed: makeLocalEmbedder(8), dim: 8 });
  const db = (store as any).db as Database.Database;
  // distill_watermark/core_state are initialized against the store's db
  // connection by the distill package (src/distill/core.ts), not by the
  // Falda constructor itself — replicate that here so this test covers the
  // full falda.db schema, not just the tables Falda.initSchema creates.
  initWatermarkSchema(db);
  initCoreStateSchema(db);
  const live = stripFtsVecShadowTables(liveSchema(db));
  assertSchemaDocumented("falda.db", live, documentedSchema);
});

test("docs/schema/tables.sql matches distill_queue.db's runtime schema", () => {
  const db = new Database(":memory:");
  initQueueSchema(db);
  const live = liveSchema(db);
  assertSchemaDocumented("distill_queue.db", live, documentedSchema);
});

test("docs/schema/tables.sql matches recall_traces.db's runtime schema", () => {
  const db = new Database(":memory:");
  initRecallTraceSchema(db);
  const live = liveSchema(db);
  assertSchemaDocumented("recall_traces.db", live, documentedSchema);
});

test("docs/schema/tables.sql has no orphaned tables left over from a rename", () => {
  const documentedTables = new Set(Object.keys(documentedSchema));
  const expectedTables = new Set([
    "stream", "stream_fts", "stream_vec",
    "atoms", "atoms_fts", "atoms_vec",
    "atom_evidence", "consolidation_decisions",
    "distillation_passes", "pass_scene_effects", "pass_core_effects",
    "scenes", "scenes_fts", "scenes_vec", "scene_atoms",
    "distill_watermark", "core_state",
    "distill_jobs",
    "recall_traces", "recall_trace_items",
  ]);
  for (const t of expectedTables) {
    assert.ok(documentedTables.has(t), `docs/schema/tables.sql is missing expected table "${t}"`);
  }
  for (const t of documentedTables) {
    assert.ok(expectedTables.has(t), `docs/schema/tables.sql documents unexpected table "${t}" — update this test's expected list too`);
  }
});
