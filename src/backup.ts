/**
 * `falda backup` — consistent-snapshot backup of everything under
 * FALDA_ROOT (docs/future/reliability-hardening.md finding 10).
 *
 * Why this exists: durable state is spread across per-tenant/per-pool
 * `falda.db` files (WAL mode, src/falda.ts), `distill_queue.db` and
 * `recall_traces.db` (src/runtime.ts), `pools.json`/`EMBEDDING.json`, and
 * per-store blob directories (`core.md`, `scenes/*.md`, src/falda.ts). WAL
 * mode makes plain `cp` of a `.db` file unsafe (a copy taken mid-checkpoint,
 * or without its `-wal`/`-shm` sidecars, can be corrupt or stale). This tool
 * snapshots every SQLite file with `VACUUM INTO`, which produces one
 * consistent, sidecar-free file safe to copy — even against a live store —
 * then copies the JSON config and blob trees, and writes a manifest with a
 * SHA-256 checksum of every captured file so `falda restore` can verify
 * integrity before touching a target root.
 *
 * What is NOT captured (by design):
 *   - The bearer token file. It lives outside FALDA_ROOT (src/runtime.ts
 *     resolveTokensPath) and is a secret, not application data — back it up
 *     through the operator's own secret-management path.
 *   - distill_watermark / core_state / store_dirty rows inside each
 *     falda.db ARE captured (they're just tables in the same file), but
 *     they are explicitly disposable operational cursors (src/distill/
 *     watermark.ts) — losing them only costs an extra reconciliation pass,
 *     never data. Nothing special is done for them; they ride along.
 *
 * Deliberately does NOT go through buildRuntime() — no token file
 * requirement, no embedding-lock enforcement, no embedder invoked. Follows
 * the same offline/read-only conventions as `falda stats` (src/stats.ts)
 * and the CLI shape of `falda reembed` (src/reembed.ts).
 *
 * Usage:
 *   falda backup --out=DIR [--root=DIR] [--tenant=T | --pool=P] [--dry-run]
 *
 * Env:
 *   FALDA_ROOT   Pool root dir (default ./falda-data)
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { listAllStores, type StoreRef } from "./stats.js";

export interface BackupOptions {
  root?: string;
  out?: string;
  tenant?: string;
  pool?: string;
  dryRun?: boolean;
}

export interface ManifestFileEntry {
  /** Path relative to the backup root (and, on restore, relative to the
   *  target FALDA_ROOT) using forward slashes regardless of platform. */
  rel_path: string;
  bytes: number;
  sha256: string;
}

export interface ManifestStoreEntry {
  label: string;
  scope: "self" | "pool";
  name: string;
  /** Present only if the store's falda.db existed at backup time (a
   *  declared-but-never-written pool has no db file to snapshot). */
  db?: ManifestFileEntry;
  blobs: ManifestFileEntry[];
}

export interface BackupManifest {
  falda_version: string;
  created_at: string;
  /** Embedding dimension the source root was locked to, from
   *  EMBEDDING.json — undefined if the root has no lock yet. Restore
   *  refuses to write into a target root whose own EMBEDDING.json (if any)
   *  declares a different dim. */
  root_dim?: number;
  embedding_model?: string;
  stores: ManifestStoreEntry[];
  /** Root-level files: pools.json, EMBEDDING.json, distill_queue.db,
   *  recall_traces.db — whichever exist. */
  top_level: ManifestFileEntry[];
}

function sha256File(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function falcVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Select which discovered stores a backup run targets, honoring the same
 *  --tenant/--pool scoping `falda stats`/`falda reembed` use. No filter =
 *  every store. */
export function selectStores(root: string, opts: { tenant?: string; pool?: string }): StoreRef[] {
  let stores = listAllStores(root);
  if (opts.tenant) stores = stores.filter((s) => s.scope === "self" && s.name === opts.tenant);
  if (opts.pool) stores = stores.filter((s) => s.scope === "pool" && s.name === opts.pool);
  return stores;
}

/** VACUUM INTO a single SQLite file into destPath (must not already exist —
 *  VACUUM INTO refuses to overwrite). Produces one consistent, defragmented,
 *  sidecar-free file safe to copy even while the source is open under WAL. */
function vacuumInto(srcPath: string, destPath: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const db = new Database(srcPath, { readonly: true, fileMustExist: true });
  try {
    db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

function snapshotFile(srcPath: string, destPath: string, relRoot: string): ManifestFileEntry {
  vacuumInto(srcPath, destPath);
  const stat = fs.statSync(destPath);
  return { rel_path: toPosix(path.relative(relRoot, destPath)), bytes: stat.size, sha256: sha256File(destPath) };
}

function copyFileEntry(srcPath: string, destPath: string, relRoot: string): ManifestFileEntry {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  const stat = fs.statSync(destPath);
  return { rel_path: toPosix(path.relative(relRoot, destPath)), bytes: stat.size, sha256: sha256File(destPath) };
}

function copyDirRecursive(srcDir: string, destDir: string, relRoot: string, out: ManifestFileEntry[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return; // blobDir doesn't exist yet (never-written store) — nothing to copy.
  }
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dest, relRoot, out);
    } else if (entry.isFile()) {
      out.push(copyFileEntry(src, dest, relRoot));
    }
  }
}

/** Runs the backup: enumerates stores, snapshots every SQLite file with
 *  VACUUM INTO, copies blob dirs and root-level JSON/db files, and returns
 *  the manifest that was written to `<outDir>/backup-manifest.json`.
 *  Refuses to run if `outDir` already exists and is non-empty (a backup is
 *  always written into a fresh directory — no partial-overwrite path). */
export function runBackup(opts: { root: string; outDir: string; tenant?: string; pool?: string }): BackupManifest {
  const { root, outDir } = opts;
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`falda backup: --out=${outDir} already exists and is not empty; choose a fresh directory`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const stores = selectStores(root, opts);

  let rootDim: number | undefined;
  let embeddingModel: string | undefined;
  const lockPath = path.join(root, "EMBEDDING.json");
  if (fs.existsSync(lockPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      rootDim = parsed.dim;
      embeddingModel = parsed.model;
    } catch { /* malformed lock file — manifest just omits dim/model */ }
  }

  const storeEntries: ManifestStoreEntry[] = [];
  for (const store of stores) {
    const relDir = path.relative(root, path.dirname(store.dbPath));
    const destDir = path.join(outDir, relDir);
    const entry: ManifestStoreEntry = { label: store.label, scope: store.scope, name: store.name, blobs: [] };

    if (fs.existsSync(store.dbPath)) {
      entry.db = snapshotFile(store.dbPath, path.join(destDir, "falda.db"), outDir);
    }
    copyDirRecursive(store.blobDir, path.join(destDir, "blobs"), outDir, entry.blobs);

    storeEntries.push(entry);
  }

  const topLevel: ManifestFileEntry[] = [];
  for (const name of ["pools.json", "EMBEDDING.json"]) {
    const src = path.join(root, name);
    if (fs.existsSync(src)) topLevel.push(copyFileEntry(src, path.join(outDir, name), outDir));
  }
  for (const name of ["distill_queue.db", "recall_traces.db"]) {
    const src = path.join(root, name);
    if (fs.existsSync(src)) topLevel.push(snapshotFile(src, path.join(outDir, name), outDir));
  }

  const manifest: BackupManifest = {
    falda_version: falcVersion(),
    created_at: new Date().toISOString(),
    root_dim: rootDim,
    embedding_model: embeddingModel,
    stores: storeEntries,
    top_level: topLevel,
  };
  fs.writeFileSync(path.join(outDir, "backup-manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): BackupOptions & { help: boolean } {
  const opts: BackupOptions & { help: boolean } = { dryRun: false, help: false };
  for (const arg of argv) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--root=")) opts.root = arg.slice("--root=".length);
    else if (arg.startsWith("--out=")) opts.out = arg.slice("--out=".length);
    else if (arg.startsWith("--tenant=")) opts.tenant = arg.slice("--tenant=".length);
    else if (arg.startsWith("--pool=")) opts.pool = arg.slice("--pool=".length);
    else {
      console.error(`falda backup: unknown argument '${arg}' (see --help)`);
      process.exit(1);
    }
  }
  return opts;
}

const HELP = `Usage: falda backup --out=DIR [--root=DIR] [--tenant=T | --pool=P] [--dry-run]

Writes a consistent-snapshot backup of everything under FALDA_ROOT (or the
one store selected by --tenant/--pool) into a fresh directory: every
falda.db/distill_queue.db/recall_traces.db via SQLite VACUUM INTO (safe
under WAL, unlike a plain file copy), pools.json/EMBEDDING.json, and every
store's blob directory (core.md, scenes/*.md). Writes backup-manifest.json
with a SHA-256 checksum of every captured file.

Does NOT back up the bearer token file (a secret, outside FALDA_ROOT) —
back that up through your own secret-management path.

See docs/OPERATIONS.md "Backing up and restoring FALDA" for the full
runbook, including how to restore with \`falda restore\`.

  --root=DIR      Pool root dir (default: FALDA_ROOT env or ./falda-data)
  --out=DIR       Destination directory for the backup (must not already
                  exist and be non-empty)
  --tenant=T      Only back up this tenant's self store (plus root-level
                  files)
  --pool=P        Only back up this declared pool's store (plus root-level
                  files)
  --dry-run       Report which stores/files would be captured; no writes
`;

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }

  const root = opts.root ?? process.env.FALDA_ROOT ?? "./falda-data";
  if (!opts.out) {
    console.error("falda backup: --out=DIR is required (see --help)");
    process.exit(1);
  }
  const outDir = opts.out;

  const stores = selectStores(root, opts);
  if (!stores.length) {
    console.error(`falda backup: no stores matched under ${root}` +
      (opts.tenant ? ` (tenant=${opts.tenant})` : opts.pool ? ` (pool=${opts.pool})` : ""));
    process.exit(1);
  }

  console.log(`falda backup: root=${root} out=${outDir}`);
  console.log(`Targeting ${stores.length} store(s): ${stores.map((s) => s.label).join(", ")}`);

  if (opts.dryRun) {
    for (const s of stores) {
      console.log(`  [dry-run] would snapshot ${s.label} (${s.dbPath}${fs.existsSync(s.dbPath) ? "" : ", not yet materialized"})`);
    }
    console.log("Dry run — no changes made.");
    return;
  }

  const manifest = runBackup({ root, outDir, tenant: opts.tenant, pool: opts.pool });

  console.log("\nDone:");
  for (const s of manifest.stores) {
    console.log(`  ${s.label}: db=${s.db ? `${s.db.bytes}B` : "(not materialized)"} blobs=${s.blobs.length}`);
  }
  console.log(`Top-level files: ${manifest.top_level.map((f) => f.rel_path).join(", ") || "(none)"}`);
  console.log(`Manifest written: ${path.join(outDir, "backup-manifest.json")}`);
}

const IS_MAIN = process.argv[1]?.endsWith("backup.js") || process.argv[1]?.endsWith("backup.ts");
if (IS_MAIN) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
