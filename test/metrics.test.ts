/**
 * In-process fixed-bin histograms (src/metrics.ts).
 *
 * Covers bin selection at/around boundaries, fixed memory footprint (no
 * growth across many observations), empty-histogram behavior, and the
 * registry's since-startup semantics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BUCKET_BOUNDS_MS, Histogram, MetricsRegistry } from "../src/metrics.js";

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

test("MetricsRegistry: exposes three independent histograms and a startup timestamp", () => {
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
