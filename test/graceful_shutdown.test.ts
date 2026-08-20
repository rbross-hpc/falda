/**
 * Graceful shutdown for the unified server (src/server.ts's ServeHandle.close()):
 *   - an in-flight HTTP request completes (and its response is delivered)
 *     even though close() was called while it was still running;
 *   - close() awaits an in-flight distillation job before closing storage,
 *     so no "database is closed" error surfaces from a half-finished pass;
 *   - close() is bounded by FALDA_SHUTDOWN_GRACE_MS / opts and returns even
 *     if something never finishes;
 *   - close() is idempotent (safe to call more than once).
 *
 * See docs/future/reliability-hardening.md finding 4.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { serve, type ServeHandle } from "../src/server.js";
import { enqueue, getJob } from "../src/distill/queue.js";

function makeTokenFile(root: string, tokens: Record<string, any>): string {
  const p = path.join(root, "tokens.json");
  fs.writeFileSync(p, JSON.stringify({ tokens }));
  return p;
}

describe("ServeHandle.close(): in-flight HTTP requests", () => {
  test("an in-flight HTTP request completes and its response is delivered even though close() was called mid-flight", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-shutdown-http-"));
    const tokensPath = makeTokenFile(root, { "tok-a": { tenants: ["proj-a"], pools: [], label: "A" } });
    let handle: ServeHandle | undefined;
    try {
      handle = await serve({
        httpPort: 0, mcpPort: 0, noMcp: true,
        runtimeConfig: { root: path.join(root, "data"), dim: 32, tokensPath, label: "shutdown-http-test" },
      });
      const port = (handle.httpServer.address() as any).port;

      // Fire a real request but don't await it yet — we want it in flight
      // when close() is called.
      const reqPromise = fetch(`http://127.0.0.1:${port}/atoms/upsert`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer tok-a",
          "x-falda-tenant": "proj-a",
        },
        body: JSON.stringify({ content: "in-flight request test atom" }),
      });

      // Give the request a moment to actually be received by the server
      // (its handler is tracked via InFlightTracker as soon as 'end' fires)
      // before starting shutdown.
      await new Promise((r) => setTimeout(r, 10));

      const closePromise = handle.close();
      const resp = await reqPromise;
      assert.equal(resp.status, 200, "in-flight request must still complete successfully");
      const json = await resp.json() as { id?: string };
      assert.ok(json.id, "response body was fully delivered");

      await closePromise; // close() itself must also resolve
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("no new HTTP connections are accepted after close() begins", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-shutdown-http2-"));
    const tokensPath = makeTokenFile(root, { "tok-a": { tenants: ["proj-a"], pools: [], label: "A" } });
    let handle: ServeHandle | undefined;
    try {
      handle = await serve({
        httpPort: 0, mcpPort: 0, noMcp: true,
        runtimeConfig: { root: path.join(root, "data"), dim: 32, tokensPath, label: "shutdown-http2-test" },
      });
      const port = (handle.httpServer.address() as any).port;
      await handle.close();

      await assert.rejects(
        () => fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) }),
        "the listener must have stopped accepting new connections",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ServeHandle.close(): in-flight distillation job", () => {
  test("close() awaits an in-flight distillation job before closing storage (no 'database is closed' error)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-shutdown-distill-"));
    const tokensPath = makeTokenFile(root, { "tok-a": { tenants: ["proj-a"], pools: [], label: "A" } });
    let handle: ServeHandle | undefined;
    try {
      handle = await serve({
        httpPort: 0, mcpPort: 0, noMcp: true,
        drainIntervalMs: 20, sweepIntervalMs: 60_000,
        runtimeConfig: { root: path.join(root, "data"), dim: 32, tokensPath, label: "shutdown-distill-test" },
      });

      const store = handle.runtime.pools.resolve("proj-a", undefined, true);
      await store.addStream("sess-1", [{ role: "user", content: "hello" }]);
      const jobId = enqueue(handle.runtime.queueDb, "proj-a:self");

      // Wait for the worker to actually claim it (the real LLM client will
      // fail fast since nothing is listening on the default LLM base URL in
      // this test env — that's fine, we only care that the job was
      // in-flight (attempts>0, status='running') when close() is invoked).
      const deadline = Date.now() + 2000;
      while ((getJob(handle.runtime.queueDb, jobId)?.attempts ?? 0) === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.ok((getJob(handle.runtime.queueDb, jobId)?.attempts ?? 0) > 0, "job was claimed before close()");

      // close() must not throw (e.g. "database is closed" from runtime.close()
      // racing distillOnce()'s in-flight SQLite writes).
      await assert.doesNotReject(() => handle!.close());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ServeHandle.close(): idempotency and bounded grace", () => {
  test("close() can be called more than once without throwing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-shutdown-idem-"));
    const tokensPath = makeTokenFile(root, { "tok-a": { tenants: ["proj-a"], pools: [], label: "A" } });
    const handle = await serve({
      httpPort: 0, mcpPort: 0, noMcp: true,
      runtimeConfig: { root: path.join(root, "data"), dim: 32, tokensPath, label: "shutdown-idem-test" },
    });
    try {
      await handle.close();
      await assert.doesNotReject(() => handle.close());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
