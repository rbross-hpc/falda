/**
 * Aggregate evaluation queries over recall traces (§12). Scoped to one
 * store_key at a time — cross-store aggregation is an admin/research
 * activity outside the per-tenant auth model, not exposed here.
 *
 * "Usage rate" throughout means used / (used + unused) — items still
 * 'unknown' (no report received) are excluded from the denominator, since
 * silence is not evidence of non-use (§4, §8).
 */
import type Database from "better-sqlite3";

export interface UsageRate { used: number; unused: number; unknown: number; rate: number | null; }

function rate(used: number, unused: number): number | null {
  const denom = used + unused;
  return denom === 0 ? null : used / denom;
}

function countsFor(db: Database.Database, storeKey: string, whereExtra: string, args: unknown[]): UsageRate {
  const row = db.prepare(
    `SELECT
       SUM(CASE WHEN i.usage='used' THEN 1 ELSE 0 END) AS used,
       SUM(CASE WHEN i.usage='unused' THEN 1 ELSE 0 END) AS unused,
       SUM(CASE WHEN i.usage='unknown' THEN 1 ELSE 0 END) AS unknown
     FROM recall_trace_items i
     JOIN recall_traces t ON t.recall_id = i.recall_id
     WHERE t.store_key = ? ${whereExtra}`
  ).get(storeKey, ...args) as { used: number | null; unused: number | null; unknown: number | null };
  const used = row.used ?? 0, unused = row.unused ?? 0, unknown = row.unknown ?? 0;
  return { used, unused, unknown, rate: rate(used, unused) };
}

export interface RecallMetrics {
  store_key: string;
  trace_count: number;
  item_count: number;
  by_tier: Record<"T1" | "T2" | "T3", UsageRate>;
  by_source: Record<string, UsageRate>;
  /** Usage rate bucketed by rank position (0-indexed ordinal) within each trace. */
  by_rank: Array<{ rank: number; used: number; unused: number; unknown: number; rate: number | null }>;
  chars: { total: number; used: number; unused_ratio: number | null };
}

export function computeRecallMetrics(db: Database.Database, storeKey: string): RecallMetrics {
  const traceCount = (db.prepare("SELECT COUNT(*) c FROM recall_traces WHERE store_key=?").get(storeKey) as any).c as number;
  const itemCount = (db.prepare(
    `SELECT COUNT(*) c FROM recall_trace_items i JOIN recall_traces t ON t.recall_id=i.recall_id WHERE t.store_key=?`
  ).get(storeKey) as any).c as number;

  const byTier = {
    T1: countsFor(db, storeKey, "AND i.tier='T1'", []),
    T2: countsFor(db, storeKey, "AND i.tier='T2'", []),
    T3: countsFor(db, storeKey, "AND i.tier='T3'", []),
  };

  const sources = (db.prepare(
    `SELECT DISTINCT i.source FROM recall_trace_items i JOIN recall_traces t ON t.recall_id=i.recall_id WHERE t.store_key=?`
  ).all(storeKey) as Array<{ source: string }>).map((r) => r.source);
  const bySource: Record<string, UsageRate> = {};
  for (const s of sources) bySource[s] = countsFor(db, storeKey, "AND i.source=?", [s]);

  const rankRows = db.prepare(
    `SELECT i.ordinal AS rank,
        SUM(CASE WHEN i.usage='used' THEN 1 ELSE 0 END) AS used,
        SUM(CASE WHEN i.usage='unused' THEN 1 ELSE 0 END) AS unused,
        SUM(CASE WHEN i.usage='unknown' THEN 1 ELSE 0 END) AS unknown
     FROM recall_trace_items i JOIN recall_traces t ON t.recall_id=i.recall_id
     WHERE t.store_key=?
     GROUP BY i.ordinal ORDER BY i.ordinal`
  ).all(storeKey) as Array<{ rank: number; used: number; unused: number; unknown: number }>;
  const byRank = rankRows.map((r) => ({ ...r, rate: rate(r.used, r.unused) }));

  const charsRow = db.prepare(
    `SELECT
       SUM(COALESCE(i.chars,0)) AS total,
       SUM(CASE WHEN i.usage='used' THEN COALESCE(i.chars,0) ELSE 0 END) AS used
     FROM recall_trace_items i JOIN recall_traces t ON t.recall_id=i.recall_id
     WHERE t.store_key=?`
  ).get(storeKey) as { total: number | null; used: number | null };
  const totalChars = charsRow.total ?? 0;
  const usedChars = charsRow.used ?? 0;
  const unusedRatio = totalChars === 0 ? null : (totalChars - usedChars) / totalChars;

  return {
    store_key: storeKey,
    trace_count: traceCount,
    item_count: itemCount,
    by_tier: byTier,
    by_source: bySource,
    by_rank: byRank,
    chars: { total: totalChars, used: usedChars, unused_ratio: unusedRatio },
  };
}
