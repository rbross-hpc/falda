/**
 * `falda restore` — restore a FALDA_ROOT from a backup written by
 * `falda backup` (docs/future/reliability-hardening.md finding 10).
 *
 * Verifies the backup's manifest (docs/OPERATIONS.md "Backing up and
 * restoring FALDA") — every file's SHA-256 checksum, and that the backup's
 * locked embedding dimension (if any) doesn't conflict with the target
 * root's own EMBEDDING.json (if any) — before copying anything, then lays
 * the files out in the same tenants/<t>/self, pools/<p>, and root-level
 * layout `falda backup` captured them from (src/pools.ts).
 *
 * Refuses to restore into a non-empty target root unless --yes is passed
 * (mirrors the destructive-op gate `falda reembed --yes` uses) — restoring
 * into a fresh root and swapping it into place is the recommended path.
 *
 * Deliberately does NOT go through buildRuntime() — pure filesystem/SQLite
 * copy, no token file, no embedder. Run with every `falda serve` process
 * against the target root stopped.
 *
 * Usage:
 *   falda restore --from=DIR --root=DIR [--dry-run] [--yes]
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BackupManifest, ManifestFileEntry } from "./backup.js";
import { inspectStore, type StoreRef } from "./stats.js";

export interface RestoreOptions {
  from?: string;
  root?: string;
  dryRun?: boolean;
}

export interface RestoreVerification {
  label: string;
  ok: boolean;
  error?: string;
  stream_total?: number;
  atoms_active?: number;
}

export interface RestoreResult {
  manifest: BackupManifest;
  files_restored: number;
  verification: RestoreVerification[];
}

function sha256File(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/** Reads and structurally sanity-checks a backup-manifest.json — does not
 *  verify file checksums (see verifyManifestFiles for that, run against the
 *  backup dir before any copy happens). */
export function readManifest(backupDir: string): BackupManifest {
  const manifestPath = path.join(backupDir, "backup-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`falda restore: no backup-manifest.json found in ${backupDir} — is this a falda backup output dir?`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest;
  if (!Array.isArray(manifest.stores) || !Array.isArray(manifest.top_level)) {
    throw new Error(`falda restore: ${manifestPath} is malformed (missing stores/top_level)`);
  }
  return manifest;
}

/** Verifies every file the manifest claims exists in backupDir with the
 *  recorded byte size and SHA-256. Throws on the first mismatch, naming the
 *  file — a corrupt/truncated/tampered backup must never be silently
 *  restored. */
export function verifyManifestFiles(backupDir: string, manifest: BackupManifest): void {
  const entries: ManifestFileEntry[] = [...manifest.top_level];
  for (const s of manifest.stores) {
    if (s.db) entries.push(s.db);
    entries.push(...s.blobs);
  }
  for (const entry of entries) {
    const abs = path.join(backupDir, entry.rel_path);
    if (!fs.existsSync(abs)) {
      throw new Error(`falda restore: manifest references missing file ${entry.rel_path} — backup is incomplete or corrupt`);
    }
    const stat = fs.statSync(abs);
    if (stat.size !== entry.bytes) {
      throw new Error(`falda restore: ${entry.rel_path} size mismatch (expected ${entry.bytes}B, found ${stat.size}B) — backup is corrupt`);
    }
    const actual = sha256File(abs);
    if (actual !== entry.sha256) {
      throw new Error(`falda restore: ${entry.rel_path} checksum mismatch — backup is corrupt or was tampered with`);
    }
  }
}

/** Refuses if the target root already has an EMBEDDING.json whose dim
 *  disagrees with the backup's root_dim — restoring a store snapshot at one
 *  dimension into a root locked to a different one would leave the vec0
 *  tables and the lock manifest inconsistent (see src/boot.ts
 *  enforceEmbeddingLock, the same rationale `falda reembed` follows). */
export function checkDimCompatibility(targetRoot: string, manifest: BackupManifest): void {
  if (manifest.root_dim === undefined) return;
  const lockPath = path.join(targetRoot, "EMBEDDING.json");
  if (!fs.existsSync(lockPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (parsed.dim !== undefined && Number(parsed.dim) !== manifest.root_dim) {
      throw new Error(
        `falda restore: target root's EMBEDDING.json dim=${parsed.dim} but backup was taken at dim=${manifest.root_dim} — ` +
        `restoring would leave vec0 tables inconsistent with the lock. Restore into a fresh root instead.`
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("falda restore:")) throw e;
    // EMBEDDING.json exists but couldn't be parsed — not this function's
    // concern; let the restored file replace it.
  }
}

function isDirEmpty(dir: string): boolean {
  if (!fs.existsSync(dir)) return true;
  return fs.readdirSync(dir).length === 0;
}

function copyRecursive(src: string, dest: string): number {
  let count = 0;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      count += copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    count += 1;
  }
  return count;
}

/** Runs the restore: verifies the manifest, checks dim compatibility, then
 *  copies every captured file into targetRoot in its original layout, and
 *  finally runs inspectStore() against every restored store as a
 *  verification pass. Refuses a non-empty targetRoot unless force=true. */
export function runRestore(opts: { backupDir: string; targetRoot: string; force?: boolean }): RestoreResult {
  const { backupDir, targetRoot } = opts;
  const manifest = readManifest(backupDir);
  verifyManifestFiles(backupDir, manifest);
  checkDimCompatibility(targetRoot, manifest);

  if (!opts.force && !isDirEmpty(targetRoot)) {
    throw new Error(
      `falda restore: target root ${targetRoot} is not empty; refusing to restore into it without --yes. ` +
      `Restore into a fresh directory and swap it into place, or pass --yes to restore in place anyway.`
    );
  }
  fs.mkdirSync(targetRoot, { recursive: true });

  let filesRestored = 0;
  for (const name of manifest.top_level) {
    filesRestored += copyRecursive(path.join(backupDir, name.rel_path), path.join(targetRoot, name.rel_path));
  }
  for (const s of manifest.stores) {
    if (s.db) {
      filesRestored += copyRecursive(path.join(backupDir, s.db.rel_path), path.join(targetRoot, s.db.rel_path));
    }
    for (const blob of s.blobs) {
      filesRestored += copyRecursive(path.join(backupDir, blob.rel_path), path.join(targetRoot, blob.rel_path));
    }
  }

  const verification: RestoreVerification[] = manifest.stores.map((s) => {
    // Reconstruct the store's dir the same way falda backup laid it out
    // (src/pools.ts layout): tenants/<tenant>/self or pools/<pool>. Derive
    // from s.db's rel_path when captured (authoritative); fall back to the
    // canonical layout for a declared-but-never-materialized pool store.
    const dbRelDir = s.db
      ? path.dirname(s.db.rel_path)
      : s.scope === "self" ? path.join("tenants", s.name, "self") : path.join("pools", s.name);
    const storeRef: StoreRef = {
      label: s.label, scope: s.scope, name: s.name,
      dbPath: path.join(targetRoot, dbRelDir, "falda.db"),
      blobDir: path.join(targetRoot, dbRelDir, "blobs"),
    };
    const report = inspectStore(storeRef);
    if (!report.ok) return { label: s.label, ok: false, error: report.error };
    return { label: s.label, ok: true, stream_total: report.stream_total, atoms_active: report.atoms.active };
  });

  return { manifest, files_restored: filesRestored, verification };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): RestoreOptions & { yes: boolean; help: boolean } {
  const opts: RestoreOptions & { yes: boolean; help: boolean } = { dryRun: false, yes: false, help: false };
  for (const arg of argv) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--yes") opts.yes = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--from=")) opts.from = arg.slice("--from=".length);
    else if (arg.startsWith("--root=")) opts.root = arg.slice("--root=".length);
    else {
      console.error(`falda restore: unknown argument '${arg}' (see --help)`);
      process.exit(1);
    }
  }
  return opts;
}

const HELP = `Usage: falda restore --from=DIR --root=DIR [--dry-run] [--yes]

Restores a FALDA_ROOT from a backup produced by \`falda backup\`. Verifies
every file's SHA-256 checksum against backup-manifest.json before copying
anything, and refuses to restore a backup whose locked embedding dimension
conflicts with the target root's own EMBEDDING.json. After copying, runs a
verification pass (falda stats' inspectStore) over every restored store and
reports tier counts.

Run with every \`falda serve\` process against --root stopped. See
docs/OPERATIONS.md "Backing up and restoring FALDA" for the full runbook.

  --from=DIR   Backup directory (as written by \`falda backup --out=DIR\`)
  --root=DIR   Target root to restore into (default: FALDA_ROOT env or
               ./falda-data)
  --dry-run    Verify the backup and report what would be restored; no writes
  --yes        Required to restore into a non-empty target root
`;

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }

  if (!opts.from) {
    console.error("falda restore: --from=DIR is required (see --help)");
    process.exit(1);
  }
  const targetRoot = opts.root ?? process.env.FALDA_ROOT ?? "./falda-data";

  console.log(`falda restore: from=${opts.from} root=${targetRoot}`);

  let manifest: BackupManifest;
  try {
    manifest = readManifest(opts.from);
  } catch (e: any) {
    console.error(e?.message ?? String(e));
    process.exit(1);
  }
  console.log(`Backup: falda_version=${manifest.falda_version} created_at=${manifest.created_at} dim=${manifest.root_dim ?? "(none)"}`);
  console.log(`Stores in backup: ${manifest.stores.map((s) => s.label).join(", ") || "(none)"}`);

  console.log("Verifying checksums...");
  try {
    verifyManifestFiles(opts.from, manifest);
    checkDimCompatibility(targetRoot, manifest);
  } catch (e: any) {
    console.error(e?.message ?? String(e));
    process.exit(1);
  }
  console.log("Checksums OK; dimension compatible.");

  if (opts.dryRun) {
    console.log(`Dry run — would restore ${manifest.stores.length} store(s) + ${manifest.top_level.length} top-level file(s) into ${targetRoot}. No changes made.`);
    return;
  }

  if (!isDirEmpty(targetRoot) && !opts.yes) {
    console.error(
      `falda restore: target root ${targetRoot} is not empty. Refusing without --yes. ` +
      `Recommended: restore into a fresh directory, verify it, then swap it into place. ` +
      `Use --dry-run to preview without --yes.`
    );
    process.exit(1);
  }

  const result = runRestore({ backupDir: opts.from, targetRoot, force: opts.yes });

  console.log(`\nRestored ${result.files_restored} file(s).`);
  console.log("Verification:");
  for (const v of result.verification) {
    if (v.ok) console.log(`  ${v.label}: OK stream=${v.stream_total} atoms_active=${v.atoms_active}`);
    else console.log(`  ${v.label}: FAILED — ${v.error}`);
  }
  const failed = result.verification.filter((v) => !v.ok);
  if (failed.length) {
    console.error(`\n${failed.length} store(s) failed post-restore verification.`);
    process.exit(1);
  }
}

const IS_MAIN = process.argv[1]?.endsWith("restore.js") || process.argv[1]?.endsWith("restore.ts");
if (IS_MAIN) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
