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
listener (`falda serve --no-mcp`, or `npm run gateway` as a standalone legacy
entry point — see below).

See [`docs/API.md`](docs/API.md) for the full HTTP route table and auth
model, and [`docs/MCP.md`](docs/MCP.md) for the MCP tool table — both
surfaces share one `TokenStore`/auth model but expose different operations
by design (MCP is the restricted agent-facing surface; HTTP additionally
exposes pool-admin routes).

For deployments where many agents (e.g. containerized opencode instances)
share one FALDA over a network, point them at the MCP endpoint. This repo
ships a `Dockerfile` running `falda serve` by default (see
[`docs/INSTALL.md`](docs/INSTALL.md) "Running in Docker"), and
[`integrations/opencode/README.md`](integrations/opencode/README.md) for the
opencode-specific setup (Compose recipe, MCP config, auto-capture plugin).

<details>
<summary>Legacy standalone entry points (deprecated, kept for compatibility)</summary>

Before the unified server, the HTTP API and MCP endpoint ran as two separate
processes with two separate token files. Both still work standalone —
`npm run gateway` / `npm run mcp` (`dist/gateway.js` / `dist/mcp.js`) — for
existing deployments that haven't migrated. `falda gateway` starts only the
HTTP API + distillation worker (no MCP); `falda mcp` starts only the MCP
endpoint (no distillation worker — nothing drains the shared queue unless
some other process owns it). Both now read the canonical `FALDA_TOKENS`
(with the old `FALDA_MCP_TOKENS` honored as a deprecated fallback for the
MCP entry point). New deployments should use `falda serve`.

</details>

To connect an agent runtime (Hermes, OpenClaw, opencode, or your own) to
FALDA — shadow or live, single-tenant or shared-pool — see
[`docs/HARNESS_INTEGRATION.md`](docs/HARNESS_INTEGRATION.md).

### Distillation (T0 → T1 → T2 → T3)

Distillation runs **in-process inside `falda serve`** (or its `falda
gateway` legacy equivalent) as a background worker (`src/distill/worker.ts`,
`src/distill/core.ts`). It is the canonical owner of the distillation
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

Distillation is triggered by: an interval timer inside `falda serve` (which
also auto-enqueues every known self-store, so distillation runs continuously
with no external trigger required), a `POST /distill` HTTP call, or the
`falda_distill` MCP tool. Each trigger enqueues a job; the single in-process
worker drains the queue.

```bash
# Trigger a distillation pass on demand (falda serve must be running):
curl -s -X POST http://localhost:8077/distill \
  -H "Authorization: Bearer <token>" \
  -H "X-Falda-Tenant: my-agent" \
  -H "Content-Type: application/json" \
  -d '{}' | jq

# Or via the standalone CLI entrypoint (one-shot, no server process needed):
FALDA_TENANT=my-agent FALDA_LLM_BASE_URL=http://localhost:8000/v1 \
  tsx src/distill/cli.ts --once
```

| Env var                 | Default                     | Notes |
|-------------------------|-----------------------------|-------|
| `FALDA_LLM_BASE_URL`    | `http://localhost:11434/v1` | chat-completions endpoint |
| `FALDA_LLM_API_KEY`     | `x`                         | bearer token for chat endpoint |
| `FALDA_LLM_MODEL`       | `gpt-4o-mini`               | extraction/synthesis model id |
| `FALDA_WORKER_INTERVAL_MS` | `60000`                  | distillation worker poll interval |

---

## Configuration

Embeddings come from any OpenAI-compatible endpoint — run open-weights models
locally (Ollama, vLLM, llama.cpp) or against a self-hosted lab server.

| Env var                   | Default                        | Notes                                  |
|---------------------------|--------------------------------|----------------------------------------|
| `FALDA_EMBED_BASE_URL`  | `http://localhost:11434/v1`    | embeddings endpoint                    |
| `FALDA_EMBED_API_KEY`   | `x`                            | bearer token (`x` for keyless local)   |
| `FALDA_EMBED_MODEL`     | `nomic-embed-text`             | embedding model id                     |
| `FALDA_DIM`             | `768`                          | must match the model's dimensionality  |
| `FALDA_ROOT`            | `./falda-data`                | pool root dir (all tenant/pool stores) |
| `FALDA_PORT`            | `8077`                         | HTTP JSON API port                     |
| `FALDA_MCP_PORT`        | `8079`                         | MCP endpoint port                      |
| `FALDA_TOKENS`          | `./falda_tokens.json`          | canonical bearer-token file, shared by HTTP and MCP (required — see `docs/API.md`) |

`FALDA_DB`/`FALDA_BLOBS` (a single store's SQLite path/blob dir) apply only
when embedding `Falda` directly as a library — see "As a library" above.
`falda serve`/`falda gateway`/`falda mcp` always address stores through
`FALDA_ROOT` + the pool layer (`docs/POOLS.md`), never a single `FALDA_DB`.

Recommended open embedding models: `nomic-embed-text` (768), `BAAI/bge-base-en-v1.5`
(768), `nomic-ai/nomic-embed-text-v1.5` (768). Set `FALDA_DIM` to match.

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
