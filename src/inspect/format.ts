/**
 * Rendering for `falda distill inspect` — human-readable text and JSON,
 * both deriving from the same InspectReport/PassDetail DTOs (src/inspect/
 * types.ts). Neither renderer computes anything the other doesn't see.
 */
import type { InspectReport, PassDetail, DecisionView, SceneEffectView, CoreEffectView } from "./types.js";

export function renderJson(report: InspectReport): string {
  return JSON.stringify(report, null, 2);
}

function fmtCandidate(d: DecisionView): string {
  const type = d.candidate.type ?? "?";
  const content = d.candidate.content ?? "(candidate content unavailable)";
  return `[${type}] ${content}`;
}

function renderDecision(d: DecisionView, verbose: boolean): string[] {
  const lines: string[] = [];
  switch (d.action) {
    case "store":
      lines.push(`  + ${fmtCandidate(d)}`);
      if (d.candidate.confidence) lines.push(`    confidence: ${d.candidate.confidence}`);
      if (d.rationale) lines.push(`    rationale: ${d.rationale}`);
      if (d.atom_id) lines.push(`    atom: ${d.atom_id}`);
      break;
    case "update":
      lines.push(`  - (superseded) ${d.target_ids[0] ?? "?"}`);
      lines.push(`  + ${fmtCandidate(d)}`);
      if (d.candidate.confidence) lines.push(`    confidence: ${d.candidate.confidence}`);
      if (d.rationale) lines.push(`    rationale: ${d.rationale}`);
      lines.push(`    old: ${d.target_ids[0] ?? "?"}`);
      lines.push(`    new: ${d.atom_id ?? "?"}`);
      break;
    case "merge":
      for (const t of d.target_ids) lines.push(`  - ${t}`);
      lines.push(`  + ${d.atom_id ?? "?"} ${fmtCandidate(d)}`);
      if (d.rationale) lines.push(`    rationale: ${d.rationale}`);
      break;
    case "skip":
      lines.push(`  ~ ${fmtCandidate(d)}`);
      if (d.rationale) lines.push(`    rationale: ${d.rationale}`);
      break;
  }
  lines.push(`    decision: ${d.id}`);
  if (verbose) lines.push(`    decided_at: ${d.decided_at}`);
  return lines;
}

function renderEvidenceFor(report: InspectReport["passes"][number], decisionId: string): string[] {
  const ev = report.evidence?.[decisionId];
  if (!ev) return [];
  const lines: string[] = ["    evidence:"];
  if (!ev.turns.length) {
    lines.push("      (no evidence found)");
    return lines;
  }
  for (const t of ev.turns) {
    lines.push(`      [session ${t.session_id}, turn ${t.turn_index ?? "?"}, ${t.role}]`);
    for (const l of t.content.split("\n")) lines.push(`        ${l}`);
    if (t.truncated) lines.push("        …(truncated)");
  }
  if (ev.truncated) lines.push("      …(additional evidence turns truncated — use --verbose to see more)");
  return lines;
}

function renderScene(s: SceneEffectView, verbose: boolean): string[] {
  if (s.effect === "unchanged" && !verbose) return [];
  const lines: string[] = [];
  lines.push(`${s.scene_kind.toUpperCase()} ${s.scene_id} "${s.title}"`);
  lines.push(`  effect: ${s.effect}`);
  lines.push(`  members: ${s.members_before} → ${s.members_after}`);
  for (const id of s.added) lines.push(`  + atom ${id}`);
  for (const id of s.removed) lines.push(`  - atom ${id}`);
  if (s.summary_regenerated) lines.push(`  summary: regenerated`);
  if (s.embedding_regenerated) lines.push(`  embedding: regenerated`);
  return lines;
}

function renderCore(c: CoreEffectView | null): string[] {
  if (!c) return ["  (no core state recorded)"];
  const lines: string[] = [`  ${c.effect}`];
  if (c.effect === "regenerated") {
    lines.push(`  input hash: ${c.old_input_hash ?? "(none)"} → ${c.new_input_hash ?? "?"}`);
    lines.push(`  chars: ${c.old_chars ?? 0} → ${c.new_chars ?? 0}`);
  } else if (c.effect === "deleted") {
    lines.push(`  chars: ${c.old_chars ?? 0} → 0`);
  }
  return lines;
}

function renderPass(p: PassDetail, report: InspectReport, verbose: boolean): string[] {
  const lines: string[] = [];
  lines.push(`Pass ${p.pass_id}`);
  lines.push(`${p.started_at}${p.completed_at ? ` → ${p.completed_at}` : ""}  [${p.status}]`);
  lines.push(`Store: ${p.store.label}`);
  if (p.model || p.prompt_version || p.distiller_version) {
    lines.push(`Model: ${p.model ?? "?"}  Prompt: ${p.prompt_version ?? "?"}  Distiller: ${p.distiller_version ?? "?"}`);
  }
  lines.push(`Evidence: ${p.input_turn_count ?? 0} turns`);
  lines.push(`Candidates: ${p.candidate_count ?? p.decisions.length}`);
  if (p.error) lines.push(`Error: ${p.error}`);

  lines.push("", "Decisions", "---------");
  if (!p.decisions.length) {
    lines.push("  (no decisions match the current filter)");
  } else {
    const byAction: Record<string, DecisionView[]> = { store: [], update: [], merge: [], skip: [] };
    for (const d of p.decisions) byAction[d.action].push(d);
    for (const action of ["store", "update", "merge", "skip"] as const) {
      const ds = byAction[action];
      if (!ds.length) continue;
      lines.push("", action.toUpperCase());
      for (const d of ds) {
        lines.push(...renderDecision(d, verbose));
        lines.push(...renderEvidenceFor(p, d.id));
      }
    }
  }

  const sceneLines = p.scenes.flatMap((s) => renderScene(s, verbose));
  if (sceneLines.length) {
    lines.push("", "Scenes", "------", ...sceneLines);
  } else if (verbose) {
    lines.push("", "Scenes", "------", "  (no scene changes)");
  }

  lines.push("", "Core", "----", ...renderCore(p.core));

  if (p.warnings.length) {
    lines.push("", "Warnings", "--------");
    for (const w of p.warnings) lines.push(`  WARN  ${w.message}`);
  }

  return lines;
}

export function renderHuman(report: InspectReport, verbose = false): string {
  const lines: string[] = [];
  if (report.selection_note) lines.push(`(${report.selection_note})`, "");
  if (!report.passes.length) {
    lines.push("No distillation passes found for the given selector.");
    lines.push("(Only passes distilled after `falda distill inspect` support was deployed are visible.)");
    return lines.join("\n");
  }
  for (let i = 0; i < report.passes.length; i++) {
    if (i > 0) lines.push("", "═".repeat(60), "");
    lines.push(...renderPass(report.passes[i], report, verbose));
  }
  return lines.join("\n");
}
