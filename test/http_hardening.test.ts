/**
 * HTTP surface hardening (src/server.ts):
 *   - an oversized request body is rejected with 413 before JSON parsing
 *     and before handleRequest's auth check (declared-Content-Length path
 *     and a streamed/chunked flood with no honest Content-Length);
 *   - the cap can be disabled (FALDA_MAX_BODY_BYTES <= 0);
 *   - both the HTTP API and MCP listeners bind loopback (127.0.0.1) by
 *     default, and can be overridden via FALDA_BIND / FALDA_MCP_BIND (or
 *     serve()'s httpHost/mcpHost options).
 *
 * See docs/future/reliability-hardening.md finding 11.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { serve, type ServeHandle } from "../src/server.js";

function makeTokenFile(root: string, tokens: Record<string, any>): string {
  const p = path.join(root, "tokens.json");
  fs.writeFileSync(p, JSON.stringify({ tokens }));
  return p;
}

async function withServer(
  opts: Parameters<typeof serve>[0],
  fn: (handle: ServeHandle, root: string) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-http-hardening-"));
  const tokensPath = makeTokenFile(root, { "tok-a": { tenants: ["proj-a"], pools: [], label: "A" } });
  let handle: ServeHandle | undefined;
  try {
    handle = await serve({
      httpPort: 0, mcpPort: 0, noMcp: true,
      runtimeConfig: { root: path.join(root, "data"), dim: 32, tokensPath, label: "http-hardening-test" },
      ...opts,
    });
    await fn(handle, root);
  } finally {
    if (handle) await handle.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("HTTP body-size cap", () => {
  test("a body under the cap is accepted normally", async () => {
    await withServer({ maxBodyBytes: 1024 }, async (handle) => {
      const port = (handle.httpServer.address() as any).port;
      const resp = await fetch(`http://127.0.0.1:${port}/atoms/upsert`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok-a", "x-falda-tenant": "proj-a" },
        body: JSON.stringify({ content: "small atom" }),
      });
      assert.equal(resp.status, 200);
      const json = await resp.json() as { id?: string };
      assert.ok(json.id);
    });
  });

  test("a body over the cap (declared via Content-Length) is rejected 413 before auth", async () => {
    await withServer({ maxBodyBytes: 16 }, async (handle) => {
      const port = (handle.httpServer.address() as any).port;
      const oversized = JSON.stringify({ content: "x".repeat(1000) });
      // Deliberately no/invalid Authorization header — if this still comes
      // back 413 (not 401), the size check ran before auth.
      const resp = await fetch(`http://127.0.0.1:${port}/atoms/upsert`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(oversized.length) },
        body: oversized,
      });
      assert.equal(resp.status, 413);
      const json = await resp.json() as { error: string; limit: number };
      assert.match(json.error, /too large/);
      assert.equal(json.limit, 16);
    });
  });

  test("a chunked body with no honest Content-Length is aborted mid-stream once it exceeds the cap, and the server stays healthy", async () => {
    await withServer({ maxBodyBytes: 16 }, async (handle) => {
      const port = (handle.httpServer.address() as any).port;

      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, path: "/atoms/upsert", method: "POST", headers: { "content-type": "application/json" } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? -1);
          },
        );
        req.on("error", () => {
          // A destroyed connection can also surface as a client-side
          // socket error depending on timing — either outcome (a 413
          // response or a reset before headers) demonstrates the flood
          // was not buffered in full; only fail if neither occurs.
          resolve(-1);
        });
        // No content-length set -> Node sends this chunked. Keep writing
        // well past the 16-byte cap so a running-total check (not just a
        // Content-Length check) is what has to catch it.
        let writes = 0;
        const interval = setInterval(() => {
          req.write(JSON.stringify({ content: "x".repeat(64) }));
          writes++;
          if (writes > 20) { clearInterval(interval); req.end(); }
        }, 5);
      });

      assert.ok(status === 413 || status === -1, `expected 413 or a reset connection, got ${status}`);

      // The server itself must still be healthy for a subsequent request.
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(health.status, 200);
    });
  });

  test("FALDA_MAX_BODY_BYTES <= 0 disables the cap", async () => {
    await withServer({ maxBodyBytes: 0 }, async (handle) => {
      const port = (handle.httpServer.address() as any).port;
      const big = JSON.stringify({ content: "x".repeat(200_000) });
      const resp = await fetch(`http://127.0.0.1:${port}/atoms/upsert`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok-a", "x-falda-tenant": "proj-a" },
        body: big,
      });
      assert.equal(resp.status, 200);
    });
  });
});

describe("HTTP/MCP bind address", () => {
  test("HTTP API binds loopback (127.0.0.1) by default", async () => {
    await withServer({}, async (handle) => {
      const addr = handle.httpServer.address() as any;
      assert.equal(addr.address, "127.0.0.1");
    });
  });

  test("HTTP API bind host can be overridden via serve() options", async () => {
    await withServer({ httpHost: "0.0.0.0" }, async (handle) => {
      const addr = handle.httpServer.address() as any;
      assert.equal(addr.address, "0.0.0.0");
    });
  });

  test("MCP endpoint binds loopback (127.0.0.1) by default", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-http-hardening-mcp-"));
    const tokensPath = makeTokenFile(root, { "tok-a": { tenants: ["proj-a"], pools: [], label: "A" } });
    let handle: ServeHandle | undefined;
    try {
      handle = await serve({
        httpPort: 0, mcpPort: 0, noMcp: false,
        runtimeConfig: { root: path.join(root, "data"), dim: 32, tokensPath, label: "http-hardening-mcp-test" },
      });
      const addr = handle.mcpServer!.address() as any;
      assert.equal(addr.address, "127.0.0.1");
    } finally {
      if (handle) await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("FALDA_BIND env var sets the HTTP API's default bind host", async () => {
    const prev = process.env.FALDA_BIND;
    process.env.FALDA_BIND = "0.0.0.0";
    try {
      await withServer({}, async (handle) => {
        const addr = handle.httpServer.address() as any;
        assert.equal(addr.address, "0.0.0.0");
      });
    } finally {
      if (prev === undefined) delete process.env.FALDA_BIND;
      else process.env.FALDA_BIND = prev;
    }
  });
});
