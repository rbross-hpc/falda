/**
 * DTOs for `falda distill inspect` (src/inspect/).
 *
 * These types are the single source of truth consumed by BOTH the human
 * renderer and the --json output (src/inspect/format.ts) — neither format
 * computes anything the other doesn't see, per the spec's "human output and
 * JSON output should derive from the same internal inspection DTOs".
 *
 * Everything here is read-only description of state already persisted by
 * src/distill/core.ts (distillation_passes, consolidation_decisions,
 * pass_scene_effects, pass_core_effects) plus src/falda.ts's stream/atoms/
 * scenes tables. Nothing in src/inspect/ mutates a store.
 */
import type { StoreRef } from "../stats.js";

export type DecisionAction = "store" | "update" | "merge" | "skip";
export type PassStatus = "running" | "done" | "failed";

export interface CandidateView {
  type: string | null;
  content: string | null;
  confidence: string | null;
}

export interface DecisionView {
  id: string;
  pass_id: string;
  action: DecisionAction;
  candidate: CandidateView;
  /** Resulting atom id, if any (store/update/merge). Null for skip. */
  atom_id: string | null;
  /** Existing atom(s) presented to consolidation and absorbed/superseded. */
  target_ids: string[];
  rationale: string | null;
  decided_at: string;
}

export interface EvidenceTurn {
  stream_id: string;
  session_id: string;
  role: string;
  content: string;
  timestamp: string;
  turn_index: number | null;
  /** True when `content` was cut to the per-turn char cap. */
  truncated: boolean;
}

export interface DecisionEvidenceView {
  decision_id: string;
  /** True when more turns exist than were returned (max-turns cap hit). */
  truncated: boolean;
  turns: EvidenceTurn[];
}

export interface SceneEffectView {
  scene_id: string;
  scene_kind: "episode" | "topic";
  title: string;
  effect: "created" | "updated" | "retired" | "unchanged";
  members_before: number;
  members_after: number;
  added: string[];
  removed: string[];
  summary_regenerated: boolean;
  embedding_regenerated: boolean;
}

export interface CoreEffectView {
  effect: "unchanged" | "regenerated" | "deleted" | "failed";
  old_input_hash: string | null;
  new_input_hash: string | null;
  old_chars: number | null;
  new_chars: number | null;
}

export interface InspectionWarning {
  code: string;
  level: "warn" | "error";
  message: string;
}

export interface PassSummary {
  pass_id: string;
  store: StoreRef;
  store_key: string;
  started_at: string;
  completed_at: string | null;
  status: PassStatus;
  watermark_start: number | null;
  watermark_end: number | null;
  input_turn_count: number | null;
  candidate_count: number | null;
  decision_counts: Record<DecisionAction, number>;
  scene_effect_count: number;
  core_changed: boolean;
  model: string | null;
  prompt_version: string | null;
  distiller_version: string | null;
  error: string | null;
}

/** Full detail view for one pass — what `--pass <id>` returns. */
export interface PassDetail extends PassSummary {
  decisions: DecisionView[];
  scenes: SceneEffectView[];
  core: CoreEffectView | null;
  warnings: InspectionWarning[];
  /** Present only when --evidence was requested. */
  evidence?: Record<string /* decision_id */, DecisionEvidenceView>;
}

export interface InspectReport {
  generated_at: string;
  passes: PassDetail[];
  /** Human-readable note on selection semantics (e.g. random sampling). */
  selection_note?: string;
}

export type ActionFilter = DecisionAction[];

export interface InspectSelector {
  root: string;
  tenant?: string;
  pool?: string;
  last?: number;
  sinceMs?: number;
  passId?: string;
  actions?: ActionFilter;
  status?: PassStatus;
  random?: number;
  evidence?: boolean;
  verbose?: boolean;
}
