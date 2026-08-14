# FALDA MCP server

A remote (Streamable HTTP) [Model Context Protocol](https://modelcontextprotocol.io)
server exposing FALDA's recall + write tools to any MCP client (opencode and
others) over a network — for deployments where **one FALDA instance serves
many agents**, potentially each working across several projects.

For the JSON/HTTP gateway (a lower-level surface with the same bearer-token
auth model, typically run on a trusted loopback/tailnet), see `docs/API.md`.

## Why a separate server from the gateway

Both the gateway (`src/gateway.ts`) and this MCP server share the same
`TokenStore`/`Principal` auth model (`src/mcp_auth.ts`) and both require
`Authorization: Bearer <token>` + `X-Falda-Tenant` on every request except
`GET /healthz`. The MCP server exists as a separate process because it speaks
the MCP protocol (Streamable HTTP, tool schemas) for MCP clients like
opencode, while the gateway is a small JSON/HTTP surface for direct
programmatic callers — same auth story, different
transport and tool surface (the gateway also exposes pool-admin routes the
MCP server intentionally omits, see "Tools" below).

## Run it

```bash
cp falda_mcp_tokens.example.json falda_mcp_tokens.json
# fill in real tokens (openssl rand -hex 24), each with a tenants[] allow-list

FALDA_ROOT=~/.falda/data \
FALDA_MCP_PORT=8079 \
FALDA_MCP_TOKENS=./falda_mcp_tokens.json \
FALDA_EMBED=local \
node --import tsx src/mcp.ts
# or: npm run mcp

curl -s localhost:8079/healthz   # {"ok":true,"mcp":true}
```

MCP endpoint: `POST/GET/DELETE http://<host>:8079/mcp` (Streamable HTTP
transport, stateless — a fresh session per connection).

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
- **Why token authorizes but header selects** (rather than one-token-one-
  tenant, as the REST-facing `proxy/` uses): a single container commonly
  works across multiple projects. One token per container, one tenant header
  per project's `opencode.json`, lets that container reach every project
  it's authorized for without juggling per-project tokens.
- A `pool` tool argument is checked against the principal's `pools`
  allow-list. `pool: "self"` (the default, omitted) is always allowed.
- The token file is hot-read per request — rotating/adding a token doesn't
  require a restart. **Never commit it** (`falda_mcp_tokens.json` is
  git-ignored).

This is a routing/authorization boundary, not transport security — run the
MCP server on a private network/tailnet. It has no TLS of its own; if you
need a public-facing endpoint, terminate TLS in front of it (see
`proxy/README.md` for the pattern FALDA already uses for the REST gateway).

## Tools

All tools accept an optional `pool` argument (must be in the token's `pools`
allow-list; omit for the tenant's private `self` store).

| Tool | Tier | R/W | Description |
|---|---|---|---|
| `falda_stream_search` | T0 Stream | read | Hybrid dense+lexical search over raw turns |
| `falda_stream_query` | T0 Stream | read | List turns by session/time window |
| `falda_stream_add` | T0 Stream | write | Append raw turns (supports `turn_index`/`turn_id` for idempotency) |
| `falda_atoms_search` | T1 Atoms | read | Hybrid dense+lexical search over distilled atoms (active only, blended re-rank) |
| `falda_atoms_query` | T1 Atoms | read | List atoms by type/time window (active by default) |
| `falda_atoms_upsert` | T1 Atoms | write | Create or update metadata of a distilled atom. Content/type are immutable post-write. |
| `falda_scenes_search` | T2 Scenes | read | Hybrid dense+lexical search over scenes (episodes + topics) |
| `falda_scenes_query` | T2 Scenes | read | List scenes by kind/status |
| `falda_scenes_get` | T2 Scenes | read | Get a single scene by id |
| `falda_core_read` | T3 Core | read | Read the persona/project core document |
| `falda_distill` | — | write | Enqueue a distillation job; returns `{job_id, store_key}`. Async. |
| `falda_distill_status` | — | read | Poll a distillation job by `job_id`. |
| `falda_whoami` | — | read | Return the tenant this connection resolves to |

**Atom type enum:** `fact | pattern | preference | constraint | instruction`.
Out-of-set values are rejected as errors (no coercion).

`falda_whoami` takes no arguments (not even `pool`) and discloses **only**
the resolved tenant — never the bearer token, and never the principal's
full `tenants`/`pools` allow-lists. Use it to confirm which tenant a given
connection actually addresses (e.g. after changing a project's
`opencode.json`), not to enumerate what a token can reach.

**T2 Scenes and T3 Core are intentionally read-only over MCP for agents.**
Those tiers are populated by the in-process distillation pipeline (triggered
via `falda_distill` / `POST /distill` / an interval timer inside the
gateway), not by freehand agent edits. Pool administration
(`/pools/declare`, `/pools/grant`, ...) is likewise **not** exposed over
MCP — use the gateway's `/pools/*` routes from an internal/admin context.

## Environment

| var | meaning | default |
|---|---|---|
| `FALDA_MCP_PORT` | port to listen on | `8079` |
| `FALDA_ROOT` | pool root dir (shared with the gateway) | `./falda-data` |
| `FALDA_MCP_TOKENS` | path to token file | `./falda_mcp_tokens.json` |
| `FALDA_DIM` / `FALDA_EMBED*` | as in the gateway | — |

## opencode integration

See `integrations/opencode/README.md` for the full setup recipe (MCP config
+ auto-capture plugin) for containerized opencode agents.
