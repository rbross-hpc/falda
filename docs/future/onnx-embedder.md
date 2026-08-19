# In-process ONNX embedder

**Status: implemented, opt-in, default-off.** `FALDA_EMBED=onnx` runs a real
sentence-embedding model inside the FALDA process via ONNX Runtime — no
daemon, no server, no network at query time. With the variable unset nothing
changes: `local` and `remote` behave exactly as before.

This document records why the path exists, the measurement behind the pooling
choice, and the dependency trade-off — the parts a reader can't recover from
the diff.

## Why

FALDA's offline default is `makeLocalEmbedder`, six lines of character-position
hashing:

```ts
for (let i = 0; i < text.length; i++) v[i % dim] += text.charCodeAt(i) / 255;
```

It returns a vector for any input, so nothing errors and everything appears to
work. But the vector carries no meaning, so the dense half of hybrid recall
contributes nothing and only FTS5/BM25 does real retrieval. Re-word a query
and it misses.

Until now the only way to get real embeddings was `FALDA_EMBED=remote` plus a
model served somewhere — Ollama, vLLM, a lab endpoint. That is a deployment
step, and it is the reason many installs simply stay on the hash. This path
removes the step: a real model, in-process, `npm install` away.

## The measurement

Three sentences, cosine similarity between the first and each of the others:

- **A** — "The cryostat target temperature is 4.2 K."
- **Similar** — "How cold does the dilution fridge need to be?" (same meaning, almost no shared vocabulary)
- **Unrelated** — "Bananas are usually yellow when ripe."

| Embedder | similar | unrelated | margin |
|---|---|---|---|
| `Xenova/bge-base-en-v1.5`, **CLS** pooling | 0.6544 | 0.4042 | **+0.2502** |
| `Xenova/bge-base-en-v1.5`, mean pooling | 0.6969 | 0.4778 | +0.2191 |
| `makeLocalEmbedder` (current default) | 0.8813 | 0.9300 | **−0.0488** |

Two things follow.

**CLS pooling is used**, not mean. BGE models are trained with a CLS objective
and the margin confirms it (+0.2502 vs +0.2191). Absolute similarity is
higher under mean pooling, which is misleading — what matters for recall
ranking is the *gap* between related and unrelated, and CLS separates them
better. This is why `src/embedder.ts` hardcodes `pooling: "cls"`.

**The hash embedder's margin is negative.** It rates the banana sentence as
*more* similar to the cryostat sentence than the semantically related question.
For dense recall it is not merely uninformative — on this pair it is
anti-correlated, actively ranking the wrong result higher. The lexical half of
hybrid recall is what has been carrying every offline install.

## Dependency: declared nowhere, installed on demand

`@huggingface/transformers` appears in **no** dependency field of
`package.json`, so npm never installs it.

The reason is weight. The library is ~380MB installed (most of it
`onnxruntime-node`'s native binaries), against FALDA's four runtime
dependencies. Making it a regular dependency would impose that on every
install, including everyone who uses Ollama or a hosted endpoint and will
never load an ONNX model. Only `FALDA_EMBED=onnx` users pay:

```bash
npm install @huggingface/transformers
```

If it is missing when the embedder is first called, the error names the
package and the command rather than surfacing a bare `ERR_MODULE_NOT_FOUND`
from deep in the stack.

**Why not `peerDependencies` + `peerDependenciesMeta.optional`?** That was the
first implementation, and it is the textbook answer for "declared but not
installed by default." It does keep the install lean — but it silently breaks
the install command. With the package named in `peerDependencies`, npm treats
it as already satisfied, and

```bash
npm install @huggingface/transformers        # -> "up to date", installs nothing
npm install @huggingface/transformers@latest # -> same
npm install --no-save @huggingface/transformers  # -> same
```

all become no-ops; only `--save-optional` breaks through, and that rewrites
FALDA's own `package.json` on the user's clone. Since the whole point of the
declaration was documentation rather than resolution, and its absence achieves
the same leanness, it is simply omitted. `optionalDependencies` was never a
candidate — those install by default and merely tolerate install failure.

The library is loaded by a lazy `await import()` behind a `// @ts-ignore`,
since TypeScript cannot resolve a package that is deliberately not installed.
`npm run build` passes without it present, so contributors pay nothing either.

**Why this library.** The alternative, `fastembed`, is smaller (233MB) and
purpose-built for embeddings, but at evaluation time it carried a *critical*
advisory in `tar` — the code path that unpacks downloaded model archives — its
tokenizer dependency resolved to a literal `0.0.0` from a personal namespace,
and its `onnxruntime-node` was pinned six minor versions behind with no
release in eight months. Tokenization is precisely where a subtle bug yields
plausible-but-wrong vectors, so the official HuggingFace tokenizer was worth
147MB.

## Model and dimension

Default `Xenova/bge-base-en-v1.5`: the ONNX build of `BAAI/bge-base-en-v1.5`,
which this README already recommends, at **768 dimensions** — matching
`FALDA_DIM`'s own default. A fresh `FALDA_EMBED=onnx` install therefore needs
no dimension configuration and cannot hit the mismatched-dim trap.

`FALDA_EMBED_MODEL` overrides it, but other models have other dimensions
(`all-MiniLM-L6-v2` and `bge-small-en-v1.5` are 384), and **changing model or
dimension on a store that already holds vectors requires `falda reembed`** —
see `docs/OPERATIONS.md`. The boot probe now runs for `onnx` precisely so a
mismatch is fatal at startup rather than surfacing as a raw sqlite-vec error
on every insert and query.

The model (~440MB for the default) downloads once on first use and is cached
by the library. Because the probe runs at boot, that download happens during
startup — a first run is slow and a failure is loud, rather than the first
user recall paying for it.

That trade has a failure mode worth designing against: for several minutes the
process is running but bound to nothing, which is indistinguishable from a
hang, and the operator's natural response — `Ctrl-C` — discards the partial
download and guarantees the same wait next time. So the load reports progress
on stderr, keeping stdout clean for `falda serve`'s own output.

### Why the gate is a stopwatch, not an event

The obvious implementation is to report on the library's `initiate` event,
which names each file as it starts. That was the first implementation, and it
is wrong. Measured against `@huggingface/transformers` 3.x with the model
**already cached**:

```
counts {"initiate":4,"download":4,"progress_total":14,"progress":14,"done":4,"ready":1}
cached pipeline ready at ms: 208
```

A warm load emits the full sequence — same statuses, same per-file progress
ramp — as a cold download. `initiate` fires before the cache is even checked,
and `download` fires after the cache-hit branch rejoins. Nothing in the stream
distinguishes "fetching 440MB over the network" from "reading a file that is
already on disk," so an event-driven reporter prints eighteen lines saying
*downloading* on every restart of a cached deployment, which is both noise and
a lie.

The one thing that does distinguish them is duration: 208ms warm against
minutes cold. Hence `ONNX_PROGRESS_AFTER_MS = 3_000` — an order of magnitude
above the warm case, two orders below the cold one — and the rule "report only
once loading has taken long enough to look like a hang." A warm boot is
silent; a cold one explains itself. The clock is injected (`cfg.now`) so the
gate is testable without sleeping.

Past the gate, output is throttled to 10% steps: the library fires a progress
event per HTTP chunk, hundreds per file, and unthrottled they scroll every
other startup line off the screen. Deciles are tracked per file rather than
globally, because a model is several files fetched concurrently and one shared
counter would let the furthest-along file silence the rest.

The payload is the library's contract, not FALDA's, and it has changed shape
across releases, so the reporter validates every field and skips anything it
does not recognise. A logging convenience must not be able to take the
embedder down — `test/embedder_onnx.test.ts` feeds it `undefined`, `{}`, a
`progress` event with no file, and a non-numeric `progress` to hold that line.

## Testing

`test/embedder_onnx.test.ts` stays offline and deterministic, matching
`boot.test.ts` and the README's promise that `npm test` needs no network. It
covers selection precedence, the interaction with `FALDA_EMBED_STRICT`, model
resolution, the boot probe's dim-mismatch fatality, and the
missing-dependency error — everything except loading the model itself.

The model's own behaviour is deliberately *not* under automated test: doing so
would add a 440MB download to a suite that currently runs in about a second
with no network. The measurement above is the substitute, and the procedure is
reproducible from the table's three sentences.

## Open questions

- Should the default flip to `onnx` once it has soaked? It would make FALDA's
  "works fully offline out of the box" claim true with real semantics rather
  than a hash. The blocker is the 380MB dependency — a default that
  requires an extra install is not a default.
- `pooling: "cls"` is correct for BGE but not universal; `all-MiniLM` wants
  mean. If `FALDA_EMBED_MODEL` overriding becomes common, pooling should
  become configurable or derived from the model rather than hardcoded.
