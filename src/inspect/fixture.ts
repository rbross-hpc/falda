/**
 * `falda distill inspect --pass <id> --export-fixture out.json`
 *
 * Assembles enough information about ONE decision (or every decision in a
 * pass, if no single decision is targeted) to later replay/evaluate it as a
 * regression case — the spec's "turn real mistakes into regression tests"
 * workflow. Read-only: writing the fixture file is the only I/O, and it
 * never touches the store itself (no coupling to mutation, per spec).
 */
import * as fs from "node:fs";
import type Database from "better-sqlite3";
import type { PassDetail, DecisionView, DecisionEvidenceView } from "./types.js";
import { getDecisionEvidence } from "./distill.js";

export interface FixtureExistingAtom {
  id: string;
  type: string;
  content: string;
  confidence: string;
}

export interface FixtureCase {
  pass_id: string;
  decision_id: string;
  model: string | null;
  prompt_version: string | null;
  distiller_version: string | null;
  input_evidence: DecisionEvidenceView;
  candidate: DecisionView["candidate"];
  /** Existing atoms that were presented to consolidation for this candidate
   *  (best-effort reconstruction: the decision's target_ids, resolved to
   *  their current row — "current" because consolidation input snapshots
   *  aren't separately persisted; see docs/OPERATIONS.md caveat). */
  existing_candidate_atoms: FixtureExistingAtom[];
  applied_decision: {
    action: DecisionView["action"];
    target_ids: string[];
    rationale: string | null;
  };
  resulting_atom_id: string | null;
}

export interface DistillFixture {
  exported_at: string;
  store_key: string;
  cases: FixtureCase[];
}

function resolveExistingAtoms(db: Database.Database, ids: string[]): FixtureExistingAtom[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, type, content, confidence FROM atoms WHERE id IN (${placeholders})`
  ).all(...ids) as FixtureExistingAtom[];
  return rows;
}

/**
 * Build a fixture for every decision in `pass` (optionally narrowed to
 * `decisionId`). `db` must be the same store db the pass was read from —
 * callers pass it through from src/inspect/cli.ts, which already has it
 * open for the report it just built.
 */
export function buildDistillFixture(
  db: Database.Database,
  pass: PassDetail,
  opts: { decisionId?: string; verbose?: boolean } = {},
): DistillFixture {
  const decisions = opts.decisionId
    ? pass.decisions.filter((d) => d.id === opts.decisionId)
    : pass.decisions;

  const cases: FixtureCase[] = decisions.map((d) => {
    const evidence = pass.evidence?.[d.id]
      ?? getDecisionEvidence(db, d, { watermark_start: pass.watermark_start, watermark_end: pass.watermark_end }, opts.verbose ?? true);
    return {
      pass_id: pass.pass_id,
      decision_id: d.id,
      model: pass.model,
      prompt_version: pass.prompt_version,
      distiller_version: pass.distiller_version,
      input_evidence: evidence,
      candidate: d.candidate,
      existing_candidate_atoms: resolveExistingAtoms(db, d.target_ids),
      applied_decision: { action: d.action, target_ids: d.target_ids, rationale: d.rationale },
      resulting_atom_id: d.atom_id,
    };
  });

  return { exported_at: new Date().toISOString(), store_key: pass.store_key, cases };
}

export function writeFixtureFile(path: string, fixture: DistillFixture): void {
  fs.writeFileSync(path, JSON.stringify(fixture, null, 2));
}
