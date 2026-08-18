# FALDA MCP server

A remote (Streamable HTTP) [Model Context Protocol](https://modelcontextprotocol.io)
server exposing FALDA's recall + write tools to any MCP client (opencode and
others) over a network — for deployments where **one FALDA instance serves
many agents**, potentially each working across several projects.

For the JSON/HTTP surface (a lower-level surface with the same bearer-token
auth model, typically run on a trusted loopback/tailnet), see `docs/API.md`.

## One process, two protocol surfaces

`falda serve` runs the MCP endpoint and the JSON/HTTP API in one process,
against one shared runtime (`src/runtime.ts`): one `PoolManager`, one
`TokenStore`, one distillation queue, one distillation worker. Both
surfaces share the same `TokenStore`/`Principal` auth model
(`src/mcp_auth.ts`) and both require `Authorization: Bearer <token>` +
`X-Falda-Tenant` on every request except `GET /healthz` — but each is its
own listener (separate ports) and its own protocol adapter with its own
allowed operations: MCP speaks the MCP protocol (Streamable HTTP, tool
schemas) and intentionally exposes only the restricted agent-facing tool
set below; the HTTP API additionally exposes pool-admin routes MCP omits
by design. Merging the daemon does not merge or broaden either surface's
capabilities.

## Run it

```bash
cp falda_tokens.example.json falda_tokens.json
# fill in real tokens (openssl rand -hex 24), each with a tenants[] allow-list
# this file is canonical — shared by the HTTP API and the MCP endpoint

FALDA_ROOT=~/.falda/data \
FALDA_TOKENS=./falda_tokens.json \
FALDA_EMBED=local \
node --import tsx src/server.ts
# or: npm run serve

curl -s localhost:8077/healthz   # HTTP API
curl -s localhost:8079/healthz   # {"ok":true,"mcp":true}
```

MCP endpoint: `POST/GET/DELETE http://<host>:8079/mcp` (Streamable HTTP
transport, stateless — a fresh session per connection), port configurable
via `FALDA_MCP_PORT` (default `8079`).

## Auth model

**Tenants are scoped per project, not per container/agent.** A token
identifies a principal (typically one container/host), but the tenant a
given request addresses is selected per call via `X-Falda-Tenant` — in
practice, whatever that *project's own* `opencode.json` sets (see
`integrations/opencode/README.md` "Per-project opencode config"). This is
what lets one container work across many projects, each with its own
isolated memory, without juggling per-project tokens.

Every request must carry:

| Header | Meaning |
|---|---|
| `Authorization: Bearer <token>` | Identifies a **principal** (e.g. one container/host). Unknown/missing token → `401` before any MCP handshake. |
| `X-Falda-Tenant: <tenant>` | **Selects** which tenant this request addresses. |

The principal's `tenants` allow-list in the token file determines which
tenants it may select via the header:

```json
{
  "tokens": {
    "<opaque-token>": {
      "tenants": ["proj-a", "proj-b"],
      "pools": ["shared-corpus"],
      "label": "opencode container — proj-a & proj-b"
    },
    "<another-token>": {
      "tenants": ["*"],
      "pools": [],
      "label": "fully-trusted internal container (any tenant)"
    }
  }
}
```

- `tenants: ["*"]` — the principal may select any tenant. Use only for fully
  trusted internal deployments.
- `tenants: ["proj-a", "proj-b"]` — the principal may only select one of
  these. Selecting any other tenant → tool call returns an error result
  (`token is not authorized for tenant "..."`).
- **Why token authorizes but header selects** (rather than a fixed
  one-token-one-tenant binding): a single container commonly works across
  multiple projects. One token per container, one tenant header per
  project's `opencode.json`, lets that container reach every project it's
  authorized for without juggling per-project tokens.
- A `pool` tool argument is checked against the principal's `pools`
  allow-list. `pool: "self"` (the default, omitted) is always allowed.
- The token file is hot-read per request — rotating/adding a token doesn't
  require a restart. **Never commit it** (`falda_mcp_tokens.json` is
  git-ignored).

This is a routing/authorization boundary, not transport security — run the
MCP server on a private network/tailnet. It has no TLS of its own; if you
need a public-facing endpoint, terminate TLS in front of it with a standard
reverse proxy (e.g. nginx, Caddy).

## Tools

**The tiers (T0/T1/T2/T3) are FALDA's internal memory model, not the
agent's API vocabulary.** By default, agents see a small,
intention-oriented tool set: ask FALDA to recall, remember, forget, or
distill. FALDA decides internally which tiers to read or write to satisfy
that intent — the model never has to choose between "search atoms" vs.
"search scenes" vs. "read core."

All tools accept an optional `pool` argument (must be in the token's `pools`
allow-list; omit for the tenant's private `self` store).

### Default surface (`FALDA_MCP_TOOLSET` unset or `default`)

| Tool | R/W | When to use |
|---|---|---|
| `falda_recall` | read | **Primary retrieval tool.** Search long-term memory for anything relevant to the current task — prior facts, preferences, constraints, instructions, or related episodes. Assembles cross-tier context (pinned atoms, ranked T1 atoms, T2 scenes, T3 core) under a character budget and returns `{recall_id, context, items, truncated}`. `budget` defaults to `FALDA_RECALL_BUDGET` (a deliberate call) or `FALDA_AUTO_RECALL_BUDGET` when `mode: "auto"` (an unattended per-task recall fired by a harness integration) — either way it's clamped to `FALDA_RECALL_MAX_BUDGET`. `recall_id` is a trace correlation key for later usage feedback (see `docs/RECALL_TRACES.md`) — best-effort, omitted rather than erroring if trace persistence fails. |
| `falda_remember` | write | Save a durable fact, pattern, preference, constraint, or standing instruction for future sessions. Not for transient details relevant only to the current conversation. Content is immutable — a changed proposition becomes a new memory, never an edit of the old one. |
| `falda_forget` | write | Stop recalling a previously stored memory (`atom_id` from `falda_remember`/a `falda_recall` hit). Logical forgetting only — moves it from active to archived; does not erase historical/provenance evidence. Not privacy erasure. |
| `falda_distill` | write | Enqueue a distillation job for the addressed store at explicit priority (claimed ahead of the worker's own passive-sweep jobs) and wake the worker to drain it immediately; returns `{job_id, store_key}`. Async — a background worker already distills periodically, so this is for requesting an out-of-cycle run. |
| `falda_distill_status` | read | Poll a distillation job by `job_id`. Returns `pending \| running \| done \| failed/dead`. Enforces tenant/pool ownership of the job (no existence oracle for jobs you don't own). |
| `falda_whoami` | read | Return the tenant this connection resolves to. |
| `falda_stream_add` | write | **Machine/harness ingestion**, not an interactive tool. Appends raw conversation turns (T0) for later distillation. Normally called automatically by a capture plugin/harness integration after each turn (see `integrations/opencode/plugin`) — the model should generally prefer `falda_remember` over calling this directly. Stays on the default endpoint (not `full`-gated) because MCP cannot hide a registered tool from one caller while exposing it to another on the same endpoint. |

**Atom type enum:** `fact | pattern | preference | constraint | instruction`.
Out-of-set values are rejected as errors (no coercion).

`falda_whoami` takes no arguments (not even `pool`) and discloses **only**
the resolved tenant — never the bearer token, and never the principal's
full `tenants`/`pools` allow-lists. Use it to confirm which tenant a given
connection actually addresses (e.g. after changing a project's
`opencode.json`), not to enumerate what a token can reach.

**Usage feedback is deliberately not an MCP tool.** There is no
`falda_report_usage` in either toolset — reporting which recalled items
were actually used is a harness/plugin responsibility (`POST
/recall/usage`, `docs/API.md`), not something the model is prompted to do
after every `falda_recall`. See `docs/RECALL_TRACES.md`.

### Advanced/debug surface (`FALDA_MCP_TOOLSET=full`)

Adds the tier-specific storage primitives the compact tools are built on
top of — for diagnostics, migrations, and workflows that genuinely need
low-level tier access. Implementations are unchanged from before this
tool set was introduced; nothing here is new capability, only visibility.

| Tool | Tier | R/W | Description |
|---|---|---|---|
| `falda_stream_search` | T0 Stream | read | Hybrid dense+lexical search over raw turns |
| `falda_stream_query` | T0 Stream | read | List turns by session/time window |
| `falda_atoms_search` | T1 Atoms | read | Hybrid dense+lexical search over distilled atoms (active only, blended re-rank) |
| `falda_atoms_query` | T1 Atoms | read | List atoms by type/time window (active by default) |
| `falda_atoms_upsert` | T1 Atoms | write | Create or update metadata of a distilled atom, including `id`/`confidence`/`supersedes` and immediate pinning. Content/type are immutable post-write. |
| `falda_scenes_search` | T2 Scenes | read | Hybrid dense+lexical search over scenes (episodes + topics) |
| `falda_scenes_query` | T2 Scenes | read | List scenes by kind/status |
| `falda_scenes_get` | T2 Scenes | read | Get a single scene by id |
| `falda_core_read` | T3 Core | read | Read the persona/project core document |

**T2 Scenes and T3 Core are intentionally read-only over MCP for agents,
even in `full`.** Those tiers are populated by the in-process distillation
pipeline (triggered via `falda_distill` / `POST /distill` / an interval
timer inside `falda serve`, and always drained by that same process's
worker — see `docs/API.md` "Distillation"), not by freehand agent edits.
Pool administration (`/pools/declare`, `/pools/grant`, ...) is likewise
**not** exposed over MCP in either toolset — use the HTTP API's `/pools/*`
routes from an internal/admin context.

### Choosing a toolset

Set `FALDA_MCP_TOOLSET=full` (env var on the `falda serve` process) to
expose the advanced tools alongside the default ones — useful
for a debugging session or an admin/migration script. The underlying
service methods (`Falda.searchAtoms`, `upsertAtom`, etc.) are never
removed; `full` only changes which tools are *registered* on the MCP
endpoint. `default` is the recommended setting for normal agent use.

## Environment

See `src/runtime.ts` for the full canonical config (shared with the HTTP
API when run via `falda serve`). MCP-specific:

| var | meaning | default |
|---|---|---|
| `FALDA_MCP_PORT` | port to listen on | `8079` |
| `FALDA_MCP_TOOLSET` | `default` (compact agent API) or `full` (+ tier-specific advanced tools) | `default` |
| `FALDA_ROOT` | pool root dir (shared with the HTTP API) | `./falda-data` |
| `FALDA_TOKENS` | canonical token file, shared by HTTP and MCP | `./falda_tokens.json` |
| `FALDA_DIM` / `FALDA_EMBED*` | embedder selection, as in the HTTP API | — |
| `FALDA_RECALL_TRACE_RETENTION_DAYS` | days to retain `recall_traces.db` rows (see `docs/RECALL_TRACES.md`); `<= 0` retains indefinitely | `90` |
| `FALDA_RECALL_BUDGET` | `falda_recall`'s default budget for a deliberate call (`mode` omitted or `"explicit"`) | `6000` |
| `FALDA_AUTO_RECALL_BUDGET` | `falda_recall`'s default budget when `mode: "auto"` — an unattended per-task recall fired by a harness integration; kept smaller by default | `3500` |
| `FALDA_RECALL_MAX_BUDGET` | hard ceiling on any requested `budget`, explicit or auto | `20000` |
| `FALDA_RECALL_ATOM_ITEM_CAP` | per-item char cap for one T1 atom admitted into `falda_recall`'s assembled context | `600` |
| `FALDA_RECALL_SCENE_ITEM_CAP` | per-item char cap for one T2 scene admitted into `falda_recall`'s assembled context (larger than the atom cap — scenes carry a title+summary) | `1800` |

## opencode integration

See `integrations/opencode/README.md` for the full setup recipe (Docker
Compose service, MCP config, auto-capture plugin) for containerized
opencode agents. This repo's `Dockerfile` builds an image whose default
`CMD` is `falda serve` — both this MCP endpoint and the HTTP API from one
container.
