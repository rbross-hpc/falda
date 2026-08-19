/**
 * Shared chat LLM client for distillation.
 * Used by the unified server runtime (src/runtime.ts) — the distillation
 * worker (src/distill/worker.ts) is the sole consumer.
 *
 * Two providers, selected by FALDA_LLM_PROVIDER:
 *
 *   openai (default)  OpenAI-compatible chat completions. This is the
 *                     self-hosted path — Ollama, vLLM, llama.cpp, or any
 *                     service exposing POST {baseUrl}/chat/completions.
 *   anthropic         Anthropic's Messages API via @anthropic-ai/sdk, for
 *                     deployments that would rather pay per token than run
 *                     a model. Opt-in; nothing changes unless you set it.
 *
 * The two are separate code paths rather than two base URLs because
 * Anthropic has no OpenAI-compatible endpoint: its API is
 * POST /v1/messages returning content blocks, not
 * POST /chat/completions returning choices[].message.content.
 *
 * Env:
 *   FALDA_LLM_PROVIDER    "openai" (default) | "anthropic"
 *   FALDA_LLM_BASE_URL    openai: chat endpoint (default: http://localhost:11434/v1)
 *                         anthropic: optional baseURL override (for a gateway
 *                         or proxy); unset uses the SDK's own default
 *   FALDA_LLM_API_KEY     openai: API key (default: "x", for keyless local)
 *                         anthropic: API key; unset falls back to the SDK's
 *                         own ANTHROPIC_API_KEY lookup
 *   FALDA_LLM_MODEL       model id (default: gpt-4o-mini / claude-haiku-4-5)
 *   FALDA_LLM_TIMEOUT_MS  Request timeout, ms (default 120000) — extraction/
 *                         synthesis prompts are slower than embeddings; a
 *                         stalled chat endpoint must not hang a distillation
 *                         pass indefinitely (see
 *                         docs/future/reliability-hardening.md finding 4).
 *                         Applies to both providers.
 */
import Anthropic from "@anthropic-ai/sdk";

export type LLMProvider = "openai" | "anthropic";

export interface LLMConfig {
  provider?: LLMProvider;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

const DEFAULT_LLM_TIMEOUT_MS = 120_000;

export type LLMFn = (prompt: string) => Promise<string>;

export interface LLMFnWithModel extends LLMFn {
  /** Model id this function is configured to call — surfaced so callers
   *  (distillOnce provenance, `falda distill inspect`) can record which
   *  model produced a given pass without re-reading env directly. */
  model: string;
}

/** Output ceiling for one distillation pass on the Anthropic path.
 *  The Messages API requires max_tokens (OpenAI's does not). It is a cap,
 *  not a target, so a generous value costs nothing when unused — but a low
 *  one would truncate a pass mid-JSON, which the worker would then record
 *  as a successful pass over malformed output. */
const ANTHROPIC_MAX_TOKENS = 16000;

const DEFAULT_MODEL: Record<LLMProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
};

/** Resolve the effective provider the same way makeLLM does. */
export function resolveLLMProvider(cfg: LLMConfig = {}): LLMProvider {
  return cfg.provider ?? (process.env.FALDA_LLM_PROVIDER as LLMProvider | undefined) ?? "openai";
}

/** Resolve the effective model id the same way makeLLM does, without
 *  constructing a client — used by callers that only need the label
 *  (e.g. the distill CLI/worker attaching provenance to a pass). */
export function resolveLLMModel(cfg: LLMConfig = {}): string {
  return cfg.model ?? process.env.FALDA_LLM_MODEL ?? DEFAULT_MODEL[resolveLLMProvider(cfg)];
}

/** Resolve the effective request timeout, shared by both providers. */
function resolveTimeoutMs(cfg: LLMConfig): number {
  return cfg.timeoutMs ?? Number(process.env.FALDA_LLM_TIMEOUT_MS ?? DEFAULT_LLM_TIMEOUT_MS);
}

export function makeLLM(cfg: LLMConfig = {}): LLMFnWithModel {
  const provider = resolveLLMProvider(cfg);
  const model = resolveLLMModel(cfg);
  const fn = provider === "anthropic" ? makeAnthropicLLM(cfg, model) : makeOpenAILLM(cfg, model);
  fn.model = model;
  return fn;
}

function makeOpenAILLM(cfg: LLMConfig, model: string): LLMFnWithModel {
  const baseUrl = cfg.baseUrl ?? process.env.FALDA_LLM_BASE_URL ?? "http://localhost:11434/v1";
  const apiKey = cfg.apiKey ?? process.env.FALDA_LLM_API_KEY ?? "x";
  const timeoutMs = resolveTimeoutMs(cfg);

  return async function llm(prompt: string): Promise<string> {
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e: any) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new Error(`LLM request timed out after ${timeoutMs}ms`);
      }
      throw e;
    }
    if (!resp.ok) throw new Error(`LLM ${resp.status}: ${await resp.text()}`);
    const j = (await resp.json()) as any;
    const choice = j.choices?.[0];
    if (choice?.finish_reason === "length") {
      // The reply was cut off mid-JSON before the model finished. Returning
      // it would let a batch parser resolve nothing and silently fall back
      // to retrying every candidate individually — or hand a non-batch
      // caller truncated JSON with no signal anything went wrong. Throw so
      // the worker's failJob/backoff sees it, mirroring the Anthropic path's
      // max_tokens guard below. A too-large FALDA_DISTILL_CONSOLIDATION_BATCH
      // is one possible cause, but not the only one (any prompt can hit the
      // server/model's own output cap), so the message names it as a
      // suspect rather than the definitive cause.
      throw new Error(
        "LLM reply was truncated (finish_reason: length) before finishing; " +
          "if this is a batched consolidation call, FALDA_DISTILL_CONSOLIDATION_BATCH " +
          "may be too large for this model/output",
      );
    }
    const content = choice?.message?.content;
    if (typeof content !== "string") {
      throw new Error(
        `LLM returned no usable message content (finish_reason: ${choice?.finish_reason ?? "unknown"})`,
      );
    }
    return content;
  } as LLMFnWithModel;
}

function makeAnthropicLLM(cfg: LLMConfig, model: string): LLMFnWithModel {
  // Unset apiKey/baseURL are left to the SDK, which falls back to
  // ANTHROPIC_API_KEY and https://api.anthropic.com respectively. The
  // openai path's "x" and Ollama defaults are deliberately not reused —
  // they are meaningless here and would produce a confusing 401.
  //
  // The SDK's own `timeout` (milliseconds) carries FALDA_LLM_TIMEOUT_MS, so
  // a stalled Messages endpoint cannot hang a pass any longer than a stalled
  // chat-completions one.
  const client = new Anthropic({
    apiKey: cfg.apiKey ?? process.env.FALDA_LLM_API_KEY,
    baseURL: cfg.baseUrl ?? process.env.FALDA_LLM_BASE_URL,
    timeout: resolveTimeoutMs(cfg),
  });

  return async function llm(prompt: string): Promise<string> {
    // No `temperature`: Opus 5, Sonnet 5, and Opus 4.7+ reject it with a
    // 400, so omitting it keeps every current Claude model selectable via
    // FALDA_LLM_MODEL. Distillation prompts carry their own determinism
    // requirements in the prompt text.
    const msg = await client.messages.create({
      model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    });

    if (msg.stop_reason === "max_tokens") {
      // The reply was cut off mid-JSON. Returning it would let the batch
      // parser resolve nothing and silently fall back to retrying every
      // candidate individually, doubling cost with no signal anywhere that
      // truncation happened. Throw so the worker's failJob/backoff sees it.
      throw new Error(
        `LLM reply hit ANTHROPIC_MAX_TOKENS (${ANTHROPIC_MAX_TOKENS}) before finishing; ` +
          `FALDA_DISTILL_CONSOLIDATION_BATCH may be too large for this model/output`,
      );
    }

    const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!text) {
      // Throwing rather than returning "" so the worker's failJob/backoff
      // sees it. An empty string would be recorded as a successful pass
      // that extracted nothing.
      const kinds = msg.content.map((b) => b.type).join(", ") || "none";
      throw new Error(`LLM returned no text block (content types: ${kinds})`);
    }
    return text.text;
  } as LLMFnWithModel;
}
