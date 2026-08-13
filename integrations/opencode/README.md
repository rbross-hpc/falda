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
projects** (each project = a different FALDA tenant). **Tenants are scoped
per project, not per agent/container** — the tenant a container's memory
tools address is whatever `X-Falda-Tenant` is set in the *project's own*
`opencode.json` (see "Per-project opencode config" below), not something
fixed for the whole container.

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

## 2b. Docker / Compose (many containerized opencode agents, one FALDA)

For the "one FALDA instance behind several containerized opencode agents"
deployment this whole integration targets, run FALDA as another service on
the same Compose network as the agents rather than by hand. This repo ships
a `Dockerfile` (multi-stage: builds `better-sqlite3` + TypeScript, then a
slim `node:24-trixie-slim` runtime running `node dist/mcp.js`) at the repo
root, purpose-built for the MCP server (not the gateway).

Add a `falda` service to your agents' `docker-compose.yml`, alongside
whatever LLM-proxy/other shared services they already depend on:

```yaml
services:
  falda:
    build:
      context: /path/to/falda        # a checkout of this repo
    image: local/falda-mcp:latest
    hostname: falda
    restart: unless-stopped
    init: true
    environment:
      FALDA_ROOT: /data
      FALDA_MCP_PORT: "8079"
      FALDA_MCP_TOKENS: /run/falda/tokens.json
      FALDA_EMBED: local             # see "Embeddings" below to use a real model
      FALDA_DIM: "768"
    volumes:
      - falda-data:/data                                       # persistent store
      - /path/to/falda_mcp_tokens.json:/run/falda/tokens.json:ro # secret, host-only
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:8079/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 10s
      timeout: 3s
      retries: 5

  your-agent:
    # ...
    depends_on:
      falda:
        condition: service_healthy

volumes:
  falda-data:
```

Notes:

- **Create the token file on the host first** — it is never baked into the
  image (`.dockerignore` excludes it) and must exist before `docker compose
  up`, e.g. `cp falda_mcp_tokens.example.json /path/to/falda_mcp_tokens.json`
  then fill in a real `openssl rand -hex 24` token. It's bind-mounted
  read-only, so rotating it is just editing the host file — no rebuild.
- **Agents reach FALDA by service name**: `http://falda:8079/mcp`, the same
  way they'd reach any other shared service (e.g. an LLM proxy) on the
  Compose network — no host port needs to be published.
- **Persistent store**: `falda-data` is a named volume for `FALDA_ROOT`, so
  atoms/stream survive `docker compose down`/image rebuilds. Use `docker
  compose down -v` only if you intend to wipe memory.
- **Embeddings**: starts as `FALDA_EMBED=local` (deterministic, offline,
  weak recall — fine to confirm wiring). To use a real embedding model
  served by something else on the Compose network (e.g. an existing
  OpenAI-compatible proxy), first confirm it actually serves
  `/v1/embeddings`:
  ```bash
  docker compose exec falda node -e "fetch('http://<proxy-service>:<port>/v1/embeddings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'<model-id>',input:'hi'})}).then(r=>r.text()).then(console.log)"
  ```
  If that returns a vector, switch to:
  ```yaml
      FALDA_EMBED: remote
      FALDA_EMBED_BASE_URL: http://<proxy-service>:<port>/v1
      FALDA_EMBED_MODEL: <model-id>
      FALDA_DIM: "<model-dim>"        # must match the model exactly
  ```
  The embedding-lock manifest (`EMBEDDING.json`, written into `/data` on
  first boot) pins model+dim for that store — changing them later requires
  re-embedding, not just a config edit.
- **Build context**: the Dockerfile only needs `package.json`,
  `package-lock.json`, `tsconfig.json`, and `src/` (see `.dockerignore`);
  it does not need `docs/`, `test/`, `integrations/`, or the Python
  distiller.

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

The plugin reads this project's *resolved* `opencode.json` at startup and
reuses whatever `mcp.falda.headers` (`Authorization`, `X-Falda-Tenant`) and
`url` you set in step 3 above — no separate credential and no risk of
capture writing to a different tenant than recall reads from. Nothing else
to configure per project.

If you're running the plugin outside a full opencode project (no
`opencode.json` resolves for it at all), it falls back to
`FALDA_MCP_URL`/`FALDA_MCP_TOKEN`/`FALDA_TENANT` env vars instead.

Set `FALDA_CAPTURE=0` to disable capture without removing the plugin.

> **Version tracking (containerized deployments).** If you're installing
> this plugin via a container image that bakes in a `package.json` for its
> deps (as the `argo-oc` image in a `docker-setups`-style deployment
> does), keep the pinned `@opencode-ai/plugin` version in sync with the
> installed `opencode` version, and remember that a running container's
> `~/.config/opencode/{bun.lock,node_modules}` won't pick up a bump on
> their own if they live on a persistent volume — see that deployment
> repo's README ("What's built-in vs. what you still configure") for the
> full explanation and the fix. This matters here specifically because the
> plugin factory is `await`ed by opencode during startup: it must never
> block on a call back into the opencode server before returning its
> hooks (see the "Lazy resolution" note in `plugin/falda-capture.ts`) or
> the agent hangs on startup with no error logged.

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

## Checklist for setting up a new project's tenant

Tenants are per-project, not per-container/agent — do this once for each
project you want FALDA memory for:

1. Choose a tenant id for the project (e.g. the project's slug — doesn't
   need to match its directory name, but that's a reasonable default).
2. Add that tenant id to the `tenants[]` allow-list of whichever bearer
   token this container/host uses, in `falda_mcp_tokens.json` (one
   container's token commonly spans several projects/tenants).
3. Add/merge `opencode.json` in the *project's own directory* (not the
   global config) with `mcp.falda` pointing at the FALDA MCP server, that
   token, and that tenant (see "Per-project opencode config" above; service
   name if running in Compose, e.g. `http://falda:8079/mcp`). This is the
   single source of truth both recall tools and the capture plugin use.
4. Add the capture plugin to the project if you want automatic turn
   logging — it picks up the same tenant from step 3 automatically.
5. If sharing memory across projects, declare a pool and grant access.
6. Keep the MCP server off the public internet.

A container with no per-project `opencode.json` falls back to whatever
tenant its *global* `~/.config/opencode/opencode.json` sets (if any) — treat
that as a default, not a substitute for giving each real project its own
tenant.
