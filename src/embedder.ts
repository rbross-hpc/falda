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

/** Deterministic local embedder for tests / offline development (no network). */
export function makeLocalEmbedder(dim = 768) {
  return async function embed(text: string): Promise<number[]> {
    const v = new Array(dim).fill(0);
    for (let i = 0; i < text.length; i++) v[i % dim] += text.charCodeAt(i) / 255;
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
}
