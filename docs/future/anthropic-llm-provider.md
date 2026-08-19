# Anthropic as a distillation LLM provider

**Status: implemented, opt-in, default-off.** `FALDA_LLM_PROVIDER=anthropic`
routes distillation's extraction/synthesis calls at Anthropic's Messages API
instead of an OpenAI-compatible chat-completions endpoint. With the variable
unset, nothing changes: the self-hosted path is untouched, byte for byte.

This document records why the provider is a separate code path, the two
places it deliberately diverges from the OpenAI path, and the positioning
question it raises — the parts a reader can't recover from the diff.

## Why a second code path, not a second base URL

FALDA's LLM client already takes a `FALDA_LLM_BASE_URL`, so the obvious move
is to point it at Anthropic and be done. That does not work: **Anthropic
publishes no OpenAI-compatible endpoint.** Its API is

```
POST {baseUrl}/v1/messages   ->  { content: [{ type: "text", text }] }
```

against the existing path's

```
POST {baseUrl}/chat/completions  ->  { choices: [{ message: { content } }] }
```

Different route, different request body, different response shape. A base
URL swap produces a 404, and a shim would be a wire-format translator
maintained in this repo forever. The provider branch is the smaller thing.

## What it does not solve: embeddings

Anthropic's API surface is Messages plus Batches, Files, Token Counting and
Models. **There is no embeddings endpoint**, so an Anthropic key cannot
serve `FALDA_EMBED_BASE_URL`. Distillation and embedding remain independent
decisions, and a deployment using this provider still needs a local
embedding model or another OpenAI-compatible embeddings service. Worth
stating plainly because "I have an API key now" naturally reads as covering
both.

## Two deliberate divergences from the OpenAI path

Both look like oversights next to `makeOpenAILLM`, so they are recorded
here rather than left to a reviewer's inference.

**No `temperature`.** The OpenAI path sends `temperature: 0`. The Anthropic
path sends nothing. `claude-haiku-4-5` would accept it, but Opus 5,
Sonnet 5, and Opus 4.7+ **reject `temperature` with a 400** — so sending it
would silently restrict `FALDA_LLM_MODEL` to older models, and the failure
would surface as a distillation job dying on backoff rather than as a
config error. Determinism was never guaranteed by `temperature: 0` anyway;
the distillation prompts carry their own output constraints.

**`max_tokens: 16000`, hardcoded.** The Messages API requires `max_tokens`;
OpenAI's does not. It is a ceiling rather than a target, so a generous value
costs nothing when unused. A low one would truncate a pass mid-JSON, and
the worker would then record a *successful* pass over malformed output —
silent corruption rather than a visible failure. 16000 is well clear of any
realistic extraction batch and stays under the SDK's non-streaming HTTP
timeout.

## Error contract

Unchanged. SDK exceptions propagate exactly as the previous
`throw new Error(\`LLM ${resp.status}\`)` did, so
`src/distill/queue.ts`'s `failJob` backoff handles them without
modification.

One case is new: a reply carrying no `text` block (all `thinking`, say)
**throws** rather than returning `""`. An empty string would flow into the
extractor as "the model found nothing," and the pass would be recorded as a
success that extracted zero atoms — indistinguishable from a genuinely
empty batch. Throwing puts it on the retry path where it belongs.

## Interface and blast radius

`makeLLM()` still returns `LLMFnWithModel` — `(prompt: string) =>
Promise<string>` with a `.model` label. The single call site
(`src/runtime.ts`) is unchanged, as are the worker and the provenance
recorded by `falda distill inspect`. `resolveLLMModel()` becomes
provider-aware so `.model` reports `claude-haiku-4-5` rather than
`gpt-4o-mini` on Anthropic passes; distillation provenance therefore stays
accurate about which model produced a pass.

## Testing

`test/distill_llm_anthropic.test.ts` drives a `node:http` stub through the
SDK's `baseURL` override, so the suite needs no API key and makes no network
call. It asserts the Messages-API route and required headers, extraction
from `content[0].text`, the absence of `temperature`, a non-lowballed
`max_tokens`, the throw-on-no-text-block behaviour, the
`claude-haiku-4-5` default, and — as a regression guard — that with the
provider unset the OpenAI path still posts chat-completions with
`temperature: 0`.

## The positioning question

FALDA's README opens with *"built entirely on open, self-hostable
components... No external service, no managed database, no cloud
lock-in."* This provider is the first thing in the codebase that can call a
commercial API.

It is opt-in and default-off, so the claim holds for every deployment that
doesn't set the variable, and the self-hosted path remains the documented
default everywhere. But it is a real widening of the project's stance and a
maintainer may reasonably want it framed differently, kept behind a build
flag, or declined outright. Flagging it here rather than letting it arrive
unannounced in a diff.

## Open questions

- Should the same treatment extend to embeddings via a non-Anthropic hosted
  provider (Voyage, OpenAI, Cohere)? It would close the "no local model
  required" story that this change only half-delivers — but it widens the
  stance further, and unlike distillation, embeddings ship *every* stored
  turn to a third party rather than periodic batches.
- `max_tokens` is a constant. If real extraction batches approach it, it
  should become `FALDA_LLM_MAX_TOKENS` rather than being raised blindly.
