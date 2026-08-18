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
trusted, and an index that is out of range or repeated is treated as
unresolved rather than applied.

This is the one place in the design that chooses strictness over tolerance.
Every other malformed-input path in distillation degrades to a skip, which
loses a candidate — recoverable, and visible in the pass record. Applying
candidate 7's decision to candidate 3 instead would *write* the wrong
consolidation: an atom merged into an unrelated one, or updated with content
that never belonged to it. That corrupts memory silently and is close to
untraceable after the fact. A dropped decision is cheap; a misattributed one
is not.

### A parser that can say "unresolved"

`parseConsolidationBatch(raw, n)` returns `Array<ConsolidationDecision | undefined>`,
where `undefined` means *no usable decision for this candidate*.

That distinction does not exist today. The current `parseConsolidation`
returns `{ action: "skip", rationale: "malformed LLM response" }` for a
response with no JSON object, and `{ action: "skip", rationale: "parse error" }`
when `JSON.parse` throws — so a garbled reply is indistinguishable from the
model deliberately skipping a redundant candidate, and the candidate is
dropped either way. Reusing that helper for the batch would make a single bad
response look like N deliberate skips, silently discarding an entire chunk.

The parser mirrors the robustness `parseCandidates` already has: try the
whole payload as a JSON array first, then fall back to scanning line by line
for parseable objects.

### Fallback: retry unresolved individually

Indices still unresolved after parsing are re-issued through today's exact
path — `llm(consolidationPrompt(candidate, existing))` parsed with the
existing `parseConsolidation`.

The worst case is therefore one call more than today's behaviour — the
wasted batched call plus the N individual retries it falls back to — reached
only when the batch misbehaves. No candidate is dropped by the batching itself.
Note this makes the batched path strictly more robust than the per-candidate
path it replaces, which still silently skips on a parse failure; that
pre-existing behaviour is left alone here rather than changed as a side
effect.

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
- an out-of-range index, a duplicated index, and a missing index each mark
  that candidate unresolved rather than misapplying a decision
- unresolved indices trigger exactly one individual retry call each
- a chunk boundary at exactly `BATCH` and at `BATCH + 1` candidates
- `FALDA_DISTILL_CONSOLIDATION_BATCH=1` reproduces the current call pattern,
  guarding the escape hatch
