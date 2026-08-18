/**
 * Embedding client for FALDA.
 *
 * Calls an OpenAI-compatible /v1/embeddings endpoint — use any US open-weights
 * embedding model served via vLLM, Ollama, llama.cpp, or a hosted lab endpoint
 * (e.g. nomic-embed-text, BAAI/bge-base-en-v1.5, gte-base).
 *
 * Env:
 *   FALDA_EMBED_BASE_URL    e.g. http://localhost:11434/v1  or  http://<lab-host>/v1
 *   FALDA_EMBED_API_KEY     bearer token ("x" for keyless local servers)
 *   FALDA_EMBED_MODEL       e.g. nomic-embed-text
 *   FALDA_EMBED_TIMEOUT_MS  request timeout, ms (default 30000) — a stalled
 *                           embedding endpoint must not hang a request or
 *                           distillation pass indefinitely (see
 *                           docs/future/reliability-hardening.md finding 4)
 */
export interface EmbedderConfig { baseUrl?: string; apiKey?: string; model?: string; timeoutMs?: number; }

const DEFAULT_EMBED_TIMEOUT_MS = 30_000;

export function makeEmbedder(cfg: EmbedderConfig = {}) {
  const baseUrl = cfg.baseUrl ?? process.env.FALDA_EMBED_BASE_URL ?? "http://localhost:11434/v1";
  const apiKey = cfg.apiKey ?? process.env.FALDA_EMBED_API_KEY ?? "x";
  const model = cfg.model ?? process.env.FALDA_EMBED_MODEL ?? "nomic-embed-text";
  const timeoutMs = cfg.timeoutMs ?? Number(process.env.FALDA_EMBED_TIMEOUT_MS ?? DEFAULT_EMBED_TIMEOUT_MS);

  return async function embed(text: string): Promise<number[]> {
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e: any) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new Error(`embeddings timed out after ${timeoutMs}ms`);
      }
      throw e;
    }
    if (!resp.ok) throw new Error(`embeddings ${resp.status}: ${await resp.text()}`);
    const j = (await resp.json()) as any;
    return j.data[0].embedding as number[];
  };
}

/** Default ONNX model: the ONNX build of BAAI/bge-base-en-v1.5, which
 *  README already recommends. 768-dimensional, matching FALDA_DIM's own
 *  default — so a fresh `FALDA_EMBED=onnx` install needs no dim change and
 *  cannot hit the mismatched-dimension trap. */
export const ONNX_DEFAULT_MODEL = "Xenova/bge-base-en-v1.5";

export interface OnnxEmbedderConfig {
  model?: string;
  /** Loader seam for the optional dependency. Injectable so the
   *  missing-dependency path can be tested without uninstalling it. */
  load?: () => Promise<any>;
  /** Sink for download-progress lines. Defaults to stderr: this is startup
   *  diagnostics, and `falda serve`'s own output belongs on stdout. */
  log?: (message: string) => void;
  /** Time source for the progress gate. Injectable so the gate is testable
   *  without sleeping. */
  now?: () => number;
}

/** How long a model load may run before it starts reporting progress.
 *
 *  A warm (cached) load of the default model measures ~200ms end to end and
 *  emits the same event sequence a cold download does, so the event stream
 *  cannot tell the two apart — only duration can. Three seconds sits an order
 *  of magnitude above the warm case and two orders below the cold one. */
export const ONNX_PROGRESS_AFTER_MS = 3_000;

export interface OnnxEmbedder {
  (text: string): Promise<number[]>;
  /** Marks this as the ONNX embedder so selection is assertable without
   *  loading a model — the other embedders are bare functions. */
  onnx: true;
}

/** Resolve the effective ONNX model id the same way makeOnnxEmbedder does. */
export function resolveOnnxModel(cfg: { model?: string } = {}): string {
  return cfg.model ?? process.env.FALDA_EMBED_MODEL ?? ONNX_DEFAULT_MODEL;
}

/**
 * In-process embedder running a real sentence-embedding model through ONNX
 * Runtime — no server, no daemon, no network at query time.
 *
 * This exists because the offline default (makeLocalEmbedder, below) is a
 * character-position hash rather than a model: it returns a vector for any
 * input, but the vector carries no meaning, so dense recall contributes
 * nothing and only FTS5/BM25 does real retrieval. Running a real model used
 * to mean standing up Ollama or a lab endpoint; this path removes that.
 *
 * @huggingface/transformers is an OPTIONAL dependency, deliberately declared
 * nowhere in package.json: npm therefore never pulls its ~380MB, and only
 * deployments that set FALDA_EMBED=onnx install it. (It was briefly an
 * optional *peer* dependency, which broke the obvious install command —
 * npm treats a declared peer as already satisfied and makes
 * `npm install @huggingface/transformers` a silent no-op. Declaring it
 * nowhere achieves the same leanness and leaves that command working.)
 * The model itself (~440MB for the default) downloads once on first use and
 * is cached by the library.
 */
export function makeOnnxEmbedder(cfg: OnnxEmbedderConfig = {}): OnnxEmbedder {
  const model = resolveOnnxModel(cfg);
  // @ts-ignore — deliberately absent from package.json, so TypeScript cannot
  // resolve it at build time. See the note above.
  const load = cfg.load ?? (() => import("@huggingface/transformers"));
  const log = cfg.log ?? ((m: string) => console.error(m));
  const now = cfg.now ?? (() => Date.now());

  /** Built once and reused: constructing the pipeline loads (and on first
   *  run downloads) the model, which must not happen per embed call. */
  let pipeline: Promise<any> | undefined;

  /**
   * Report a first-run model download — and only a first-run model download.
   *
   * A fresh `FALDA_EMBED=onnx` boot fetches ~440MB before the server binds,
   * during which the process looks hung. The operator's natural response,
   * killing it, discards the partial download and guarantees the same wait
   * next time. Saying so costs nothing and saves that.
   *
   * The gate is ELAPSED TIME rather than anything in the event stream, because
   * the event stream cannot tell the two cases apart: measured against the
   * real library, a fully cached load emits the same initiate/download/
   * progress/done sequence a cold download does. It just finishes in ~200ms.
   * So: report only once the load has run long enough to look like a hang,
   * which leaves a warm restart completely silent.
   *
   * Past that gate, output is throttled to 10% steps — the library fires a
   * progress event per chunk, hundreds per file, and unthrottled they scroll
   * every other startup line away. Deciles are tracked per file, because a
   * model is several files fetched concurrently and one shared counter would
   * let the furthest-along file silence the rest.
   *
   * The payload is @huggingface/transformers' contract rather than FALDA's,
   * and it has changed shape across releases, so everything here is defensive
   * — an unrecognised event is skipped, never thrown on. A logging convenience
   * must not be able to take the embedder down.
   */
  function makeProgressReporter(): (event: any) => void {
    const startedAt = now();
    const deciles = new Map<string, number>();
    let announced = false;

    return (event: any) => {
      if (event?.status !== "progress") return;
      const file = typeof event.file === "string" ? event.file : undefined;
      if (!file) return;
      const pct = event.progress;
      if (typeof pct !== "number" || !Number.isFinite(pct)) return;
      if (now() - startedAt < ONNX_PROGRESS_AFTER_MS) return;

      const decile = Math.floor(Math.min(Math.max(pct, 0), 100) / 10) * 10;
      if (decile <= (deciles.get(file) ?? -1)) return;
      deciles.set(file, decile);

      if (!announced) {
        announced = true;
        log(
          `falda: downloading the embedding model ${model}. This happens once and is ` +
          `then cached; interrupting it loses the partial download.`,
        );
      }
      log(`falda:   ${file} ${decile}%`);
    };
  }

  async function buildPipeline(): Promise<any> {
    let mod: any;
    try {
      mod = await load();
    } catch (e: any) {
      throw new Error(
        `FALDA_EMBED=onnx requires the optional dependency @huggingface/transformers, ` +
        `which is not installed. Run: npm install @huggingface/transformers ` +
        `(underlying error: ${String(e?.message ?? e)})`,
      );
    }
    return mod.pipeline("feature-extraction", model, {
      progress_callback: makeProgressReporter(),
    });
  }

  const fn = async function embed(text: string): Promise<number[]> {
    if (!pipeline) pipeline = buildPipeline();
    const extractor = await pipeline;
    // BGE models are trained with CLS pooling; `normalize` gives unit vectors
    // so sqlite-vec's cosine distance behaves. See docs/future/onnx-embedder.md
    // ("Verifying the model") for the measurement backing this choice.
    const out = await extractor(text, { pooling: "cls", normalize: true });
    return Array.from(out.data as Float32Array) as number[];
  } as OnnxEmbedder;
  fn.onnx = true;
  return fn;
}

/** Deterministic local embedder for tests / offline development (no network). */
export function makeLocalEmbedder(dim = 768) {
  return async function embed(text: string): Promise<number[]> {
    const v = new Array(dim).fill(0);
    for (let i = 0; i < text.length; i++) v[i % dim] += text.charCodeAt(i) / 255;
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
}
