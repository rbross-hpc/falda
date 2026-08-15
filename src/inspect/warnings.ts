/**
 * Suspicion/anomaly heuristics for `falda distill inspect`.
 *
 * These are attention-directing signals for a human reviewer, NOT
 * correctness judgments, and computing them never mutates a store (spec
 * §Suspicion/anomaly signals). Thresholds are configurable via
 * FALDA_INSPECT_WARN_* env vars, resolved once per CLI invocation — same
 * pattern as src/recall/budgets.ts.
 */
import type { DecisionView, SceneEffectView, CoreEffectView, InspectionWarning } from "./types.js";

export interface InspectWarnThresholds {
  /** candidate_count / input_turn_count ratio above which extraction is "large". */
  largeExtractionRatio: number;
  /** input_turn_count at/above which zero candidates counts as "empty extraction". */
  emptyExtractionMinTurns: number;
  /** merge absorbing >= this many target atoms is "large". */
  largeMergeAtoms: number;
  /** scene membership churn fraction (added+removed / max(before,after)) above which scene churn warns. */
  sceneChurnFraction: number;
  /** core char-count relative change (|new-old|/max(old,1)) above which core churn warns. */
  coreChurnFraction: number;
  /** an atom superseded within this many minutes of its own creation is "rapid". */
  rapidSupersessionMinutes: number;
  /** stored-atom count in a single pass at/above this is a "growth spike". */
  atomGrowthSpike: number;
}

const DEFAULTS: InspectWarnThresholds = {
  largeExtractionRatio: 1.5,
  emptyExtractionMinTurns: 5,
  largeMergeAtoms: 3,
  sceneChurnFraction: 0.5,
  coreChurnFraction: 0.5,
  rapidSupersessionMinutes: 60,
  atomGrowthSpike: 10,
};

function resolveFloatEnv(envValue: string | undefined, fallback: number): number {
  if (envValue === undefined || envValue === "") return fallback;
  const n = Number(envValue);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function resolveInspectWarnThresholds(env: NodeJS.ProcessEnv = process.env): InspectWarnThresholds {
  return {
    largeExtractionRatio: resolveFloatEnv(env.FALDA_INSPECT_WARN_LARGE_EXTRACTION_RATIO, DEFAULTS.largeExtractionRatio),
    emptyExtractionMinTurns: resolveFloatEnv(env.FALDA_INSPECT_WARN_EMPTY_EXTRACTION_MIN_TURNS, DEFAULTS.emptyExtractionMinTurns),
    largeMergeAtoms: resolveFloatEnv(env.FALDA_INSPECT_WARN_LARGE_MERGE_ATOMS, DEFAULTS.largeMergeAtoms),
    sceneChurnFraction: resolveFloatEnv(env.FALDA_INSPECT_WARN_SCENE_CHURN_FRACTION, DEFAULTS.sceneChurnFraction),
    coreChurnFraction: resolveFloatEnv(env.FALDA_INSPECT_WARN_CORE_CHURN_FRACTION, DEFAULTS.coreChurnFraction),
    rapidSupersessionMinutes: resolveFloatEnv(env.FALDA_INSPECT_WARN_RAPID_SUPERSESSION_MINUTES, DEFAULTS.rapidSupersessionMinutes),
    atomGrowthSpike: resolveFloatEnv(env.FALDA_INSPECT_WARN_ATOM_GROWTH_SPIKE, DEFAULTS.atomGrowthSpike),
  };
}

export interface WarningInputs {
  input_turn_count: number | null;
  candidate_count: number | null;
  decisions: DecisionView[];
  scenes: SceneEffectView[];
  core: CoreEffectView | null;
  /** decided_at of this pass (used as the "now" for supersession timing). */
  decided_at?: string;
  /** created_at of each atom targeted by an update/merge decision in this
   *  pass, keyed by atom id — used to detect rapid supersession. Omitted
   *  entries are treated as "unknown age", never flagged. */
  targetAtomCreatedAt?: Record<string, string>;
}

/**
 * Compute heuristic warnings for one pass. Pure function — no I/O, no
 * mutation. Thresholds default to resolveInspectWarnThresholds() but can be
 * overridden (primarily for tests).
 */
export function computeInspectionWarnings(
  p: WarningInputs,
  thresholds: InspectWarnThresholds = resolveInspectWarnThresholds(),
): InspectionWarning[] {
  const warnings: InspectionWarning[] = [];
  const turns = p.input_turn_count ?? 0;
  const candidates = p.candidate_count ?? p.decisions.length;

  // large extraction: candidates high relative to input turns
  if (turns > 0 && candidates / turns > thresholds.largeExtractionRatio) {
    warnings.push({
      code: "large_extraction",
      level: "warn",
      message: `${candidates} candidate(s) extracted from ${turns} turn(s) (ratio ${(candidates / turns).toFixed(2)} > ${thresholds.largeExtractionRatio})`,
    });
  }

  // empty extraction: many turns processed, zero candidates
  if (turns >= thresholds.emptyExtractionMinTurns && candidates === 0) {
    warnings.push({
      code: "empty_extraction",
      level: "warn",
      message: `0 candidates extracted from ${turns} turns`,
    });
  }

  // large merge: merge absorbs >= N atoms
  for (const d of p.decisions) {
    if (d.action === "merge" && d.target_ids.length >= thresholds.largeMergeAtoms) {
      warnings.push({
        code: "large_merge",
        level: "warn",
        message: `merge absorbed ${d.target_ids.length} active atom(s) (decision ${d.id})`,
      });
    }
  }

  // scene churn: membership changed beyond configured fraction
  for (const s of p.scenes) {
    if (s.effect === "retired" || s.effect === "created") continue; // wholesale create/retire is not "churn"
    const denom = Math.max(s.members_before, s.members_after, 1);
    const churn = (s.added.length + s.removed.length) / denom;
    if (churn > thresholds.sceneChurnFraction) {
      warnings.push({
        code: "scene_churn",
        level: "warn",
        message: `${s.scene_kind} scene "${s.title}" (${s.scene_id}) membership changed ${(churn * 100).toFixed(0)}%`,
      });
    }
  }

  // atom growth spike: many atoms stored in one pass
  const storedCount = p.decisions.filter((d) => d.action === "store").length;
  if (storedCount >= thresholds.atomGrowthSpike) {
    warnings.push({
      code: "atom_growth_spike",
      level: "warn",
      message: `${storedCount} new atom(s) stored in a single pass (>= ${thresholds.atomGrowthSpike})`,
    });
  }

  // rapid supersession: an update/merge target was created shortly before
  // being superseded/absorbed by this same pass.
  if (p.decided_at && p.targetAtomCreatedAt) {
    const decidedMs = Date.parse(p.decided_at);
    for (const d of p.decisions) {
      if (d.action !== "update" && d.action !== "merge") continue;
      for (const targetId of d.target_ids) {
        const createdAt = p.targetAtomCreatedAt[targetId];
        if (!createdAt) continue;
        const ageMinutes = (decidedMs - Date.parse(createdAt)) / 60000;
        if (ageMinutes >= 0 && ageMinutes < thresholds.rapidSupersessionMinutes) {
          warnings.push({
            code: "rapid_supersession",
            level: "warn",
            message: `atom ${targetId} superseded/absorbed ${Math.round(ageMinutes)} min after creation (decision ${d.id})`,
          });
        }
      }
    }
  }

  // core churn: input/output size changed sharply
  if (p.core && p.core.effect === "regenerated") {
    const oldChars = p.core.old_chars ?? 0;
    const newChars = p.core.new_chars ?? 0;
    const denom = Math.max(oldChars, 1);
    const churn = Math.abs(newChars - oldChars) / denom;
    if (oldChars > 0 && churn > thresholds.coreChurnFraction) {
      warnings.push({
        code: "core_churn",
        level: "warn",
        message: `core size changed ${(churn * 100).toFixed(0)}% (${oldChars} → ${newChars} chars)`,
      });
    }
  }

  return warnings;
}
