/**
 * `falda reembed` — rebuild dense-vector indexes after switching embedding
 * model/dimension.
 *
 * Why this exists: `enforceEmbeddingLock` (src/boot.ts) refuses to boot a
 * server whose FALDA_EMBED_MODEL/FALDA_DIM no longer match a store's locked
 * EMBEDDING.json manifest, and its error message has always said "re-embed
 * the store and update the manifest" — but no such command previously
 * existed. This is that command.
 *
 * What it does, per store (self tenant or declared pool):
 *   1. Opens the store with the currently configured embedder (the same
 *      FALDA_EMBED* / FALDA_DIM env this CLI is invoked with).
 *   2. Calls Falda.reembedAll() (src/falda.ts) — drops and recreates the
 *      atoms_vec/scenes_vec/stream_vec tables at the new dimension (the vec0
 *      dimension is baked into the schema, so a dim change cannot be done
 *      as a row-level rewrite) and re-embeds every atom/scene/turn's
 *      existing content, unchanged.
 *   3. Rewrites EMBEDDING.json to the new model/dim so a subsequent
 *      `falda serve` boots clean against enforceEmbeddingLock.
 *
 * Must be run with the server (and any other writer against these stores)
 * stopped: it holds no application-level lock across the multi-statement
 * rebuild, and a concurrent write could be silently dropped from the
 * rebuilt vector index (the source-of-truth tables — atoms/scenes/stream —
 * are untouched, so no data is lost, but a write racing the rebuild might
 * not get a vector until the *next* reembed or a normal upsert touches it).
 *
 * Usage:
 *   falda reembed --root=DIR [--tenant=T | --pool=P] [--dry-run] [--yes]
 *
 * Env (same embedder-selection env as any other FALDA process):
 *   FALDA_ROOT           Pool root dir (default ./falda-data)
 *   FALDA_DIM            Target embedding dimensionality (default 768)
 *   FALDA_EMBED*         Embedder selection — see src/boot.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Falda } from "./falda.js";
import { selectEmbedder, probeEmbedder } from "./boot.js";
import { listAllStores, type StoreRef } from "./stats.js";

export interface ReembedOptions {
  root?: string;
  tenant?: string;
  pool?: string;
  dryRun?: boolean;
}

export interface ReembedStoreResult {
  store: StoreRef;
  stream: number;
  atoms: number;
  scenes: number;
  dim: number;
}

/** Select which discovered stores a reembed run targets, honoring the same
 *  --tenant/--pool scoping `falda stats` uses. No filter = every store. */
export function selectStores(root: string, opts: { tenant?: string; pool?: string }): StoreRef[] {
  let stores = listAllStores(root);
  if (opts.tenant) stores = stores.filter((s) => s.scope === "self" && s.name === opts.tenant);
  if (opts.pool) stores = stores.filter((s) => s.scope === "pool" && s.name === opts.pool);
  return stores;
}

/** Re-embed one store in place and update its EMBEDDING.json-equivalent —
 *  actually the shared root-level EMBEDDING.json, since the lock is one
 *  manifest per FALDA_ROOT, not per store (see src/boot.ts). Callers should
 *  update the manifest once after all stores in a root have been processed
 *  (writeEmbeddingManifest below), not per-store. */
export async function reembedStore(store: StoreRef, dim: number, label = "falda-reembed"): Promise<ReembedStoreResult> {
  const embed = selectEmbedder(dim, label);
  const falda = new Falda({ dbPath: store.dbPath, blobDir: store.blobDir, embed, dim });
  try {
    const result = await falda.reembedAll((tier, done, total) => {
      if (done === total || done % 25 === 0) {
        console.log(`  [${store.label}] ${tier}: ${done}/${total}`);
      }
    });
    return { store, ...result };
  } finally {
    falda.close();
  }
}

/** Overwrite EMBEDDING.json with the new model/dim once every targeted
 *  store has been successfully re-embedded. Deliberately unconditional
 *  (unlike enforceEmbeddingLock's first-boot-only write) — this command's
 *  entire purpose is to update the lock after an intentional model/dim
 *  change. */
export function writeEmbeddingManifest(root: string, dim: number): void {
  const manifestPath = path.join(root, "EMBEDDING.json");
  const model = process.env.FALDA_EMBED_MODEL ?? "";
  const manifest = { model, dim, locked: true, locked_at: new Date().toISOString().slice(0, 10) };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function parseArgs(argv: string[]): ReembedOptions & { yes: boolean; help: boolean } {
  const opts: ReembedOptions & { yes: boolean; help: boolean } = { dryRun: false, yes: false, help: false };
  for (const arg of argv) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--yes") opts.yes = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--root=")) opts.root = arg.slice("--root=".length);
    else if (arg.startsWith("--tenant=")) opts.tenant = arg.slice("--tenant=".length);
    else if (arg.startsWith("--pool=")) opts.pool = arg.slice("--pool=".length);
    else {
      console.error(`falda reembed: unknown argument '${arg}' (see --help)`);
      process.exit(1);
    }
  }
  return opts;
}

const HELP = `Usage: falda reembed [--root=DIR] [--tenant=T | --pool=P] [--dry-run] [--yes]

Rebuilds dense-vector indexes for every store under FALDA_ROOT (or the one
selected by --tenant/--pool) using the currently configured embedder
(FALDA_EMBED*/FALDA_DIM), then updates EMBEDDING.json to match.

Run with the server stopped. See docs/OPERATIONS.md "Re-embedding after a
model/dimension change" for the full runbook.

  --root=DIR      Pool root dir (default: FALDA_ROOT env or ./falda-data)
  --tenant=T      Only re-embed this tenant's self store
  --pool=P        Only re-embed this declared pool's store
  --dry-run       Report which stores/counts would be affected; no writes
  --yes           Skip the interactive confirmation prompt
`;

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }

  const root = opts.root ?? process.env.FALDA_ROOT ?? "./falda-data";
  const dim = Number(process.env.FALDA_DIM ?? 768);

  const stores = selectStores(root, opts);
  if (!stores.length) {
    console.error(`falda reembed: no stores matched under ${root}` +
      (opts.tenant ? ` (tenant=${opts.tenant})` : opts.pool ? ` (pool=${opts.pool})` : ""));
    process.exit(1);
  }

  console.log(`falda reembed: root=${root} dim=${dim} FALDA_EMBED_MODEL=${process.env.FALDA_EMBED_MODEL ?? "(unset)"}`);
  console.log(`Targeting ${stores.length} store(s): ${stores.map((s) => s.label).join(", ")}`);

  // Probe the new embedder before touching anything — a down endpoint or a
  // dim mismatch should abort before any store's vec tables are dropped.
  const probeEmbed = selectEmbedder(dim, "falda-reembed");
  await probeEmbedder(probeEmbed, dim, "falda-reembed");

  if (opts.dryRun) {
    for (const s of stores) console.log(`  [dry-run] would re-embed ${s.label} (${s.dbPath})`);
    console.log("Dry run — no changes made.");
    return;
  }

  if (!opts.yes) {
    console.error(
      "Refusing to proceed without --yes (this rewrites every atoms_vec/scenes_vec/stream_vec table " +
      "in the targeted store(s) and overwrites EMBEDDING.json). Stop the server first, review the " +
      "targeted stores above, then re-run with --yes. Use --dry-run to preview without --yes.");
    process.exit(1);
  }

  const results: ReembedStoreResult[] = [];
  for (const store of stores) {
    console.log(`Re-embedding ${store.label} ...`);
    results.push(await reembedStore(store, dim));
  }

  writeEmbeddingManifest(root, dim);

  console.log("\nDone:");
  for (const r of results) {
    console.log(`  ${r.store.label}: stream=${r.stream} atoms=${r.atoms} scenes=${r.scenes} dim=${r.dim}`);
  }
  console.log(`EMBEDDING.json updated: model=${process.env.FALDA_EMBED_MODEL ?? ""} dim=${dim}`);
}

const IS_MAIN = process.argv[1]?.endsWith("reembed.js") || process.argv[1]?.endsWith("reembed.ts");
if (IS_MAIN) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
