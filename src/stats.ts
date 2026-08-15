/**
 * FALDA status/interrogation tool — `falda stats`.
 *
 * Read-only, offline, in-process report of everything under FALDA_ROOT:
 * per-store tier counts (T0 stream / T1 atoms / T2 scenes / T3 core), the
 * distillation queue's job backlog, recall-usage metrics, and on-disk
 * config/layout (embedding lock, token file, pool registry). Composes
 * existing public primitives (Falda's own query methods, listJobs,
 * computeRecallMetrics) rather than adding new store surface area.
 *
 * Deliberately does NOT go through buildRuntime() (src/runtime.ts):
 *   - No FALDA_TOKENS file is required — this is a host-side diagnostic,
 *     not a request that needs a bearer token.
 *   - No embedding-lock enforcement (enforceEmbeddingLock would process.exit
 *     on a mismatch) — a stats report should never crash because the
 *     operator's current env doesn't match a store's locked embedder.
 *   - No embedder is invoked at all: every store is opened as a plain
 *     read-only `better-sqlite3` connection and inspected with hand-rolled
 *     COUNT/GROUP BY SQL against the tables `Falda`'s initSchema() creates
 *     (src/falda.ts). This works even against a `vec0` virtual-table schema
 *     without loading the sqlite-vec extension, because we only ever touch
 *     the plain tables (stream/atoms/scenes), never the `_vec`/`_fts` ones.
 *
 * Usage:
 *   tsx src/stats.ts [--root=<dir>] [--tenant=<t>] [--pool=<p>]
 *                     [--section=stores|queue|recall|layout]
 *                     [--json]
 *
 * Env (same precedence as src/runtime.ts, no other env required):
 *   FALDA_ROOT   Pool root dir (default ./falda-data)
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── types ──────────────────────────────────────────────────────────────────

export type StoreScope = "self" | "pool";

export interface StoreRef {
  /** "<tenant>:self" or "<tenant-or-pool-name>:pool" — human label only. */
  label: string;
  scope: StoreScope;
  /** Tenant for self stores; pool name for pool stores. */
  name: string;
  dbPath: string;
  blobDir: string;
}

export interface AtomStatusCounts {
  active: number; superseded: number; merged: number; archived: number;
}

export interface SceneCounts {
  episode_active: number; episode_retired: number;
  topic_active: number; topic_retired: number;
}

export interface StoreReport {
  store: StoreRef;
  ok: true;
  stream_total: number;
  stream_head_seq: number | null;
  atoms: AtomStatusCounts;
  atoms_pinned: number;
  scenes: SceneCounts;
  core_present: boolean;
  core_chars: number;
}

export interface StoreReportError {
  store: StoreRef;
  ok: false;
  error: string;
}

export interface QueueReport {
  present: boolean;
  by_status: Record<string, number>;
  dead_jobs: Array<{ id: string; store_key: string; attempts: number; error: string | null; updated_at: string }>;
  oldest_pending: { id: string; store_key: string; created_at: string } | null;
}

export interface RecallReport {
  present: boolean;
  by_store: Array<{ store_key: string; trace_count: number; item_count: number }>;
}

export interface LayoutReport {
  root: string;
  root_exists: boolean;
  queue_db: { path: string; present: boolean };
  recall_traces_db: { path: string; present: boolean };
  pools_json: { path: string; present: boolean; pool_count: number };
  embedding_lock: { path: string; present: boolean; model?: string; dim?: number };
  tokens_file: { path: string; present: boolean };
}

export interface Warning {
  level: "warn" | "error";
  message: string;
}

export type Section = "stores" | "queue" | "recall" | "layout";

export interface StatsReport {
  generated_at: string;
  root: string;
  sections: Section[];
  stores: Array<StoreReport | StoreReportError>;
  queue: QueueReport;
  recall: RecallReport;
  layout: LayoutReport;
  warnings: Warning[];
}

// ─── store enumeration ──────────────────────────────────────────────────────

/** Self-tenant stores: root/tenants/<tenant>/self/falda.db.
 *  Mirrors PoolManager.listSelfTenants() (src/pools.ts) without opening a
 *  PoolManager (which would create tenants/ and pools/ dirs as a side effect
 *  on an otherwise-empty root — undesirable for a read-only inspector). */
function listSelfStores(root: string): StoreRef[] {
  const tenantsDir = path.join(root, "tenants");
  let entries: string[];
  try { entries = fs.readdirSync(tenantsDir); } catch { return []; }
  const out: StoreRef[] = [];
  for (const tenant of entries) {
    const dir = path.join(tenantsDir, tenant, "self");
    const dbPath = path.join(dir, "falda.db");
    try {
      if (fs.statSync(dbPath).isFile()) {
        out.push({ label: `${tenant}:self`, scope: "self", name: tenant, dbPath, blobDir: path.join(dir, "blobs") });
      }
    } catch { /* not a store dir, skip */ }
  }
  return out;
}

/** Pool stores: every pool declared in pools.json (root/pools.json), whether
 *  or not its falda.db has been materialized yet (declarePool creates the
 *  dir eagerly, src/pools.ts, but a store with zero writes has no db file
 *  until first open — report it as present-but-empty rather than omitting it). */
function listPoolStores(root: string): StoreRef[] {
  const regPath = path.join(root, "pools.json");
  let reg: { pools?: Record<string, unknown> };
  try { reg = JSON.parse(fs.readFileSync(regPath, "utf8")); } catch { return []; }
  const names = Object.keys(reg.pools ?? {});
  return names.map((name) => {
    const dir = path.join(root, "pools", name);
    return { label: `${name}:pool`, scope: "pool" as const, name, dbPath: path.join(dir, "falda.db"), blobDir: path.join(dir, "blobs") };
  });
}

export function listAllStores(root: string): StoreRef[] {
  return [...listSelfStores(root), ...listPoolStores(root)];
}

// ─── per-store inspection (raw read-only SQL, no Falda/embedder involved) ──

const ATOM_STATUSES = ["active", "superseded", "merged", "archived"] as const;

function countWhere(db: Database.Database, table: string, where: string, args: unknown[] = []): number {
  const row = db.prepare(`SELECT COUNT(*) c FROM ${table} ${where}`).get(...args) as { c: number };
  return row.c;
}

export function inspectStore(store: StoreRef): StoreReport | StoreReportError {
  let db: Database.Database | undefined;
  try {
    if (!fs.existsSync(store.dbPath)) {
      // Declared pool with no store materialized yet: report zeros, not an error.
      return {
        store, ok: true,
        stream_total: 0, stream_head_seq: null,
        atoms: { active: 0, superseded: 0, merged: 0, archived: 0 },
        atoms_pinned: 0,
        scenes: { episode_active: 0, episode_retired: 0, topic_active: 0, topic_retired: 0 },
        core_present: false, core_chars: 0,
      };
    }
    db = new Database(store.dbPath, { readonly: true, fileMustExist: true });

    const streamTotal = countWhere(db, "stream", "");
    const headRow = db.prepare("SELECT MAX(seq) m FROM stream").get() as { m: number | null };

    const atoms: AtomStatusCounts = { active: 0, superseded: 0, merged: 0, archived: 0 };
    for (const s of ATOM_STATUSES) atoms[s] = countWhere(db, "atoms", "WHERE status=?", [s]);
    const pinned = countWhere(db, "atoms", "WHERE status='active' AND pinned=1");

    const scenes: SceneCounts = {
      episode_active: countWhere(db, "scenes", "WHERE scene_kind='episode' AND status='active'"),
      episode_retired: countWhere(db, "scenes", "WHERE scene_kind='episode' AND status='retired'"),
      topic_active: countWhere(db, "scenes", "WHERE scene_kind='topic' AND status='active'"),
      topic_retired: countWhere(db, "scenes", "WHERE scene_kind='topic' AND status='retired'"),
    };

    const corePath = path.join(store.blobDir, "core.md");
    const coreExists = fs.existsSync(corePath);
    const coreChars = coreExists ? fs.statSync(corePath).size : 0;

    return {
      store, ok: true,
      stream_total: streamTotal,
      stream_head_seq: headRow.m,
      atoms, atoms_pinned: pinned,
      scenes,
      core_present: coreExists, core_chars: coreChars,
    };
  } catch (e: any) {
    return { store, ok: false, error: String(e?.message ?? e) };
  } finally {
    db?.close();
  }
}

// ─── queue inspection ───────────────────────────────────────────────────────

const STALE_PENDING_MS = 15 * 60 * 1000; // matches the README's suggested worker interval order of magnitude

export function inspectQueue(root: string, warnings: Warning[]): QueueReport {
  const queuePath = path.join(root, "distill_queue.db");
  if (!fs.existsSync(queuePath)) return { present: false, by_status: {}, dead_jobs: [], oldest_pending: null };

  const db = new Database(queuePath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare("SELECT status, COUNT(*) c FROM distill_jobs GROUP BY status").all() as Array<{ status: string; c: number }>;
    const by_status: Record<string, number> = {};
    for (const r of rows) by_status[r.status] = r.c;

    const dead = db.prepare(
      "SELECT id, store_key, attempts, error, updated_at FROM distill_jobs WHERE status='dead' ORDER BY updated_at DESC"
    ).all() as QueueReport["dead_jobs"];
    if (dead.length) {
      warnings.push({ level: "error", message: `${dead.length} distillation job(s) dead-lettered (max attempts exhausted) — see queue.dead_jobs` });
    }

    const oldestPendingRow = db.prepare(
      "SELECT id, store_key, created_at FROM distill_jobs WHERE status='pending' ORDER BY created_at ASC LIMIT 1"
    ).get() as { id: string; store_key: string; created_at: string } | undefined;
    if (oldestPendingRow) {
      const ageMs = Date.now() - Date.parse(oldestPendingRow.created_at);
      if (ageMs > STALE_PENDING_MS) {
        warnings.push({
          level: "warn",
          message: `oldest pending distillation job (${oldestPendingRow.store_key}) has been waiting ` +
            `${Math.round(ageMs / 60000)} min — is the worker running (falda serve)?`,
        });
      }
    }

    return { present: true, by_status, dead_jobs: dead, oldest_pending: oldestPendingRow ?? null };
  } finally {
    db.close();
  }
}

// ─── recall trace inspection ────────────────────────────────────────────────

export function inspectRecall(root: string): RecallReport {
  const tracePath = path.join(root, "recall_traces.db");
  if (!fs.existsSync(tracePath)) return { present: false, by_store: [] };

  const db = new Database(tracePath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(
      `SELECT t.store_key AS store_key, COUNT(DISTINCT t.recall_id) AS trace_count, COUNT(i.recall_id) AS item_count
       FROM recall_traces t LEFT JOIN recall_trace_items i ON i.recall_id = t.recall_id
       GROUP BY t.store_key ORDER BY t.store_key`
    ).all() as Array<{ store_key: string; trace_count: number; item_count: number }>;
    return { present: true, by_store: rows };
  } finally {
    db.close();
  }
}

// ─── layout / config inspection ─────────────────────────────────────────────

export function inspectLayout(root: string, warnings: Warning[]): LayoutReport {
  const queueDbPath = path.join(root, "distill_queue.db");
  const traceDbPath = path.join(root, "recall_traces.db");
  const poolsJsonPath = path.join(root, "pools.json");
  const lockPath = path.join(root, "EMBEDDING.json");
  const tokensPath = process.env.FALDA_TOKENS ?? "./falda_tokens.json";

  let poolCount = 0;
  try { poolCount = Object.keys(JSON.parse(fs.readFileSync(poolsJsonPath, "utf8")).pools ?? {}).length; } catch { /* absent/malformed */ }

  let lock: { model?: string; dim?: number } = {};
  const lockPresent = fs.existsSync(lockPath);
  if (lockPresent) {
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      lock = { model: parsed.model, dim: parsed.dim };
      const envDim = process.env.FALDA_DIM ? Number(process.env.FALDA_DIM) : undefined;
      const envModel = process.env.FALDA_EMBED_MODEL;
      if (envDim !== undefined && parsed.dim !== undefined && Number(parsed.dim) !== envDim) {
        warnings.push({ level: "error", message: `EMBEDDING.json dim=${parsed.dim} but FALDA_DIM=${envDim} in this shell — a server started with this env would refuse to boot (see src/boot.ts enforceEmbeddingLock)` });
      }
      if (envModel !== undefined && parsed.model !== undefined && parsed.model !== envModel) {
        warnings.push({ level: "warn", message: `EMBEDDING.json model=${parsed.model} but FALDA_EMBED_MODEL=${envModel} in this shell` });
      }
    } catch {
      warnings.push({ level: "warn", message: `EMBEDDING.json exists but could not be parsed at ${lockPath}` });
    }
  }

  const tokensPresent = fs.existsSync(tokensPath);
  if (!tokensPresent) {
    warnings.push({ level: "warn", message: `no token file found at ${tokensPath} (FALDA_TOKENS) — falda serve would refuse to start` });
  }

  return {
    root,
    root_exists: fs.existsSync(root),
    queue_db: { path: queueDbPath, present: fs.existsSync(queueDbPath) },
    recall_traces_db: { path: traceDbPath, present: fs.existsSync(traceDbPath) },
    pools_json: { path: poolsJsonPath, present: fs.existsSync(poolsJsonPath), pool_count: poolCount },
    embedding_lock: { path: lockPath, present: lockPresent, ...lock },
    tokens_file: { path: tokensPath, present: tokensPresent },
  };
}

// ─── top-level report assembly ──────────────────────────────────────────────

export interface StatsOptions {
  root?: string;
  tenant?: string;
  pool?: string;
  sections?: Section[];
}

const ALL_SECTIONS = ["stores", "queue", "recall", "layout"] as const;

export function buildStatsReport(opts: StatsOptions = {}): StatsReport {
  const root = opts.root ?? process.env.FALDA_ROOT ?? "./falda-data";
  const sections = opts.sections?.length ? opts.sections : [...ALL_SECTIONS];
  const warnings: Warning[] = [];

  let allStores = listAllStores(root);
  if (opts.tenant) allStores = allStores.filter((s) => s.scope === "self" && s.name === opts.tenant);
  if (opts.pool) allStores = allStores.filter((s) => s.scope === "pool" && s.name === opts.pool);

  const stores = sections.includes("stores") ? allStores.map(inspectStore) : [];
  for (const s of stores) if (!s.ok) warnings.push({ level: "error", message: `store ${s.store.label} failed to open: ${s.error}` });

  const queue = sections.includes("queue")
    ? inspectQueue(root, warnings)
    : { present: false, by_status: {}, dead_jobs: [], oldest_pending: null };
  const recall = sections.includes("recall") ? inspectRecall(root) : { present: false, by_store: [] };
  const layout = sections.includes("layout")
    ? inspectLayout(root, warnings)
    : { root, root_exists: fs.existsSync(root), queue_db: { path: "", present: false }, recall_traces_db: { path: "", present: false }, pools_json: { path: "", present: false, pool_count: 0 }, embedding_lock: { path: "", present: false }, tokens_file: { path: "", present: false } };

  if (allStores.length === 0 && sections.includes("stores")) {
    warnings.push({ level: "warn", message: `no stores found under ${root} (no tenants/, no declared pools) — has anything been written yet?` });
  }

  return { generated_at: new Date().toISOString(), root, sections, stores, queue, recall, layout, warnings };
}

// ─── human-readable rendering ───────────────────────────────────────────────

function fmtAtoms(a: AtomStatusCounts): string {
  return `active=${a.active} superseded=${a.superseded} merged=${a.merged} archived=${a.archived}`;
}
function fmtScenes(s: SceneCounts): string {
  return `episodes=${s.episode_active}/${s.episode_retired} (active/retired) topics=${s.topic_active}/${s.topic_retired}`;
}

export function renderHuman(report: StatsReport): string {
  const lines: string[] = [];
  lines.push(`FALDA stats — root=${report.root} @ ${report.generated_at}`);

  if (report.sections.includes("stores")) {
    lines.push("", "## Stores");
    if (!report.stores.length) {
      lines.push("  (none found)");
    } else {
      for (const s of report.stores) {
        if (!s.ok) { lines.push(`  ✗ ${s.store.label}: ERROR — ${s.error}`); continue; }
        lines.push(`  ${s.store.label}`);
        lines.push(`      stream: ${s.stream_total} turns (head seq=${s.stream_head_seq ?? "-"})`);
        lines.push(`      atoms:  ${fmtAtoms(s.atoms)} (pinned=${s.atoms_pinned})`);
        lines.push(`      scenes: ${fmtScenes(s.scenes)}`);
        lines.push(`      core:   ${s.core_present ? `present (${s.core_chars} chars)` : "absent"}`);
      }
    }
  }

  if (report.sections.includes("queue")) {
    lines.push("", "## Distillation queue");
    if (!report.queue.present) {
      lines.push("  (no distill_queue.db found)");
    } else {
      const parts = Object.entries(report.queue.by_status).map(([k, v]) => `${k}=${v}`);
      lines.push(`  jobs: ${parts.length ? parts.join(" ") : "none"}`);
      if (report.queue.oldest_pending) {
        lines.push(`  oldest pending: ${report.queue.oldest_pending.store_key} (${report.queue.oldest_pending.created_at})`);
      }
      if (report.queue.dead_jobs.length) {
        lines.push(`  dead-lettered (${report.queue.dead_jobs.length}):`);
        for (const j of report.queue.dead_jobs) lines.push(`    - ${j.store_key} attempts=${j.attempts} error=${j.error ?? "?"}`);
      }
    }
  }

  if (report.sections.includes("recall")) {
    lines.push("", "## Recall metrics");
    if (!report.recall.present) {
      lines.push("  (no recall_traces.db found)");
    } else if (!report.recall.by_store.length) {
      lines.push("  no recall traces recorded yet");
    } else {
      for (const r of report.recall.by_store) lines.push(`  ${r.store_key}: ${r.trace_count} traces, ${r.item_count} items`);
    }
  }

  if (report.sections.includes("layout")) {
    lines.push("", "## Layout", `  root: ${report.layout.root} (${report.layout.root_exists ? "exists" : "MISSING"})`);
    lines.push(`  distill_queue.db:  ${report.layout.queue_db.present ? "present" : "absent"}`);
    lines.push(`  recall_traces.db:  ${report.layout.recall_traces_db.present ? "present" : "absent"}`);
    lines.push(`  pools.json:        ${report.layout.pools_json.present ? `present (${report.layout.pools_json.pool_count} pool(s))` : "absent"}`);
    lines.push(`  EMBEDDING.json:    ${report.layout.embedding_lock.present ? `model=${report.layout.embedding_lock.model} dim=${report.layout.embedding_lock.dim}` : "absent"}`);
    lines.push(`  token file:        ${report.layout.tokens_file.present ? "present" : "absent"} (${report.layout.tokens_file.path})`);
  }

  if (report.warnings.length) {
    lines.push("", "## Warnings");
    for (const w of report.warnings) lines.push(`  [${w.level.toUpperCase()}] ${w.message}`);
  } else {
    lines.push("", "No warnings.");
  }

  return lines.join("\n");
}

// ─── CLI entry point ────────────────────────────────────────────────────────

function parseArgs(argv: string[]): StatsOptions & { json: boolean } {
  const opts: StatsOptions & { json: boolean } = { json: false };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--root=")) opts.root = arg.slice("--root=".length);
    else if (arg.startsWith("--tenant=")) opts.tenant = arg.slice("--tenant=".length);
    else if (arg.startsWith("--pool=")) opts.pool = arg.slice("--pool=".length);
    else if (arg.startsWith("--section=")) {
      const requested = arg.slice("--section=".length).split(",").map((s) => s.trim());
      for (const s of requested) {
        if (!(ALL_SECTIONS as readonly string[]).includes(s)) {
          console.error(`falda stats: unknown --section '${s}' (valid: ${ALL_SECTIONS.join(", ")})`);
          process.exit(1);
        }
      }
      opts.sections = requested as Section[];
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: falda stats [--root=DIR] [--tenant=T] [--pool=P] " +
        "[--section=stores|queue|recall|layout[,...]] [--json]",
      );
      process.exit(0);
    } else {
      console.error(`falda stats: unknown argument '${arg}' (see --help)`);
      process.exit(1);
    }
  }
  return opts;
}

const IS_MAIN = process.argv[1]?.endsWith("stats.js") || process.argv[1]?.endsWith("stats.ts");
if (IS_MAIN) {
  const { json, ...statsOpts } = parseArgs(process.argv.slice(2));
  const report = buildStatsReport(statsOpts);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderHuman(report));
  }
  const hasErrors = report.warnings.some((w) => w.level === "error");
  process.exitCode = hasErrors ? 1 : 0;
}
