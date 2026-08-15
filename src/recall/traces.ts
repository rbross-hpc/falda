/**
 * Recall trace persistence: one row in recall_traces + one row per admitted
 * item in recall_trace_items, written in a single transaction after
 * assembleContext() succeeds. See src/mcp/tools/recall.ts and
 * src/gateway.ts's /recall route for the two callers — both call this
 * directly rather than duplicating the write, so trace capture is
 * automatic on every recall surface (§14).
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { RecallItem } from "../distill/context.js";
import type { CreateRecallTraceInput, RecallMode, RecallTraceView, UsageState } from "./types.js";

/**
 * Persist a completed recall as a trace. Returns the new recall_id.
 * Caller is responsible for making this best-effort (wrap in try/catch) if
 * telemetry must never fail the recall itself — see recall.ts's usage.
 */
export function createRecallTrace(db: Database.Database, input: CreateRecallTraceInput): string {
  const recall_id = randomUUID();
  const now = new Date().toISOString();
  const tx = db.transaction((items: RecallItem[]) => {
    db.prepare(
      `INSERT INTO recall_traces(recall_id,store_key,tenant,pool,query,requested_budget,used_budget,mode,policy_snapshot,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(
      recall_id, input.store_key, input.tenant, input.pool, input.query,
      input.requested_budget, input.used_budget, input.mode ?? "explicit",
      JSON.stringify(input.policy_snapshot), now,
    );
    const ins = db.prepare(
      `INSERT INTO recall_trace_items(recall_id,ordinal,tier,item_id,source,score,chars,usage)
       VALUES(?,?,?,?,?,?,?,'unknown')`
    );
    items.forEach((item, ordinal) => {
      ins.run(recall_id, ordinal, item.tier, item.id, item.source, item.score ?? null, item.chars ?? null);
    });
  });
  tx(input.items);
  return recall_id;
}

/**
 * Fetch a trace (with its items, in rank order) only if it belongs to
 * callerStoreKey. Returns null for both a missing recall_id AND a
 * recall_id that belongs to another store — no existence oracle, mirroring
 * distill/queue.ts's getJobAuthorized.
 */
export function getRecallTraceAuthorized(
  db: Database.Database,
  recallId: string,
  callerStoreKey: string,
): RecallTraceView | null {
  const trace = db.prepare("SELECT * FROM recall_traces WHERE recall_id=?").get(recallId) as any;
  if (!trace || trace.store_key !== callerStoreKey) return null;
  const rows = db.prepare(
    "SELECT * FROM recall_trace_items WHERE recall_id=? ORDER BY ordinal"
  ).all(recallId) as any[];
  return {
    recall_id: trace.recall_id,
    store_key: trace.store_key,
    tenant: trace.tenant,
    pool: trace.pool,
    query: trace.query,
    requested_budget: trace.requested_budget,
    used_budget: trace.used_budget,
    mode: (trace.mode ?? "explicit") as RecallMode,
    policy_snapshot: JSON.parse(trace.policy_snapshot),
    created_at: trace.created_at,
    items: rows.map((r) => ({
      tier: r.tier,
      id: r.item_id,
      rank: r.ordinal,
      source: r.source,
      score: r.score,
      chars: r.chars,
      usage: r.usage as UsageState,
    })),
  };
}
