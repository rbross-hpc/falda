# Auth hardening — future work

**Status: proposed / future work. Not yet implemented.** This is a design
doc, not a changelog — nothing here has landed in `src/`. It exists to
capture a comparison of the auth approaches that now exist in the FALDA
lineage, and a menu of hardening options for the one that shipped
(`src/mcp_auth.ts`), so the analysis isn't lost as tribal knowledge.

## Background: the shared vulnerability

Before per-request auth existed, the gateway resolved tenant identity
straight from the request body:

```ts
const tenant = b.tenant ?? DEFAULT_TENANT;
```

FALDA's physical isolation — a separate SQLite file + blob dir per
`(tenant, "self")` (see `docs/POOLS.md`) — defeats *accidental* cross-tenant
leaks: there's no shared tenant-column table a forgotten `WHERE` could spill.
It does **not** defeat a *spoofed* tenant field: on any network where more
than one caller can reach the gateway (a shared multi-agent instance, a
tailnet peer, a container network), a caller can simply name someone else's
tenant and the resolver opens their store directly.

Every implementation described below fixes this the same fundamental way:
bind tenant identity to a server-side-verified credential instead of trusting
what the client claims. They differ in *where* that binding happens and
*how strong* the credential handling is.

## Three implementations in the FALDA lineage

### 1. Shipped: in-process auth (`src/mcp_auth.ts`, this repo)

- Auth lives **inside** `src/gateway.ts` and `src/mcp.ts` themselves — no
  separate process. Both servers share one `TokenStore`/`Principal` model.
- **Token → tenant is an allow-list, not a fixed binding.** A `Principal` has
  `tenants: string[]` (or `["*"]` for fully-trusted). The caller **selects**
  which tenant to address per request via the `X-Falda-Tenant` header; the
  token *authorizes* the selection rather than fixing it.
- This exists specifically because one opencode container commonly spans
  many projects — one token per container, one tenant per project's
  `opencode.json`, without provisioning a token per project.
- Covers **both** front doors: the JSON gateway and the MCP server. (The MCP
  server is the one actually exposed to agent containers in the current
  deployment — see `docs/MCP.md`.)
- Always-enforce: every route except `GET /healthz` requires a valid bearer
  token; there is no unauthenticated fallback and no default tenant.
- Boot-time fail-fast (`requireTokenFile`): refuses to start if the token
  file is missing, malformed, or empty, rather than silently 401-ing every
  request forever.
- Pool-admin routes (`/pools/*`) additionally require a fully-trusted
  (`tenants: ["*"]`) principal.
- **Tokens are stored and compared as raw plaintext strings**, hot-read from
  a JSON file per request, looked up via a plain object key
  (`tokens[bearerToken]`).

### 2. `rick-stevens-ai/falda` PR #1 (courtPNNL, "authenticating proxy")

<https://github.com/rick-stevens-ai/falda/pull/1>

- Adds a **separate reverse-proxy process**, `falda-authproxy.mjs`, that
  sits in front of an **unmodified** gateway. The gateway itself stays
  loopback-only and never faces the network; the proxy is the only outward
  listener.
- **Token → tenant is a fixed 1:1 binding.** Each token is minted for
  exactly one tenant. The proxy **overwrites** `body.tenant` with the
  token's bound tenant before forwarding, discarding whatever the client
  sent — this is what makes spoofing structurally impossible rather than
  merely rejected.
- **Tokens are stored as SHA-256 hashes only** (`0600` file); the raw token
  is shown once at mint time (`falda-authproxy-token.mjs`) and never
  persisted. Comparison uses `crypto.timingSafeEqual`.
- Pure Node stdlib, no dependencies.
- Route allowlist: only `/stream/`, `/atoms/`, `/scenes/`, `/core/`,
  `/pools/`-adjacent data routes pass through; `GET /healthz` is
  unauthenticated.
- **Opt-in and non-breaking**: existing loopback deployments are untouched;
  the proxy is only needed if you expose FALDA beyond loopback.
- **Gap for our deployment: fronts the JSON gateway only.** It does not
  cover the MCP server (`src/mcp.ts`, port 8079), which is the actual
  surface `alpha`/`beta` connect to in the current compose deployment.
- Companion PR #2 (same author, same repo) separately proposes defaulting
  the gateway's bind address to loopback (`127.0.0.1`) rather than all
  interfaces, as independent defense-in-depth.

### 3. Existing: `proxy/falda_access_proxy.py` (already in this repo)

- Predates both of the above. Same "clamp the tenant" idea, aimed at a
  narrower use case: exposing FALDA to **external demo partners** over the
  public internet.
- Adds a real network-facing control layer: **TLS termination**
  (self-signed cert), bearer-token auth, tenant clamp (identical spirit to
  Court's proxy — discard the client's claimed tenant, substitute the
  token's bound tenant), a **route allowlist** (read/append + own-pool-list
  only; pool admin stays internal), and a **per-token pool allowlist**.
- Config is a hot-read JSON file, tokens stored **as raw strings**, 1
  token → 1 tenant (`{"tenant": "crush", "pools": [...], "label": "..."}`).
- Deliberately narrow-purpose (external demo egress point on a tailnet-
  attached public VPS), not a general internal auth layer — but it
  establishes that raw-token storage plus a proxy-level clamp is already a
  precedent elsewhere in this codebase, not something introduced only by
  Court's PR.

## Comparison

| | Shipped (`mcp_auth.ts`) | Court PR #1 (proxy) | `proxy/falda_access_proxy.py` |
|---|---|---|---|
| Auth location | In-process (gateway + MCP) | Separate reverse-proxy process | Separate reverse-proxy process |
| Token → tenant | Allow-list; header selects | Fixed 1:1; body overwritten | Fixed 1:1; body overwritten |
| Secret at rest | Raw plaintext | **SHA-256 hash only** | Raw plaintext |
| Comparison | Object-key lookup | **`timingSafeEqual`** | Not constant-time |
| TLS | None (defers to front-end) | None (defers to front-end) | **Terminates TLS itself** |
| MCP server covered | **Yes** | No (gateway only) | No (gateway only) |
| Pool-admin gating | **Yes (`tenants:["*"]`)** | Not addressed | Admin routes excluded via allowlist |
| Boot fail-fast on bad token file | **Yes** | Not applicable (proxy config) | No |
| Rollout | Always-enforce (breaking) | Opt-in (non-breaking) | N/A — always was auth'd |
| Extra process to run/supervise | No | Yes | Yes |
| Multi-project-per-token | **Yes** | No | No |

## Gap analysis: what the shipped approach is missing

Ranked by how much it matters:

1. **Raw tokens in plaintext at rest.** `TokenStore.load()` parses the token
   file and indexes principals by the raw bearer string
   (`tokens[bearerToken]`, `src/mcp_auth.ts`). If the token file leaks
   (backup, misconfigured volume mount, log capture, etc.), every token in
   it is immediately usable — no further compromise needed. Court's
   hash-only storage means a leaked file yields nothing usable directly.
2. **Non-constant-time token comparison.** Plain object-key lookup can, in
   principle, leak timing information about how much of a candidate token
   matches a real one. This is a weaker vector over a network with JSON
   parsing and JS object hashing in between, but it's a real gap that costs
   nothing to close.
3. **No loopback-default bind.** Both `gateway.ts` and `mcp.ts` call
   `.listen(PORT, ...)` with no host argument, so Node binds all interfaces
   (`0.0.0.0`) inside the container. The current deployment is safe only
   because `docker-compose` publishes the port as `127.0.0.1:8079:8079` —
   i.e., safety is an *external* deployment convention, not something the
   server itself defends. A misconfigured compose file (bare `"8079:8079"`)
   would silently expose it. Court's PR #2 addresses the equivalent gap on
   the gateway.
4. **No TLS.** Documented as an explicit non-goal in `docs/MCP.md` (auth is
   an authorization boundary, not transport security); tokens and payloads
   cross the wire in cleartext. Acceptable on a private compose network or
   loopback, not over anything untrusted. `proxy/falda_access_proxy.py`
   already has a TLS-terminating pattern in this repo if a public-facing
   need arises.

## Proposed hardening options

Each option is independent and separately adoptable — this is a menu, not a
sequence that must be taken as a whole.

### Option A — Hash tokens at rest (highest value, highest migration cost)

Store only a SHA-256 (or similar) hash of each token in the token file;
`TokenStore.authenticate` hashes the presented bearer and looks up the hash
instead of the raw string. Mirrors Court's `falda-authproxy-token.mjs`
mint-once pattern: a small CLI prints the raw token once at creation time
and persists only the hash.

**Migration cost:** this is a breaking change to the token file format. It
would invalidate:
- The deployed `tokens.json`, per
  `docker-setups/stacks/alpha-beta/compose.yaml`.
- `falda_tokens.example.json`.
- Anyone who has hand-authored a token file per the current documented
  shape (`{"tokens": {"<raw-token>": {...}}}`).

Two rollout shapes to choose between if this is picked up:
- **Hard cutover**: ship a `falda-mint-token` CLI, require re-minting all
  tokens, document the break in `docs/MCP.md`/`docs/API.md` as a breaking
  change.
- **Dual-accept transition window**: `TokenStore.load()` accepts both a raw
  string key and a `{hash: "..."}` entry shape for one release, logging a
  deprecation warning on raw-string principals, before removing raw support.

### Option B — Constant-time comparison (low cost, no migration)

Adopt `crypto.timingSafeEqual` for the token comparison. Composes naturally
with Option A (compare hashes, not raw tokens, in constant time). Can be
shipped alone first with no format change: iterate the token map and compare
each candidate key to the presented token with `timingSafeEqual` instead of
relying on object-key equality. No token file format change, no migration.

### Option C — Loopback-default bind (low cost, no migration)

Add `FALDA_MCP_BIND` / `FALDA_BIND` env vars (default `127.0.0.1`) and pass
the resolved host into `.listen(PORT, HOST, ...)` in both `src/gateway.ts`
and `src/mcp.ts`. Defense-in-depth: the current compose deployment already
publishes on loopback only, so this changes nothing there, but it protects
any deployment that runs these processes directly on a host (no compose
port-publish layer to rely on) or any future compose file that forgets the
`127.0.0.1:` prefix. Mirrors Court's PR #2 intent for the gateway; would
extend the same default to the MCP server.

### Option D — Stronger caller identity (mTLS), deferred

Court's PR notes bearer tokens are "a pragmatic first factor" and that
mTLS (client-cert → tenant/principal) fits the same overwrite/bind model if
stronger caller identity is needed later. `proxy/falda_access_proxy.py`
already establishes a TLS-termination pattern in this repo. Not proposed for
near-term work; noted here so it isn't reinvented from scratch if the need
arises (e.g., a genuinely public-facing deployment beyond the existing
`proxy/` external-demo use case).

## Suggested sequencing, if pursued

1. **B (constant-time compare)** and **C (loopback-default bind)** first —
   independent, no migration, no breaking change, cheap to review and land.
2. **A (hash tokens at rest)** as a separate, deliberately-scoped follow-up,
   specifically because it requires a mint tool and a migration decision
   (hard cutover vs. dual-accept) that deserves its own review rather than
   riding alongside B/C.
3. **D (mTLS)** stays parked until there's an actual public-facing
   deployment need beyond what `proxy/falda_access_proxy.py` already serves.

## Non-goals (kept explicitly out of scope here, per Court's PR #1)

- Provenance fields on stored records.
- An append-only event log.
- Tombstones / supersession semantics.
- Export tooling.

These are store-layer concerns unrelated to the auth boundary and are called
out only to keep this document's scope bounded.

## Open questions

- If Option A is picked up: hard cutover or a dual-accept transition window?
  Hard cutover is simpler to reason about and test; dual-accept is kinder to
  anyone who already has a hand-rolled token file deployed outside this
  repo's own `docker-setups` usage.
- Should the three auth surfaces that now exist in the FALDA lineage
  (in-process `mcp_auth.ts`, Court's standalone proxy, the pre-existing
  `proxy/falda_access_proxy.py`) stay layered/independent as they are today,
  or should the standalone-proxy pattern be retired in favor of always
  using the in-process model now that it also fronts the MCP server? No
  action proposed here either way — flagging it as a question for whoever
  picks this up next.
