/**
 * Human-readable + JSON rendering for MetricsSnapshot (src/metrics.ts).
 * Shared by `falda stats --section=timing` (src/stats.ts), which fetches a
 * snapshot from a running server's /metrics route (src/gateway.ts) rather
 * than reading anything off disk — these numbers are in-process,
 * since-startup counters with no durable backing store.
 */
import type { HistogramSnapshot, MetricsSnapshot } from "./metrics.js";

const BAR_WIDTH = 30;

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "+Inf";
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtBound(ms: number): string {
  return ms === Infinity ? "+Inf" : fmtMs(ms);
}

/** Render one histogram as a fixed-bin ASCII bar chart plus a
 *  count/min/max/mean summary line. No percentiles — raw samples are not
 *  retained (fixed-memory bins only), so only exact scalars are shown. */
export function renderHistogram(name: string, snap: HistogramSnapshot): string[] {
  const lines: string[] = [];
  lines.push(`${name}:`);
  if (snap.count === 0) {
    lines.push("  (no observations yet)");
    return lines;
  }
  const maxCount = Math.max(...snap.buckets.map((b) => b.count), 1);
  for (const b of snap.buckets) {
    const barLen = b.count === 0 ? 0 : Math.max(1, Math.round((b.count / maxCount) * BAR_WIDTH));
    const bar = "#".repeat(barLen);
    const label = `[${fmtBound(b.lo)}, ${fmtBound(b.hi)})`.padEnd(18);
    lines.push(`  ${label} ${bar} ${b.count}`);
  }
  lines.push(
    `  count=${snap.count} min=${fmtMs(snap.min ?? 0)} max=${fmtMs(snap.max ?? 0)} mean=${fmtMs(snap.mean ?? 0)}`,
  );
  return lines;
}

export function renderMetricsSnapshot(snap: MetricsSnapshot): string {
  const lines: string[] = [];
  lines.push(`Since: ${snap.started_at} (process start — counters reset on restart)`);
  lines.push("");
  lines.push(...renderHistogram("recall_ms (assembleContext wall time)", snap.recall_ms));
  lines.push("");
  lines.push(...renderHistogram("distill_pending_ms (enqueue -> claim)", snap.distill_pending_ms));
  lines.push("");
  lines.push(...renderHistogram("distill_service_ms (distillOnce wall time)", snap.distill_service_ms));
  return lines.join("\n");
}
