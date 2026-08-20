/**
 * Read-only distillation inspection service — the data layer behind
 * `falda distill inspect` (src/inspect/cli.ts) and, per the spec, usable
 * later to back an HTTP/admin UI without change.
 *
 * Store resolution mirrors src/stats.ts / src/reembed.ts: offline,
 * filesystem-scoped by --tenant/--pool over FALDA_ROOT, no token/auth
 * layer (there is no running server involved). A store never opened by
 * this module is never inspectable — that IS the authorization boundary
 * (spec "Do not allow inspection of stores the caller is not authorized
 * to access").
 *
 * Every exported function here is read-only. No write statement appears
 * anywhere in this file.
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import { listAllStores, type StoreRef } from "../stats.js";
import { computeInspectionWarnings, type InspectWarnThresholds } from "./warnings.js";
import type {
  ActionFilter, CandidateView, CoreEffectView, DecisionAction, DecisionEvidenceView,
  DecisionView, EvidenceTurn, InspectReport, InspectSelector, PassDetail, PassStatus,
  PassSummary, SceneEffectView,
} from "./types.js";

// Evidence truncation defaults (spec §Evidence mode). --verbose expands both.
const DEFAULT_MAX_EVIDENCE_TURNS = 10;
const DEFAULT_MAX_EVIDENCE_CHARS = 1000;
const VERBOSE_MAX_EVIDENCE_TURNS = 50;
const VERBOSE_MAX_EVIDENCE_CHARS = 5000;

interface OpenStore { store: StoreRef; db: Database.Database }

/** Resolve which stores under `root` are in-scope for this selector, and
 *  open each one that has a materialized falda.db, read-only. Stores with
 *  no db file yet are silently skipped (nothing to inspect) — mirrors
 *  src/stats.ts's inspectStore zero-report behavior but there is no report
 *  to emit for an inspector, so it is simply absent from results. */
function openStoresForSelector(sel: InspectSelector): OpenStore[] {
  let stores = listAllStores(sel.root);
  if (sel.tenant) stores = stores.filter((s) => s.scope === "self" && s.name === sel.tenant);
  if (sel.pool) stores = stores.filter((s) => s.scope === "pool" && s.name === sel.pool);

  const open: OpenStore[] = [];
  for (const store of stores) {
    if (!fs.existsSync(store.dbPath)) continue;
    try {
      const db = new Database(store.dbPath, { readonly: true, fileMustExist: true });
      // distillation_passes / consolidation_decisions / pass_scene_effects /
      // pass_core_effects may not exist on a store never distilled — treat
      // as "nothing to inspect" rather than an error.
      const has = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='distillation_passes'"
      ).get();
      if (!has) { db.close(); continue; }
      open.push({ store, db });
    } catch {
      // Corrupt/locked store db: skip rather than crash the whole report.
    }
  }
  return open;
}

function closeAll(open: OpenStore[]): void {
  for (const o of open) { try { o.db.close(); } catch { /* best-effort */ } }
}

interface RawPassRow {
  pass_id: string; store_key: string;
  watermark_start: number | null; watermark_end: number | null;
  started_at: string; completed_at: string | null; status: PassStatus;
  input_turn_count: number | null; candidate_count: number | null; error: string | null;
  model: string | null; prompt_version: string | null; distiller_version: string | null;
}

function decisionCountsFor(db: Database.Database, passId: string): Record<DecisionAction, number> {
  const rows = db.prepare(
    "SELECT action, COUNT(*) c FROM consolidation_decisions WHERE pass_id=? GROUP BY action"
  ).all(passId) as Array<{ action: string; c: number }>;
  const counts: Record<DecisionAction, number> = { store: 0, update: 0, merge: 0, skip: 0 };
  for (const r of rows) if (r.action in counts) counts[r.action as DecisionAction] = r.c;
  return counts;
}

function toSummary(o: OpenStore, row: RawPassRow): PassSummary {
  const decision_counts = decisionCountsFor(o.db, row.pass_id);
  const sceneEffectCount = (o.db.prepare(
    "SELECT COUNT(*) c FROM pass_scene_effects WHERE pass_id=?"
  ).get(row.pass_id) as any).c as number;
  const coreRow = o.db.prepare(
    "SELECT effect FROM pass_core_effects WHERE pass_id=?"
  ).get(row.pass_id) as { effect: string } | undefined;
  return {
    pass_id: row.pass_id,
    store: o.store,
    store_key: row.store_key,
    started_at: row.started_at,
    completed_at: row.completed_at,
    status: row.status,
    watermark_start: row.watermark_start,
    watermark_end: row.watermark_end,
    input_turn_count: row.input_turn_count,
    candidate_count: row.candidate_count,
    decision_counts,
    scene_effect_count: sceneEffectCount,
    core_changed: coreRow ? coreRow.effect !== "unchanged" : false,
    model: row.model,
    prompt_version: row.prompt_version,
    distiller_version: row.distiller_version,
    error: row.error,
  };
}

/** True if `startedAt` falls within `sinceMs` milliseconds of now. */
function withinSince(startedAt: string, sinceMs: number): boolean {
  return Date.now() - Date.parse(startedAt) <= sinceMs;
}

/**
 * List passes across every in-scope store, newest first.
 *
 * Selection semantics (spec: "Selectors should compose where sensible"):
 *   --pass          exact lookup, ignores --last/--since/--random
 *   --since/--status/--action  narrow the candidate set; compose freely
 *   --last          caps the result count. Defaults to 10 ONLY when the
 *                   caller supplied no other narrowing selector (--since,
 *                   --pass, --random) — otherwise "--since 24h" would
 *                   silently hide passes beyond the 10 most recent, which
 *                   contradicts the spec's own example ("show me the last
 *                   24h", however many that is).
 *   --random N      independent sampling mode — see selectRandomDecisions.
 */
export function listDistillationPasses(sel: InspectSelector): PassSummary[] {
  const open = openStoresForSelector(sel);
  try {
    let rows: Array<{ o: OpenStore; row: RawPassRow }> = [];
    for (const o of open) {
      const where: string[] = []; const args: unknown[] = [];
      if (sel.passId) { where.push("pass_id=?"); args.push(sel.passId); }
      if (sel.status) { where.push("status=?"); args.push(sel.status); }
      const w = where.length ? "WHERE " + where.join(" AND ") : "";
      const storeRows = o.db.prepare(
        `SELECT * FROM distillation_passes ${w} ORDER BY started_at DESC`
      ).all(...args) as RawPassRow[];
      for (const row of storeRows) rows.push({ o, row });
    }

    if (sel.sinceMs !== undefined) {
      rows = rows.filter((r) => withinSince(r.row.started_at, sel.sinceMs!));
    }

    if (sel.actions?.length) {
      rows = rows.filter((r) => {
        const counts = decisionCountsFor(r.o.db, r.row.pass_id);
        return sel.actions!.some((a) => counts[a] > 0);
      });
    }

    rows.sort((a, b) => (a.row.started_at < b.row.started_at ? 1 : -1));

    const noOtherNarrowing = sel.sinceMs === undefined && !sel.passId && !sel.random;
    const effectiveLast = sel.last ?? (noOtherNarrowing ? 10 : undefined);
    if (effectiveLast !== undefined) rows = rows.slice(0, effectiveLast);

    return rows.map(({ o, row }) => toSummary(o, row));
  } finally {
    closeAll(open);
  }
}

function candidateFromRow(row: any): CandidateView {
  return {
    type: row.candidate_type ?? null,
    content: row.candidate_content ?? null,
    confidence: row.candidate_confidence ?? null,
  };
}

/** All decisions for one pass, in original extraction order. */
export function getPassDecisions(db: Database.Database, passId: string, actions?: ActionFilter): DecisionView[] {
  const rows = db.prepare(
    "SELECT * FROM consolidation_decisions WHERE pass_id=? ORDER BY id"
  ).all(passId) as any[];
  const filtered = actions?.length ? rows.filter((r) => actions.includes(r.action)) : rows;
  return filtered.map((r) => ({
    id: r.id,
    pass_id: r.pass_id,
    action: r.action as DecisionAction,
    candidate: candidateFromRow(r),
    atom_id: r.atom_id ?? null,
    target_ids: r.target_ids ? JSON.parse(r.target_ids) : [],
    rationale: r.rationale ?? null,
    decided_at: r.decided_at,
  }));
}

export function getPassSceneChanges(db: Database.Database, passId: string): SceneEffectView[] {
  const rows = db.prepare(
    "SELECT * FROM pass_scene_effects WHERE pass_id=? ORDER BY scene_kind, scene_id"
  ).all(passId) as any[];
  return rows.map((r) => ({
    scene_id: r.scene_id,
    scene_kind: r.scene_kind,
    title: r.title,
    effect: r.effect,
    members_before: r.members_before,
    members_after: r.members_after,
    added: JSON.parse(r.added_json ?? "[]"),
    removed: JSON.parse(r.removed_json ?? "[]"),
    summary_regenerated: !!r.summary_regenerated,
    embedding_regenerated: !!r.embedding_regenerated,
  }));
}

export function getPassCoreChange(db: Database.Database, passId: string): CoreEffectView | null {
  const row = db.prepare("SELECT * FROM pass_core_effects WHERE pass_id=?").get(passId) as any;
  if (!row) return null;
  return {
    effect: row.effect,
    old_input_hash: row.old_input_hash ?? null,
    new_input_hash: row.new_input_hash ?? null,
    old_chars: row.old_chars ?? null,
    new_chars: row.new_chars ?? null,
  };
}

/**
 * Evidence turns for one decision (spec §Evidence mode).
 *   - store/update/merge (atom_id set): full evidence chain for that atom
 *     via atom_evidence → stream — includes prior-pass evidence for
 *     updated/merged atoms, which is intentional (shows the full
 *     provenance, not just this pass's contribution).
 *   - skip (no durable atom): falls back to the pass's own turn window
 *     (watermark_start, watermark_end] — the only evidence a skipped
 *     candidate ever had (spec: "use the pass/window evidence associated
 *     with that candidate").
 */
export function getDecisionEvidence(
  db: Database.Database,
  decision: DecisionView,
  pass: { watermark_start: number | null; watermark_end: number | null },
  verbose = false,
): DecisionEvidenceView {
  const maxTurns = verbose ? VERBOSE_MAX_EVIDENCE_TURNS : DEFAULT_MAX_EVIDENCE_TURNS;
  const maxChars = verbose ? VERBOSE_MAX_EVIDENCE_CHARS : DEFAULT_MAX_EVIDENCE_CHARS;

  let rows: any[];
  if (decision.atom_id) {
    rows = db.prepare(
      `SELECT s.id AS stream_id, s.session_id, s.role, s.content, s.ts AS timestamp, s.turn_index, s.seq
       FROM atom_evidence ae JOIN stream s ON s.id = ae.stream_id
       WHERE ae.atom_id = ? ORDER BY s.seq`
    ).all(decision.atom_id);
  } else {
    rows = db.prepare(
      `SELECT id AS stream_id, session_id, role, content, ts AS timestamp, turn_index, seq
       FROM stream WHERE seq > ? AND seq <= ? ORDER BY seq`
    ).all(pass.watermark_start ?? 0, pass.watermark_end ?? Number.MAX_SAFE_INTEGER);
  }

  const truncatedByCount = rows.length > maxTurns;
  const kept = rows.slice(0, maxTurns);
  const turns: EvidenceTurn[] = kept.map((r) => {
    const truncated = r.content.length > maxChars;
    return {
      stream_id: r.stream_id,
      session_id: r.session_id,
      role: r.role,
      content: truncated ? r.content.slice(0, maxChars) + "…" : r.content,
      timestamp: r.timestamp,
      turn_index: r.turn_index ?? null,
      truncated,
    };
  });

  return { decision_id: decision.id, truncated: truncatedByCount, turns };
}

function buildPassDetail(o: OpenStore, row: RawPassRow, sel: InspectSelector, warnThresholds?: InspectWarnThresholds): PassDetail {
  const summary = toSummary(o, row);
  const decisions = getPassDecisions(o.db, row.pass_id, sel.actions);
  const scenes = getPassSceneChanges(o.db, row.pass_id);
  const core = getPassCoreChange(o.db, row.pass_id);

  // Target-atom ages for the rapid-supersession signal.
  const targetIds = [...new Set(decisions.flatMap((d) => d.target_ids))];
  const targetAtomCreatedAt: Record<string, string> = {};
  if (targetIds.length) {
    const placeholders = targetIds.map(() => "?").join(",");
    const atomRows = o.db.prepare(
      `SELECT id, created_at FROM atoms WHERE id IN (${placeholders})`
    ).all(...targetIds) as Array<{ id: string; created_at: string }>;
    for (const r of atomRows) targetAtomCreatedAt[r.id] = r.created_at;
  }

  const warnings = computeInspectionWarnings({
    input_turn_count: row.input_turn_count,
    candidate_count: row.candidate_count,
    decisions: getPassDecisions(o.db, row.pass_id), // unfiltered — warnings judge the whole pass, not the --action view
    scenes,
    core,
    decided_at: row.completed_at ?? row.started_at,
    targetAtomCreatedAt,
  }, warnThresholds);

  const detail: PassDetail = { ...summary, decisions, scenes, core, warnings };

  if (sel.evidence) {
    detail.evidence = {};
    for (const d of decisions) {
      detail.evidence[d.id] = getDecisionEvidence(o.db, d, row, sel.verbose);
    }
  }

  return detail;
}

/** Full detail for every pass matched by the selector (spec's default
 *  `falda distill inspect --last 10` path — NOT random sampling). */
export function buildInspectReport(sel: InspectSelector, warnThresholds?: InspectWarnThresholds): InspectReport {
  if (sel.random) return buildRandomDecisionReport(sel, warnThresholds);

  const summaries = listDistillationPasses(sel);
  const open = openStoresForSelector(sel);
  try {
    const byStoreKey = new Map<string, OpenStore>();
    for (const o of open) byStoreKey.set(`${o.store.dbPath}`, o);

    const passes: PassDetail[] = [];
    for (const summary of summaries) {
      const o = byStoreKey.get(summary.store.dbPath);
      if (!o) continue;
      const row = o.db.prepare("SELECT * FROM distillation_passes WHERE pass_id=?").get(summary.pass_id) as RawPassRow;
      const detail = buildPassDetail(o, row, sel, warnThresholds);
      // --action already narrowed which PASSES appear (listDistillationPasses);
      // buildPassDetail further narrows which DECISIONS are shown within it.
      if (sel.actions?.length && detail.decisions.length === 0) continue;
      passes.push(detail);
    }

    return { generated_at: new Date().toISOString(), passes };
  } finally {
    closeAll(open);
  }
}

/**
 * `--random N` — spec: "I suggest sampling decisions rather than passes
 * because it is more useful for quality review." Samples N decisions
 * (optionally filtered by --action) uniformly at random across every
 * in-scope store, using SQLite's ORDER BY RANDOM() (not cryptographically
 * random — the spec explicitly says this is unnecessary). Each sampled
 * decision is returned wrapped in its owning pass's summary, but the
 * pass's `decisions` array contains ONLY the sampled decision(s) from that
 * pass — never the full pass — and `selection_note` documents the sample.
 */
function buildRandomDecisionReport(sel: InspectSelector, warnThresholds?: InspectWarnThresholds): InspectReport {
  const open = openStoresForSelector(sel);
  try {
    interface Sampled { o: OpenStore; passRow: RawPassRow; decisionId: string }
    const candidates: Sampled[] = [];

    for (const o of open) {
      const where: string[] = [];
      const args: unknown[] = [];
      if (sel.actions?.length) {
        where.push(`d.action IN (${sel.actions.map(() => "?").join(",")})`);
        args.push(...sel.actions);
      }
      if (sel.passId) { where.push("d.pass_id=?"); args.push(sel.passId); }
      const w = where.length ? "WHERE " + where.join(" AND ") : "";
      const rows = o.db.prepare(
        `SELECT d.id AS decision_id, p.* FROM consolidation_decisions d
         JOIN distillation_passes p ON p.pass_id = d.pass_id
         ${w}`
      ).all(...args) as any[];
      for (const r of rows) {
        const { decision_id, ...passRow } = r;
        candidates.push({ o, passRow: passRow as RawPassRow, decisionId: decision_id });
      }
    }

    if (sel.sinceMs !== undefined) {
      candidates.splice(0, candidates.length, ...candidates.filter((c) => withinSince(c.passRow.started_at, sel.sinceMs!)));
    }

    // Fisher-Yates shuffle then take N — deterministic-enough, not crypto.
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const sample = candidates.slice(0, sel.random);

    // Group sampled decisions by (store, pass) so each pass header appears once.
    const grouped = new Map<string, { o: OpenStore; passRow: RawPassRow; decisionIds: Set<string> }>();
    for (const c of sample) {
      const key = `${c.o.store.dbPath}|${c.passRow.pass_id}`;
      if (!grouped.has(key)) grouped.set(key, { o: c.o, passRow: c.passRow, decisionIds: new Set() });
      grouped.get(key)!.decisionIds.add(c.decisionId);
    }

    const passes: PassDetail[] = [];
    for (const { o, passRow, decisionIds } of grouped.values()) {
      const allDecisions = getPassDecisions(o.db, passRow.pass_id);
      const sampledDecisions = allDecisions.filter((d) => decisionIds.has(d.id));
      const scenes = getPassSceneChanges(o.db, passRow.pass_id);
      const core = getPassCoreChange(o.db, passRow.pass_id);
      const warnings = computeInspectionWarnings({
        input_turn_count: passRow.input_turn_count,
        candidate_count: passRow.candidate_count,
        decisions: allDecisions,
        scenes, core,
        decided_at: passRow.completed_at ?? passRow.started_at,
      }, warnThresholds);
      const summary = toSummary(o, passRow);
      const detail: PassDetail = { ...summary, decisions: sampledDecisions, scenes, core, warnings };
      if (sel.evidence) {
        detail.evidence = {};
        for (const d of sampledDecisions) detail.evidence[d.id] = getDecisionEvidence(o.db, d, passRow, sel.verbose);
      }
      passes.push(detail);
    }

    passes.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));

    return {
      generated_at: new Date().toISOString(),
      passes,
      selection_note: `random sample of ${sample.length} decision(s)` +
        (sel.actions?.length ? ` (action in: ${sel.actions.join(", ")})` : "") +
        ` out of ${candidates.length} matching candidate(s)`,
    };
  } finally {
    closeAll(open);
  }
}
