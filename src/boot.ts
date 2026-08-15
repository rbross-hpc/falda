/**
 * Shared boot helpers for FALDA server processes (gateway, MCP server, ...).
 *
 * Both the HTTP gateway and the MCP server need the same embedder selection
 * and embedding-lock enforcement so a store's dense vectors are never
 * silently corrupted by a mismatched model/dim across processes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeEmbedder, makeLocalEmbedder, type EmbedderConfig } from "./embedder.js";
import type { Embedder } from "./falda.js";

/**
 * Embedder selection:
 *   FALDA_EMBED=local                  -> deterministic offline embedder (no network)
 *   FALDA_EMBED=remote                 -> require a configured /v1/embeddings endpoint
 *   (unset) + FALDA_EMBED_BASE_URL set -> remote
 *   (unset) + no base URL                -> local offline default (so it just works)
 *
 * FALDA_EMBED_STRICT=1 turns the last case (unconfigured embedder silently
 * falling back to the deterministic local embedder) into a startup FATAL
 * instead. Off by default so `falda smoke`/tests and first-run "it just
 * works" behavior are unaffected — opt in for production deployments where
 * a misconfigured FALDA_EMBED_BASE_URL should never be able to silently
 * degrade recall to the fake embedder.
 */
export function selectEmbedder(dim: number, label = "FALDA"): Embedder {
  const mode = (process.env.FALDA_EMBED ?? "").toLowerCase();
  const hasRemote = !!process.env.FALDA_EMBED_BASE_URL;
  const strict = process.env.FALDA_EMBED_STRICT === "1";
  if (mode === "local") { console.log(`${label} embedder: local (offline, deterministic)`); return makeLocalEmbedder(dim); }
  if (mode === "remote" || hasRemote) { console.log(`${label} embedder: remote (${process.env.FALDA_EMBED_BASE_URL ?? "http://localhost:11434/v1"})`); return makeEmbedder(); }
  if (strict) {
    console.error(
      `FATAL: ${label} has no embedder configured (FALDA_EMBED unset, no FALDA_EMBED_BASE_URL) and ` +
      `FALDA_EMBED_STRICT=1 — refusing to silently fall back to the deterministic local embedder. ` +
      `Set FALDA_EMBED=local to opt into it explicitly, or configure FALDA_EMBED_BASE_URL/FALDA_EMBED_MODEL for a real embedder.`);
    process.exit(1);
  }
  console.log(`${label} embedder: local (offline default; set FALDA_EMBED_BASE_URL for dense recall)`);
  return makeLocalEmbedder(dim);
}

/**
 * Probe the selected embedder once at boot: call it with a fixed string and
 * verify the returned vector's length matches the configured dim. Catches
 * two failure modes enforceEmbeddingLock cannot see on its own (it only
 * compares env strings against the on-disk manifest, never calls the
 * embedder): a down/unreachable remote endpoint, and an endpoint that's up
 * but serving a different model/dimension than FALDA_DIM claims.
 *
 * Skipped for the local embedder (deterministic, dim-correct by
 * construction — probing it would just be a self-check of makeLocalEmbedder).
 *
 * Call this *before* enforceEmbeddingLock: on first boot, enforceEmbeddingLock
 * writes EMBEDDING.json from whatever FALDA_EMBED_MODEL/dim the env claims,
 * with no verification of its own (trust-on-first-use). Running the probe
 * first means that claim is already network-verified by the time it's
 * written, instead of being taken on faith — a down endpoint or wrong
 * dimension is caught before it ever gets locked in.
 *
 * Returns the probed vector's length (== dim, since a mismatch is fatal
 * above), or null if the probe was skipped (local embedder).
 */
export async function probeEmbedder(embed: Embedder, dim: number, label = "FALDA"): Promise<number | null> {
  const mode = (process.env.FALDA_EMBED ?? "").toLowerCase();
  const hasRemote = !!process.env.FALDA_EMBED_BASE_URL;
  if (mode === "local" || (!hasRemote && mode !== "remote")) return null; // local embedder: skip

  let vec: number[];
  try {
    vec = await embed("falda embedding startup probe");
  } catch (e: any) {
    console.error(`FATAL: ${label} embedding probe failed — could not reach the configured embedder ` +
      `(FALDA_EMBED_BASE_URL=${process.env.FALDA_EMBED_BASE_URL ?? "?"}): ${String(e?.message ?? e)}`);
    process.exit(1);
  }
  if (!Array.isArray(vec) || vec.length !== dim) {
    console.error(`FATAL: ${label} embedding probe returned a ${Array.isArray(vec) ? vec.length : typeof vec}-dim ` +
      `vector but FALDA_DIM=${dim} — the configured FALDA_EMBED_MODEL does not match FALDA_DIM. ` +
      `Fix FALDA_DIM to the model's real dimension, or point FALDA_EMBED_MODEL at a ${dim}-dim model.`);
    process.exit(1);
  }
  console.log(`${label} embedding probe: OK (${vec.length}-dim vector received)`);
  return vec.length;
}

/**
 * Embedding lock: verify running embed model+dim against the store's locked
 * manifest (EMBEDDING.json) at boot. Prevents silent recall corruption from a
 * same-dim/different-model swap, and broken inserts from a dim change.
 *
 * Shared across processes (gateway, MCP server, ...) addressing the same
 * FALDA_ROOT, so any process can be first-boot writer of the manifest.
 */
export function enforceEmbeddingLock(root: string, dim: number, label = "FALDA"): void {
  const path = join(root, "EMBEDDING.json");
  const model = process.env.FALDA_EMBED_MODEL ?? "";
  let locked: any;
  try {
    locked = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    locked = { model, dim, locked: true, locked_at: new Date().toISOString().slice(0, 10) };
    try { writeFileSync(path, JSON.stringify(locked, null, 2)); } catch {}
    console.log(`${label} embedding lock: initialized manifest model=${model} dim=${dim}`);
    return;
  }
  const mismatch: string[] = [];
  if (locked.model !== undefined && locked.model !== model) mismatch.push(`model ${locked.model} != ${model}`);
  if (locked.dim !== undefined && Number(locked.dim) !== dim) mismatch.push(`dim ${locked.dim} != ${dim}`);
  if (mismatch.length) {
    console.error(`FATAL: embedding config does not match locked store manifest (${path}): ${mismatch.join("; ")}. ` +
      `Serving would corrupt recall. Fix FALDA_EMBED_MODEL/FALDA_DIM to match, or run 'falda reembed --yes' ` +
      `to rebuild this store's vector indexes at the new model/dim (see docs/OPERATIONS.md).`);
    process.exit(1);
  }
  console.log(`${label} embedding lock: OK model=${model} dim=${dim}`);
}
