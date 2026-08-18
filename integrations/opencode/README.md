# Connecting opencode to FALDA

opencode consumes external tools via [MCP servers](https://opencode.ai/docs/mcp-servers/)
and extends its behavior via [plugins](https://opencode.ai/docs/plugins/).
FALDA ships both halves of the integration:

| Piece | What it does | Where |
|---|---|---|
| **MCP endpoint** | Recall/remember/forget/distill tools (`falda_*`) the model calls directly | one facet of `falda serve` (`src/server.ts`), backed by `src/mcp.ts` |
| **Capture plugin** | Auto-logs every turn to FALDA's Stream (T0), no tool call needed; also fires one small auto-recall per session before the model's first turn | `integrations/opencode/plugin/falda-capture.ts` |

`falda serve` is the recommended way to run FALDA for this integration: one
process exposes the MCP endpoint (port `8079`, above) *and* the HTTP/JSON
API (port `8077` — pool admin, `/distill`, and the recall-trace inspection
routes in `docs/RECALL_TRACES.md`) *and* the background distillation worker,
sharing one token file and one embedder. See "Why not the JSON gateway
directly?" below for why agents specifically use the MCP surface.

This is designed for **one FALDA deployment serving many containerized
opencode agents**, where a single container may work across **several
projects** (each project = a different FALDA tenant). **Tenants are scoped
per project, not per agent/container** — the tenant a container's memory
tools address is whatever `X-Falda-Tenant` is set in the *project's own*
`opencode.json` (see "Per-project opencode config" below), not something
fixed for the whole container.

## One server, two protocol surfaces

`falda serve` runs the HTTP/JSON API (`src/gateway.ts`, port `8077`) and the
MCP endpoint (`src/mcp.ts`, port `8079`) in one process, against one shared
`TokenStore`: both require `Authorization: Bearer <token>` and both SELECT
the addressed tenant via the `X-Falda-Tenant` header (the token only
*authorizes* which tenants it may select — see "Auth model" below). Neither
surface trusts a tenant claim from the request body. Auth is identical
either way; the surfaces differ in what they expose:

- **MCP** (what this integration uses) — the compact, intention-level
  `falda_*` tool set (`falda_recall`, `falda_remember`, `falda_forget`,
  `falda_distill`, `falda_distill_status`, `falda_whoami`, plus
  `falda_stream_add` for the capture plugin below) — see `docs/MCP.md`.
  opencode (and other MCP clients) get typed tool schemas for free.
- **HTTP/JSON** — the same tier-level operations as low-level routes, plus
  pool administration (`/pools/*`) and recall-trace inspection/usage
  reporting (`/recall/usage`, `/recalls/get`, `/recalls/metrics` —
  `docs/RECALL_TRACES.md`) that are deliberately **not** exposed over MCP.
  Used for admin/debug and for harness-level usage reporting, not by the
  model.

Both stay off the public internet — no TLS/rate-limiting of their own; bind
to a private network/tailnet or Compose-internal network (terminate TLS in
front with a standard reverse proxy, e.g. nginx or Caddy, if you need a
public-facing front door).

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
cp falda_tokens.example.json falda_tokens.json
#   -> fill in real tokens (e.g. `openssl rand -hex 24`), each with its
#      tenants[] allow-list (and pools[] if it should reach shared pools)
#   this one file is canonical — shared by the HTTP API and the MCP endpoint

FALDA_ROOT=~/.falda/data \
FALDA_TOKENS=./falda_tokens.json \
FALDA_EMBED=local \            # or remote; see docs/INSTALL.md
falda serve                    # or: node --import tsx src/server.ts

curl -s localhost:8077/healthz   # HTTP API
curl -s localhost:8079/healthz   # {"ok":true,"mcp":true}
```

## 2b. Docker / Compose (many containerized opencode agents, one FALDA)

For the "one FALDA instance behind several containerized opencode agents"
deployment this whole integration targets, run FALDA as another service on
the same Compose network as the agents rather than by hand. This repo ships
a `Dockerfile` (multi-stage: builds `better-sqlite3` + TypeScript, then a
slim `node:24-trixie-slim` runtime) at the repo root, running `falda serve`
(`node dist/server.js`) by default — one process, both protocol surfaces,
the distillation worker, and recall-trace pruning.

Add a `falda` service to your agents' `docker-compose.yml`, alongside
whatever LLM-proxy/other shared services they already depend on:

```yaml
services:
  falda:
    build:
      context: /path/to/falda        # a checkout of this repo
    image: local/falda:latest
    hostname: falda
    restart: unless-stopped
    init: true
    environment:
      FALDA_ROOT: /data
      FALDA_PORT: "8077"
      FALDA_MCP_PORT: "8079"
      FALDA_TOKENS: /run/falda/tokens.json
      FALDA_EMBED: local             # see "Embeddings" below to use a real model
      FALDA_DIM: "768"              # MUST match FALDA_EMBED_MODEL's real dim; see "Embeddings" (a mismatch refuses to boot — enforceEmbeddingLock)
      # Distillation (T0->T1->T2->T3) — any OpenAI-compatible chat model,
      # decoupled from whatever model the agents themselves use:
      FALDA_LLM_BASE_URL: "https://your-llm-proxy/v1"
      FALDA_LLM_API_KEY: "${YOUR_LLM_API_KEY}"
      FALDA_LLM_MODEL: "gpt-4.1-mini"
      FALDA_WORKER_INTERVAL_MS: "900000"   # 15 min; auto-enqueues every self-store
    volumes:
      - falda-data:/data                                  # persistent store
      - /path/to/falda_tokens.json:/run/falda/tokens.json:ro # secret, host-only
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
  up`, e.g. `cp falda_tokens.example.json /path/to/falda_tokens.json` then
  fill in a real `openssl rand -hex 24` token. It's bind-mounted read-only,
  so rotating it is just editing the host file — no rebuild. This one file
  authenticates both the MCP endpoint and the HTTP API.
- **Agents reach FALDA by service name**: `http://falda:8079/mcp`, the same
  way they'd reach any other shared service (e.g. an LLM proxy) on the
  Compose network. No host port needs to be published for agents to work;
  publishing `127.0.0.1:8077:8077` (and/or `:8079`) is only useful for
  host-side debugging (`curl`ing `/healthz`, `/recalls/metrics`, triggering
  an out-of-cycle `/distill`).
- **Persistent store**: `falda-data` is a named volume for `FALDA_ROOT`, so
  atoms/stream/scenes/core survive `docker compose down`/image rebuilds —
  along with `distill_queue.db` and `recall_traces.db` (recall-trace
  telemetry, pruned on its own retention schedule; see
  `docs/RECALL_TRACES.md`). Use `docker compose down -v` only if you intend
  to wipe memory (and telemetry) entirely.
- **Distillation runs in this same container** — there is no separate
  gateway/worker service to bring up. The worker auto-enqueues every
  self-store it finds on disk on each `FALDA_WORKER_INTERVAL_MS` tick and
  drains the shared queue with `FALDA_LLM_*`. Tail `docker compose logs -f
  falda` and confirm a clean `[falda-worker] enqueued ... / pass ...` cycle
  before leaving it running unattended — see the README's "Distillation"
  section in a downstream Compose repo (e.g. `docker-setups`) for the log
  shapes to expect.
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
  One concrete example (not a requirement — any OpenAI-compatible embedding
  endpoint works): a `Qwen3-Embedding-0.6B` served by such a proxy uses
  `FALDA_EMBED_MODEL: Qwen3-Embedding-0.6B` and `FALDA_DIM: "1024"` — note
  that's *not* the `768` default set above, which is exactly the mismatch
  `enforceEmbeddingLock` will refuse to boot with if `FALDA_DIM` isn't
  updated to match when switching models.
  The embedding-lock manifest (`EMBEDDING.json`, written into `/data` on
  first boot) pins model+dim for that store — changing them later requires
  re-embedding, not just a config edit.
- **Build context**: the Dockerfile only needs `package.json`,
  `package-lock.json`, `tsconfig.json`, and `src/` (see `.dockerignore`);
  it does not need `docs/`, `test/`, `integrations/`, or the Python
  distiller.
- **`command:` override**: the image's default `CMD` is `node dist/server.js`
  (`falda serve`, both ports + worker). Pass `command: ["node",
  "dist/server.js", "--no-mcp"]` if you only want the HTTP API + worker in a
  given service (rare — MCP is what agents actually use).

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
`falda_tokens.json`) includes both.

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

**Auto-recall** is a second, independent feature of the same plugin: once
per session, before the model's first turn, it fires a small `falda_recall`
(`mode: "auto"` — a smaller default budget than an explicit call, see
`FALDA_AUTO_RECALL_BUDGET` in `docs/MCP.md`) and injects the result into
that first user message, wrapped in a `<falda-auto-recall>` block so the
model can tell it apart from its own tool calls. It never blocks the turn
— a 5s timeout or any failure just means nothing gets injected, silently.
Set `FALDA_AUTO_RECALL=0` to disable it independently of `FALDA_CAPTURE`.
The model is still expected to call `falda_recall` itself for anything the
auto-recall's smaller budget didn't surface (see `AGENTS.md.snippet`).

**Auto-distill** is a third, independent feature of the same plugin: it
fires one `falda_distill` (fire-and-forget, no args) on opencode's
`experimental.session.compacting` hook, which runs *before* opencode
generates a compaction's continuation summary. Because distillation reads
from the FALDA Stream (T0) that auto-capture has already persisted
server-side, triggering it here — rather than after compaction — lets the
async distill job run concurrently with the summary generation instead of
strictly after it. It never blocks or fails the compaction — a 5s timeout
or any failure is logged and swallowed. Set `FALDA_DISTILL_ON_COMPACT=0` to
disable it independently of `FALDA_CAPTURE`/`FALDA_AUTO_RECALL`. Because
this relies on an `experimental.*` opencode hook that may change across
versions, it's a latency optimization on top of the periodic background
distillation worker (`FALDA_WORKER_INTERVAL_MS`), not a replacement for it.

**Post-compaction recall** is a fourth, independent feature of the same
plugin: a compaction's summary can drop detail that FALDA's Stream (T0)
still has durably, so the plugin fires one additional `falda_recall`
(`mode: "auto"`) on the **first real user message after a session
compacts**, reusing the same `<falda-auto-recall>` injection the model
already recognizes from the first-turn auto-recall above. It uses opencode's
stable `session.compacted` event to mark the session, then fires on the
next `chat.message` — it deliberately does *not* fire on opencode's
synthetic auto-continue turn ("Continue if you have next steps..."),
because that turn is injected directly by opencode's compaction internals
and never reaches the `chat.message` hook at all, so the next `chat.message`
observed after a compaction is already the user's real next message. Never
blocks the turn — same 5s-timeout/log-and-swallow discipline as the other
features. Set `FALDA_RECALL_ON_COMPACT=0` to disable it independently of
`FALDA_AUTO_RECALL`/`FALDA_DISTILL_ON_COMPACT`. It's forced off whenever
`FALDA_CAPTURE=0`, regardless of `FALDA_RECALL_ON_COMPACT` — it only makes
sense if auto-capture is writing this session's turns to the Stream it
re-queries. Because the model already understands `<falda-auto-recall>`
blocks generically (see `AGENTS.md.snippet`), no snippet change is needed
for this feature.

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
curl -s localhost:8077/pools/declare \
  -H "Authorization: Bearer <fully-trusted-token>" -d '{
  "name": "shared-corpus",
  "members": {"proj-a": "readwrite", "proj-b": "read"},
  "description": "facts both projects contribute to / read"
}'
```

Then pass `pool: "shared-corpus"` as an argument to any `falda_*` tool from
an authorized project. Private (`self`) memory stays the default and is
always physically isolated per tenant — see `docs/POOLS.md`.

## 6. Tool reference

See `docs/MCP.md` for the full tool table. By default the model sees a
compact set — `falda_recall`, `falda_remember`, `falda_forget`,
`falda_distill`, `falda_distill_status`, `falda_whoami` — plus
`falda_stream_add` for the capture plugin's own use. Set
`FALDA_MCP_TOOLSET=full` on the server to also expose the tier-specific
tools (`falda_atoms_search`, `falda_scenes_search`, ...) for debugging;
Scenes and Core stay read-only in either toolset, curated by the
distillation pipeline.

## Checklist for setting up a new project's tenant

Tenants are per-project, not per-container/agent — do this once for each
project you want FALDA memory for:

1. Choose a tenant id for the project (e.g. the project's slug — doesn't
   need to match its directory name, but that's a reasonable default).
2. Add that tenant id to the `tenants[]` allow-list of whichever bearer
   token this container/host uses, in `falda_tokens.json` (one
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
