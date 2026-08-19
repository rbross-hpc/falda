/**
 * Tests for the in-process ONNX embedder (FALDA_EMBED=onnx).
 *
 * FALDA's offline default (`makeLocalEmbedder`) is a character-position hash,
 * not a model: it returns a vector for every input, but the vector carries no
 * semantics, so dense recall is noise and only FTS5/BM25 does real work. The
 * onnx path runs a real sentence-embedding model in-process via
 * @huggingface/transformers — no daemon, no network at query time, no server
 * to deploy.
 *
 * These tests stay OFFLINE and DETERMINISTIC, matching boot.test.ts and the
 * README's promise that `npm test` needs no network. They therefore cover
 * selection, configuration, and the missing-dependency path — everything
 * except actually loading the ~440MB model. The model's own behaviour
 * (pooling strategy, embedding quality) is verified by hand during
 * development and recorded in docs/future/onnx-embedder.md; see that
 * document's "Verifying the model" section for the procedure and results.
 *
 * Guarantees under test:
 *   1. FALDA_EMBED=onnx selects the ONNX embedder, not local or remote.
 *   2. It wins over FALDA_EMBED_BASE_URL being set (explicit beats inferred).
 *   3. It is never the default — an unconfigured FALDA still falls back to
 *      the local embedder, so no existing deployment changes behaviour.
 *   4. FALDA_EMBED_STRICT=1 does not fire for onnx: it is a real embedder.
 *   5. The default model is the 768-dim bge-base, matching FALDA_DIM's own
 *      default so a fresh install needs no dim reconfiguration.
 *   6. FALDA_EMBED_MODEL overrides that default.
 *   7. With the optional peer dependency absent, calling the embedder throws
 *      an actionable install instruction rather than a bare module-not-found.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { selectEmbedder, probeEmbedder } from "../src/boot.js";
import { makeOnnxEmbedder, ONNX_DEFAULT_MODEL, resolveOnnxModel } from "../src/embedder.js";

const ENV_KEYS = ["FALDA_EMBED", "FALDA_EMBED_BASE_URL", "FALDA_EMBED_STRICT", "FALDA_EMBED_MODEL"] as const;
let savedEnv: Record<string, string | undefined>;

before(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

function restore() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

afterEach(restore);
after(restore);

/** Marker the onnx embedder carries so selection can be asserted without
 *  loading a model — selectEmbedder returns a bare function otherwise. */
function isOnnx(embed: unknown): boolean {
  return (embed as { onnx?: boolean })?.onnx === true;
}

/** Run fn with process.exit stubbed to throw a sentinel, so the FATAL paths
 *  can be asserted without killing the runner. Mirrors boot.test.ts. */
async function captureExit<T>(
  fn: () => T | Promise<T>,
): Promise<{ exited: boolean; code: number | undefined; result?: T }> {
  const realExit = process.exit;
  let exited = false;
  let code: number | undefined;
  (process as any).exit = ((c?: number) => {
    exited = true;
    code = c;
    throw new Error("__exit__");
  }) as any;
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

// ─── selection ────────────────────────────────────────────────────────────────

test("selectEmbedder: FALDA_EMBED=onnx selects the in-process ONNX embedder", () => {
  process.env.FALDA_EMBED = "onnx";
  delete process.env.FALDA_EMBED_BASE_URL;

  const embed = selectEmbedder(768, "test");
  assert.ok(isOnnx(embed), "expected the onnx embedder, got local or remote");
});

test("selectEmbedder: FALDA_EMBED=onnx wins over a set FALDA_EMBED_BASE_URL", () => {
  process.env.FALDA_EMBED = "onnx";
  process.env.FALDA_EMBED_BASE_URL = "http://localhost:11434/v1";

  const embed = selectEmbedder(768, "test");
  assert.ok(isOnnx(embed), "an explicit FALDA_EMBED must beat the inferred remote path");
});

test("selectEmbedder: onnx is never the default — unconfigured still falls back to local", () => {
  delete process.env.FALDA_EMBED;
  delete process.env.FALDA_EMBED_BASE_URL;
  delete process.env.FALDA_EMBED_STRICT;

  const embed = selectEmbedder(768, "test");
  assert.ok(!isOnnx(embed), "adding the onnx path must not change any existing deployment");
});

test("selectEmbedder: FALDA_EMBED=onnx is not fatal under FALDA_EMBED_STRICT=1", () => {
  process.env.FALDA_EMBED = "onnx";
  process.env.FALDA_EMBED_STRICT = "1";

  // STRICT exists to stop a *silent fallback to the fake embedder*. onnx is a
  // real model, so it must satisfy strict mode rather than trip it.
  const embed = selectEmbedder(768, "test");
  assert.ok(isOnnx(embed));
});

// ─── model configuration ──────────────────────────────────────────────────────

test("default model is 768-dim, matching FALDA_DIM's own default", () => {
  delete process.env.FALDA_EMBED_MODEL;

  assert.equal(resolveOnnxModel(), ONNX_DEFAULT_MODEL);
  assert.match(
    ONNX_DEFAULT_MODEL,
    /bge-base/,
    "the default must be a 768-dim model so a fresh install needs no FALDA_DIM change",
  );
});

test("FALDA_EMBED_MODEL overrides the default model", () => {
  process.env.FALDA_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
  assert.equal(resolveOnnxModel(), "Xenova/all-MiniLM-L6-v2");
});

test("an explicit config model beats the environment", () => {
  process.env.FALDA_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
  assert.equal(resolveOnnxModel({ model: "Xenova/bge-small-en-v1.5" }), "Xenova/bge-small-en-v1.5");
});

// ─── boot probe ───────────────────────────────────────────────────────────────

test("probeEmbedder: runs for onnx and is fatal when the model's dim != FALDA_DIM", async () => {
  process.env.FALDA_EMBED = "onnx";
  delete process.env.FALDA_EMBED_BASE_URL;

  // A 384-dim model (all-MiniLM, bge-small) under the default FALDA_DIM=768
  // would fail on every insert and query with a raw sqlite-vec error. The
  // probe exists to catch exactly this at boot, so it must not skip onnx the
  // way it skips the deterministic local embedder.
  const wrongDim = async () => new Array(384).fill(0.1);

  const { exited, code } = await captureExit(() => probeEmbedder(wrongDim, 768, "test"));
  assert.equal(exited, true, "a dim mismatch must be caught at boot, not at first recall");
  assert.equal(code, 1);
});

test("probeEmbedder: onnx with a matching dim passes and reports the length", async () => {
  process.env.FALDA_EMBED = "onnx";
  delete process.env.FALDA_EMBED_BASE_URL;

  const rightDim = async () => new Array(768).fill(0.1);

  const { exited, result } = await captureExit(() => probeEmbedder(rightDim, 768, "test"));
  assert.equal(exited, false);
  assert.equal(result, 768);
});

// ─── missing optional dependency ──────────────────────────────────────────────

test("a missing @huggingface/transformers throws an actionable install instruction", async () => {
  // The dependency is an optional peer, so a default `npm install` does not
  // pull it. Someone who sets FALDA_EMBED=onnx without installing it must get
  // told what to run — not a bare ERR_MODULE_NOT_FOUND from deep in the stack.
  const embed = makeOnnxEmbedder({
    load: async () => {
      throw Object.assign(new Error("Cannot find package '@huggingface/transformers'"), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    },
  });

  await assert.rejects(
    () => embed("anything"),
    (err: Error) => {
      assert.match(err.message, /@huggingface\/transformers/, "names the missing package");
      assert.match(err.message, /npm install/, "tells the operator what to run");
      return true;
    },
  );
});

// ─── first-run download progress ──────────────────────────────────────────────
//
// The reporting is gated on ELAPSED TIME, not on the event stream, because the
// event stream does not distinguish the two cases. Measured against the real
// library (@huggingface/transformers 3.x) with the model already cached, a
// warm load emits a full 4 initiate / 4 download / 14 progress / 4 done
// sequence — identical in shape to a cold download — and completes in ~200ms.
// Only duration separates them: a cold fetch of the 440MB default runs for
// minutes with the server bound to nothing.
//
// So the rule is "report only once loading has taken long enough to look like
// a hang." A warm boot stays silent; a cold one explains itself.

/** Build an onnx embedder whose injected loader captures the options passed to
 *  `pipeline()` and returns a trivial extractor, so the progress plumbing can
 *  be driven without touching the network. `clock` is the injected time
 *  source — advance it to simulate a slow load. */
function withCapturedPipeline(cfg: { model?: string } = {}) {
  const lines: string[] = [];
  let opts: any;
  let now = 0;
  const embed = makeOnnxEmbedder({
    ...cfg,
    log: (m: string) => lines.push(m),
    now: () => now,
    load: async () => ({
      pipeline: async (_task: string, _model: string, o: any) => {
        opts = o;
        return async () => ({ data: new Float32Array(768) });
      },
    }),
  });
  return {
    embed,
    lines,
    opts: () => opts,
    /** Move the injected clock to `ms` after the load began. */
    advanceTo: (ms: number) => { now = ms; },
  };
}

test("stays silent when the model loads from cache", async () => {
  // The exact event sequence a warm load produces, replayed at the timings the
  // real library produced it at (whole load: 208ms). None of it is news to an
  // operator — the server is up before they could read it — and 18 lines of
  // "downloading" on every restart of a cached deployment is pure noise.
  const { embed, lines, opts, advanceTo } = withCapturedPipeline();
  await embed("hello");
  const cb = opts().progress_callback;

  advanceTo(50);
  for (const file of ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model.onnx"]) {
    cb({ status: "initiate", file });
    cb({ status: "download", file });
  }
  for (let pct = 9.2; pct <= 100; pct += 9.2) {
    advanceTo(50 + pct * 1.5);
    cb({ status: "progress", file: "tokenizer.json", progress: Math.min(pct, 100) });
  }
  advanceTo(195);
  cb({ status: "progress", file: "onnx/model.onnx", progress: 100 });
  advanceTo(208);

  assert.deepEqual(lines, [], "a warm load is not worth a single line");
});

test("explains itself once loading is slow enough to look like a hang", async () => {
  // The first `FALDA_EMBED=onnx` boot fetches ~440MB before the server answers
  // anything. Without this the process looks hung, and the operator's next move
  // is to kill it — which throws away the partial download.
  const { embed, lines, opts, advanceTo } = withCapturedPipeline();
  await embed("hello");
  const cb = opts().progress_callback;

  advanceTo(30_000);
  cb({ status: "progress", file: "onnx/model.onnx", progress: 12 });

  assert.ok(lines.length >= 1);
  assert.ok(
    lines.some((l) => l.includes(ONNX_DEFAULT_MODEL)),
    "names the model, so the wait is attributable",
  );
  assert.ok(
    lines.some((l) => /onnx\/model\.onnx/.test(l) && /10%/.test(l)),
    `reports the file and its progress, got: ${JSON.stringify(lines)}`,
  );
});

test("throttles progress to 10% steps rather than logging every chunk", async () => {
  // @huggingface/transformers fires a progress event per chunk — hundreds per
  // file. Logging each one buries every other startup line.
  const { embed, lines, opts, advanceTo } = withCapturedPipeline();
  await embed("hello");
  const cb = opts().progress_callback;
  advanceTo(30_000);

  for (const progress of [0.4, 3.2, 9.9, 10.1, 11, 19.8, 20.2, 74, 99.9]) {
    cb({ status: "progress", file: "model.onnx", progress });
  }

  // Deciles crossed: 0, 10, 20, 70, 90 — five progress lines, not nine.
  const pct = lines.filter((l) => /\d+%/.test(l));
  assert.equal(pct.length, 5, `expected one line per decile, got: ${JSON.stringify(lines)}`);
  assert.match(pct[0], /0%/);
  assert.match(pct[1], /10%/);
  assert.match(pct[4], /90%/);
});

test("tracks each file's progress separately", async () => {
  // A model is several files (weights, tokenizer, config) fetched
  // concurrently. A single shared decile counter would silence whichever file
  // happened to lag behind the one setting the high-water mark.
  const { embed, lines, opts, advanceTo } = withCapturedPipeline();
  await embed("hello");
  const cb = opts().progress_callback;
  advanceTo(30_000);

  cb({ status: "progress", file: "model.onnx", progress: 55 });
  cb({ status: "progress", file: "tokenizer.json", progress: 12 });

  const pct = lines.filter((l) => /\d+%/.test(l));
  assert.equal(pct.length, 2);
  assert.match(pct[0], /model\.onnx/);
  assert.match(pct[1], /tokenizer\.json/);
});

test("survives a progress event whose shape it does not expect", async () => {
  // The payload is the library's contract, not FALDA's, and it has changed
  // shape across releases. A logging convenience must never be able to take
  // the embedder down.
  const { embed, lines, opts, advanceTo } = withCapturedPipeline();
  await embed("hello");
  const cb = opts().progress_callback;
  advanceTo(30_000);

  assert.doesNotThrow(() => cb(undefined));
  assert.doesNotThrow(() => cb({}));
  assert.doesNotThrow(() => cb({ status: "progress" }));
  assert.doesNotThrow(() => cb({ status: "progress", file: "m", progress: "not a number" }));
  assert.equal(lines.length, 0, "nothing parseable, nothing logged");
});

test("names the configured model, not the default, when one is set", async () => {
  const { embed, lines, opts, advanceTo } = withCapturedPipeline({ model: "Xenova/bge-small-en-v1.5" });
  await embed("hello");
  advanceTo(30_000);

  opts().progress_callback({ status: "progress", file: "model.onnx", progress: 5 });

  assert.ok(lines.some((l) => l.includes("Xenova/bge-small-en-v1.5")));
});
