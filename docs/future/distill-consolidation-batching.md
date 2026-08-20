# Batched consolidation decisions

**Status: implemented, on by default.** This document specifies collapsing
distillation's per-candidate consolidation calls into one batched call per
chunk. It is provider-agnostic: the saving applies to the self-hosted OpenAI
path exactly as it does to `FALDA_LLM_PROVIDER=anthropic`.

This document records the cost measurement that motivates the change, why the
batch is correlated by explicit index rather than by order, and which
cheaper-looking alternatives were rejected — the parts a reader can't recover
from the diff.

## Why

`distillOnce` makes one LLM call to extract candidate atoms, then **one call
per candidate** to decide whether that candidate is stored, updates an
existing atom, merges several, or is skipped. That loop is `src/distill/core.ts`,
at the `llm(consolidationPrompt(candidate, existing))` call site.

Every one of those calls re-sends the same instruction block. It is ~250
tokens of role framing, output schema, and the four action rules; only the
candidate and its retrieved neighbours differ.

### The measurement

Per pass, with N candidates and `DEFAULT_CANDIDATE_LIMIT = 8` existing atoms
retrieved per candidate:

| | per-candidate (today) | batched |
|---|---|---|
| requests | N | ⌈N / 20⌉ |
| instruction tokens | N × ~250 | ~250 per chunk |
| candidate + neighbours | N × ~250 | N × ~250 |
| output tokens | N × ~60 | N × ~60 |

At N = 15 that is ~7,500 input tokens across 15 requests, against ~4,000
across 1 — an estimated **~47% reduction in input tokens**, and 15 requests
collapsed to 1.

Two honest qualifications:

- **The saving is bounded by the instruction block, not the call count.** The
  candidate text and its eight retrieved neighbours must still be sent for
  every candidate; that half of the payload does not shrink. Framing this as
  "N× fewer calls therefore N× cheaper" would be wrong.
- **Output tokens do not change at all.** N decisions are still produced.

The reduction is nonetheless in the same range as the Anthropic Batch API's
50% discount, without that API's asynchronous turnaround.

## What it does not solve

Extraction, scene title/summary, and core synthesis calls are untouched. This
addresses the consolidation loop only, because that is the only site whose
call count scales with the size of the input.

## Design

### One prompt, N numbered blocks

`consolidationBatchPrompt(items)` emits the shared instruction block once,
then a numbered block per candidate carrying that candidate and its own
`searchAtoms` results. The retrieved neighbour set genuinely differs per
candidate, so it is not dedupable — only the instructions are.

The model returns a JSON array, each element:

```json
{ "candidate": 3, "action": "update", "target_ids": ["..."], "rationale": "..." }
```

### Correlation by explicit index, never by order

Each decision names the candidate index it belongs to. Array position is not
trusted, and an out-of-range or non-integer index is treated as unresolved
rather than applied.

This is the one place in the design that chooses strictness over tolerance.
Applying candidate 7's decision to candidate 3 instead would *write* the
wrong consolidation: an atom merged into an unrelated one, or updated with
content that never belonged to it. That corrupts memory silently and is close
to untraceable after the fact. A dropped decision is cheap; a misattributed
one is not.

A **repeated** in-range index is handled differently: the first valid
decision for that index is kept, later occurrences cannot override it, and
`onDuplicateIndex` fires once per duplicated index — regardless of whether
either occurrence's decision is itself valid — surfaced via `console.warn`,
independent of `--verbose`, so an operator can see the LLM violated the
"each candidate exactly once" instruction. This is not known to have
happened with real model output — no incident has been observed — so it is
treated as a visibility concern rather than a correctness one, and it does
NOT trigger the individual-retry fallback described below. Reporting is
itself non-fatal: an exception from `onDuplicateIndex` is swallowed, never
propagated, so a broken warning sink cannot fail an otherwise-resolvable
batch.

### A parser that can say "unresolved"

`parseConsolidationBatch(raw, allowedTargetIdsByCandidate)` returns
`Array<ConsolidationDecision | undefined>`, where `undefined` means
*no usable decision for this candidate*.

`undefined` is distinct from a parsed `action: "skip"`. An explicit skip is
a successful, auditable decision; `undefined` means the batch entry is
absent or fails structural/action/cardinality/membership validation. The
shared `validateConsolidationDecision` helper enforces: known action,
`target_ids` is an array of distinct strings, every target was shown to the
model for that specific candidate (candidate-local membership), and
action-specific cardinality (store/skip → 0, update → 1, merge → 2+).

The parser tries the whole payload as a JSON array first, then falls back
to scanning line by line for parseable objects.

### Fallback: retry unresolved individually

Indices still unresolved after parsing are re-issued through the single-
candidate path — `llm(consolidationPrompt(candidate, existing))` parsed with
`parseConsolidation`, which applies the same strict validation.

The worst case is therefore one call more than today's behaviour — the
wasted batched call plus the N individual retries it falls back to — reached
only when the batch misbehaves. No candidate is dropped by the batching
itself. If an individual fallback also fails validation, the whole pass fails
retryably before any L1 write: the watermark does not advance and the queue
backoff mechanism engages (finding 16).

### Chunking is not optional

The extraction prompt places no ceiling on how many candidates it may return,
so N is unbounded and a single prompt is not safe at the tail. Candidates are
processed in chunks of `FALDA_DISTILL_CONSOLIDATION_BATCH` (default 20).

Twenty bounds the output at roughly 20 × 60 ≈ 1,200 tokens, comfortably
inside the Anthropic path's `ANTHROPIC_MAX_TOKENS` of 16,000, and keeps the
model from having to hold a very long list in attention while emitting
structured output for each entry. N = 50 becomes 3 calls rather than 50.

### Configuration

`FALDA_DISTILL_CONSOLIDATION_BATCH` — integer, default 20. Setting it to `1`
restores exactly the current one-call-per-candidate behaviour, which is both
the escape hatch and the regression test.

### Input-side cap: `FALDA_DISTILL_CONSOLIDATION_MAX_CHARS`

`FALDA_DISTILL_CONSOLIDATION_BATCH` bounds candidate *count*, not built-prompt
*size*. Each candidate in a chunk carries its own retrieved neighbour set
(`candidateLimit`, default 8, existing atoms — full `content` each, see
`consolidationBatchPrompt`), so a chunk's actual prompt size depends on
neighbour content, not just how many candidates it holds. A batch of 20
candidates each with 8 verbose neighbours can be considerably larger than a
batch of 20 short ones.

`FALDA_DISTILL_CONSOLIDATION_MAX_CHARS` — integer, default `0` (disabled).
When set to a positive value, `distillOnce`'s chunking becomes size-aware:
candidates are still capped at `FALDA_DISTILL_CONSOLIDATION_BATCH` per chunk,
but a chunk is closed early — before adding the next candidate — if the
built prompt (via the same `consolidationBatchPrompt` that will actually be
sent) would exceed the cap. This is a greedy pack, not a fixed split: it
fills each chunk closer to the cap than blind halving would, since per-
candidate cost is not uniform.

The cap is a character count, not a token count — no tokenizer is used
(one would be model-specific, and the self-hosted OpenAI path can point at
any model). Treat it as a rough proxy (~4 chars/token is a commonly cited
heuristic for English text) and leave headroom.

A lone candidate whose own built prompt already exceeds the cap is still
sent alone — there's nothing smaller to try, and dropping it would violate
the "never drop a candidate" rule the individual-retry fallback already
follows. A verbose-mode log line records this so an operator can see it
happened, without failing the pass.

Left disabled by default: it's a second knob on top of
`FALDA_DISTILL_CONSOLIDATION_BATCH`, and a deployment that hasn't hit an
input-size problem shouldn't have its batch sizing silently reshaped by a
cap it never asked for.

### Output-side guard: truncated replies must fail loudly, on both providers

The Anthropic path already throws when `stop_reason === "max_tokens"`
(`src/distill/llm.ts`) rather than returning a reply that may be truncated
mid-JSON — silently returning it would let the batch parser (or the
single-decision parser) resolve nothing, and a batch would collapse into N
wasted individual retries with no signal anywhere that truncation happened.

The OpenAI-compatible path did not have the same guard: `makeOpenAILLM`
returned `choices[0].message.content` unconditionally. It now checks
`choices[0].finish_reason` and throws on `"length"`, mirroring the Anthropic
behaviour so the worker's `failJob`/backoff sees a truncated reply as a
failure to retry rather than a successful pass over unusable output. The
error names `FALDA_DISTILL_CONSOLIDATION_BATCH` as one *possible* cause
(phrased that way deliberately — this guard applies to every OpenAI-path
call, including extraction, synthesis, and single-candidate consolidation,
not only batched consolidation, so a too-large batch is not the only thing
that can trigger it).

## Alternatives rejected

**Anthropic Batch API (~50% discount).** Asynchronous, with a turnaround of up
to 24 hours. `LLMFn` is `(prompt: string) => Promise<string>`; making it
batch-aware means job ids, persistence, and polling in a worker that currently
triggers on compaction and expects results within a pass. It is also
Anthropic-only, so it would fork the provider abstraction that
`docs/future/anthropic-llm-provider.md` deliberately keeps behind one
interface. Comparable saving, far larger blast radius.

**Prompt caching on the repeated instruction block.** The obvious fix for
"the same 250 tokens N times", and it does not work: the minimum cacheable
prefix is ~1024 tokens, and the consolidation prompt is roughly a quarter of
that. Caching would silently not engage, with `cache_read_input_tokens`
staying at zero and no error to explain why.

**Parallelising the loop without batching.** The consolidation calls are
already independent — the loop performs only `searchAtoms` and
`evidenceForAtom` reads, and no atom is written until after it completes — so
they could be issued concurrently. That improves latency and nothing else:
the same N requests are sent, each still carrying its own copy of the
instruction block. Worth doing on its own merits; it is not a cost measure.

## Testing

- the batch prompt contains every candidate in the chunk, each with its own
  retrieved neighbour set
- decisions are applied by their stated index, not by array position
- an out-of-range index and a missing index each mark that candidate
  unresolved rather than misapplying a decision
- a repeated in-range index keeps the first valid decision, does not trigger
  individual retry, and fires exactly one non-fatal duplicate warning
  reporting the candidate index and occurrence count
- unresolved indices trigger exactly one individual retry call each
- a chunk boundary at exactly `BATCH` and at `BATCH + 1` candidates
- `FALDA_DISTILL_CONSOLIDATION_BATCH=1` reproduces the current call pattern,
  guarding the escape hatch
- `FALDA_DISTILL_CONSOLIDATION_MAX_CHARS` unset reproduces fixed-stride
  chunking byte for byte
- a tight `FALDA_DISTILL_CONSOLIDATION_MAX_CHARS` splits a chunk that would
  otherwise fit by count alone, and drops no candidate
- a lone candidate exceeding `FALDA_DISTILL_CONSOLIDATION_MAX_CHARS` is still
  sent, not dropped
- an unresolved candidate inside a size-capped chunk still falls back
  individually
- the OpenAI path throws on `finish_reason: "length"`, mirroring the
  Anthropic path's `stop_reason: "max_tokens"` guard
