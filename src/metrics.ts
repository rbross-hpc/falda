/**
 * In-process, fixed-memory timing histograms — "since this process started,"
 * not a durable/queryable record. Deliberately NOT backed by SQLite: no
 * schema, no migration, no unbounded growth. A histogram is a small array of
 * bin counters plus four running scalars (count/sum/min/max); observe() is
 * O(1) and the memory footprint never grows regardless of how many
 * observations are made.
 *
 * Three histograms are tracked (src/runtime.ts's MetricsRegistry):
 *   distill_pending_ms  — enqueue -> claim wall time (src/distill/worker.ts)
 *   distill_service_ms  — distillOnce() wall time (src/distill/worker.ts)
 *   recall_ms           — assembleContext() wall time (mcp/tools/recall.ts,
 *                          gateway.ts's /recall route)
 *
 * Exposed to operators via the live HTTP /metrics route (src/gateway.ts) and
 * rendered by `falda stats --section=timing` (src/stats.ts), which fetches
 * it from a running server rather than reading any on-disk store — these
 * numbers do not survive a restart, by design (§ "since last startup").
 */

/** Shared bin edges (ms) for all three histograms. `Infinity` as the final
 *  upper bound catches everything above the last finite edge. Log-ish
 *  spacing: fine-grained at the low end (typical recall latency), coarse at
 *  the high end (typical distill service/pending time). */
export const DEFAULT_BUCKET_BOUNDS_MS: readonly number[] = [
  0, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, Infinity,
];

export interface HistogramBucket {
  /** Inclusive lower bound (ms). */
  lo: number;
  /** Exclusive upper bound (ms); `Infinity` for the overflow bucket. */
  hi: number;
  count: number;
}

export interface HistogramSnapshot {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  buckets: HistogramBucket[];
}

/** Fixed-bin histogram. Bin edges are set once at construction and never
 *  change; `observe()` never allocates. */
export class Histogram {
  private readonly bounds: readonly number[];
  private readonly counts: Uint32Array;
  private count = 0;
  private sum = 0;
  private min: number | null = null;
  private max: number | null = null;

  constructor(bounds: readonly number[] = DEFAULT_BUCKET_BOUNDS_MS) {
    if (bounds.length < 2) throw new Error("Histogram requires at least 2 bucket bounds");
    this.bounds = bounds;
    // One bucket per (bounds[i], bounds[i+1]) pair.
    this.counts = new Uint32Array(bounds.length - 1);
  }

  /** Record one observation, in milliseconds. Negative/non-finite values are
   *  ignored (defensive — a caller-side clock error must never throw). */
  observe(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.count++;
    this.sum += ms;
    this.min = this.min === null ? ms : Math.min(this.min, ms);
    this.max = this.max === null ? ms : Math.max(this.max, ms);

    let idx = this.counts.length - 1;
    for (let i = 0; i < this.bounds.length - 1; i++) {
      if (ms >= this.bounds[i] && ms < this.bounds[i + 1]) { idx = i; break; }
    }
    this.counts[idx]++;
  }

  snapshot(): HistogramSnapshot {
    const buckets: HistogramBucket[] = [];
    for (let i = 0; i < this.counts.length; i++) {
      buckets.push({ lo: this.bounds[i], hi: this.bounds[i + 1], count: this.counts[i] });
    }
    return {
      count: this.count,
      min: this.min,
      max: this.max,
      mean: this.count > 0 ? this.sum / this.count : null,
      buckets,
    };
  }
}

export interface MetricsSnapshot {
  started_at: string;
  distill_pending_ms: HistogramSnapshot;
  distill_service_ms: HistogramSnapshot;
  recall_ms: HistogramSnapshot;
}

/** One registry per process, created once in buildRuntime() (src/runtime.ts)
 *  and shared by every surface (HTTP, MCP, distillation worker) so all three
 *  histograms reflect the whole process's activity since startup. */
export class MetricsRegistry {
  readonly started_at: string;
  readonly distill_pending_ms: Histogram;
  readonly distill_service_ms: Histogram;
  readonly recall_ms: Histogram;

  constructor(bounds: readonly number[] = DEFAULT_BUCKET_BOUNDS_MS) {
    this.started_at = new Date().toISOString();
    this.distill_pending_ms = new Histogram(bounds);
    this.distill_service_ms = new Histogram(bounds);
    this.recall_ms = new Histogram(bounds);
  }

  snapshot(): MetricsSnapshot {
    return {
      started_at: this.started_at,
      distill_pending_ms: this.distill_pending_ms.snapshot(),
      distill_service_ms: this.distill_service_ms.snapshot(),
      recall_ms: this.recall_ms.snapshot(),
    };
  }
}
