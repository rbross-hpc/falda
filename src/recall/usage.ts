/**
 * Usage reporting: attach "was this recalled item actually used" feedback
 * to a prior recall trace, without mutating the memories themselves
 * (§ "usage feedback should attach to that trace rather than mutate the
 * memories"). Deliberately NOT exposed as a normal model-selected MCP
 * tool — see src/mcp/tools/ (no falda_report_usage registered anywhere);
 * this is reached only via HTTP (POST /recall/usage), the intended
 * harness/plugin-facing surface.
 *
 * Transition rules (all other reads/writes are ordinary row updates):
 *   unknown -> used      allowed
 *   unknown -> unused    allowed
 *   used    -> used      no-op (idempotent)
 *   unused  -> unused    no-op (idempotent)
 *   used    -> unused    REJECTED (conflicting report)
 *   unused  -> used      REJECTED (conflicting report)
 * A conflicting report leaves ALL of that request's items untouched (the
 * whole call is atomic) and raises RecallTraceError("conflict") naming the
 * offending refs, so a client can decide how to resolve it rather than
 * having FALDA silently pick a side.
 */
import type Database from "better-sqlite3";
import { getRecallTraceAuthorized } from "./traces.js";
import { RecallTraceError, type ItemRef, type ReportUsageResult, type UsageState } from "./types.js";

function refKey(r: ItemRef): string { return `${r.tier}:${r.id}`; }

export function reportRecallUsage(
  db: Database.Database,
  recallId: string,
  callerStoreKey: string,
  used: ItemRef[] = [],
  unused: ItemRef[] = [],
): ReportUsageResult {
  const trace = getRecallTraceAuthorized(db, recallId, callerStoreKey);
  if (!trace) {
    throw new RecallTraceError("not_found", `recall trace not found: ${recallId}`);
  }

  const known = new Map(trace.items.map((it) => [refKey({ tier: it.tier, id: it.id }), it]));

  const requested: Array<{ ref: ItemRef; target: UsageState }> = [
    ...used.map((ref) => ({ ref, target: "used" as UsageState })),
    ...unused.map((ref) => ({ ref, target: "unused" as UsageState })),
  ];

  // Reject unknown item ids up front — none of this recall's items change.
  const unknownRefs = requested.filter((r) => !known.has(refKey(r.ref)));
  if (unknownRefs.length) {
    throw new RecallTraceError(
      "unknown_items",
      `item(s) not present in recall ${recallId}: ${unknownRefs.map((r) => refKey(r.ref)).join(", ")}`,
    );
  }

  // Reject the same ref appearing in both used[] and unused[] within one call.
  const usedKeys = new Set(used.map(refKey));
  const bothLists = unused.filter((r) => usedKeys.has(refKey(r)));
  if (bothLists.length) {
    throw new RecallTraceError(
      "conflict",
      `item(s) listed in both used and unused in the same report: ${bothLists.map(refKey).join(", ")}`,
    );
  }

  // Reject any requested transition that conflicts with a stored terminal state.
  const conflicts = requested.filter((r) => {
    const current = known.get(refKey(r.ref))!.usage;
    return (current === "used" && r.target === "unused") || (current === "unused" && r.target === "used");
  });
  if (conflicts.length) {
    throw new RecallTraceError(
      "conflict",
      `item(s) already reported with the opposite usage state: ${conflicts.map((r) => refKey(r.ref)).join(", ")}`,
    );
  }

  const updated: ItemRef[] = [];
  const unchanged: ItemRef[] = [];
  const tx = db.transaction(() => {
    const upd = db.prepare(
      "UPDATE recall_trace_items SET usage=? WHERE recall_id=? AND tier=? AND item_id=?"
    );
    for (const { ref, target } of requested) {
      const current = known.get(refKey(ref))!.usage;
      if (current === target) { unchanged.push(ref); continue; }
      upd.run(target, recallId, ref.tier, ref.id);
      updated.push(ref);
    }
  });
  tx();

  return { updated, unchanged };
}
