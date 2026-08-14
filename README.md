# FALDA

**Clustered hierarchical memory for scientific agents.**

FALDA gives an autonomous agent a layered, long-lived memory — like geological
strata, knowledge settles into tiers, from raw observation up to a stable core.
It is built entirely on open, self-hostable components: SQLite, `sqlite-vec`,
SQLite FTS5, and any OpenAI-compatible embedding endpoint. No external service,
no managed database, no cloud lock-in.

---

## The four tiers

| Tier | Name   | Holds                                              | Backing store            |
|------|--------|----------------------------------------------------|--------------------------|
| T0   | Stream | raw conversation / observation log                 | SQLite + vec + FTS5      |
| T1   | Atoms  | distilled atomic memories (facts, prefs, rules)    | SQLite + vec + FTS5      |
| T2   | Scenes | synthesized episodic scene blocks (markdown)       | local filesystem         |
| T3   | Core   | long-lived persona / project core (markdown)       | local filesystem         |

Lower tiers are high-volume and queryable; higher tiers are curated and stable.
An agent writes raw turns to **Stream**, distills durable facts into **Atoms**,
periodically synthesizes episodes into **Scenes**, and maintains a single
**Core** document describing who/what it is and the project it serves.

## Recall

Both vectorized tiers (Stream, Atoms) support **hybrid recall**: a dense nearest-
neighbor search (`sqlite-vec`, cosine) and a lexical BM25 search (FTS5) are fused
via reciprocal-rank fusion. You get semantic recall *and* exact-term recall in a
single call, with no separate search service.

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

```bash
cp falda_gateway_tokens.example.json falda_gateway_tokens.json   # fill in real tokens
npm run gateway     # JSON HTTP API on :8077
curl localhost:8077/healthz   # unauthenticated
curl -X POST localhost:8077/atoms/search \
  -H "Authorization: Bearer <token>" -H "X-Falda-Tenant: <tenant>" \
  -d '{"query":"..."}'
```

See [`docs/API.md`](docs/API.md) for the full route table and auth model.

### As an MCP server (opencode and other MCP clients)

For deployments where many agents (e.g. containerized opencode instances)
share one FALDA over a network, use the authenticated MCP server instead of
the gateway directly:

```bash
cp falda_mcp_tokens.example.json falda_mcp_tokens.json   # fill in real tokens
npm run mcp          # Streamable HTTP MCP endpoint on :8079
curl localhost:8079/healthz
```

See [`docs/MCP.md`](docs/MCP.md) for the tool table and auth model, and
[`integrations/opencode/README.md`](integrations/opencode/README.md) for the
opencode-specific setup (MCP config + auto-capture plugin).

To connect an agent runtime (Hermes, OpenClaw, opencode, or your own) to
FALDA — shadow or live, single-tenant or shared-pool — see
[`docs/HARNESS_INTEGRATION.md`](docs/HARNESS_INTEGRATION.md).

### Distillation (T0 → T1 → T2 → T3)

The gateway provides the storage primitives; promotion between tiers is driven
by a standalone sidecar, [`falda_distiller.py`](falda_distiller.py). It
polls the Stream over the HTTP API and uses any OpenAI-compatible chat model to:

- **T0 → T1**: extract typed atoms (`persona` / `episodic` / `instruction`)
  from new turns, in small windows (defaults to 12-turn chunks — large blobs
  cause under-extraction).
- **T1 → T2**: synthesize periodic scene summaries (`L2_INTERVAL_S`, default 1h).
- **T2 → T3**: synthesize a stable core/persona (`L3_INTERVAL_S`, default 6h).

It touches only the documented HTTP API plus your LLM endpoint, and keeps a
restart-safe checkpoint in `~/.falda/distiller_state.json`.

```bash
export LLM_BASE_URL=http://localhost:8000/v1   # any OpenAI-compatible chat endpoint
export LLM_API_KEY=...                          # required, no default
export FALDA_TOKEN=...                          # required, no default — gateway bearer token
export DISTILLER_MODEL=gpt-4o-mini
python3 falda_distiller.py --once             # one backfill pass
python3 falda_distiller.py                    # continuous loop
```

| Env var          | Default            | Notes                              |
|------------------|--------------------|------------------------------------|
| `LLM_BASE_URL`   | `localhost:8000/v1`| chat-completions endpoint          |
| `LLM_API_KEY`    | _(required)_       | bearer token for the chat endpoint |
| `FALDA_TOKEN`    | _(required)_       | gateway bearer token (must be authorized for `FALDA_TENANT`) |
| `DISTILLER_MODEL`| `gpt-4o-mini`      | extraction/synthesis model id      |
| `L1_EVERY_N`     | `10`               | new turns before an atom pass      |
| `L2_INTERVAL_S`  | `3600`             | scene synthesis cadence            |
| `L3_INTERVAL_S`  | `21600`            | core synthesis cadence             |

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
| `FALDA_DB`              | `./falda.db`                 | SQLite file                            |
| `FALDA_BLOBS`           | `./falda-blobs`              | scene + core blob directory            |
| `FALDA_PORT`            | `8077`                         | gateway port                           |
| `FALDA_TOKENS`          | `./falda_gateway_tokens.json`  | gateway bearer-token file (required — see `docs/API.md`) |

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
     │ + sqlite-vec│    │ (BM25 lexical) │    │ scenes + core  │
     │ (T0,T1 vec) │    │ (T0,T1 lexical)│    │ (T2,T3)        │
     └─────────────┘    └────────────────┘    └────────────────┘
                          embeddings via OpenAI-compatible endpoint
```

The store is a single embeddable class (`Falda`). The gateway is a thin
JSON wrapper over it for multi-process or polyglot deployments.

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
