/**
 * Shared OpenAI-compatible chat LLM client for distillation.
 * Used by the unified server runtime (src/runtime.ts) and the standalone
 * distill CLI (src/distill/cli.ts) — one implementation, not two copies.
 *
 * Env:
 *   FALDA_LLM_BASE_URL    OpenAI-compatible chat endpoint (default: http://localhost:11434/v1)
 *   FALDA_LLM_API_KEY     API key (default: "x")
 *   FALDA_LLM_MODEL       Model name (default: gpt-4o-mini)
 */
export interface LLMConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export type LLMFn = (prompt: string) => Promise<string>;

export interface LLMFnWithModel extends LLMFn {
  /** Model id this function is configured to call — surfaced so callers
   *  (distillOnce provenance, `falda distill inspect`) can record which
   *  model produced a given pass without re-reading env directly. */
  model: string;
}

/** Resolve the effective model id the same way makeLLM does, without
 *  constructing a client — used by callers that only need the label
 *  (e.g. the distill CLI/worker attaching provenance to a pass). */
export function resolveLLMModel(cfg: LLMConfig = {}): string {
  return cfg.model ?? process.env.FALDA_LLM_MODEL ?? "gpt-4o-mini";
}

export function makeLLM(cfg: LLMConfig = {}): LLMFnWithModel {
  const baseUrl = cfg.baseUrl ?? process.env.FALDA_LLM_BASE_URL ?? "http://localhost:11434/v1";
  const apiKey = cfg.apiKey ?? process.env.FALDA_LLM_API_KEY ?? "x";
  const model = resolveLLMModel(cfg);

  const fn = async function llm(prompt: string): Promise<string> {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0 }),
    });
    if (!resp.ok) throw new Error(`LLM ${resp.status}: ${await resp.text()}`);
    const j = (await resp.json()) as any;
    return j.choices[0].message.content as string;
  } as LLMFnWithModel;
  fn.model = model;
  return fn;
}
