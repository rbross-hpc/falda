/**
 * FALDA distillation core — L0 → L1 → L2 → L3 pipeline.
 *
 * Pure: no env reads, no HTTP server, no process.exit.
 * All I/O is through the Falda store (better-sqlite3, synchronous) and
 * the provided LLM function (async over fetch or similar).
 *
 * Transaction boundary (§8.5):
 *   L1 atom writes + evidence edges + consolidation_decisions + watermark
 *   advance all commit in one db.transaction(). L2 and L3 are independently
 *   retryable via hash-gating — they sit outside the L1 transaction.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import type { Falda, AtomType, AtomConfidence, SceneKind, StreamTurn } from "../falda.js";
import { VALID_TYPES, VALID_CONFIDENCE } from "./prompts.js";
import {
  extractionPrompt, consolidationPrompt, consolidationBatchPrompt,
  sceneTitlePrompt, sceneSummaryPrompt, coreSynthesisPrompt,
} from "./prompts.js";
import {
  initWatermarkSchema, getWatermark, setWatermark, passId,
  initCoreStateSchema, getCoreState, setCoreState, clearCoreState,
  initDirtySchema, isDirty, markDirty, clearDirty,
} from "./watermark.js";

export interface LLMFn {
  (prompt: string): Promise<string>;
}

export interface DistillOptions {
  storeKey?: string;
  windowSize?: number;
  candidateLimit?: number;
  /** Cosine-similarity threshold for assigning an atom to a topic cluster.
   *  Controls how similar an atom must be to a cluster's founding centroid
   *  to be considered part of that topic. */
  topicSimilarityThreshold?: number;
  /** Jaccard-overlap threshold for matching a freshly derived cluster to an
   *  existing topic scene (preserves scene identity across passes).
   *  Statistically distinct from topicSimilarityThreshold — 0.5 Jaccard
   *  and 0.5 cosine happen to share a number but mean different things. */
  sceneMatchThreshold?: number;
  /** Jaccard-churn threshold above which an existing topic scene is retired
   *  and a new one created (reorganization). */
  sceneReorgThreshold?: number;
  verbose?: boolean;
  /** Provenance recorded on the distillation_passes row (falda distill
   *  inspect) — which LLM/prompt policy/code version produced this pass's
   *  decisions. Purely informational; distillOnce behavior is unaffected
   *  by these values. */
  model?: string;
  promptVersion?: string;
  distillerVersion?: string;
}

export interface DistillResult {
  pass_id: string;
  turns_processed: number;
  atoms_stored: number;
  atoms_updated: number;
  atoms_merged: number;
  atoms_skipped: number;
  scenes_derived: number;
  core_regenerated: boolean;
}

const DEFAULT_WINDOW_SIZE = 20;
const DEFAULT_CANDIDATE_LIMIT = 8;
const DEFAULT_TOPIC_SIMILARITY_THRESHOLD = 0.5;
const DEFAULT_SCENE_MATCH_THRESHOLD = 0.5;
const DEFAULT_SCENE_REORG_THRESHOLD = 0.7;
const DEFAULT_CONSOLIDATION_BATCH = 20;
const DEFAULT_CONSOLIDATION_MAX_CHARS = 0;

/** Candidates per batched consolidation call. 1 restores the historical
 *  one-call-per-candidate behaviour. Chunking is not optional: the extraction
 *  prompt puts no ceiling on how many candidates it may return, so a single
 *  prompt is unbounded at the tail. */
function consolidationBatchSize(): number {
  const raw = Number(process.env.FALDA_DISTILL_CONSOLIDATION_BATCH);
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_CONSOLIDATION_BATCH;
}

/** Approximate char budget for one batched consolidation prompt, as a proxy
 *  for input tokens (no tokenizer is available here, and one would still be
 *  model-specific — a self-hosted deployment can point at anything). <= 0
 *  disables the check, which is also the default: FALDA_DISTILL_CONSOLIDATION_BATCH
 *  alone was the existing knob, and a new deployment should not have its
 *  batch sizing silently reshaped by a second cap it never asked for. Each
 *  candidate brings its own retrieved-neighbour text (up to candidateLimit
 *  existing atoms, full content each — see consolidationBatchPrompt), so a
 *  batch's built prompt size varies per chunk and can't be predicted from
 *  batchSize alone. */
function consolidationMaxChars(): number {
  const raw = Number(process.env.FALDA_DISTILL_CONSOLIDATION_MAX_CHARS);
  return Number.isFinite(raw) ? raw : DEFAULT_CONSOLIDATION_MAX_CHARS;
}

// ─── LLM response parsers ─────────────────────────────────────────────────────

interface CandidateAtom {
  type: AtomType;
  content: string;
  confidence: AtomConfidence;
}

function validateCandidate(obj: any): CandidateAtom | null {
  const type = obj?.type as string;
  const content = obj?.content as string;
  const confidence = obj?.confidence as string;
  if (!VALID_TYPES.includes(type as AtomType)) return null;
  if (!VALID_CONFIDENCE.includes(confidence as AtomConfidence)) return null;
  if (typeof content !== "string" || !content.trim()) return null;
  return { type: type as AtomType, content: content.trim(), confidence: confidence as AtomConfidence };
}

/** Discriminated result from parseCandidates: either a (possibly empty) valid
 *  candidate list, or a failure reason that must fail the pass. */
type CandidateParseResult =
  | { ok: true; candidates: CandidateAtom[] }
  | { ok: false; reason: string };

/**
 * Parse LLM extraction output into candidate atoms.
 *
 * Tolerates the common variations a chat model may emit despite "Output ONLY
 * the JSON lines / [] if nothing" instructions:
 *   1. Markdown code fences (```json … ```) — stripped before parsing.
 *   2. `[]` — intentional empty extraction (success, zero candidates).
 *   3. A JSON array of objects ([ {…}, {…} ]) — parsed as one unit; any
 *      invalid element fails the whole extraction.
 *   4. Newline-delimited JSON objects — scanned line-by-line; any
 *      object-looking line that is malformed or invalid fails the whole
 *      extraction. Non-object prose lines are tolerated when at least one
 *      valid object exists.
 *
 * Blank/whitespace-only responses and fully prose-only responses are failures.
 * This is in contrast to the old behaviour that silently returned [] in these
 * cases, advancing the watermark past the source window with zero memories
 * (docs/future/reliability-hardening.md finding 16).
 */
function parseCandidates(raw: string): CandidateParseResult {
  // Strip markdown code fences.
  const stripped = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();

  if (!stripped) return { ok: false, reason: "blank extraction response" };

  // Explicit empty sentinel — the model confirmed there is nothing to extract.
  if (stripped === "[]") return { ok: true, candidates: [] };

  // JSON array path.
  if (stripped.startsWith("[")) {
    let arr: unknown;
    try { arr = JSON.parse(stripped); } catch {
      return { ok: false, reason: "extraction response started with '[' but is not valid JSON" };
    }
    if (!Array.isArray(arr)) {
      return { ok: false, reason: "extraction response parsed as non-array JSON" };
    }
    const candidates: CandidateAtom[] = [];
    for (let i = 0; i < arr.length; i++) {
      const c = validateCandidate(arr[i]);
      if (!c) return { ok: false, reason: `array element ${i} failed candidate validation` };
      candidates.push(c);
    }
    return { ok: true, candidates };
  }

  // JSON-lines path.
  const candidates: CandidateAtom[] = [];
  for (const line of stripped.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue; // tolerate non-object prose
    let obj: unknown;
    try { obj = JSON.parse(trimmed); } catch {
      return { ok: false, reason: `extraction response contains malformed JSON object: ${trimmed.slice(0, 80)}` };
    }
    const c = validateCandidate(obj);
    if (!c) return { ok: false, reason: `extraction response contains invalid candidate fields: ${trimmed.slice(0, 80)}` };
    candidates.push(c);
  }
  if (candidates.length === 0) {
    return { ok: false, reason: "extraction response contained no JSON objects" };
  }
  return { ok: true, candidates };
}

export interface ConsolidationDecision {
  action: "store" | "update" | "merge" | "skip";
  target_ids: string[];
  rationale: string;
}

const CONSOLIDATION_ACTIONS = ["store", "update", "merge", "skip"] as const;

/**
 * Shared consolidation-decision validator used by both single and batch
 * parsers.
 *
 * Enforces:
 *   - action is a known value;
 *   - target_ids is an array of strings (no coercion — numbers/objects are
 *     invalid because they indicate a model that did not follow the contract);
 *   - entries are distinct (duplicate IDs would satisfy merge's nominal "2+"
 *     count without naming separate memories);
 *   - every target is present in allowedTargetIds (the IDs shown in the
 *     candidate's own prompt — prevents cross-candidate ID confusion);
 *   - action-specific cardinality:
 *       store / skip → exactly 0 targets
 *       update       → exactly 1 target
 *       merge        → at least 2 targets
 *
 * Returns a validated ConsolidationDecision or undefined (invalid).
 * Never synthesizes a "skip" for invalid responses (finding 16).
 * Rationale is tolerated as missing/non-string → "".
 */
function validateConsolidationDecision(
  obj: unknown,
  allowedTargetIds: ReadonlySet<string>,
): ConsolidationDecision | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const o = obj as Record<string, unknown>;

  const action = o.action;
  if (!CONSOLIDATION_ACTIONS.includes(action as any)) return undefined;
  const act = action as ConsolidationDecision["action"];

  if (!Array.isArray(o.target_ids)) return undefined;
  const ids: string[] = [];
  for (const entry of o.target_ids) {
    if (typeof entry !== "string") return undefined; // no coercion
    ids.push(entry);
  }

  // Duplicate check.
  if (new Set(ids).size !== ids.length) return undefined;

  // Membership check — every target must have been shown for this candidate.
  if (ids.some((id) => !allowedTargetIds.has(id))) return undefined;

  // Action-specific cardinality.
  if ((act === "store" || act === "skip") && ids.length !== 0) return undefined;
  if (act === "update" && ids.length !== 1) return undefined;
  if (act === "merge" && ids.length < 2) return undefined;

  return {
    action: act,
    target_ids: ids,
    rationale: typeof o.rationale === "string" ? o.rationale : "",
  };
}

/**
 * Parse a single consolidation LLM response.
 *
 * Returns a valid ConsolidationDecision, or undefined when the response is
 * malformed or fails strict validation. Callers must treat undefined as a
 * retryable failure — they must NOT silently convert it into a skip, which
 * would discard a validly-extracted candidate without any durable record
 * (finding 16).
 *
 * Valid action:"skip" is distinct from a parse failure and remains a
 * successful decision that advances the watermark.
 */
export function parseConsolidation(
  raw: string,
  allowedTargetIds: ReadonlySet<string>,
): ConsolidationDecision | undefined {
  const trimmed = raw.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) return undefined;
  try {
    const obj = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
    return validateConsolidationDecision(obj, allowedTargetIds);
  } catch {
    return undefined;
  }
}

/** Parse a batched consolidation reply into one decision per candidate.
 *
 *  Returns a dense array of length equal to allowedTargetIdsByCandidate.
 *  `undefined` means "no usable decision for this candidate", which the
 *  caller retries individually via decideIndividually(). That gap is
 *  deliberately distinct from a parsed `action: "skip"` — a valid explicit
 *  skip is a successful decision; `undefined` means the batch entry is absent
 *  or fails structural/action/cardinality/membership validation. Reusing a
 *  skip sentinel would make a bad reply look like N deliberate skips and
 *  silently discard a whole chunk without any audit trace.
 *
 *  Decisions are correlated by their stated `candidate` index, never by
 *  array position. An out-of-range or non-integer index is dropped rather
 *  than applied: a lost decision costs one candidate, but a misattributed
 *  one writes a wrong consolidation into memory with no trace.
 *
 *  A repeated in-range index is NOT known to occur with real model output
 *  (no observed incident as of this writing) — this is defensive handling
 *  for a plausible malformed reply, not a fix for something seen in
 *  production. The FIRST valid decision for that index is kept; later
 *  occurrences (valid or not) cannot override it. Failing the whole
 *  candidate to force an individual retry would be disproportionate for an
 *  unobserved failure mode, so `onDuplicateIndex` is called instead so the
 *  caller can emit a non-fatal warning without changing which decision is
 *  applied. This is reported whenever an in-range candidate index repeats,
 *  regardless of whether either occurrence's decision is itself valid — a
 *  batch reply that names candidate 0 twice with two malformed decisions is
 *  just as much a contract violation as one with two valid-but-conflicting
 *  decisions, and an operator should see it either way. `onDuplicateIndex`
 *  is itself non-fatal to parsing: an exception from the callback is
 *  swallowed rather than propagated, so a misbehaving observer can never
 *  cause an otherwise-resolvable batch to fail.
 *
 *  Structural/action/cardinality/membership validation is applied by the
 *  shared validateConsolidationDecision helper; batch entries that fail it
 *  are left unresolved (individual retry), not silently converted to skip.
 *
 *  Tries to parse the payload as a JSON array first. That array is treated
 *  as the batch payload itself — returned as-is, including reporting any
 *  duplicate indices, even if every element in it turns out to be invalid —
 *  as long as at least one element declares an integer, in-range
 *  `candidate` field. Only when NONE of its elements look candidate-shaped
 *  (e.g. the "array" actually captured is a bare single-decision object's
 *  own `target_ids` field, whose elements are plain strings) does parsing
 *  fall back to line-by-line scanning for parseable JSON objects. This
 *  distinction matters: without it, a compact batch reply where every
 *  duplicate entry also happens to be structurally invalid would silently
 *  fall through to the line scan and lose its duplicate-index signal. */
export function parseConsolidationBatch(
  raw: string,
  allowedTargetIdsByCandidate: ReadonlyArray<ReadonlySet<string>>,
  onDuplicateIndex?: (candidateIndex: number, occurrenceCount: number) => void,
): Array<ConsolidationDecision | undefined> {
  const n = allowedTargetIdsByCandidate.length;
  const out: Array<ConsolidationDecision | undefined> = new Array(n).fill(undefined);
  // Counts every syntactically valid, in-range candidate index seen, even
  // when that particular entry fails strict validation — duplication itself
  // is what we want visibility into, independent of which occurrence (if
  // any) turned out to be usable.
  const seenCount: number[] = new Array(n).fill(0);

  const isInRangeCandidateIndex = (obj: unknown): obj is { candidate: number } => {
    const idx = (obj as any)?.candidate;
    return Number.isInteger(idx) && idx >= 0 && idx < n;
  };

  const accept = (obj: any): boolean => {
    if (!isInRangeCandidateIndex(obj)) return false;
    const idx = obj.candidate;
    seenCount[idx]++;
    if (out[idx] !== undefined) return false; // duplicate index: keep the first valid decision
    const dec = validateConsolidationDecision(obj, allowedTargetIdsByCandidate[idx]);
    if (!dec) return false;
    out[idx] = dec;
    return true;
  };

  // Strip markdown code fences, mirroring parseCandidates.
  const stripped = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();

  // Non-fatal by design: reporting a duplicate must never itself fail
  // parsing. A throwing (or otherwise misbehaving) onDuplicateIndex must
  // not prevent already-resolved decisions from being returned, nor block
  // reporting of OTHER duplicated indices in the same reply.
  const reportDuplicates = () => {
    if (!onDuplicateIndex) return;
    for (let i = 0; i < n; i++) {
      if (seenCount[i] > 1) {
        try { onDuplicateIndex(i, seenCount[i]); } catch { /* non-fatal observer */ }
      }
    }
  };

  const arrStart = stripped.indexOf("[");
  const arrEnd = stripped.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) {
    try {
      const arr = JSON.parse(stripped.slice(arrStart, arrEnd + 1));
      if (Array.isArray(arr)) {
        // An element is "batch-shaped" if it declares an integer, in-range
        // `candidate` field, independent of whether the rest of it
        // validates. If ANY element is batch-shaped, this array IS the
        // batch payload — return it as-is (reporting duplicates) rather
        // than falling through to the line scan, even when every element
        // turns out to be invalid. Only when NO element is batch-shaped
        // (e.g. this "array" is actually a bare single-decision object's
        // own target_ids field, whose elements are plain strings/numbers)
        // does the line scan below get a chance to find the real object.
        let batchShaped = 0;
        arr.forEach((item) => {
          if (isInRangeCandidateIndex(item)) batchShaped++;
          accept(item);
        });
        if (batchShaped > 0) { reportDuplicates(); return out; }
      }
    } catch { /* fall through to the line scan */ }
  }

  // Line scan: accept any line that is a parseable JSON object.
  for (const line of stripped.split("\n")) {
    const trimmed = line.trim().replace(/,$/, "");
    if (!trimmed.startsWith("{")) continue;
    try { accept(JSON.parse(trimmed)); } catch { /* skip malformed line */ }
  }
  reportDuplicates();
  return out;
}

/** Group retrieved candidates into consolidation-batch chunks, respecting
 *  both `batchSize` (candidate count) and `maxChars` (approximate input
 *  size, via the prompt this batch would actually build — each candidate's
 *  neighbour set varies in size, so byte cost per candidate is not uniform
 *  and can't be predicted from count alone). Greedy packing fills each
 *  chunk closer to the cap than blind halving would, preserving more of
 *  batching's token savings.
 *
 *  maxChars <= 0 disables the size check entirely, reproducing the historical
 *  fixed-stride chunking byte for byte.
 *
 *  A lone candidate whose own prompt already exceeds maxChars is still sent
 *  — there is nothing smaller to try — matching the "never drop a candidate"
 *  rule the individual-retry fallback already follows. `warn` is called in
 *  that case so the operator has a trail without failing the pass. */
function packConsolidationChunks<T>(
  items: T[],
  batchSize: number,
  maxChars: number,
  buildPrompt: (chunk: T[]) => string,
  warn: (msg: string) => void,
): T[][] {
  if (maxChars <= 0) {
    const chunks: T[][] = [];
    for (let start = 0; start < items.length; start += batchSize) {
      chunks.push(items.slice(start, start + batchSize));
    }
    return chunks;
  }

  const chunks: T[][] = [];
  let current: T[] = [];

  const startNewChunk = (item: T) => {
    current = [item];
    const size = buildPrompt(current).length;
    if (size > maxChars) {
      warn(
        `[distill] a single candidate's consolidation prompt (${size} chars) exceeds ` +
          `FALDA_DISTILL_CONSOLIDATION_MAX_CHARS (${maxChars}); sending it alone`,
      );
    }
  };

  for (const item of items) {
    if (current.length === 0) {
      startNewChunk(item);
      continue;
    }
    const tentative = [...current, item];
    if (tentative.length <= batchSize && buildPrompt(tentative).length <= maxChars) {
      current = tentative;
    } else {
      chunks.push(current);
      startNewChunk(item);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ─── Stable atom id from content hash (for idempotent re-runs) ────────────────

function atomIdFromContent(type: string, content: string): string {
  return "l1-" + createHash("sha256").update(`${type}:${content}`).digest("hex").slice(0, 24);
}

/**
 * Deterministic episode scene_id for a given session.
 * Keyed by session identity, never by title — the title is pure presentation
 * and may be replaced by the LLM summary pass on every run (§6.2/§6.3).
 */
function episodeSceneId(sessionId: string): string {
  return "episode:" + createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}

// ─── Topic clustering (embedding-based cosine similarity) ─────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

interface AtomVec { id: string; vec: number[] }

/**
 * Greedy centroid clustering: atoms are assigned to the cluster whose founding
 * atom has the highest cosine similarity above topicSimilarityThreshold.
 * Input must be sorted deterministically (by id) to ensure insertion-order
 * independence — callers must guarantee this.
 */
function clusterAtoms(atoms: AtomVec[], topicSimilarityThreshold: number): Map<string, string[]> {
  const clusters = new Map<string, string[]>();
  const assigned = new Map<string, string>();

  for (const atom of atoms) {
    let bestCluster: string | null = null;
    let bestSim = -1;
    for (const [centroidId] of clusters) {
      const centroidAtom = atoms.find((a) => a.id === centroidId);
      if (!centroidAtom) continue;
      const sim = cosineSimilarity(atom.vec, centroidAtom.vec);
      if (sim > bestSim) { bestSim = sim; bestCluster = centroidId; }
    }
    if (bestCluster && bestSim >= topicSimilarityThreshold) {
      clusters.get(bestCluster)!.push(atom.id);
      assigned.set(atom.id, bestCluster);
    } else {
      clusters.set(atom.id, [atom.id]);
      assigned.set(atom.id, atom.id);
    }
  }
  return clusters;
}

// ─── Main distillation function ───────────────────────────────────────────────

export async function distillOnce(
  store: Falda,
  llm: LLMFn,
  opts: DistillOptions = {},
): Promise<DistillResult> {
  const storeKey = opts.storeKey ?? "default";
  const windowSize = opts.windowSize ?? DEFAULT_WINDOW_SIZE;
  const candidateLimit = opts.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const topicSimilarityThreshold = opts.topicSimilarityThreshold ?? DEFAULT_TOPIC_SIMILARITY_THRESHOLD;
  const sceneMatchThreshold = opts.sceneMatchThreshold ?? DEFAULT_SCENE_MATCH_THRESHOLD;
  const sceneReorgThreshold = opts.sceneReorgThreshold ?? DEFAULT_SCENE_REORG_THRESHOLD;
  const verbose = opts.verbose ?? false;
  const log = verbose ? console.log : () => {};

  // Access the underlying db through the store's exposed method.
  const db = (store as any).db as import("better-sqlite3").Database;

  initWatermarkSchema(db);
  initCoreStateSchema(db);
  initDirtySchema(db);

  const result: DistillResult = {
    pass_id: "",
    turns_processed: 0,
    atoms_stored: 0,
    atoms_updated: 0,
    atoms_merged: 0,
    atoms_skipped: 0,
    scenes_derived: 0,
    core_regenerated: false,
  };

  // ── L0: Read new turns since watermark (seq-based, cross-session safe) ────
  // queryStreamSeq orders globally by seq (insertion order), not by session_id
  // first. This prevents a full session-A window from advancing the watermark
  // past unprocessed session-B turns that share an overlapping timestamp range.

  const wm = getWatermark(db, storeKey);
  const afterSeq = wm?.last_processed_seq ?? null;

  const turns = store.queryStreamSeq({ afterSeq: afterSeq ?? 0, limit: windowSize });

  // A store is truly a no-op only when there are no new turns to extract AND
  // nothing has flagged it dirty (docs/future/reliability-hardening.md
  // finding 2, docs/MODEL.md §8.7). The dirty flag is set by out-of-band
  // atom/stream lifecycle mutations (supersede/merge/archive/hard-delete/
  // evidence-affecting stream deletion, src/falda.ts's markStoreDirty) or by
  // a previous pass whose L2/L3 phase failed to fully complete — either way,
  // L2/L3 must get a chance to re-run against the CURRENT active-atom/scene
  // set even though L1 has nothing new to process this time.
  const dirty = isDirty(db, storeKey);
  if (!turns.length && !dirty) {
    log("[distill] no new turns and store is clean, skipping");
    result.pass_id = passId(storeKey, afterSeq, afterSeq ?? "empty");
    return result;
  }

  // lastTurn is only defined when there ARE new turns — a dirty-only pass
  // (turns.length === 0, dirty === true) has no real lastTurn and must NOT
  // advance the watermark to a fabricated value (see distillOncePass's L1
  // section, which guards setWatermark on turns.length > 0).
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  // Reuse the exact "no new turns" pass-id expression the old early-return
  // used to compute for a dirty-only pass, so it stays a stable, replayable
  // id derived from "no new turns since afterSeq" rather than colliding
  // with a future real pass's id once turns do arrive.
  const pid = lastTurn ? passId(storeKey, afterSeq, lastTurn.seq) : passId(storeKey, afterSeq, afterSeq ?? "empty");
  result.pass_id = pid;
  result.turns_processed = turns.length;
  log(turns.length
    ? `[distill] pass ${pid}: ${turns.length} turns (seq ${(afterSeq ?? 0) + 1}–${lastTurn!.seq})`
    : `[distill] pass ${pid}: 0 turns, store is dirty — running L2/L3 reconciliation only`);

  // Pass metadata + effect log (falda distill inspect, src/inspect/). Only
  // real or dirty-triggered passes are instrumented — see the early return
  // above for the fully-clean no-new-turns case, which never reaches here.
  // Best-effort: a telemetry write failure must never abort distillation.
  try {
    store.recordPassStart({
      pass_id: pid, store_key: storeKey,
      watermark_start: afterSeq, watermark_end: lastTurn?.seq ?? afterSeq,
      input_turn_count: turns.length,
      model: opts.model, prompt_version: opts.promptVersion, distiller_version: opts.distillerVersion,
    });
  } catch { /* best-effort */ }

  const sceneEffects = new Map<string, SceneEffectAccum>();

  try {
    return await distillOncePass(store, llm, db, {
      storeKey, candidateLimit, topicSimilarityThreshold, sceneMatchThreshold, sceneReorgThreshold,
      verbose, log, turns, afterSeq, lastTurn, pid, result, sceneEffects,
    });
  } catch (e) {
    try {
      store.recordPassComplete({ pass_id: pid, status: "failed", error: String((e as any)?.message ?? e) });
    } catch { /* best-effort */ }
    throw e;
  }
}

interface SceneEffectAccum {
  scene_kind: SceneKind;
  title: string;
  effect: "created" | "updated" | "retired" | "unchanged";
  members_before: number;
  members_after: number;
  added: string[];
  removed: string[];
  summary_regenerated: boolean;
  embedding_regenerated: boolean;
}

async function distillOncePass(
  store: Falda,
  llm: LLMFn,
  db: import("better-sqlite3").Database,
  ctx: {
    storeKey: string; candidateLimit: number;
    topicSimilarityThreshold: number; sceneMatchThreshold: number; sceneReorgThreshold: number;
    verbose: boolean; log: (...args: any[]) => void;
    turns: StreamTurn[]; afterSeq: number | null; lastTurn: StreamTurn | null;
    pid: string; result: DistillResult; sceneEffects: Map<string, SceneEffectAccum>;
  },
): Promise<DistillResult> {
  const {
    storeKey, candidateLimit, topicSimilarityThreshold, sceneMatchThreshold, sceneReorgThreshold,
    verbose, log, turns, lastTurn, pid, result, sceneEffects,
  } = ctx;

  // ── L1: Extract + Consolidate (one atomic transaction) ────────────────────
  //
  // Atomicity contract (docs/MODEL.md §8.5, docs/future/reliability-hardening.md
  // finding 1): atom rows, their atoms_fts/atoms_vec index rows, evidence
  // edges, lifecycle changes (supersede/merge), consolidation_decisions, and
  // the watermark advance all commit in ONE synchronous SQLite transaction,
  // or none of them do. better-sqlite3 transactions must be fully
  // synchronous, so ALL async work (LLM calls, embeddings, candidate search)
  // happens below, before the transaction opens. Nothing after that point
  // may await anything.
  //
  // Dirty-only pass (finding 2, docs/future/reliability-hardening.md): when
  // turns.length === 0, this pass was triggered purely because the store is
  // flagged dirty (an out-of-band lifecycle mutation or a previous failed
  // L2/L3 attempt) — there is nothing for L1 to extract/consolidate, so the
  // extraction/consolidation LLM calls are skipped entirely (candidates/
  // writeOps/preparedAtoms all stay empty) and control falls straight
  // through to L2/L3 below. The L1 transaction below still runs but does
  // zero work in that case; critically it must NOT advance the watermark,
  // since there is no real lastTurn to advance it to (see the setWatermark
  // guard inside the transaction).

  const streamIds = turns.map((t) => t.id);

  interface L1WriteOp {
    action: "store" | "update" | "merge" | "skip";
    candidate: CandidateAtom;
    newId: string;
    targetIds: string[];
    rationale: string;
    decId: string;
  }

  const writeOps: L1WriteOp[] = [];

  if (turns.length > 0) {
    // Extract candidate atoms.
    const extractRaw = await llm(extractionPrompt(
      turns.map((t) => ({ role: t.role, content: t.content }))
    ));
    const parseResult = parseCandidates(extractRaw);
    if (!parseResult.ok) {
      throw new Error(`malformed extraction response: ${parseResult.reason}`);
    }
    const candidates = parseResult.candidates;
    log(`[distill] L1 extracted ${candidates.length} candidates`);

    // Phase 1: retrieve each candidate's neighbours. These are reads only
    // (searchAtoms), and no atom is written until after this whole section, so
    // hoisting them out of the decision loop changes no behaviour.
    const retrieved: Array<{
      candidate: CandidateAtom;
      existing: Array<{ id: string; type: string; content: string; confidence: string }>;
    }> = [];
    for (const candidate of candidates) {
      const existingHits = await store.searchAtoms(candidate.content, candidateLimit);
      retrieved.push({
        candidate,
        existing: existingHits.map((h) => ({
          id: h.id, type: h.type, content: h.content, confidence: h.confidence,
        })),
      });
    }

    // Phase 2: one consolidation decision per candidate, batched where possible.
    // allowedTargetIds[i] is the set of existing-atom IDs shown to the LLM
    // for candidate i — used by the strict validator to reject cross-candidate
    // or invented target references.
    const batchSize = consolidationBatchSize();
    const maxChars = consolidationMaxChars();
    const decisions: ConsolidationDecision[] = new Array(retrieved.length);
    const allowedTargetIds: ReadonlySet<string>[] = retrieved.map(
      (r) => new Set(r.existing.map((e) => e.id)),
    );

    const decideIndividually = async (i: number): Promise<void> => {
      const raw = await llm(consolidationPrompt(retrieved[i].candidate, retrieved[i].existing));
      const dec = parseConsolidation(raw, allowedTargetIds[i]);
      if (dec === undefined) {
        throw new Error(`malformed consolidation response for candidate ${i}`);
      }
      decisions[i] = dec;
    };

    if (batchSize <= 1 || retrieved.length <= 1) {
      // Historical path, byte for byte. Also the N=1 case, where batching would
      // add prompt scaffolding for no saving.
      for (let i = 0; i < retrieved.length; i++) await decideIndividually(i);
    } else {
      const chunks = packConsolidationChunks(
        retrieved, batchSize, maxChars, consolidationBatchPrompt, log,
      );
      let start = 0;
      for (const chunk of chunks) {
        const raw = await llm(consolidationBatchPrompt(chunk));
        const chunkStart = start;
        const parsed = parseConsolidationBatch(
          raw,
          allowedTargetIds.slice(start, start + chunk.length),
          (localIdx, occurrenceCount) => {
            // Non-fatal: duplication is not known to occur with real model
            // output (see parseConsolidationBatch's doc comment). The first
            // valid decision is retained and the pass continues normally —
            // this is visibility, not a retryable failure. Always surfaced
            // via console.warn, independent of --verbose, since it signals
            // an LLM contract violation an operator may want to know about
            // even outside verbose runs.
            console.warn(
              `[distill] pass ${pid}: candidate ${chunkStart + localIdx} appeared ` +
                `${occurrenceCount} times in a consolidation batch reply; retained the first valid decision`,
            );
          },
        );
        for (let j = 0; j < chunk.length; j++) {
          const dec = parsed[j];
          if (dec) decisions[start + j] = dec;
          else await decideIndividually(start + j); // never drop a candidate
        }
        start += chunk.length;
      }
    }

    // Phase 3: turn decisions into write ops.
    // Decisions have already passed strict validation (action, target type,
    // cardinality, and candidate-local membership), so no filtering or action
    // rewriting is needed here.
    for (let i = 0; i < retrieved.length; i++) {
      const candidate = retrieved[i].candidate;
      const dec = decisions[i];
      const newId = atomIdFromContent(candidate.type, candidate.content);
      const decId = `${pid}-dec-${i}`;

      writeOps.push({ action: dec.action, candidate, newId, targetIds: dec.target_ids, rationale: dec.rationale, decId });
    }
  } // end: turns.length > 0 (extraction/consolidation skipped for a dirty-only pass)

  // Precompute (and validate) one embedding per UNIQUE non-skip atom id —
  // sequentially, not in parallel, to preserve existing call ordering and
  // keep remote-embedder load and failure-injection behavior predictable.
  // No DB writes happen here. Deliberately NOT gated on "does this id
  // already exist" — an existing deterministic id still needs a prepared
  // embedding so the write phase can repair a historical partial write
  // (e.g. an atom row with no FTS/vector row from before this fix).
  interface PreparedAtom {
    id: string; type: AtomType; content: string; confidence: AtomConfidence; embedding: number[];
  }
  const preparedAtoms = new Map<string, PreparedAtom>();
  for (const op of writeOps) {
    if (op.action === "skip") continue;
    if (!preparedAtoms.has(op.newId)) {
      const embedding = await store.prepareAtomEmbedding(op.candidate.content);
      preparedAtoms.set(op.newId, {
        id: op.newId, type: op.candidate.type, content: op.candidate.content,
        confidence: op.candidate.confidence, embedding,
      });
    }
  }

  // ── Synchronous L1 transaction ─────────────────────────────────────────────
  // Everything below this point is synchronous. Counters/log messages are
  // accumulated locally and only applied to `result`/emitted after the
  // transaction commits — SQLite rollback does not undo JS mutations or
  // console output, so applying them eagerly could report success for
  // writes that were actually rolled back.
  let txAtomsStored = 0, txAtomsUpdated = 0, txAtomsMerged = 0, txAtomsSkipped = 0;
  const txLogs: string[] = [];
  const countedStoredIds = new Set<string>();

  const commitL1 = db.transaction(() => {
    // Phase A: ensure/repair each unique prepared atom exactly once. Doing
    // this once per unique id (rather than once per write-op) means
    // duplicate extracted candidates don't repeatedly delete+reinsert the
    // same FTS/vector rows.
    const writeResults = new Map<string, { inserted: boolean }>();
    for (const atom of preparedAtoms.values()) {
      const res = store.upsertDistilledAtomSync(
        { id: atom.id, type: atom.type, content: atom.content, confidence: atom.confidence },
        atom.embedding,
      );
      writeResults.set(atom.id, { inserted: res.inserted });
    }

    // Phase B: per-candidate evidence / lifecycle / decision writes, in
    // original candidate order (preserves consolidation-decision ordering
    // and audit shape even when multiple candidates share one atom id).
    for (const op of writeOps) {
      if (op.action === "store") {
        if (preparedAtoms.has(op.newId)) {
          store.addEvidence(op.newId, streamIds);
          if (!countedStoredIds.has(op.newId)) {
            countedStoredIds.add(op.newId);
            txAtomsStored++;
            txLogs.push(`[distill] stored atom ${op.newId}`);
          }
        }
        store.recordDecision({
          id: op.decId, pass_id: pid, action: "store", atom_id: op.newId, rationale: op.rationale,
          candidate_type: op.candidate.type, candidate_content: op.candidate.content,
          candidate_confidence: op.candidate.confidence,
        });

      } else if (op.action === "update") {
        const oldId = op.targetIds[0];
        if (preparedAtoms.has(op.newId)) {
          // Inherited evidence is read here, inside the transaction, so it
          // reflects the current committed state rather than a snapshot
          // taken before the (possibly long) async planning phase above.
          const inherited = store.evidenceForAtom(oldId).map((e) => e.stream_id);
          // Always attach evidence for this pass's turns, even when
          // newId === oldId ("update-to-self") — only the supersede
          // lifecycle write is conditional on the ids actually differing.
          store.addEvidence(op.newId, [...new Set([...inherited, ...streamIds])]);
          if (op.newId !== oldId) {
            store.supersedeAtom(oldId, op.newId);
            txAtomsUpdated++;
          }
        }
        store.recordDecision({
          id: op.decId, pass_id: pid, action: "update", atom_id: op.newId, target_ids: [oldId], rationale: op.rationale,
          candidate_type: op.candidate.type, candidate_content: op.candidate.content,
          candidate_confidence: op.candidate.confidence,
        });

      } else if (op.action === "merge") {
        if (preparedAtoms.has(op.newId)) {
          const inherited = new Set<string>();
          for (const tid of op.targetIds) {
            store.evidenceForAtom(tid).forEach((e) => inherited.add(e.stream_id));
          }
          for (const sid of streamIds) inherited.add(sid);
          store.addEvidence(op.newId, [...inherited]);
          // Exclude the winner from lifecycle losers — the LLM's
          // target_ids can include the atom id it just decided to keep
          // (e.g. when recall surfaces the deterministic id itself as a
          // candidate target), and mergeAtoms() would otherwise mark that
          // winner 'merged' too.
          const lifecycleLosers = op.targetIds.filter((id) => id !== op.newId);
          if (lifecycleLosers.length > 0) {
            store.mergeAtoms(lifecycleLosers, op.newId);
            txAtomsMerged++;
          }
        }
        store.recordDecision({
          id: op.decId, pass_id: pid, action: "merge", atom_id: op.newId, target_ids: op.targetIds, rationale: op.rationale,
          candidate_type: op.candidate.type, candidate_content: op.candidate.content,
          candidate_confidence: op.candidate.confidence,
        });

      } else {
        // skip: no durable atom is ever created for this candidate, so the
        // candidate_* columns on this row are the ONLY place its content
        // survives (falda distill inspect's regression requirement).
        store.recordDecision({
          id: op.decId, pass_id: pid, action: "skip", rationale: op.rationale,
          candidate_type: op.candidate.type, candidate_content: op.candidate.content,
          candidate_confidence: op.candidate.confidence,
        });
        txAtomsSkipped++;
      }
    }

    // Advance watermark — last thing in the transaction. Only when there was
    // a real lastTurn: a dirty-only pass (turns.length === 0) has nothing to
    // advance the watermark to, and fabricating an advance would corrupt the
    // L1 cursor (docs/future/reliability-hardening.md finding 2).
    if (lastTurn) {
      setWatermark(db, storeKey, lastTurn.id, lastTurn.timestamp, lastTurn.seq);
    }
  });

  // .immediate() preserves the previous BEGIN IMMEDIATE write-lock timing;
  // plain commitL1() would use a deferred transaction instead. Any throw
  // inside the callback above rolls back every write it made, including
  // the atoms/atoms_fts/atoms_vec writes from Phase A — this is the actual
  // fix for finding 1 (previously those were written before the tx began).
  commitL1.immediate();

  // Only apply counters/logs once the transaction has durably committed.
  result.atoms_stored += txAtomsStored;
  result.atoms_updated += txAtomsUpdated;
  result.atoms_merged += txAtomsMerged;
  result.atoms_skipped += txAtomsSkipped;
  for (const msg of txLogs) log(msg);

  // ── L2: Organize into scenes ──────────────────────────────────────────────

  const setDiff = (before: string[], after: string[]) => ({
    added: after.filter((id) => !before.includes(id)),
    removed: before.filter((id) => !after.includes(id)),
  });

  const noteSceneEffect = (e: SceneEffectAccum & { scene_id: string }) => {
    const { scene_id, ...rest } = e;
    sceneEffects.set(scene_id, rest);
  };

  // Episode scenes: deterministic projection of atom_evidence by session.
  const sessionRows = db.prepare(
    `SELECT DISTINCT s.session_id FROM atom_evidence ae
     JOIN stream s ON s.id=ae.stream_id`
  ).all() as Array<{ session_id: string }>;

  for (const { session_id } of sessionRows) {
    const atomIds = store.atomsFromSession(session_id);
    const activeAtomIds = atomIds.filter((id) => {
      const row = db.prepare("SELECT status FROM atoms WHERE id=?").get(id) as any;
      return row?.status === "active";
    });

    // Deterministic episode scene_id keyed by session identity (§6.2/§6.3).
    // Never look up by title — the title is presentation-only and may be
    // replaced by the LLM summary pass, which must not break identity.
    const sceneId = episodeSceneId(session_id);
    const existingEp = db.prepare(
      "SELECT * FROM scenes WHERE scene_id=?"
    ).get(sceneId) as any;
    const prevAtomIds: string[] = existingEp ? JSON.parse(existingEp.atom_ids ?? "[]") : [];

    const provisional = `Session ${session_id}`;

    if (activeAtomIds.length === 0) {
      // No active atoms trace to this session — retire the scene if it exists.
      if (existingEp) {
        await store.upsertScene({
          scene_id: sceneId,
          scene_kind: "episode",
          title: existingEp.title,
          atom_ids: [],
          status: "retired",
        });
        noteSceneEffect({
          scene_id: sceneId, scene_kind: "episode", title: existingEp.title, effect: "retired",
          members_before: prevAtomIds.length, members_after: 0,
          added: [], removed: prevAtomIds, summary_regenerated: false, embedding_regenerated: false,
        });
      }
      continue;
    }

    await store.upsertScene({
      scene_id: sceneId,
      scene_kind: "episode",
      title: existingEp?.title ?? provisional,
      atom_ids: activeAtomIds,
      status: "active",
    });
    const { added, removed } = setDiff(prevAtomIds, activeAtomIds);
    noteSceneEffect({
      scene_id: sceneId, scene_kind: "episode", title: existingEp?.title ?? provisional,
      effect: !existingEp ? "created" : (added.length || removed.length) ? "updated" : "unchanged",
      members_before: prevAtomIds.length, members_after: activeAtomIds.length,
      added, removed, summary_regenerated: false, embedding_regenerated: false,
    });
    result.scenes_derived++;
  }

  // Topic scenes: embedding clustering + hysteresis reconciliation.
  // ORDER BY id ensures deterministic clustering regardless of DB insertion order.
  const allAtomRows = db.prepare(
    "SELECT id FROM atoms WHERE status='active' ORDER BY id"
  ).all() as Array<{ id: string }>;

  if (allAtomRows.length === 0) {
    // No active atoms left at all (e.g. the last one was archived/superseded/
    // merged/hard-deleted) — retire every still-active topic scene. Without
    // this branch, a store that goes from "some atoms" to "zero atoms" would
    // leave stale topic scenes active forever, since the clustering loop
    // below never runs when there's nothing to cluster (finding 2 —
    // uncovered by the dirty-only reconciliation pass this phase adds,
    // which is the first thing that ever actually exercises "zero active
    // atoms, but scenes still need reconciling").
    const staleTopics = db.prepare(
      "SELECT * FROM scenes WHERE scene_kind='topic' AND status='active'"
    ).all() as any[];
    for (const et of staleTopics) {
      const prevAtoms: string[] = JSON.parse(et.atom_ids ?? "[]");
      await store.upsertScene({
        scene_id: et.scene_id,
        scene_kind: "topic",
        title: et.title,
        atom_ids: prevAtoms,
        status: "retired",
      });
      noteSceneEffect({
        scene_id: et.scene_id, scene_kind: "topic", title: et.title, effect: "retired",
        members_before: prevAtoms.length, members_after: 0,
        added: [], removed: prevAtoms, summary_regenerated: false, embedding_regenerated: false,
      });
    }
  } else {
    // Get embeddings for all active atoms from atoms_vec.
    const atomVecs: AtomVec[] = [];
    for (const { id } of allAtomRows) {
      const vecRow = db.prepare(
        "SELECT embedding FROM atoms_vec WHERE id=?"
      ).get(id) as { embedding: Buffer } | undefined;
      if (vecRow) {
        const f32 = new Float32Array(vecRow.embedding.buffer, vecRow.embedding.byteOffset, vecRow.embedding.byteLength / 4);
        atomVecs.push({ id, vec: Array.from(f32) });
      }
    }

    const clusters = clusterAtoms(atomVecs, topicSimilarityThreshold);

    // Get existing topic scenes.
    const existingTopics = db.prepare(
      "SELECT * FROM scenes WHERE scene_kind='topic' AND status='active'"
    ).all() as any[];

    const matchedExistingIds = new Set<string>();

    for (const [, memberIds] of clusters) {
      // Find best matching existing topic scene by membership overlap.
      let bestMatch: any = null;
      let bestOverlap = 0;
      for (const et of existingTopics) {
        if (matchedExistingIds.has(et.scene_id)) continue;
        const etAtoms: string[] = JSON.parse(et.atom_ids ?? "[]");
        const overlap = memberIds.filter((id) => etAtoms.includes(id)).length;
        const unionSize = new Set([...memberIds, ...etAtoms]).size;
        const jaccard = unionSize > 0 ? overlap / unionSize : 0;
        if (jaccard > bestOverlap) { bestOverlap = jaccard; bestMatch = et; }
      }

      if (bestMatch && bestOverlap >= sceneMatchThreshold) {
        // Same topic — keep the existing scene_id, just update membership.
        matchedExistingIds.add(bestMatch.scene_id);
        const prevAtoms: string[] = JSON.parse(bestMatch.atom_ids ?? "[]");
        const churn = memberIds.filter((id) => !prevAtoms.includes(id)).length
          + prevAtoms.filter((id) => !memberIds.includes(id)).length;
        const churnFraction = prevAtoms.length > 0 ? churn / prevAtoms.length : 1;

        if (churnFraction < sceneReorgThreshold) {
          // Below reorg threshold: update membership, keep scene.
          await store.upsertScene({
            scene_id: bestMatch.scene_id,
            scene_kind: "topic",
            title: bestMatch.title,
            atom_ids: memberIds,
            status: "active",
          });
          const { added, removed } = setDiff(prevAtoms, memberIds);
          noteSceneEffect({
            scene_id: bestMatch.scene_id, scene_kind: "topic", title: bestMatch.title,
            effect: (added.length || removed.length) ? "updated" : "unchanged",
            members_before: prevAtoms.length, members_after: memberIds.length,
            added, removed, summary_regenerated: false, embedding_regenerated: false,
          });
        } else {
          // Above reorg threshold: retire old, create new with lineage.
          const newScene = await store.upsertScene({
            scene_kind: "topic",
            title: `Topic ${Date.now()}`,
            atom_ids: memberIds,
            derived_from: [bestMatch.scene_id],
            status: "active",
          });
          await store.upsertScene({
            scene_id: bestMatch.scene_id,
            scene_kind: "topic",
            title: bestMatch.title,
            atom_ids: JSON.parse(bestMatch.atom_ids ?? "[]"),
            status: "retired",
            superseded_by: [newScene.scene_id],
          });
          noteSceneEffect({
            scene_id: newScene.scene_id, scene_kind: "topic", title: newScene.title, effect: "created",
            members_before: 0, members_after: memberIds.length,
            added: memberIds, removed: [], summary_regenerated: false, embedding_regenerated: false,
          });
          noteSceneEffect({
            scene_id: bestMatch.scene_id, scene_kind: "topic", title: bestMatch.title, effect: "retired",
            members_before: prevAtoms.length, members_after: 0,
            added: [], removed: prevAtoms, summary_regenerated: false, embedding_regenerated: false,
          });
        }
      } else {
        // New cluster — create a new topic scene with a provisional title.
        const newScene = await store.upsertScene({
          scene_kind: "topic",
          title: `Topic ${Date.now()}`,
          atom_ids: memberIds,
          status: "active",
        });
        noteSceneEffect({
          scene_id: newScene.scene_id, scene_kind: "topic", title: newScene.title, effect: "created",
          members_before: 0, members_after: memberIds.length,
          added: memberIds, removed: [], summary_regenerated: false, embedding_regenerated: false,
        });
      }
      result.scenes_derived++;
    }

    // Retire topic scenes with no matching cluster.
    for (const et of existingTopics) {
      if (!matchedExistingIds.has(et.scene_id)) {
        const prevAtoms: string[] = JSON.parse(et.atom_ids ?? "[]");
        await store.upsertScene({
          scene_id: et.scene_id,
          scene_kind: "topic",
          title: et.title,
          atom_ids: prevAtoms,
          status: "retired",
        });
        noteSceneEffect({
          scene_id: et.scene_id, scene_kind: "topic", title: et.title, effect: "retired",
          members_before: prevAtoms.length, members_after: 0,
          added: [], removed: prevAtoms, summary_regenerated: false, embedding_regenerated: false,
        });
      }
    }
  }

  // Lazy hash-gated title/summary + re-embed pass for changed scenes.
  //
  // L2 failure tracking (docs/future/reliability-hardening.md finding 2):
  // a scene whose narration LLM call throws must NOT have content_hash
  // advanced to newHash — persisting newHash despite failure would make
  // hash-gating believe this scene's narration is up to date, permanently
  // skipping the retry the failed attempt actually needs. Each scene is
  // isolated (one scene's narration failure must not skip its siblings),
  // but failures are counted so the pass as a whole can report incomplete
  // reconciliation below.
  const activeScenes = db.prepare(
    "SELECT * FROM scenes WHERE status='active'"
  ).all() as any[];

  let l2FailureCount = 0;

  for (const sc of activeScenes) {
    const atomIds: string[] = JSON.parse(sc.atom_ids ?? "[]");
    const newHash = store.computeSceneHash(sc.scene_kind as SceneKind, atomIds);
    if (sc.content_hash === newHash) continue; // Nothing changed.

    // Fetch active member atoms for LLM calls.
    const memberAtoms = atomIds
      .map((id) => db.prepare("SELECT type,content FROM atoms WHERE id=? AND status='active'").get(id) as any)
      .filter(Boolean);

    let newTitle = sc.title;
    let newSummary = sc.summary ?? null;
    let narrationFailed = false;

    if (memberAtoms.length > 0 && llm) {
      try {
        newTitle = (await llm(sceneTitlePrompt(sc.scene_kind, memberAtoms))).trim().slice(0, 200);
        newSummary = (await llm(sceneSummaryPrompt(sc.scene_kind, newTitle, memberAtoms))).trim();
      } catch (e) {
        // Keep provisional title/summary on LLM failure, and — critically —
        // do NOT advance content_hash below, so the next pass retries this
        // scene's narration instead of silently accepting the old text.
        narrationFailed = true;
        l2FailureCount++;
        log(`[distill] L2 scene narration failed for ${sc.scene_id}: ${e}`);
      }
    }

    await store.upsertScene({
      scene_id: sc.scene_id,
      scene_kind: sc.scene_kind,
      title: newTitle || sc.title,
      atom_ids: atomIds,
      summary: newSummary,
      content_hash: narrationFailed ? sc.content_hash : newHash,
      status: "active",
    });

    // Merge into whatever L2 already recorded for this scene (membership
    // effect) rather than overwrite it — this loop only adds the
    // title/summary/embedding-regeneration flags on top.
    const finalTitle = newTitle || sc.title;
    const renderChanged = finalTitle !== sc.title || newSummary !== (sc.summary ?? null);
    const existingEffect = sceneEffects.get(sc.scene_id);
    sceneEffects.set(sc.scene_id, {
      scene_kind: sc.scene_kind, title: finalTitle,
      effect: existingEffect?.effect ?? "unchanged",
      members_before: existingEffect?.members_before ?? atomIds.length,
      members_after: existingEffect?.members_after ?? atomIds.length,
      added: existingEffect?.added ?? [], removed: existingEffect?.removed ?? [],
      summary_regenerated: !narrationFailed,
      embedding_regenerated: !narrationFailed && renderChanged,
    });
  }

  // ── L3: Synthesize core ──────────────────────────────────────────────────
  // Hash-gate: compare the *input* hash (what the core synthesis prompt would
  // consume) against the last input hash we actually used, persisted in
  // core_state. The old code compared against sha256(readCore()) — the LLM
  // *output* — which could never match the input hash, so core was always
  // regenerated on every pass with active scenes. (MODEL.md §8.4)

  const newCoreHash = store.computeCoreHash();
  const coreState = getCoreState(db, storeKey);
  const oldCoreChars = store.readCore().length;

  let coreEffect: "unchanged" | "regenerated" | "deleted" | "failed" = "unchanged";
  let newCoreChars = oldCoreChars;

  // Check if any active scenes exist.
  const sceneCount = (db.prepare("SELECT COUNT(*) c FROM scenes WHERE status='active'").get() as any).c;
  if (sceneCount === 0) {
    // No active scenes → delete core and clear persisted input hash.
    const fp = join((store as any).blobDir, "core.md");
    try { if (existsSync(fp)) unlinkSync(fp); } catch {}
    clearCoreState(db, storeKey);
    if (oldCoreChars > 0) { coreEffect = "deleted"; newCoreChars = 0; }
  } else {
    // Re-synthesize only if input structure changed since last synthesis.
    const finalScenes = db.prepare(
      "SELECT * FROM scenes WHERE status='active' ORDER BY scene_id"
    ).all() as any[];

    const coreInput = finalScenes.map((sc: any) => {
      const atomIds: string[] = JSON.parse(sc.atom_ids ?? "[]");
      const atoms = atomIds
        .map((id) => db.prepare("SELECT type,content FROM atoms WHERE id=? AND status='active'").get(id) as any)
        .filter(Boolean);
      return { scene_kind: sc.scene_kind, title: sc.title, atoms };
    });

    const needsRegen = newCoreHash !== coreState?.input_hash;
    if (needsRegen) {
      try {
        const newCore = await llm(coreSynthesisPrompt(coreInput));
        store.writeCore(newCore);
        setCoreState(db, storeKey, newCoreHash);
        result.core_regenerated = true;
        coreEffect = "regenerated";
        newCoreChars = newCore.length;
        log(`[distill] L3 core synthesized`);
      } catch (e) {
        coreEffect = "failed";
        log(`[distill] L3 core synthesis failed: ${e}`);
      }
    } else {
      log(`[distill] L3 core unchanged (input hash matches), skipping`);
    }
  }
  const l3Failed = coreEffect === "failed";

  // ── Persist the effect log + finalize pass metadata (best-effort) ────────
  try {
    for (const [scene_id, eff] of sceneEffects) {
      store.recordSceneEffect({ pass_id: pid, scene_id, ...eff });
    }
    store.recordCoreEffect({
      pass_id: pid, effect: coreEffect,
      old_input_hash: coreState?.input_hash ?? null,
      new_input_hash: coreEffect === "regenerated" ? newCoreHash : (coreState?.input_hash ?? null),
      old_chars: oldCoreChars, new_chars: newCoreChars,
    });
    const candidateCount = (db.prepare(
      "SELECT COUNT(*) c FROM consolidation_decisions WHERE pass_id=?"
    ).get(pid) as any).c as number;
    // Telemetry always reports 'done' for distillOncePass's own outcome —
    // the L2/L3-incomplete throw below is a SEPARATE signal (job/queue
    // retry), not a rewrite of this best-effort audit row. This preserves
    // docs/MODEL.md §8.5's rule that distillation_passes.status reflects
    // distillOnce's own outcome; distillOnce's outer catch (unchanged from
    // finding 1) is what actually flips this row to 'failed' when the
    // throw below propagates.
    store.recordPassComplete({ pass_id: pid, status: "done", candidate_count: candidateCount });
  } catch { /* best-effort — pass data itself already committed */ }

  // ── L2/L3 completeness gate (finding 2) ───────────────────────────────────
  // L1's atomic transaction (finding 1) has already committed by this point
  // — a throw here does NOT roll back L1's atom/evidence/decision/watermark
  // writes, which is correct: L1's atomicity guarantee is about L1 alone
  // (docs/MODEL.md §8.5). What this throw DOES do is propagate out through
  // distillOnce's existing try/catch (which marks distillation_passes
  // 'failed' and rethrows) to src/distill/worker.ts's runJob, whose catch
  // calls failJob() instead of completeJob() — engaging the existing
  // backoff/dead-letter retry policy for a persistently broken narration/
  // synthesis LLM, rather than silently reporting pass success forever.
  //
  // The dirty flag is cleared ONLY on the fully-clean path below — every
  // other exit from this function (including this throw) leaves it set, so
  // the next attempt (retry or next sweep) re-runs L2/L3 against the
  // current state. Since L2/L3 are pure, hash-gated functions of the
  // current active-atom/scene set (docs/MODEL.md §8.5), re-running already-
  // succeeded parts on retry is a correctly-priced no-op.
  if (l2FailureCount > 0 || l3Failed) {
    // Explicitly (re-)mark dirty — this pass may not have started dirty
    // (e.g. a first-ever pass whose L1 succeeded but L2/L3 then failed), so
    // simply "not calling clearDirty" is not sufficient on its own.
    markDirty(db, storeKey, `L2/L3 incomplete: ${l2FailureCount} scene failure(s)${l3Failed ? ", core failed" : ""}`);
    throw new Error(
      `L2/L3 reconciliation incomplete: ${l2FailureCount} scene narration failure(s)` +
      (l3Failed ? ", core synthesis failed" : ""),
    );
  }

  clearDirty(db, storeKey);

  return result;
}
