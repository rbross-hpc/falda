/**
 * Retrieval policy snapshot — what recall_weights/tier_budgets a given
 * falda_recall invocation actually used, recorded on the trace so future
 * evaluation can tell "was this atom never retrieved" apart from "was this
 * atom retrieved under an old policy that has since been retuned"
 * (§13 policy provenance). Bump RETRIEVAL_POLICY_VERSION whenever the
 * *shape or meaning* of the weights/budgets changes (not on every tuning
 * pass — the numeric values themselves are already captured verbatim).
 */
import type { RecallWeights } from "../falda.js";
import type { TierBudgets } from "../distill/context.js";
import type { PolicySnapshot } from "./types.js";

export const RETRIEVAL_POLICY_VERSION = "1";

export function buildPolicySnapshot(weights: RecallWeights, budgets: TierBudgets): PolicySnapshot {
  return {
    weights: {
      recency: weights.wRecency,
      priority: weights.wPriority,
      confidence: weights.wConfidence,
    },
    budgets: { ...budgets },
    recency_half_life_days: weights.recencyHalfLifeDays,
    version: RETRIEVAL_POLICY_VERSION,
  };
}
