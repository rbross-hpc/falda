# Connecting opencode to FALDA

opencode consumes external tools via [MCP servers](https://opencode.ai/docs/mcp-servers/)
and extends its behavior via [plugins](https://opencode.ai/docs/plugins/).
FALDA ships both halves of the integration:

| Piece | What it does | Where |
|---|---|---|
| **MCP server** | Recall + write tools (`falda_*`) the model calls directly | `src/mcp.ts` (this repo) |
| **Capture plugin** | Auto-logs every turn to FALDA's Stream (T0), no tool call needed | `integrations/opencode/plugin/falda-capture.ts` |

This is designed for **one FALDA deployment serving many containerized
opencode agents**, where a single container may work across **several
projects** (each project = a different FALDA tenant).

## Why not the JSON gateway directly?

The FALDA gateway (`src/gateway.ts`, port `8077`/`8078`) trusts a `tenant`
field straight from the request body — fine on a private loopback/tailnet
(see `docs/POOLS.md`), but not safe to expose to many containers over a
shared network, since any caller could claim any tenant. The MCP server adds
**token-based auth** for exactly that case — see `docs/MCP.md`.

## 1. Auth model in one paragraph

A **bearer token** identifies a *principal* (typically: one opencode
container/host). Each principal has an explicit `tenants` allow-list (or
`["*"]` for a fully-trusted principal). The **`X-Falda-Tenant` header
selects** which tenant a given request addresses; the token must authorize
that tenant. This split — token authorizes, header selects — is what lets one
container/token drive multiple projects: each project's `opencode.json` sets
the same token but a different `X-Falda-Tenant`.

## 2. Server-side setup (once per FALDA deployment)

```bash
# from a checkout of this repo
cp falda_mcp_tokens.example.json falda_mcp_tokens.json
#   -> fill in real tokens (e.g. `openssl rand -hex 24`), each with its
#      tenants[] allow-list (and pools[] if it should reach shared pools)

FALDA_ROOT=~/.falda/data \
FALDA_MCP_PORT=8079 \
FALDA_MCP_TOKENS=./falda_mcp_tokens.json \
FALDA_EMBED=local \            # or remote; see docs/INSTALL.md
node --import tsx src/mcp.ts

curl -s localhost:8079/healthz   # {"ok":true,"mcp":true}
```

Keep the MCP server off the public internet (no TLS/rate-limiting of its
own) — bind to a private network/tailnet, same posture as the gateway
(see `proxy/README.md` if you need a public-facing front door with TLS).

## 3. Per-project opencode config

Copy `opencode.json.example` into each project's `opencode.json` (merge with
any existing config), filling in that container's token and that project's
tenant:

```jsonc
{
  "mcp": {
    "falda": {
      "type": "remote",
      "url": "http://falda-host:8079/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer <this-container's-token>",
        "X-Falda-Tenant": "<this-project's-tenant>"
      }
    }
  }
}
```

Two projects in the same container reuse the same token but set a different
`X-Falda-Tenant` — as long as the token's `tenants` allow-list (in
`falda_mcp_tokens.json`) includes both.

Add `AGENTS.md.snippet`'s contents to the project's `AGENTS.md` so the model
knows to use the `falda_*` tools for recall.

## 4. Auto-capture plugin (optional but recommended)

Copy the plugin and give it a `package.json` for its MCP client dependency:

```bash
mkdir -p .opencode/plugins
cp path/to/falda/integrations/opencode/plugin/falda-capture.ts .opencode/plugins/
cp path/to/falda/integrations/opencode/package.json.example .opencode/package.json
```

Set matching env vars (same token/tenant as the MCP config above) wherever
the opencode process runs:

```bash
FALDA_MCP_URL=http://falda-host:8079/mcp
FALDA_MCP_TOKEN=<this-container's-token>
FALDA_TENANT=<this-project's-tenant>
```

Set `FALDA_CAPTURE=0` to disable capture without removing the plugin.

## 5. Shared pools across projects/agents

If two projects/agents should share a slice of memory, declare a pool on the
FALDA side (admin-only — not exposed over MCP) and add it to each
authorized token's `pools` allow-list:

```bash
curl -s localhost:8078/pools/declare -d '{
  "name": "shared-corpus",
  "members": {"proj-a": "readwrite", "proj-b": "read"},
  "description": "facts both projects contribute to / read"
}'
```

Then pass `pool: "shared-corpus"` as an argument to any `falda_*` tool from
an authorized project. Private (`self`) memory stays the default and is
always physically isolated per tenant — see `docs/POOLS.md`.

## 6. Tool reference

See `docs/MCP.md` for the full tool table (recall/read across all four
tiers; write for Stream + Atoms only — Scenes and Core stay read-only,
curated by the distillation pipeline).

## Checklist for a new opencode deployment

1. Choose a tenant id per project (not per container — one container’s token
   may span several tenants).
2. Issue (or reuse) a bearer token for the container; add its tenant(s) to
   `falda_mcp_tokens.json`.
3. Point `opencode.json`'s `mcp.falda` at the FALDA MCP server with that
   token + tenant header.
4. Add the capture plugin if you want automatic turn logging.
5. If sharing memory across projects, declare a pool and grant access.
6. Keep the MCP server off the public internet.
