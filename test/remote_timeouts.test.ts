/**
 * Tests for FALDA_EMBED_TIMEOUT_MS / FALDA_LLM_TIMEOUT_MS (src/embedder.ts,
 * src/distill/llm.ts) — a stalled upstream must reject within the configured
 * budget rather than hang a request or distillation pass indefinitely.
 * See docs/future/reliability-hardening.md finding 4.
 *
 * Uses a real HTTP server that accepts the connection but never writes a
 * response, so the client-side AbortSignal.timeout is what actually fires
 * (closer to a real stalled-upstream scenario than mocking fetch).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { makeEmbedder } from "../src/embedder.js";
import { makeLLM } from "../src/distill/llm.js";

async function startHangingServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, _res) => {
    // Never respond — simulates a stalled upstream.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

test("makeEmbedder rejects with a clear error when the endpoint hangs past the timeout", async () => {
  const { server, url } = await startHangingServer();
  try {
    const embed = makeEmbedder({ baseUrl: url, timeoutMs: 50 });
    await assert.rejects(
      () => embed("hello"),
      (e: any) => {
        assert.match(e.message, /embeddings timed out after 50ms/);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test("makeLLM rejects with a clear error when the endpoint hangs past the timeout", async () => {
  const { server, url } = await startHangingServer();
  try {
    const llm = makeLLM({ baseUrl: url, timeoutMs: 50 });
    await assert.rejects(
      () => llm("prompt"),
      (e: any) => {
        assert.match(e.message, /LLM request timed out after 50ms/);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test("makeEmbedder still resolves normally against a fast endpoint (timeout does not affect happy path)", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const embed = makeEmbedder({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 5000 });
    const vec = await embed("hello");
    assert.deepEqual(vec, [0.1, 0.2, 0.3]);
  } finally {
    server.close();
  }
});

test("makeLLM still resolves normally against a fast endpoint (timeout does not affect happy path)", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const llm = makeLLM({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 5000 });
    const out = await llm("prompt");
    assert.equal(out, "ok");
  } finally {
    server.close();
  }
});

test("makeEmbedder honors FALDA_EMBED_TIMEOUT_MS env var when no explicit timeoutMs is passed", async () => {
  const { server, url } = await startHangingServer();
  const saved = process.env.FALDA_EMBED_TIMEOUT_MS;
  process.env.FALDA_EMBED_TIMEOUT_MS = "50";
  try {
    const embed = makeEmbedder({ baseUrl: url });
    await assert.rejects(() => embed("hello"), /embeddings timed out after 50ms/);
  } finally {
    server.close();
    if (saved === undefined) delete process.env.FALDA_EMBED_TIMEOUT_MS;
    else process.env.FALDA_EMBED_TIMEOUT_MS = saved;
  }
});
