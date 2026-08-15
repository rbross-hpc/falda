/**
 * Tests for src/boot.ts — embedder selection, the FALDA_EMBED_STRICT loud
 * fallback, and the startup embedding probe (probeEmbedder).
 *
 * Mirrors mcp_auth.test.ts's pattern for testing process.exit(1) paths:
 * stub process.exit to throw a sentinel instead of actually exiting, so the
 * FATAL path can be asserted without killing the test runner.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { selectEmbedder, probeEmbedder } from "../src/boot.js";

const ENV_KEYS = ["FALDA_EMBED", "FALDA_EMBED_BASE_URL", "FALDA_EMBED_STRICT"] as const;
let savedEnv: Record<string, string | undefined>;

before(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Run fn with process.exit stubbed to throw a sentinel instead of exiting.
 *  Returns whether exit was called and with what code, or the fn's return
 *  value if it completed without exiting. */
async function captureExit<T>(fn: () => T | Promise<T>): Promise<{ exited: boolean; code: number | undefined; result?: T }> {
  const realExit = process.exit;
  let exited = false;
  let code: number | undefined;
  (process as any).exit = ((c?: number) => { exited = true; code = c; throw new Error("__exit__"); }) as any;
  try {
    const result = await fn();
    return { exited, code, result };
  } catch (e: any) {
    if (e?.message !== "__exit__") throw e;
    return { exited, code };
  } finally {
    process.exit = realExit;
  }
}

// ─── selectEmbedder: FALDA_EMBED_STRICT ────────────────────────────────────────

test("selectEmbedder: unconfigured + strict off (default) silently falls back to local", async () => {
  delete process.env.FALDA_EMBED;
  delete process.env.FALDA_EMBED_BASE_URL;
  delete process.env.FALDA_EMBED_STRICT;
  const { exited } = await captureExit(() => selectEmbedder(16, "test"));
  assert.equal(exited, false, "no fatal — silent fallback is the default");
});

test("selectEmbedder: unconfigured + FALDA_EMBED_STRICT=1 is fatal", async () => {
  delete process.env.FALDA_EMBED;
  delete process.env.FALDA_EMBED_BASE_URL;
  process.env.FALDA_EMBED_STRICT = "1";
  const { exited, code } = await captureExit(() => selectEmbedder(16, "test"));
  assert.equal(exited, true, "strict mode refuses to silently fall back");
  assert.equal(code, 1);
});

test("selectEmbedder: FALDA_EMBED=local is never fatal, even with strict=1", async () => {
  process.env.FALDA_EMBED = "local";
  process.env.FALDA_EMBED_STRICT = "1";
  const { exited } = await captureExit(() => selectEmbedder(16, "test"));
  assert.equal(exited, false, "explicit local opt-in is always allowed");
});

test("selectEmbedder: FALDA_EMBED_BASE_URL set is never fatal, even with strict=1", async () => {
  delete process.env.FALDA_EMBED;
  process.env.FALDA_EMBED_BASE_URL = "http://example.invalid/v1";
  process.env.FALDA_EMBED_STRICT = "1";
  const { exited } = await captureExit(() => selectEmbedder(16, "test"));
  assert.equal(exited, false, "a configured remote endpoint is never the silent-fallback case");
});

// ─── probeEmbedder ──────────────────────────────────────────────────────────

test("probeEmbedder: skipped entirely for the local embedder", async () => {
  process.env.FALDA_EMBED = "local";
  delete process.env.FALDA_EMBED_BASE_URL;
  const embed = async () => { throw new Error("should never be called"); };
  const dim = await probeEmbedder(embed, 16, "test");
  assert.equal(dim, null, "probe is a no-op for the local embedder");
});

test("probeEmbedder: skipped when no embedder is configured at all", async () => {
  delete process.env.FALDA_EMBED;
  delete process.env.FALDA_EMBED_BASE_URL;
  const embed = async () => { throw new Error("should never be called"); };
  const dim = await probeEmbedder(embed, 16, "test");
  assert.equal(dim, null);
});

test("probeEmbedder: remote + matching dim succeeds and returns the dim", async () => {
  process.env.FALDA_EMBED_BASE_URL = "http://example.invalid/v1";
  const embed = async () => new Array(16).fill(0.1);
  const { exited, result } = await captureExit(() => probeEmbedder(embed, 16, "test"));
  assert.equal(exited, false);
  assert.equal(result, 16);
});

test("probeEmbedder: remote + dim mismatch is fatal", async () => {
  process.env.FALDA_EMBED_BASE_URL = "http://example.invalid/v1";
  const embed = async () => new Array(999).fill(0.1); // model actually returns 999-dim, FALDA_DIM says 16
  const { exited, code } = await captureExit(() => probeEmbedder(embed, 16, "test"));
  assert.equal(exited, true, "a dim mismatch between the real embedder and FALDA_DIM must be caught at boot");
  assert.equal(code, 1);
});

test("probeEmbedder: remote + unreachable endpoint is fatal", async () => {
  process.env.FALDA_EMBED_BASE_URL = "http://example.invalid/v1";
  const embed = async () => { throw new Error("ECONNREFUSED"); };
  const { exited, code } = await captureExit(() => probeEmbedder(embed, 16, "test"));
  assert.equal(exited, true, "a down/unreachable embedder must be caught at boot, not silently ignored");
  assert.equal(code, 1);
});

test("probeEmbedder: FALDA_EMBED=remote (no base URL override) still probes", async () => {
  process.env.FALDA_EMBED = "remote";
  delete process.env.FALDA_EMBED_BASE_URL;
  const embed = async () => new Array(8).fill(0.1);
  const { exited, result } = await captureExit(() => probeEmbedder(embed, 8, "test"));
  assert.equal(exited, false);
  assert.equal(result, 8);
});
