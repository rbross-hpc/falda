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

> **Containerized deployments:** see §4b below for the entrypoint-based
> auto-install pattern, dependency version tracking, and startup-deadlock
> hazard notes that apply when the plugin is installed via a container image.

## 4b. Automated install via a container entrypoint (optional)

For "one FALDA instance behind many containerized opencode agents" setups,
it's cleaner to have the container entrypoint wire up FALDA automatically
at each start rather than copying the plugin manually per project.
`integrations/opencode/entrypoint.sh.example` is a ready-to-adapt reference
implementation. The pattern has two steps:

1. **Copy the capture plugin** from a mounted FALDA checkout into
   `~/.config/opencode/plugins/` on every container start (so the plugin
   always tracks whatever checkout is mounted — no image rebuild needed to
   pick up plugin changes).

2. **Write a global fallback `mcp.falda` config** from
   `FALDA_MCP_URL`/`FALDA_MCP_TOKEN`/`FALDA_TENANT` into
   `~/.config/opencode/opencode.json`, **only if one doesn't already
   exist**. This is a fallback default only — a project's own
   `opencode.json` (with that project's own `X-Falda-Tenant`) overrides
   it, because opencode merges global + project config.

Both steps are best-effort and silently skip if their inputs are absent.

### Minimal Dockerfile wiring

```dockerfile
# Install opencode globally
RUN npm install -g opencode-ai

# Bake in the plugin's npm deps so opencode's bun install can resolve them
# at startup (see opencode-deps.package.json.example for the contents and
# version-tracking note)
COPY opencode-deps.package.json /home/node/.config/opencode/package.json

# Install and register the entrypoint
COPY entrypoint.sh /usr/local/bin/falda-entrypoint
RUN chmod +x /usr/local/bin/falda-entrypoint

ENTRYPOINT ["falda-entrypoint"]
CMD ["bash"]
```

At runtime, bind-mount the FALDA checkout and set `FALDA_PLUGIN_SRC` to
its `integrations/opencode/plugin/falda-capture.ts` path inside the
container, or set `FALDA_PLUGIN_SRC` in the environment if your mount path
differs from the default in `entrypoint.sh.example`.

### Per-project opencode.json must be the full mcp.falda block

> **opencode does not deep-merge `mcp.<name>.headers`.** A per-project
> `opencode.json` that sets only `X-Falda-Tenant` (hoping to inherit `url`
> and `Authorization` from the global config) will silently keep the global
> config's tenant instead — recall and capture would then diverge with no
> error. Always include the complete block in each project's config:
>
> ```jsonc
> "mcp": {
>   "falda": {
>     "type": "remote",
>     "url": "http://falda:8079/mcp",
>     "enabled": true,
>     "headers": {
>       "Authorization": "Bearer <token>",
>       "X-Falda-Tenant": "<this-project's-tenant>"
>     }
>   }
> }
> ```
>
> Verified with `opencode debug config --pure` (scalar keys like `enabled`
> do override; nested `headers` objects do not merge).

To avoid copying the raw bearer token into every project config, see the
`{file:...}` token de-duplication option commented out in
`entrypoint.sh.example`.

### Startup-deadlock hazard

> **The capture plugin factory must never block during opencode startup.**
> opencode `await`s every plugin's factory function before finishing
> bootstrap. If the factory calls back into the opencode server (e.g.
> `client.config.get(...)`) before returning its hooks, the server can't
> answer while it's still blocked loading plugins — circular wait, silent
> hang, no error logged. This was the original bug fixed in
> `plugin/falda-capture.ts` (see the "Lazy resolution" doc comment). Any
> future edits to the plugin factory must not re-introduce an `await` of
> server calls at the top level.

### Dependency version tracking and persistent-volume caveats

The plugin's npm deps (`@opencode-ai/plugin`, `@modelcontextprotocol/sdk`)
are declared in a `package.json` baked into the image (see
`opencode-deps.package.json.example`); opencode runs `bun install` at
startup to install them into `~/.config/opencode/node_modules/`.

**Keep `@opencode-ai/plugin` in sync with the installed opencode version.**
The plugin SDK and the opencode runtime are versioned together; a large
mismatch can surface subtle API differences.

**If `~/.config/opencode/` lives on a persistent volume** (common in
long-lived named-volume setups so sessions/config survive container
restarts), the `bun.lock`/`node_modules` cached there from the previous
start won't automatically pick up a version bump in the image's
`package.json`. After bumping the version, clear the stale lock on each
agent's home volume before restarting:

```bash
docker compose exec <agent> \
  bash -lc 'rm -rf ~/.config/opencode/{bun.lock,node_modules}'
```

Then restart the container so opencode re-runs `bun install` against the
updated `package.json`.

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
