/**
 * In-process fixed-bin histograms (src/metrics.ts).
 *
 * Covers bin selection at/around boundaries, fixed memory footprint (no
 * growth across many observations), empty-histogram behavior, and the
 * registry's since-startup semantics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BUCKET_BOUNDS_MS, Histogram, MetricsRegistry, TaggedHistogram } from "../src/metrics.js";

test("Histogram: empty snapshot has zero count and null min/max/mean", () => {
  const h = new Histogram();
  const snap = h.snapshot();
  assert.equal(snap.count, 0);
  assert.equal(snap.min, null);
  assert.equal(snap.max, null);
  assert.equal(snap.mean, null);
  assert.equal(snap.buckets.length, DEFAULT_BUCKET_BOUNDS_MS.length - 1);
  for (const b of snap.buckets) assert.equal(b.count, 0);
});

test("Histogram: observations land in the correct bucket", () => {
  const h = new Histogram([0, 10, 100, Infinity]);
  h.observe(0);    // [0,10)
  h.observe(9.9);  // [0,10)
  h.observe(10);   // [10,100) -- boundary is inclusive-lower on the next bucket
  h.observe(99);   // [10,100)
  h.observe(100);  // [100, +Inf)
  h.observe(1e9);  // [100, +Inf)

  const snap = h.snapshot();
  assert.deepEqual(snap.buckets.map((b) => b.count), [2, 2, 2]);
  assert.equal(snap.count, 6);
  assert.equal(snap.min, 0);
  assert.equal(snap.max, 1e9);
});

test("Histogram: mean is the arithmetic mean of observed values", () => {
  const h = new Histogram([0, 10, 100, Infinity]);
  h.observe(2);
  h.observe(4);
  h.observe(6);
  assert.equal(h.snapshot().mean, 4);
});

test("Histogram: negative or non-finite observations are ignored", () => {
  const h = new Histogram();
  h.observe(-5);
  h.observe(NaN);
  h.observe(Infinity);
  assert.equal(h.snapshot().count, 0);
});

test("Histogram: fixed memory -- bucket array length never changes across many observations", () => {
  const h = new Histogram([0, 10, 100, Infinity]);
  const before = h.snapshot().buckets.length;
  for (let i = 0; i < 100_000; i++) h.observe(Math.random() * 200_000);
  const after = h.snapshot();
  assert.equal(after.buckets.length, before);
  assert.equal(after.count, 100_000);
});

test("Histogram: requires at least 2 bucket bounds", () => {
  assert.throws(() => new Histogram([0]));
});

test("MetricsRegistry: exposes three independent plain histograms and a startup timestamp", () => {
  const reg = new MetricsRegistry();
  assert.ok(reg.started_at);
  reg.recall_ms.observe(12);
  reg.distill_service_ms.observe(5000);
  reg.distill_pending_ms.observe(70000);

  const snap = reg.snapshot();
  assert.equal(snap.recall_ms.count, 1);
  assert.equal(snap.distill_service_ms.count, 1);
  assert.equal(snap.distill_pending_ms.count, 1);
  assert.equal(snap.started_at, reg.started_at);
});

test("MetricsRegistry: snapshot() reflects only observations made this process lifetime (no persistence hooks)", () => {
  const reg1 = new MetricsRegistry();
  reg1.recall_ms.observe(1);
  const reg2 = new MetricsRegistry();
  assert.equal(reg2.snapshot().recall_ms.count, 0);
});

test("TaggedHistogram: observe() routes into active or idle by the boolean flag", () => {
  const t = new TaggedHistogram([0, 10, 100, Infinity]);
  t.observe(5, true);
  t.observe(50, false);
  t.observe(6, true);

  const snap = t.snapshot();
  assert.equal(snap.active.count, 2);
  assert.equal(snap.idle.count, 1);
  assert.equal(snap.active.min, 5);
  assert.equal(snap.idle.min, 50);
});

test("MetricsRegistry: distillActive() reflects distillStarted/distillFinished balance, including overlap", () => {
  const reg = new MetricsRegistry();
  assert.equal(reg.distillActive(), false);
  reg.distillStarted();
  assert.equal(reg.distillActive(), true);
  reg.distillStarted(); // overlapping second pass
  assert.equal(reg.distillActive(), true);
  reg.distillFinished();
  assert.equal(reg.distillActive(), true); // one still in flight
  reg.distillFinished();
  assert.equal(reg.distillActive(), false);
});

test("MetricsRegistry: exposes http_request_ms, mcp_request_ms, stream_add_ms as tagged histograms gated on distillActive()", () => {
  const reg = new MetricsRegistry();
  reg.http_request_ms.observe(10, reg.distillActive());
  reg.distillStarted();
  reg.mcp_request_ms.observe(20, reg.distillActive());
  reg.stream_add_ms.observe(30, reg.distillActive());
  reg.distillFinished();

  const snap = reg.snapshot();
  assert.equal(snap.http_request_ms.idle.count, 1);
  assert.equal(snap.http_request_ms.active.count, 0);
  assert.equal(snap.mcp_request_ms.active.count, 1);
  assert.equal(snap.mcp_request_ms.idle.count, 0);
  assert.equal(snap.stream_add_ms.active.count, 1);
  assert.equal(snap.stream_add_ms.idle.count, 0);
});
