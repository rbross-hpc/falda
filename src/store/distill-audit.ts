/**
 * Distillation audit persistence — consolidation decisions, pass metadata,
 * and scene/core effect logs (the write side of `falda distill inspect`,
 * see src/inspect/).
 *
 * Extracted from src/falda.ts (originally Falda.recordDecision/
 * recordPassStart/recordPassComplete/recordSceneEffect/recordCoreEffect) to
 * separate audit-trail persistence from tier-repository CRUD, without
 * changing behavior. These tables live in the same per-store falda.db as
 * the T0-T3 tiers (docs/MODEL.md §14), but writing to them is not itself
 * T0-T3 domain logic — it is bookkeeping the distillation pipeline
 * (src/distill/core.ts) uses to make its own decisions inspectable after
 * the fact. `Falda` still exposes these as public methods (recordDecision,
 * recordPassStart, ...), delegating to the functions here, so
 * src/distill/core.ts's call sites are unchanged.
 */
import type Database from "better-sqlite3";
import type { SceneKind } from "../falda.js";

export function recordDecision(db: Database.Database, d: {
  id: string; pass_id: string; action: string;
  atom_id?: string; target_ids?: string[]; rationale?: string;
  candidate_type?: string; candidate_content?: string; candidate_confidence?: string;
}): void {
  db.prepare(
    `INSERT OR IGNORE INTO consolidation_decisions
     (id,pass_id,action,atom_id,target_ids,rationale,decided_at,
      candidate_type,candidate_content,candidate_confidence)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).run(
    d.id, d.pass_id, d.action,
    d.atom_id ?? null,
    d.target_ids ? JSON.stringify(d.target_ids) : null,
    d.rationale ?? null,
    new Date().toISOString(),
    d.candidate_type ?? null,
    d.candidate_content ?? null,
    d.candidate_confidence ?? null,
  );
}

export function recordPassStart(db: Database.Database, p: {
  pass_id: string; store_key: string;
  watermark_start: number | null; watermark_end: number | null;
  input_turn_count: number;
  model?: string; prompt_version?: string; distiller_version?: string;
}): void {
  // INSERT ... ON CONFLICT DO UPDATE (upsert on primary key) so that a
  // retry of the same deterministic pass_id refreshes the row with the
  // latest attempt's provenance (model, prompt_version, distiller_version,
  // started_at) and clears stale completion data. Without this, a
  // successful retry run under a different model or prompt version would
  // still display the original failed attempt's provenance in
  // `falda distill inspect`.
  db.prepare(
    `INSERT INTO distillation_passes
     (pass_id,store_key,watermark_start,watermark_end,started_at,status,
      input_turn_count,candidate_count,error,model,prompt_version,distiller_version)
     VALUES(?,?,?,?,?,'running',?,NULL,NULL,?,?,?)
     ON CONFLICT(pass_id) DO UPDATE SET
       store_key=excluded.store_key,
       watermark_start=excluded.watermark_start,
       watermark_end=excluded.watermark_end,
       started_at=excluded.started_at,
       completed_at=NULL,
       status='running',
       input_turn_count=excluded.input_turn_count,
       candidate_count=NULL,
       error=NULL,
       model=excluded.model,
       prompt_version=excluded.prompt_version,
       distiller_version=excluded.distiller_version`
  ).run(
    p.pass_id, p.store_key, p.watermark_start, p.watermark_end,
    new Date().toISOString(), p.input_turn_count,
    p.model ?? null, p.prompt_version ?? null, p.distiller_version ?? null,
  );
}

export function recordPassComplete(db: Database.Database, p: {
  pass_id: string; status: "done" | "failed";
  candidate_count?: number; error?: string;
}): void {
  db.prepare(
    `UPDATE distillation_passes SET completed_at=?,status=?,candidate_count=?,error=?
     WHERE pass_id=?`
  ).run(
    new Date().toISOString(), p.status,
    p.candidate_count ?? null, p.error ?? null,
    p.pass_id,
  );
}

export function recordSceneEffect(db: Database.Database, e: {
  pass_id: string; scene_id: string; scene_kind: SceneKind; title: string;
  effect: "created" | "updated" | "retired" | "unchanged";
  members_before: number; members_after: number;
  added?: string[]; removed?: string[];
  summary_regenerated?: boolean; embedding_regenerated?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO pass_scene_effects
     (pass_id,scene_id,scene_kind,title,effect,members_before,members_after,
      added_json,removed_json,summary_regenerated,embedding_regenerated)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    e.pass_id, e.scene_id, e.scene_kind, e.title, e.effect,
    e.members_before, e.members_after,
    JSON.stringify(e.added ?? []), JSON.stringify(e.removed ?? []),
    e.summary_regenerated ? 1 : 0, e.embedding_regenerated ? 1 : 0,
  );
}

export function recordCoreEffect(db: Database.Database, e: {
  pass_id: string; effect: "unchanged" | "regenerated" | "deleted" | "failed";
  old_input_hash?: string | null; new_input_hash?: string | null;
  old_chars?: number | null; new_chars?: number | null;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO pass_core_effects
     (pass_id,effect,old_input_hash,new_input_hash,old_chars,new_chars)
     VALUES(?,?,?,?,?,?)`
  ).run(
    e.pass_id, e.effect,
    e.old_input_hash ?? null, e.new_input_hash ?? null,
    e.old_chars ?? null, e.new_chars ?? null,
  );
}
