/**
 * `falda stats --section=timing` (src/stats.ts) — the one section that talks
 * to a RUNNING falda server instead of reading files offline.
 *
 * Covers:
 *   1. Fetches a real snapshot from a live serve() instance and renders it.
 *   2. Graceful degradation (a warning, not a crash/throw) when no server
 *      is reachable at the given URL.
 *   3. Graceful degradation on a bad/missing token (401).
 *   4. "timing" is NOT included by default (no --section) — a plain
 *      `falda stats` must stay fully offline with no network calls.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { serve, type ServeHandle } from "../src/server.js";
import { buildStatsReport, renderHuman } from "../src/stats.js";

function makeTokenFile(root: string, tokens: Record<string, any>): string {
  const p = path.join(root, "tokens.json");
  fs.writeFileSync(p, JSON.stringify({ tokens }));
  return p;
}

describe("stats: timing section (live server)", () => {
  let root: string;
  let handle: ServeHandle;
  let url: string;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-stats-timing-"));
    const tokensPath = makeTokenFile(root, { "tok-a": { tenants: ["proj-a"], pools: [], label: "A" } });
    process.env.FALDA_EMBED = "local";
    process.env.FALDA_DIM = "32";
    handle = await serve({
      httpPort: 0,
      mcpPort: 0,
      noMcp: true,
      runtimeConfig: { root: path.join(root, "data"), dim: 32, tokensPath, label: "stats-timing-test" },
    });
    const port = (handle.httpServer.address() as any).port;
    url = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await handle.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("fetches and renders a real snapshot from the running server", async () => {
    // Drive at least one recall through the live server so recall_ms has an
    // observation (proves the route reflects the real registry, not a stub).
    await fetch(new URL("/atoms/upsert", url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-a", "x-falda-tenant": "proj-a" },
      body: JSON.stringify({ type: "fact", content: "timing section integration test atom" }),
    });
    await fetch(new URL("/recall", url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-a", "x-falda-tenant": "proj-a" },
      body: JSON.stringify({ query: "timing section integration test atom" }),
    });

    const report = await buildStatsReport({
      root: path.join(root, "data"), sections: ["timing"], url, token: "tok-a",
    });
    assert.equal(report.timing.available, true);
    assert.ok(report.timing.snapshot);
    assert.equal(report.timing.snapshot!.recall_ms.count, 1, "the /recall call above was observed");
    assert.ok(!report.warnings.some((w) => w.message.includes("timing section unavailable")));

    const text = renderHuman(report);
    assert.ok(text.includes("## Timing"));
    assert.ok(text.includes("recall_ms"));
  });

  test("--json includes the raw MetricsSnapshot shape under timing.snapshot", async () => {
    const report = await buildStatsReport({ root: path.join(root, "data"), sections: ["timing"], url, token: "tok-a" });
    const json = JSON.parse(JSON.stringify(report));
    assert.ok(json.timing.snapshot.started_at);
    assert.ok(Array.isArray(json.timing.snapshot.recall_ms.buckets));
  });

  test("unreachable server degrades to a warning, not a thrown error", async () => {
    const report = await buildStatsReport({
      root: path.join(root, "data"), sections: ["timing"], url: "http://127.0.0.1:1", token: "tok-a",
    });
    assert.equal(report.timing.available, false);
    assert.ok(report.timing.unavailable_reason);
    assert.ok(report.warnings.some((w) => w.level === "warn" && w.message.includes("timing section unavailable")));
    const text = renderHuman(report);
    assert.ok(text.includes("unavailable"));
  });

  test("bad token degrades to a warning (401), not a thrown error", async () => {
    const report = await buildStatsReport({
      root: path.join(root, "data"), sections: ["timing"], url, token: "not-a-real-token",
    });
    assert.equal(report.timing.available, false);
    assert.match(report.timing.unavailable_reason ?? "", /401/);
  });

  test("timing is NOT fetched when --section is omitted (default sections)", async () => {
    // No server override needed to prove this: point url at something that
    // would fail loudly if ever called, and confirm no warning is raised.
    const report = await buildStatsReport({ root: path.join(root, "data"), url: "http://127.0.0.1:1" });
    assert.equal(report.timing.available, false);
    assert.equal(report.timing.unavailable_reason, "not requested");
    assert.ok(!report.warnings.some((w) => w.message.includes("timing")));
  });
});
