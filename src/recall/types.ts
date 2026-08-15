/**
 * Recall trace + usage-reporting types (§ recall-feedback-loop).
 *
 * A "trace" is the record of one falda_recall / POST /recall invocation:
 * what was asked, what was returned (in rank order, with provenance), and
 * — filled in later, asynchronously, by a separate call — which of the
 * returned items were actually used. Traces are telemetry, not memory:
 * they live in their own store (recall_traces.db, see schema.ts) with
 * their own retention policy, never mutate the atoms/scenes they
 * reference, and a trace-persistence failure must never fail the recall
 * that produced it (best-effort — see traces.ts).
 */
import type { RecallItem } from "../distill/context.js";

export type UsageState = "unknown" | "used" | "unused";
export type RecallMode = "explicit" | "auto";

export interface PolicySnapshot {
  weights: { recency: number; priority: number; confidence: number };
  budgets: { pinned: number; atoms: number; scenes: number; core: number };
  recency_half_life_days: number;
  version: string;
}

export interface RecallTrace {
  recall_id: string;
  store_key: string;
  tenant: string;
  pool: string | null;
  query: string;
  requested_budget: number;
  used_budget: number;
  mode: RecallMode;
  policy_snapshot: PolicySnapshot;
  created_at: string;
}

export interface RecallTraceItemRow {
  recall_id: string;
  ordinal: number;
  tier: "T1" | "T2" | "T3";
  item_id: string;
  source: string;
  score: number | null;
  chars: number | null;
  usage: UsageState;
}

/** Minimal reference used to identify an item in a usage report. */
export interface ItemRef {
  tier: "T1" | "T2" | "T3";
  id: string;
}

export interface CreateRecallTraceInput {
  store_key: string;
  tenant: string;
  pool: string | null;
  query: string;
  requested_budget: number;
  used_budget: number;
  /** Defaults to "explicit" if omitted — see src/recall/budgets.ts. */
  mode?: RecallMode;
  policy_snapshot: PolicySnapshot;
  items: RecallItem[];
}

export interface RecallTraceView extends RecallTrace {
  items: Array<{
    tier: "T1" | "T2" | "T3";
    id: string;
    rank: number;
    source: string;
    score: number | null;
    chars: number | null;
    usage: UsageState;
  }>;
}

export interface ReportUsageResult {
  updated: ItemRef[];
  unchanged: ItemRef[];
}

export class RecallTraceError extends Error {
  constructor(public code: "not_found" | "unknown_items" | "conflict", msg: string) {
    super(msg);
    this.name = "RecallTraceError";
  }
}
