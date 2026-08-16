/**
 * Human-readable rendering of a MetricsSnapshot (src/metrics_render.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Histogram, MetricsRegistry } from "../src/metrics.js";
import { renderHistogram, renderMetricsSnapshot } from "../src/metrics_render.js";

test("renderHistogram: empty histogram renders a 'no observations' line, no bars", () => {
  const h = new Histogram();
  const lines = renderHistogram("recall_ms", h.snapshot());
  assert.ok(lines[0].startsWith("recall_ms:"));
  assert.ok(lines.some((l) => l.includes("no observations yet")));
});

test("renderHistogram: non-empty histogram renders one line per bucket plus a summary", () => {
  const h = new Histogram([0, 10, 100, Infinity]);
  h.observe(5);
  h.observe(5);
  h.observe(50);
  const lines = renderHistogram("distill_service_ms", h.snapshot());
  // header + 3 buckets + summary
  assert.equal(lines.length, 1 + 3 + 1);
  assert.ok(lines[lines.length - 1].includes("count=3"));
  assert.ok(lines[lines.length - 1].includes("min="));
  assert.ok(lines[lines.length - 1].includes("max="));
  assert.ok(lines[lines.length - 1].includes("mean="));
});

test("renderMetricsSnapshot: includes started_at and all three histograms", () => {
  const reg = new MetricsRegistry();
  reg.recall_ms.observe(10);
  reg.distill_pending_ms.observe(1000);
  reg.distill_service_ms.observe(2000);
  const text = renderMetricsSnapshot(reg.snapshot());
  assert.ok(text.includes(reg.started_at));
  assert.ok(text.includes("recall_ms"));
  assert.ok(text.includes("distill_pending_ms"));
  assert.ok(text.includes("distill_service_ms"));
});
