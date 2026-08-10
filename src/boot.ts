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
 */
export function selectEmbedder(dim: number, label = "FALDA"): Embedder {
  const mode = (process.env.FALDA_EMBED ?? "").toLowerCase();
  const hasRemote = !!process.env.FALDA_EMBED_BASE_URL;
  if (mode === "local") { console.log(`${label} embedder: local (offline, deterministic)`); return makeLocalEmbedder(dim); }
  if (mode === "remote" || hasRemote) { console.log(`${label} embedder: remote (${process.env.FALDA_EMBED_BASE_URL ?? "http://localhost:11434/v1"})`); return makeEmbedder(); }
  console.log(`${label} embedder: local (offline default; set FALDA_EMBED_BASE_URL for dense recall)`);
  return makeLocalEmbedder(dim);
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
      `Serving would corrupt recall. Fix FALDA_EMBED_MODEL/FALDA_DIM to match, or re-embed the store and update the manifest.`);
    process.exit(1);
  }
  console.log(`${label} embedding lock: OK model=${model} dim=${dim}`);
}
