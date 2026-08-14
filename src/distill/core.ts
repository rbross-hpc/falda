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
  extractionPrompt, consolidationPrompt,
  sceneTitlePrompt, sceneSummaryPrompt, coreSynthesisPrompt,
} from "./prompts.js";
import { initWatermarkSchema, getWatermark, setWatermark, passId } from "./watermark.js";

export interface LLMFn {
  (prompt: string): Promise<string>;
}

export interface DistillOptions {
  storeKey?: string;
  windowSize?: number;
  candidateLimit?: number;
  matchThreshold?: number;
  reorgThreshold?: number;
  verbose?: boolean;
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
const DEFAULT_MATCH_THRESHOLD = 0.5;
const DEFAULT_REORG_THRESHOLD = 0.7;

// ─── LLM response parsers ─────────────────────────────────────────────────────

interface CandidateAtom {
  type: AtomType;
  content: string;
  confidence: AtomConfidence;
}

function parseCandidates(raw: string): CandidateAtom[] {
  const results: CandidateAtom[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed);
      const type = obj.type as string;
      const content = obj.content as string;
      const confidence = obj.confidence as string;
      if (!VALID_TYPES.includes(type as AtomType)) {
        throw new Error(`Invalid type: ${type}`);
      }
      if (!VALID_CONFIDENCE.includes(confidence as AtomConfidence)) {
        throw new Error(`Invalid confidence: ${confidence}`);
      }
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("Missing content");
      }
      results.push({ type: type as AtomType, content: content.trim(), confidence: confidence as AtomConfidence });
    } catch {
      // Skip malformed lines — extraction is best-effort.
    }
  }
  return results;
}

interface ConsolidationDecision {
  action: "store" | "update" | "merge" | "skip";
  target_ids: string[];
  rationale: string;
}

function parseConsolidation(raw: string): ConsolidationDecision {
  const trimmed = raw.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) {
    return { action: "skip", target_ids: [], rationale: "malformed LLM response" };
  }
  try {
    const obj = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
    const action = obj.action as string;
    if (!["store", "update", "merge", "skip"].includes(action)) {
      return { action: "skip", target_ids: [], rationale: "unknown action" };
    }
    return {
      action: action as ConsolidationDecision["action"],
      target_ids: Array.isArray(obj.target_ids) ? obj.target_ids.map(String) : [],
      rationale: typeof obj.rationale === "string" ? obj.rationale : "",
    };
  } catch {
    return { action: "skip", target_ids: [], rationale: "parse error" };
  }
}

// ─── Stable atom id from content hash (for idempotent re-runs) ────────────────

function atomIdFromContent(type: string, content: string): string {
  return "l1-" + createHash("sha256").update(`${type}:${content}`).digest("hex").slice(0, 24);
}

// ─── Topic clustering (embedding-based cosine similarity) ─────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

interface AtomVec { id: string; vec: number[] }

function clusterAtoms(atoms: AtomVec[], matchThreshold: number): Map<string, string[]> {
  const clusters = new Map<string, string[]>();
  const assigned = new Map<string, string>();

  for (const atom of atoms) {
    let bestCluster: string | null = null;
    let bestSim = -1;
    for (const [centroidId, members] of clusters) {
      const centroidAtom = atoms.find((a) => a.id === centroidId);
      if (!centroidAtom) continue;
      const sim = cosineSimilarity(atom.vec, centroidAtom.vec);
      if (sim > bestSim) { bestSim = sim; bestCluster = centroidId; }
    }
    if (bestCluster && bestSim >= matchThreshold) {
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
  const matchThreshold = opts.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
  const reorgThreshold = opts.reorgThreshold ?? DEFAULT_REORG_THRESHOLD;
  const verbose = opts.verbose ?? false;
  const log = verbose ? console.log : () => {};

  // Access the underlying db through the store's exposed method.
  const db = (store as any).db as import("better-sqlite3").Database;

  initWatermarkSchema(db);

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

  if (!turns.length) {
    log("[distill] no new turns, skipping");
    result.pass_id = passId(storeKey, afterSeq, afterSeq ?? "empty");
    return result;
  }

  const lastTurn = turns[turns.length - 1];
  const pid = passId(storeKey, afterSeq, lastTurn.seq);
  result.pass_id = pid;
  result.turns_processed = turns.length;
  log(`[distill] pass ${pid}: ${turns.length} turns (seq ${(afterSeq ?? 0) + 1}–${lastTurn.seq})`);

  // ── L1: Extract + Consolidate (one atomic transaction) ────────────────────

  // ── L1 async work: LLM calls BEFORE the transaction ────────────────────────
  // better-sqlite3 transactions are synchronous — no async functions inside.
  // Strategy: do all async work (LLM calls, embeddings) outside the transaction,
  // collect the resulting write operations, then commit them atomically.

  const streamIds = turns.map((t) => t.id);

  // Extract candidate atoms.
  const extractRaw = await llm(extractionPrompt(
    turns.map((t) => ({ role: t.role, content: t.content }))
  ));
  const candidates = parseCandidates(extractRaw);
  log(`[distill] L1 extracted ${candidates.length} candidates`);

  // For each candidate: recall existing atoms and get consolidation decision from LLM.
  interface L1WriteOp {
    action: "store" | "update" | "merge" | "skip";
    candidate: CandidateAtom;
    newId: string;
    validTargetIds: string[];
    oldEvidence: string[];  // for update/merge: evidence from absorbed atoms
    rationale: string;
    decId: string;
  }

  const writeOps: L1WriteOp[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const existingHits = await store.searchAtoms(candidate.content, candidateLimit);
    const existing = existingHits.map((h) => ({
      id: h.id, type: h.type, content: h.content, confidence: h.confidence,
    }));
    const decRaw = await llm(consolidationPrompt(candidate, existing));
    const dec = parseConsolidation(decRaw);
    const validTargetIds = dec.target_ids.filter((id) => existing.some((e) => e.id === id));
    const newId = atomIdFromContent(candidate.type, candidate.content);
    const decId = `${pid}-dec-${i}`;

    // Collect old evidence for update/merge now (before tx) so tx is sync.
    const oldEvidence: string[] = [];
    if ((dec.action === "update" || dec.action === "merge") && validTargetIds.length > 0) {
      for (const tid of validTargetIds) {
        store.evidenceForAtom(tid).forEach((e) => oldEvidence.push(e.stream_id));
      }
    }

    const action =
      (dec.action === "store" || (validTargetIds.length === 0 && dec.action !== "skip")) ? "store"
      : dec.action === "update" && validTargetIds.length === 1 ? "update"
      : dec.action === "merge" && validTargetIds.length >= 1 ? "merge"
      : "skip";

    writeOps.push({ action, candidate, newId, validTargetIds, oldEvidence, rationale: dec.rationale, decId });
  }

  // Now embed all new-atom content before the transaction (async work done).
  // Pre-embed: for each store/update/merge op, we need the embedding to call upsertAtom.
  // upsertAtom itself is async (it embeds). We call it outside tx and collect the rows.
  // Then the tx just records everything synchronously.

  interface PreparedAtom {
    id: string; type: AtomType; content: string; confidence: AtomConfidence;
  }
  const preparedAtoms = new Map<string, PreparedAtom>();
  for (const op of writeOps) {
    if (op.action === "skip") continue;
    if (!preparedAtoms.has(op.newId)) {
      const existing = db.prepare("SELECT id FROM atoms WHERE id=?").get(op.newId);
      if (!existing) {
        // Pre-call upsertAtom (async, embeds content, inserts row).
        // We do this outside the transaction so embedding can be async.
        const a = await store.upsertAtom({
          id: op.newId,
          type: op.candidate.type,
          content: op.candidate.content,
          confidence: op.candidate.confidence,
        });
        preparedAtoms.set(op.newId, { id: a.id, type: a.type, content: a.content, confidence: a.confidence });
      }
    }
  }

  // Synchronous transaction: record evidence edges, lifecycle changes, decisions, watermark.
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const op of writeOps) {
      if (op.action === "store") {
        const atom = preparedAtoms.get(op.newId);
        if (atom) {
          store.addEvidence(atom.id, streamIds);
          result.atoms_stored++;
          log(`[distill] stored atom ${atom.id}`);
        }
        store.recordDecision({ id: op.decId, pass_id: pid, action: "store", atom_id: op.newId, rationale: op.rationale });

      } else if (op.action === "update") {
        const oldId = op.validTargetIds[0];
        const atom = preparedAtoms.get(op.newId);
        if (atom && op.newId !== oldId) {
          store.addEvidence(atom.id, [...op.oldEvidence, ...streamIds]);
          store.supersedeAtom(oldId, op.newId);
          result.atoms_updated++;
        }
        store.recordDecision({ id: op.decId, pass_id: pid, action: "update", atom_id: op.newId, target_ids: [oldId], rationale: op.rationale });

      } else if (op.action === "merge") {
        const atom = preparedAtoms.get(op.newId);
        if (atom) {
          const allEvidence = new Set<string>([...op.oldEvidence, ...streamIds]);
          store.addEvidence(atom.id, [...allEvidence]);
          store.mergeAtoms(op.validTargetIds, op.newId);
          result.atoms_merged++;
        }
        store.recordDecision({ id: op.decId, pass_id: pid, action: "merge", atom_id: op.newId, target_ids: op.validTargetIds, rationale: op.rationale });

      } else {
        store.recordDecision({ id: op.decId, pass_id: pid, action: "skip", rationale: op.rationale });
        result.atoms_skipped++;
      }
    }
    // Advance watermark — last thing in the transaction.
    setWatermark(db, storeKey, lastTurn.id, lastTurn.timestamp, lastTurn.seq);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }

  // ── L2: Organize into scenes ──────────────────────────────────────────────

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

    // Find or create the episode scene for this session.
    const existingEp = db.prepare(
      `SELECT sc.* FROM scenes sc
       WHERE sc.scene_kind='episode' AND sc.title LIKE ?`
    ).get(`Session ${session_id}%`) as any;

    const provisional = `Session ${session_id}`;

    if (activeAtomIds.length === 0) {
      // No active atoms trace to this session — retire the scene if it exists.
      if (existingEp) {
        await store.upsertScene({
          scene_id: existingEp.scene_id,
          scene_kind: "episode",
          title: existingEp.title,
          atom_ids: [],
          status: "retired",
        });
      }
      continue;
    }

    const sceneId = existingEp?.scene_id;
    await store.upsertScene({
      scene_id: sceneId,
      scene_kind: "episode",
      title: existingEp?.title ?? provisional,
      atom_ids: activeAtomIds,
      status: "active",
    });
    result.scenes_derived++;
  }

  // Topic scenes: embedding clustering + hysteresis reconciliation.
  const allAtomRows = db.prepare(
    "SELECT id FROM atoms WHERE status='active'"
  ).all() as Array<{ id: string }>;

  if (allAtomRows.length > 0) {
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

    const clusters = clusterAtoms(atomVecs, matchThreshold);

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

      if (bestMatch && bestOverlap >= matchThreshold) {
        // Same topic — keep the existing scene_id, just update membership.
        matchedExistingIds.add(bestMatch.scene_id);
        const prevAtoms: string[] = JSON.parse(bestMatch.atom_ids ?? "[]");
        const churn = memberIds.filter((id) => !prevAtoms.includes(id)).length
          + prevAtoms.filter((id) => !memberIds.includes(id)).length;
        const churnFraction = prevAtoms.length > 0 ? churn / prevAtoms.length : 1;

        if (churnFraction < reorgThreshold) {
          // Below reorg threshold: update membership, keep scene.
          await store.upsertScene({
            scene_id: bestMatch.scene_id,
            scene_kind: "topic",
            title: bestMatch.title,
            atom_ids: memberIds,
            status: "active",
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
        }
      } else {
        // New cluster — create a new topic scene with a provisional title.
        await store.upsertScene({
          scene_kind: "topic",
          title: `Topic ${Date.now()}`,
          atom_ids: memberIds,
          status: "active",
        });
      }
      result.scenes_derived++;
    }

    // Retire topic scenes with no matching cluster.
    for (const et of existingTopics) {
      if (!matchedExistingIds.has(et.scene_id)) {
        await store.upsertScene({
          scene_id: et.scene_id,
          scene_kind: "topic",
          title: et.title,
          atom_ids: JSON.parse(et.atom_ids ?? "[]"),
          status: "retired",
        });
      }
    }
  }

  // Lazy hash-gated title/summary + re-embed pass for changed scenes.
  const activeScenes = db.prepare(
    "SELECT * FROM scenes WHERE status='active'"
  ).all() as any[];

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

    if (memberAtoms.length > 0 && llm) {
      try {
        newTitle = (await llm(sceneTitlePrompt(sc.scene_kind, memberAtoms))).trim().slice(0, 200);
        newSummary = (await llm(sceneSummaryPrompt(sc.scene_kind, newTitle, memberAtoms))).trim();
      } catch {
        // Keep provisional title/summary on LLM failure.
      }
    }

    await store.upsertScene({
      scene_id: sc.scene_id,
      scene_kind: sc.scene_kind,
      title: newTitle || sc.title,
      atom_ids: atomIds,
      summary: newSummary,
      content_hash: newHash,
      status: "active",
    });
  }

  // ── L3: Synthesize core ──────────────────────────────────────────────────

  const newCoreHash = store.computeCoreHash();
  const currentCore = store.readCore();
  const currentCoreHash = currentCore
    ? createHash("sha256").update(currentCore).digest("hex")
    : null;

  // Check if any active scenes exist.
  const sceneCount = (db.prepare("SELECT COUNT(*) c FROM scenes WHERE status='active'").get() as any).c;
  if (sceneCount === 0) {
    // No active scenes → delete core.
    const fp = join((store as any).blobDir, "core.md");
    try { if (existsSync(fp)) unlinkSync(fp); } catch {}
  } else {
    // Re-synthesize only if scene structure changed.
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

    const needsRegen = newCoreHash !== currentCoreHash;
    if (needsRegen) {
      try {
        const newCore = await llm(coreSynthesisPrompt(coreInput));
        store.writeCore(newCore);
        result.core_regenerated = true;
        log(`[distill] L3 core synthesized`);
      } catch (e) {
        log(`[distill] L3 core synthesis failed: ${e}`);
      }
    }
  }

  return result;
}
