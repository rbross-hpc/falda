/**
 * In-process, fixed-memory timing histograms — "since this process started,"
 * not a durable/queryable record. Deliberately NOT backed by SQLite: no
 * schema, no migration, no unbounded growth. A histogram is a small array of
 * bin counters plus four running scalars (count/sum/min/max); observe() is
 * O(1) and the memory footprint never grows regardless of how many
 * observations are made.
 *
 * Six histograms are tracked (src/runtime.ts's MetricsRegistry):
 *   distill_pending_ms  — enqueue -> claim wall time (src/distill/worker.ts)
 *   distill_service_ms  — distillOnce() wall time (src/distill/worker.ts)
 *   recall_ms           — assembleContext() wall time (mcp/tools/recall.ts,
 *                          gateway.ts's /recall route)
 *   http_request_ms     — whole-request wall time for every /metrics-JSON
 *                          gateway route except /metrics and /healthz
 *                          themselves (src/gateway.ts's handleRequest)
 *   mcp_request_ms      — whole-request wall time for every MCP request,
 *                          including handshake/list calls, not just tool
 *                          calls (src/mcp/server.ts's handleFaldaMcpRequest)
 *   stream_add_ms       — addStream() wall time specifically, observed at
 *                          both the HTTP (/stream/add) and MCP
 *                          (falda_stream_add) ingestion entry points —
 *                          deliberately overlaps http_request_ms/
 *                          mcp_request_ms, isolating the one hot ingestion
 *                          path across both doors
 *
 * The three foreground-latency histograms above are TaggedHistogram, not
 * plain Histogram: each observation is split into an `active` or `idle`
 * bucket depending on whether a distillation pass (src/distill/worker.ts's
 * runJob) was in flight at the moment of observation (MetricsRegistry's
 * distillActive counter). This is what lets an operator see whether the
 * long-running, LLM-bound distillOnce() passes are stalling foreground
 * request latency. The other three histograms are NOT tagged:
 * distill_service_ms IS a distill pass (distill_active would be trivially
 * true for every sample), distill_pending_ms is about queue wait rather
 * than event-loop contention, and recall_ms is left as a plain Histogram
 * for now to keep this an additive, minimal-shape change (revisit if
 * recall-vs-distill contention becomes the open question).
 *
 * Deliberately just a pair of plain Histograms per tagged metric — not a
 * generic labeled-histogram type — to keep with the "no schema, fixed bins,
 * no dynamic labels" design: there is exactly one tag with two values, so a
 * struct beats a label map.
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

export interface TaggedHistogramSnapshot {
  /** Observations recorded while a distillation pass was in flight
   *  (MetricsRegistry.distillActive > 0 at observe() time). */
  active: HistogramSnapshot;
  /** Observations recorded while no distillation pass was in flight. */
  idle: HistogramSnapshot;
}

/** A pair of plain Histograms, split by whether a distillation pass was
 *  active at observation time. See the module doc header for why this is a
 *  fixed two-value struct rather than a generic labeled histogram. */
export class TaggedHistogram {
  readonly active: Histogram;
  readonly idle: Histogram;

  constructor(bounds: readonly number[] = DEFAULT_BUCKET_BOUNDS_MS) {
    this.active = new Histogram(bounds);
    this.idle = new Histogram(bounds);
  }

  observe(ms: number, distillActive: boolean): void {
    (distillActive ? this.active : this.idle).observe(ms);
  }

  snapshot(): TaggedHistogramSnapshot {
    return { active: this.active.snapshot(), idle: this.idle.snapshot() };
  }
}

export interface MetricsSnapshot {
  started_at: string;
  distill_pending_ms: HistogramSnapshot;
  distill_service_ms: HistogramSnapshot;
  recall_ms: HistogramSnapshot;
  http_request_ms: TaggedHistogramSnapshot;
  mcp_request_ms: TaggedHistogramSnapshot;
  stream_add_ms: TaggedHistogramSnapshot;
}

/** One registry per process, created once in buildRuntime() (src/runtime.ts)
 *  and shared by every surface (HTTP, MCP, distillation worker) so all
 *  histograms reflect the whole process's activity since startup. */
export class MetricsRegistry {
  readonly started_at: string;
  readonly distill_pending_ms: Histogram;
  readonly distill_service_ms: Histogram;
  readonly recall_ms: Histogram;
  readonly http_request_ms: TaggedHistogram;
  readonly mcp_request_ms: TaggedHistogram;
  readonly stream_add_ms: TaggedHistogram;

  /** Count of distillation passes currently running (src/distill/worker.ts's
   *  runJob, incremented before distillOnce and decremented in its finally).
   *  A count rather than a boolean so overlapping passes — none today, the
   *  drain is strictly serial, but a future concurrent drain would not
   *  silently misreport — stay correct. Read via distillActive() below when
   *  tagging a foreground observation. */
  private distillActiveCount = 0;

  constructor(bounds: readonly number[] = DEFAULT_BUCKET_BOUNDS_MS) {
    this.started_at = new Date().toISOString();
    this.distill_pending_ms = new Histogram(bounds);
    this.distill_service_ms = new Histogram(bounds);
    this.recall_ms = new Histogram(bounds);
    this.http_request_ms = new TaggedHistogram(bounds);
    this.mcp_request_ms = new TaggedHistogram(bounds);
    this.stream_add_ms = new TaggedHistogram(bounds);
  }

  /** True if at least one distillation pass is currently in flight. */
  distillActive(): boolean {
    return this.distillActiveCount > 0;
  }

  /** Called by src/distill/worker.ts's runJob around distillOnce(). */
  distillStarted(): void {
    this.distillActiveCount++;
  }

  /** Called by src/distill/worker.ts's runJob's finally, matching every
   *  distillStarted(). */
  distillFinished(): void {
    this.distillActiveCount--;
  }

  snapshot(): MetricsSnapshot {
    return {
      started_at: this.started_at,
      distill_pending_ms: this.distill_pending_ms.snapshot(),
      distill_service_ms: this.distill_service_ms.snapshot(),
      recall_ms: this.recall_ms.snapshot(),
      http_request_ms: this.http_request_ms.snapshot(),
      mcp_request_ms: this.mcp_request_ms.snapshot(),
      stream_add_ms: this.stream_add_ms.snapshot(),
    };
  }
}
