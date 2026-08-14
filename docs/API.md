# FALDA API

All routes are `POST` with a JSON body and JSON response, except `/healthz` (`GET`).
Default port: `8077` (`FALDA_PORT`). Served by `falda serve` (recommended —
runs alongside the MCP endpoint from one shared runtime, see `docs/MCP.md`)
or the standalone `falda gateway` legacy entry point (HTTP API only, no MCP).

## Authentication

Every route below requires `Authorization: Bearer <token>` **except**
`GET /healthz`, which is intentionally unauthenticated (used for liveness
checks). Auth uses the same token-file/principal model as the MCP server
(`docs/MCP.md`) — see that doc's "Auth model" section for the full token
file shape and rationale; the short version:

| Header | Meaning |
|---|---|
| `Authorization: Bearer <token>` | Identifies a **principal**. Unknown/missing token → `401`. |
| `X-Falda-Tenant: <tenant>` | **Selects** which tenant this request addresses. Missing, or outside the principal's `tenants` allow-list → `403`. There is no default tenant. |

The `tenant` field in request bodies below is **not used for addressing** —
tenant selection is header-only. `pool` (where shown) is still a body field,
checked against the principal's `pools` allow-list (`self`/omitted is always
allowed).

Pool-admin routes (`/pools/*`) are cross-tenant management operations and
require a fully-trusted principal (`tenants: ["*"]`) regardless of
`X-Falda-Tenant`; any other principal gets `403`.

The server refuses to boot if `FALDA_TOKENS` doesn't point at a valid,
non-empty token file (fail-fast — see `docs/POOLS.md` "Environment").
`FALDA_TOKENS` is the **one canonical token file, shared by the HTTP API
and the MCP endpoint** — both authenticate against the same `TokenStore`
(`src/runtime.ts` builds it once; `falda serve` hands the same instance to
both protocol adapters). Auth is defense-in-depth on top of whatever
network exposure you choose (e.g. binding to localhost); it does not itself
change where the server listens.

## Tier T0 — Stream

### `POST /stream/add`
```json
{
  "session_id": "sess-1",
  "messages": [
    { "role": "user", "content": "...", "turn_index": 1, "turn_id": "optional-idempotency-token" }
  ]
}
```
→ `{ "accepted_ids": ["..."], "total_count": 1 }`

`turn_index` and `turn_id` are optional. When supplied, two partial unique
indexes enforce idempotency:
- Identical `(session_id, turn_index, content)` → no-op, returns existing id.
- Same `turn_index` with different content → `409 Conflict` (`index_conflict`).
- Same `turn_id` at a different `turn_index` → `409 Conflict` (`turn_id_conflict`).

### `POST /stream/query`
```json
{ "session_id": "sess-1", "limit": 50, "offset": 0, "time_start": "...", "time_end": "..." }
```
→ `{ "messages": [ { "id", "session_id", "role", "content", "timestamp", "turn_index", "turn_id" } ], "total": 42 }`

Ordering: `(session_id, turn_index)` when `turn_index` is present, else `ts`.

### `POST /stream/search`  (hybrid dense + lexical)
```json
{ "query": "neutron detector energy", "limit": 10 }
```
→ `{ "messages": [ { ...turn fields, "score" } ] }`

### `POST /stream/delete`
```json
{ "ids": ["..."] }            // or { "session_id": "sess-1" }
```
→ `{ "deleted_count": 3, "affected_atom_ids": ["..."] }`

Returns the atom ids whose provenance evidence was affected by the deletion.
The atoms themselves are not auto-deleted; the caller may choose to
re-evaluate or archive them.

## Tier T1 — Atoms

Atom types: `fact | pattern | preference | constraint | instruction`.
Out-of-set types are rejected with `400`. Content and type are **immutable**
once written — changing either on an existing id is rejected with `409`
(`AtomImmutabilityError`). To update a proposition, record a new atom.

### `POST /atoms/upsert`
```json
{
  "id": "optional",
  "type": "fact",
  "content": "...",
  "background": "optional free-text context",
  "priority": 50,
  "confidence": "high",
  "pinned": false,
  "tags": ["verified"]
}
```
→ full Atom object (all fields)

### `POST /atoms/query`
```json
{ "type": "fact", "status": "active", "limit": 50, "offset": 0 }
```
→ `{ "items": [ Atom ], "total": 10 }` (default: `status=active` only)

### `POST /atoms/search`  (hybrid dense + lexical, with re-rank)
```json
{ "query": "what temperature is the cryostat?", "limit": 10 }
```
→ `{ "items": [ { ...Atom, "score" } ] }` (active atoms only; blended re-rank)

### `POST /atoms/delete`
```json
{ "ids": ["..."] }
```
→ `{ "deleted_count": 1 }` (deprecated — prefer lifecycle methods below)

### Lifecycle

| Route | Body | Effect |
|---|---|---|
| `POST /atoms/supersede` | `{ "old_id": "...", "new_id": "..." }` | Marks `old_id` as `superseded`. |
| `POST /atoms/merge` | `{ "loser_ids": ["..."], "winner_id": "..." }` | Marks losers as `merged`. |
| `POST /atoms/archive` | `{ "id": "..." }` | Marks atom as `archived` (no replacement). |

## Tier T2 — Scenes  (id-addressed, SQLite-backed)

Scenes are organizational units (episodes, topics) populated by the
distillation pipeline. Agents can read/search scenes; only the in-process
distill worker writes them. A best-effort markdown mirror is written to
`blobDir/scenes/<scene_id>.md` whenever a summary is generated.

Scene kinds: `episode | topic`. Scene status: `active | retired`.

### `POST /scenes/upsert`  (distill worker use — not for agent freehand edits)
```json
{
  "scene_id": "optional-stable-id",
  "scene_kind": "episode",
  "title": "Session 2026-07-01",
  "atom_ids": ["atom-1", "atom-2"],
  "summary": "optional narrative",
  "content_hash": "optional hash for regeneration gating",
  "status": "active",
  "derived_from": null,
  "superseded_by": null
}
```
→ full Scene object

### `POST /scenes/get`
```json
{ "scene_id": "..." }
```
→ Scene object or `null`

### `POST /scenes/list`
```json
{ "scene_kind": "episode", "status": "active", "limit": 50, "offset": 0 }
```
→ `{ "items": [ Scene ], "total": N }` (default: `status=active`)

### `POST /scenes/search`  (hybrid dense + lexical)
```json
{ "query": "cryostat calibration run", "limit": 10 }
```
→ `{ "items": [ { ...Scene, "score" } ] }`

### `POST /scenes/for-atom`
```json
{ "atom_id": "...", "scene_kind": "episode" }
```
→ `{ "items": [ Scene ] }` (all active scenes containing this atom, optionally filtered by kind)

### `POST /scenes/remove`  (distill worker use)
```json
{ "scene_id": "..." }
```
→ `{ "ok": true }`

## Tier T3 — Core  (single markdown document)

| Route | Body | Returns |
|-------|------|---------|
| `POST /core/read`  | `{}`                  | `{ "content" }` |
| `POST /core/write` | `{ "content": "..." }`| `{ "ok": true }` |

## Distillation

### `POST /distill`
```json
{ "pool": "optional-pool-name" }
```
→ `{ "job_id": "...", "store_key": "..." }`

Enqueues a distillation job for the addressed store. `store_key` is always
derived from the authenticated tenant + pool (never from a body field) to
prevent cross-tenant enqueue. Duplicate pending jobs for the same store are
coalesced (returns existing job id). Asynchronous — does not wait for
distillation to complete. Drained by the single in-process distillation
worker started by `falda serve` (or `falda gateway`) — see the README's
"Distillation" section.

### `POST /distill/status`
```json
{ "job_id": "..." }
```
→ DistillJob object (`{ id, store_key, status, attempts, next_attempt_at, error, ... }`)

Status values: `pending | running | done | dead`.

## Pool admin

| Route | Body | Returns |
|-------|------|---------|
| `POST /pools/declare` | `{ "name", "members": { "tenant": "readwrite\|read" }, "description"? }` | PoolDecl |
| `POST /pools/update`  | `{ "name", "members"?, "description"? }` | PoolDecl |
| `POST /pools/grant`   | `{ "name", "tenant", "access": "readwrite\|read\|none" }` | PoolDecl |
| `POST /pools/get`     | `{ "name" }` | `{ "pool": PoolDecl }` |
| `POST /pools/list`    | `{}` | `{ "pools": PoolDecl[] }` |
| `POST /pools/mine`    | `{ "tenant" }` | `{ "pools": [...] }` |

All pool-admin routes require a fully-trusted principal (`tenants: ["*"]`).

## Health

### `GET /healthz`
→ `{ "ok": true, "tiers": ["stream", "atoms", "scenes", "core"], "pools": true }`
