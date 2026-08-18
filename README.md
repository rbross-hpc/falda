# FALDA

**Clustered hierarchical memory for scientific agents.**

FALDA gives an autonomous agent a layered, long-lived memory — like geological
strata, knowledge settles into tiers, from raw observation up to a stable core.
It is built entirely on open, self-hostable components: SQLite, `sqlite-vec`,
SQLite FTS5, and any OpenAI-compatible embedding endpoint. No external service,
no managed database, no cloud lock-in.

---

## The four tiers

| Tier | Name   | Holds                                                       | Backing store              |
|------|--------|-------------------------------------------------------------|----------------------------|
| T0   | Stream | raw conversation / observation log                          | SQLite + vec + FTS5        |
| T1   | Atoms  | distilled atomic memories (facts, patterns, instructions…)  | SQLite + vec + FTS5        |
| T2   | Scenes | organizational units — episodes (by session) + topics (by semantic cluster) | SQLite + vec + FTS5 (best-effort markdown mirror) |
| T3   | Core   | long-lived persona / project core                           | markdown blob (`core.md`)  |

Lower tiers are high-volume and queryable; higher tiers are curated and stable.
An agent writes raw turns to **Stream**; the distillation pipeline extracts
durable facts into **Atoms**, organises them into **Scenes** (episodes derived
from provenance, topics derived from embedding clustering), and synthesises a
single **Core** document describing who/what the agent is and the project it
serves.

T2 Scenes are stored in SQLite with FTS5 and vector indexes — they are
id-addressed, independently recallable, and browsable by kind (episode/topic).
The markdown files under `blobDir/scenes/` are a best-effort rendering cache,
not the source of truth.

## Recall

All three queryable tiers (Stream, Atoms, Scenes) support **hybrid recall**:
dense nearest-neighbor search (`sqlite-vec`, cosine) and lexical BM25 search
(SQLite FTS5) are fused via reciprocal-rank fusion. You get semantic recall
*and* exact-term recall in a single call, with no separate search service.
Atom recall additionally applies a parameterised blended re-rank (recency,
priority, confidence) and a pinned-first pass for standing instructions.

---

## Quick start

```bash
npm install
npm test           # offline, deterministic — full node:test suite
```

### As a library

```ts
import { Falda, makeEmbedder } from "falda-memory";

const memory = new Falda({
  dbPath: "./falda.db",
  blobDir: "./falda-blobs",
  embed: makeEmbedder(),   // OpenAI-compatible /v1/embeddings endpoint
  dim: 768,
});

await memory.addStream("session-1", [
  { role: "user", content: "The cryostat target temperature is 4.2 K." },
]);
await memory.upsertAtom({ type: "fact", content: "Cryostat target temperature is 4.2 K." });

const hits = await memory.searchAtoms("what temperature is the cryostat?", 3);
```

### As a service

`falda serve` starts the unified server: the HTTP JSON API, the MCP
endpoint, and the background distillation worker, all in one process
sharing one runtime (one embedder, one auth store, one distillation queue).

```bash
cp falda_tokens.example.json falda_tokens.json   # fill in real tokens; shared by HTTP + MCP
npm run serve        # HTTP JSON API on :8077, MCP on :8079
curl localhost:8077/healthz   # HTTP API, unauthenticated
curl localhost:8079/healthz   # MCP endpoint, unauthenticated
curl -X POST localhost:8077/atoms/search \
  -H "Authorization: Bearer <token>" -H "X-Falda-Tenant: <tenant>" \
  -d '{"query":"..."}'
```

Pass `--no-mcp` to run the HTTP API + distillation worker only, with no MCP
listener (`falda serve --no-mcp`).

See [`docs/API.md`](docs/API.md) for the full HTTP route table and auth
model, and [`docs/MCP.md`](docs/MCP.md) for the MCP tool table — both
surfaces share one `TokenStore`/auth model but expose different operations
by design (MCP is the restricted agent-facing surface; HTTP additionally
exposes pool-admin routes).

To interrogate a deployment from the host — tier counts, distillation queue
health, recall metrics, and config/layout, all read-only and offline (no
token, no running server needed) — run `falda stats` (or `npm run stats`).
A few sibling CLIs cover the rest of day-2 operations: `falda reembed`
rebuilds vector indexes after an embedding model/dimension change; `falda
distill inspect` reviews what a distillation pass actually decided (which
memories were extracted, stored, updated, merged, or skipped, and why —
also read-only and offline); `falda show recall` views a recall (by
default, the most recent one) through a *running* server, since a real
recall needs the configured embedder. See
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) for all four.

For deployments where many agents (e.g. containerized opencode instances)
share one FALDA over a network, point them at the MCP endpoint. This repo
ships a `Dockerfile` running `falda serve` by default (see
[`docs/INSTALL.md`](docs/INSTALL.md) "Running in Docker"), and
[`integrations/opencode/README.md`](integrations/opencode/README.md) for the
opencode-specific setup (Compose recipe, MCP config, auto-capture plugin).

To connect an agent runtime (Hermes, OpenClaw, opencode, or your own) to
FALDA — single-tenant or shared-pool — see
[`docs/HARNESS_INTEGRATION.md`](docs/HARNESS_INTEGRATION.md).

### Roadmap and known gaps

Deferred design questions, auth-hardening options, and a ranked audit of
failure/recovery-path gaps (not the nominal path — the full test suite
passes) live under `docs/future/`:
[`open-questions.md`](docs/future/open-questions.md),
[`auth-hardening.md`](docs/future/auth-hardening.md),
[`reliability-hardening.md`](docs/future/reliability-hardening.md).
None of these are implemented; they're tracked so the analysis isn't lost.

### Distillation (T0 → T1 → T2 → T3)

Distillation runs **in-process inside `falda serve`** as a background
worker (`src/distill/worker.ts`, `src/distill/core.ts`). It is the
canonical owner of the distillation
queue — a job enqueued via `falda_distill` (MCP) or `POST /distill` (HTTP)
is always drained by the same process that accepted it, because both
protocol surfaces and the worker share one runtime (`src/runtime.ts`). It
uses any OpenAI-compatible chat model to:

- **T0 → T1**: extract typed atoms (`fact | pattern | preference | constraint |
  instruction`) from new turns, consolidate against existing atoms (merge/update/
  store/skip), and record evidence edges.
- **T1 → T2**: organize atoms into episode and topic scenes (episode membership
  is a direct projection of provenance; topics are clustered by embedding with
  hysteresis).
- **T2 → T3**: synthesize a core document from the active scene structure.

Distillation is triggered two ways, both landing in one priority queue drained
by the single in-process worker inside `falda serve`:
- **Passive**: a sweep timer (`FALDA_SWEEP_INTERVAL_MS`, default 5 min)
  auto-enqueues every known self-store that has an undistilled turn
  (comparing the store's latest turn to its distillation watermark — a
  store with nothing new since its last pass is skipped, not re-enqueued),
  and a separate drain timer (`FALDA_DRAIN_INTERVAL_MS`, default 1 min)
  processes one ready job per tick — distillation runs continuously with no
  external trigger required, without wasting drain ticks on idle stores.
- **Explicit**: a `POST /distill` HTTP call or the `falda_distill` MCP tool
  enqueues at a higher priority than passive jobs (so it's claimed first) and
  immediately wakes the worker to drain it, rather than waiting for the next
  drain tick.

**Crash recovery:** a claimed job holds a time-limited lease
(`FALDA_DISTILL_LEASE_MS`, default 10 min). If the process claiming a job
crashes or is killed before finishing it, the job doesn't stay stuck
`running` forever — once its lease expires it becomes claimable again (by
the next claim on this or a restarted process), and `falda serve` also
proactively recovers any already-expired leases on startup, before its
first sweep/drain tick.

```bash
# Trigger a distillation pass on demand (falda serve must be running):
curl -s -X POST http://localhost:8077/distill \
  -H "Authorization: Bearer <token>" \
  -H "X-Falda-Tenant: my-agent" \
  -H "Content-Type: application/json" \
  -d '{}' | jq
```

| Env var                 | Default                     | Notes |
|-------------------------|-----------------------------|-------|
| `FALDA_LLM_PROVIDER`    | `openai`                    | `openai` (any OpenAI-compatible chat-completions endpoint — Ollama, vLLM, llama.cpp) or `anthropic` (Anthropic's Messages API; see below) |
| `FALDA_LLM_BASE_URL`    | `http://localhost:11434/v1` | chat-completions endpoint. On `anthropic`, an optional baseURL override for a gateway — unset uses Anthropic's own default |
| `FALDA_LLM_API_KEY`     | `x`                         | bearer token for chat endpoint. On `anthropic`, unset falls back to the SDK's `ANTHROPIC_API_KEY` lookup |
| `FALDA_LLM_MODEL`       | `gpt-4o-mini`               | extraction/synthesis model id (`claude-haiku-4-5` when `FALDA_LLM_PROVIDER=anthropic`) |
| `FALDA_LLM_TIMEOUT_MS`  | `120000`                    | request timeout, both providers — a stalled LLM fails the pass (retried with backoff) instead of hanging indefinitely |
| `FALDA_DRAIN_INTERVAL_MS`  | `60000`                  | how often the worker drains one ready job from the queue |
| `FALDA_SWEEP_INTERVAL_MS`  | `300000`                 | how often the worker auto-enqueues every self-store, and prunes `recall_traces.db` |
| `FALDA_WORKER_INTERVAL_MS` | *(unset)*                | **deprecated**: sets both of the above when they're unset — set the split vars instead |
| `FALDA_DISTILL_LEASE_MS`   | `600000`                 | how long a claimed distillation job's lease lasts before it's considered abandoned (e.g. by a crashed process) and reclaimable by the next claim — see "Crash recovery" below |
| `FALDA_SHUTDOWN_GRACE_MS`  | `10000`                  | on `SIGTERM`/`SIGINT`, how long `falda serve` waits for in-flight HTTP requests and an in-flight distillation job to finish before closing storage anyway — see "Graceful shutdown" below |

**Graceful shutdown:** `falda serve` handles `SIGTERM`/`SIGINT` by stopping
new work (new HTTP connections, new distillation claims), awaiting whatever
was already in flight (bounded by `FALDA_SHUTDOWN_GRACE_MS`), then closing
storage — so a container restart or `Ctrl-C` doesn't cut off an in-flight
request mid-response or close a SQLite handle while a distillation pass is
still writing. A second signal during shutdown forces an immediate exit.

Distillation defaults to a **self-hosted** model, and nothing about that
changes unless you opt in. `FALDA_LLM_PROVIDER=anthropic` exists for
deployments that would rather pay per token than run one:

```bash
FALDA_LLM_PROVIDER=anthropic \
FALDA_LLM_API_KEY=sk-ant-... \
FALDA_LLM_MODEL=claude-haiku-4-5 \
  falda serve
```

This is the one place FALDA can reach a hosted service, and only when
explicitly configured — see
[`docs/future/anthropic-llm-provider.md`](docs/future/anthropic-llm-provider.md)
for the design and its trade-offs. **Embeddings are unaffected:** Anthropic
publishes no embeddings endpoint, so `FALDA_EMBED_*` still needs a local
model or another OpenAI-compatible service.

---

## Configuration

Embeddings come from any OpenAI-compatible endpoint — run open-weights models
locally (Ollama, vLLM, llama.cpp) or against a self-hosted lab server.

| Env var                   | Default                        | Notes                                  |
|---------------------------|--------------------------------|----------------------------------------|
| `FALDA_EMBED`           | *(unset)*                      | embedder mode: `local` (deterministic, offline) or `remote` (calls `FALDA_EMBED_BASE_URL`); unset + no base URL defaults to `local`, unset + a base URL configured defaults to `remote` |
| `FALDA_EMBED_BASE_URL`  | `http://localhost:11434/v1`    | embeddings endpoint                    |
| `FALDA_EMBED_API_KEY`   | `x`                            | bearer token (`x` for keyless local)   |
| `FALDA_EMBED_MODEL`     | `nomic-embed-text`             | embedding model id                     |
| `FALDA_EMBED_STRICT`    | *(unset)*                      | `1` makes an unconfigured embedder a startup FATAL instead of silently falling back to the local embedder — recommended for production |
| `FALDA_EMBED_TIMEOUT_MS` | `30000`                       | request timeout for the embeddings endpoint — a stalled embedder fails the call instead of hanging indefinitely |
| `FALDA_DIM`             | `768`                          | must match the model's dimensionality  |
| `FALDA_ROOT`            | `./falda-data`                | pool root dir (all tenant/pool stores) |
| `FALDA_PORT`            | `8077`                         | HTTP JSON API port                     |
| `FALDA_MCP_PORT`        | `8079`                         | MCP endpoint port                      |
| `FALDA_BIND`            | `127.0.0.1`                    | HTTP JSON API bind host — loopback-only by default; see "Bind address & request size limits" below |
| `FALDA_MCP_BIND`        | `127.0.0.1`                    | MCP endpoint bind host — same loopback-only default |
| `FALDA_MAX_BODY_BYTES`  | `1048576`                      | max HTTP request body size (bytes); oversized bodies get `413` before parsing/auth; `<= 0` disables the cap |
| `FALDA_MCP_TOOLSET`     | `default`                      | `default` (compact agent API) or `full` (+ tier-specific advanced tools) |
| `FALDA_TOKENS`          | `./falda_tokens.json`          | canonical bearer-token file, shared by HTTP and MCP (required — see `docs/API.md`) |
| `FALDA_RECALL_BUDGET`      | `6000`  | `falda_recall`/`POST /recall` default budget (chars) for a deliberate ("explicit") call |
| `FALDA_AUTO_RECALL_BUDGET` | `3500`  | default budget for an unattended per-task recall (`mode: "auto"`) fired by a harness integration — kept smaller so it doesn't crowd out the task prompt |
| `FALDA_RECALL_MAX_BUDGET`  | `20000` | hard ceiling on any requested `budget`, explicit or auto |
| `FALDA_RECALL_ATOM_ITEM_CAP`  | `600`  | per-item char cap for one T1 atom admitted into a recall's assembled context |
| `FALDA_RECALL_SCENE_ITEM_CAP` | `1800` | per-item char cap for one T2 scene admitted into a recall's assembled context |
| `FALDA_RECALL_TRACE_RETENTION_DAYS` | `90` | days to retain `recall_traces.db` rows; `<= 0` retains indefinitely |
| `FALDA_LEGACY_ATOM_BUDGET` | `6000` | total char budget for `Falda.recallAtoms()`, a legacy T1-only recall path superseded by the cross-tier `assembleContext()` behind `falda_recall`/`POST /recall` — exercised only by tests today, not the live recall surface |

`FALDA_DB`/`FALDA_BLOBS` (a single store's SQLite path/blob dir) apply only
when embedding `Falda` directly as a library — see "As a library" above.
`falda serve` always addresses stores through `FALDA_ROOT` + the pool layer
(`docs/POOLS.md`), never a single `FALDA_DB`.

**Bind address & request size limits:** both listeners bind `127.0.0.1`
(loopback-only) by default — a bare host run of `falda serve` is not
reachable from another machine unless you opt in. **Containerized
deployments must set `FALDA_BIND=0.0.0.0` and `FALDA_MCP_BIND=0.0.0.0`**:
binding loopback *inside* a container defeats `docker run -p`/compose port
publishing, since Docker's port-forwarding connects to the container's own
network address, not its internal loopback interface — safety in that case
comes from the *publish spec* instead (e.g. `-p 127.0.0.1:8079:8079` keeps
it host-loopback-only; a bare `8079:8079` exposes it on every host
interface). The published Docker image (see `Dockerfile`) already sets both
to `0.0.0.0` so `docker run -p 127.0.0.1:PORT:PORT ...` works out of the
box. The HTTP API also rejects a request body larger than
`FALDA_MAX_BODY_BYTES` (default 1 MiB) with `413`, checked as soon as
possible — from a declared `Content-Length` if present, otherwise by
aborting the connection mid-stream once the running total is exceeded —
and always before JSON parsing or auth, so an unauthenticated caller can't
force unbounded memory growth. The MCP endpoint has no equivalent cap: it
authenticates before its SDK-owned transport reads any body, so the
pre-auth-flood risk this closes doesn't apply there. See
`docs/future/reliability-hardening.md` finding 11.

Recommended open embedding models: `nomic-embed-text` (768), `BAAI/bge-base-en-v1.5`
(768), `nomic-ai/nomic-embed-text-v1.5` (768). Set `FALDA_DIM` to match.

### CLI-client environment variables

These are read by CLI **clients**, not `falda serve` itself:

| Env var        | Default                   | Notes |
|----------------|----------------------------|-------|
| `FALDA_URL`    | `http://localhost:8077`   | server base URL for `falda show recall` and `falda stats --section=timing` |
| `FALDA_TOKEN`  | *(unset)*                  | bearer token for `falda show recall` and `falda stats --section=timing` — **not** the same as `FALDA_TOKENS` above (that's the server's token *file*; this is a single token *value* a client sends) |

---

## Architecture

```
                    ┌──────────────────────────┐
   agent  ───────▶  │  Falda  (lib or HTTP)  │
                    └────────────┬─────────────┘
            ┌────────────────────┼────────────────────┐
            ▼                    ▼                     ▼
     ┌─────────────┐    ┌────────────────┐    ┌────────────────┐
     │ SQLite      │    │ SQLite FTS5    │    │ local FS       │
     │ + sqlite-vec│    │ (BM25 lexical) │    │ core.md (T3)   │
     │ (T0–T2 vec) │    │ (T0–T2 lexical)│    │ + scene mirror │
     └─────────────┘    └────────────────┘    └────────────────┘
                          embeddings via OpenAI-compatible endpoint
```

The store is a single embeddable class (`Falda`). `falda serve` layers the
HTTP JSON API and MCP endpoint over one shared runtime (`src/runtime.ts`) as
independent protocol adapters — for multi-process or polyglot deployments,
or when embedding `Falda` directly isn't an option.

---

## Why "FALDA"

*Falda* is the Italian word for a **layer** or **stratum** — and, in hydrology, a
*falda acquifera* is an aquifer: water held and drawn from layered ground.
Memory in this system works the same way. It settles into discrete strata — from
raw observation up to long-lived persona — and recall draws from whichever layer
best answers a query, the way a well draws from the right depth. The name reads
operationally and describes exactly what the system does.

## License

Apache-2.0. See [LICENSE](LICENSE).
