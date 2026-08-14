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

export function makeLLM(cfg: LLMConfig = {}): LLMFn {
  const baseUrl = cfg.baseUrl ?? process.env.FALDA_LLM_BASE_URL ?? "http://localhost:11434/v1";
  const apiKey = cfg.apiKey ?? process.env.FALDA_LLM_API_KEY ?? "x";
  const model = cfg.model ?? process.env.FALDA_LLM_MODEL ?? "gpt-4o-mini";

  return async function llm(prompt: string): Promise<string> {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0 }),
    });
    if (!resp.ok) throw new Error(`LLM ${resp.status}: ${await resp.text()}`);
    const j = (await resp.json()) as any;
    return j.choices[0].message.content as string;
  };
}
