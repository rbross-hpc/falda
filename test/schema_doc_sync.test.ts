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
 *
 * Beyond names, this also compares per-column NULLABILITY and DEFAULT value
 * (docs/future/reliability-hardening.md finding 13: a name-only comparison
 * previously let the doc and the runtime silently disagree about what a
 * column *means*, not just that it exists), and the set of INDEX names each
 * database creates, including whether a partial index's WHERE clause is
 * documented. Ordinary (non-virtual) tables only — FTS5/vec0 virtual tables
 * report no meaningful notnull/dflt_value via PRAGMA table_info (every
 * column comes back nullable with no default regardless of the DDL), so
 * those keep the pre-existing name-only check. CHECK-constraint text and the
 * `float[DIM]` vec0 placeholder remain intentionally out of scope — same
 * brittleness-avoidance rationale as the name-only comparison above.
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

/** Per-column semantic info: nullability + normalized default. Only
 *  meaningful for ordinary tables — see the file header note on virtual
 *  tables. */
interface ColumnInfo {
  notNull: boolean;
  /** Normalized default value, matching PRAGMA table_info's dflt_value
   *  string form (e.g. "0", "'active'", "'[]'"), or null if no default. */
  dflt: string | null;
}

interface TableColumnInfo {
  [table: string]: { [column: string]: ColumnInfo };
}

interface IndexInfo {
  /** Normalized (whitespace-collapsed) WHERE clause text if the index is
   *  partial, else null. */
  where: string | null;
  /** Table the index is declared on — used to scope a global doc-file parse
   *  down to the one database a given test is checking (tables.sql
   *  documents all three DBs' indexes in one file; live comparisons only
   *  see one DB's sqlite_master at a time). */
  table: string;
}

interface Indexes {
  [indexName: string]: IndexInfo;
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

/** Names of tables created via CREATE VIRTUAL TABLE (FTS5/vec0) — excluded
 *  from per-column notnull/default assertions since PRAGMA table_info
 *  reports no meaningful semantics for them (every column comes back
 *  nullable, no default, regardless of the declaring DDL). */
function virtualTableNames(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/** Live per-column nullability + default, ordinary tables only. */
function liveColumnInfo(db: Database.Database, skip: Set<string>): TableColumnInfo {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string }>;
  const out: TableColumnInfo = {};
  for (const { name } of tables) {
    if (skip.has(name) || name.includes("_fts_") || name.includes("_vec_")) continue;
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const info: { [column: string]: ColumnInfo } = {};
    for (const c of cols) {
      info[c.name] = { notNull: c.notnull === 1, dflt: c.dflt_value };
    }
    out[name] = info;
  }
  return out;
}

/** Live index name -> partial-WHERE text, excluding SQLite's own implicit
 *  autoindexes (sqlite_autoindex_*, which have no `sql` text and back a
 *  UNIQUE/PRIMARY KEY constraint that's already covered by the column-level
 *  comparison, not a separately-declared CREATE INDEX). */
function liveIndexes(db: Database.Database): Indexes {
  const rows = db
    .prepare(`SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`)
    .all() as Array<{ name: string; tbl_name: string; sql: string }>;
  const out: Indexes = {};
  for (const { name, tbl_name, sql } of rows) {
    const whereMatch = sql.match(/\bWHERE\b([\s\S]*)$/i);
    out[name] = { table: tbl_name, where: whereMatch ? normalizeWhitespace(whereMatch[1]) : null };
  }
  return out;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Normalize a DEFAULT literal to PRAGMA table_info's dflt_value string
 *  form: bare numbers pass through unchanged; single-quoted string literals
 *  keep their quotes (PRAGMA reports "'active'", not "active"). */
function normalizeDefaultLiteral(raw: string): string {
  return raw.trim();
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
  const out: TableColumns = {};
  const info = parseDocColumnInfo(sqlText);
  for (const table of Object.keys(info)) {
    out[table] = new Set(Object.keys(info[table]));
  }
  return out;
}

/** Names of tables docs/schema/tables.sql declares via CREATE VIRTUAL
 *  TABLE — parallel to virtualTableNames() for the live schema. */
function docVirtualTableNames(sqlText: string): Set<string> {
  const noLineComments = stripLineComments(sqlText);
  const names = new Set<string>();
  const re = /CREATE VIRTUAL TABLE IF NOT EXISTS (\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noLineComments))) names.add(m[1]);
  return names;
}

function stripLineComments(sqlText: string): string {
  return sqlText
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

/** Parse docs/schema/tables.sql into per-column nullability + normalized
 *  default, for both ordinary and virtual tables (virtual-table columns get
 *  { notNull: false, dflt: null } uniformly, matching the live-schema side's
 *  decision to skip semantic checks for them — this function still needs to
 *  report their column NAMES for the existing name-set comparison). */
function parseDocColumnInfo(sqlText: string): TableColumnInfo {
  const noLineComments = stripLineComments(sqlText);
  const out: TableColumnInfo = {};
  const headerRe = /CREATE (TABLE|VIRTUAL TABLE) IF NOT EXISTS (\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(noLineComments))) {
    const kind = m[1];
    const table = m[2];
    const openIdx = noLineComments.indexOf("(", m.index);
    const closeIdx = findMatchingParen(noLineComments, openIdx);
    const body = noLineComments.slice(openIdx + 1, closeIdx);
    const cols: { [column: string]: ColumnInfo } = {};
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
      if (!colMatch) continue;
      const colName = colMatch[1];
      if (kind === "VIRTUAL TABLE") {
        cols[colName] = { notNull: false, dflt: null };
        continue;
      }
      const notNull = /\bNOT\s+NULL\b/i.test(line);
      const defaultMatch = line.match(/\bDEFAULT\s+('(?:[^']|'')*'|-?\w+)/i);
      cols[colName] = { notNull, dflt: defaultMatch ? normalizeDefaultLiteral(defaultMatch[1]) : null };
    }
    out[table] = cols;
  }
  return out;
}

/** Parse docs/schema/tables.sql's CREATE [UNIQUE] INDEX statements into the
 *  same shape as liveIndexes(). */
function parseDocIndexes(sqlText: string): Indexes {
  const noLineComments = stripLineComments(sqlText);
  const out: Indexes = {};
  const re = /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)\s+ON\s+(\w+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noLineComments))) {
    const name = m[1];
    const table = m[2];
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingParen(noLineComments, openIdx);
    // A partial index's WHERE clause follows the closing paren, up to the
    // statement-terminating semicolon.
    const afterParen = noLineComments.slice(closeIdx + 1);
    const semiIdx = afterParen.indexOf(";");
    const tail = semiIdx >= 0 ? afterParen.slice(0, semiIdx) : afterParen;
    const whereMatch = tail.match(/\bWHERE\b([\s\S]*)$/i);
    out[name] = { table, where: whereMatch ? normalizeWhitespace(whereMatch[1]) : null };
  }
  return out;
}

/** Scope a global (whole-doc-file) index map down to the indexes declared
 *  on tables that exist in `tableNames` — used to compare one DB's live
 *  indexes against just its slice of the doc file. */
function indexesForTables(indexes: Indexes, tableNames: Set<string>): Indexes {
  const out: Indexes = {};
  for (const [name, info] of Object.entries(indexes)) {
    if (tableNames.has(info.table)) out[name] = info;
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

/** Assert per-column nullability + default match, ordinary tables only
 *  (virtual-table columns are excluded on both sides before this is
 *  called — see the file header note). */
function assertColumnSemanticsMatch(label: string, live: TableColumnInfo, documented: TableColumnInfo) {
  for (const table of Object.keys(live)) {
    const docCols = documented[table];
    assert.ok(docCols, `${label}: table "${table}" exists at runtime but is not documented`);
    for (const col of Object.keys(live[table])) {
      const liveInfo = live[table][col];
      const docInfo = docCols[col];
      assert.ok(docInfo, `${label}: column "${table}.${col}" exists at runtime but is not documented`);
      assert.equal(
        liveInfo.notNull,
        docInfo.notNull,
        `${label}: "${table}.${col}" NOT NULL mismatch — runtime is ${
          liveInfo.notNull ? "NOT NULL" : "nullable"
        }, docs/schema/tables.sql documents it as ${docInfo.notNull ? "NOT NULL" : "nullable"}`
      );
      assert.equal(
        liveInfo.dflt,
        docInfo.dflt,
        `${label}: "${table}.${col}" DEFAULT mismatch — runtime default is ${JSON.stringify(
          liveInfo.dflt
        )}, docs/schema/tables.sql documents ${JSON.stringify(docInfo.dflt)}`
      );
    }
  }
}

/** Assert the set of index names (and, for partial indexes, their WHERE
 *  clause) matches between the live schema and the doc. */
function assertIndexesMatch(label: string, live: Indexes, documented: Indexes) {
  const liveNames = new Set(Object.keys(live));
  const docNames = new Set(Object.keys(documented));
  for (const name of liveNames) {
    assert.ok(docNames.has(name), `${label}: index "${name}" exists at runtime but is not documented in docs/schema/tables.sql`);
  }
  for (const name of docNames) {
    assert.ok(
      liveNames.has(name),
      `${label}: docs/schema/tables.sql documents index "${name}" but the runtime schema does not have it (stale doc)`
    );
  }
  for (const name of liveNames) {
    if (!docNames.has(name)) continue;
    assert.equal(
      live[name].where,
      documented[name].where,
      `${label}: index "${name}" partial-WHERE mismatch — runtime is ${JSON.stringify(
        live[name].where
      )}, docs/schema/tables.sql documents ${JSON.stringify(documented[name].where)}`
    );
  }
}

const docSchemaPath = path.join(import.meta.dirname, "..", "docs", "schema", "tables.sql");
const docSchemaText = fs.readFileSync(docSchemaPath, "utf8");
const documentedSchema = parseDocSchema(docSchemaText);
const documentedColumnInfo = parseDocColumnInfo(docSchemaText);
const documentedVirtualTables = docVirtualTableNames(docSchemaText);
const documentedIndexes = parseDocIndexes(docSchemaText);

test("docs/schema/tables.sql matches falda.db's runtime schema", () => {
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-schema-sync-"));
  const store = new Falda({ dbPath: ":memory:", blobDir, embed: makeLocalEmbedder(8), dim: 8 });
  const db = (store as any).db as Database.Database;
  // distill_watermark/core_state are initialized against the store's db
  // connection by the distill package (src/distill/core.ts), not by the
  // Falda constructor itself — replicate that here so this test covers the
  // full falda.db schema, not just the tables initSchema() (src/store/
  // schema.ts, invoked from Falda's constructor) creates.
  initWatermarkSchema(db);
  initCoreStateSchema(db);
  const live = stripFtsVecShadowTables(liveSchema(db));
  assertSchemaDocumented("falda.db", live, documentedSchema);

  const virtualNames = virtualTableNames(db);
  assert.deepEqual(virtualNames, documentedVirtualTables, "falda.db: virtual-table name set mismatch between runtime and docs/schema/tables.sql");
  const liveCols = liveColumnInfo(db, virtualNames);
  assertColumnSemanticsMatch("falda.db", liveCols, documentedColumnInfo);
  assertIndexesMatch("falda.db", liveIndexes(db), indexesForTables(documentedIndexes, new Set(Object.keys(live))));
});

test("docs/schema/tables.sql matches distill_queue.db's runtime schema", () => {
  const db = new Database(":memory:");
  initQueueSchema(db);
  const live = liveSchema(db);
  assertSchemaDocumented("distill_queue.db", live, documentedSchema);
  assertColumnSemanticsMatch("distill_queue.db", liveColumnInfo(db, virtualTableNames(db)), documentedColumnInfo);
  assertIndexesMatch("distill_queue.db", liveIndexes(db), indexesForTables(documentedIndexes, new Set(Object.keys(live))));
});

test("docs/schema/tables.sql matches recall_traces.db's runtime schema", () => {
  const db = new Database(":memory:");
  initRecallTraceSchema(db);
  const live = liveSchema(db);
  assertSchemaDocumented("recall_traces.db", live, documentedSchema);
  assertColumnSemanticsMatch("recall_traces.db", liveColumnInfo(db, virtualTableNames(db)), documentedColumnInfo);
  assertIndexesMatch("recall_traces.db", liveIndexes(db), indexesForTables(documentedIndexes, new Set(Object.keys(live))));
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
