# FALDA API

All routes are `POST` with a JSON body and JSON response, except `/healthz` (`GET`).
Gateway default port: `8077` (`FALDA_PORT`).

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

The gateway refuses to boot if `FALDA_TOKENS` doesn't point at a valid,
non-empty token file (fail-fast — see `docs/POOLS.md` "Environment").
Auth is defense-in-depth on top of whatever network exposure you choose
(e.g. binding to localhost); it does not itself change where the gateway
listens.

## Tier T0 — Stream

### `POST /stream/add`
```json
{ "session_id": "sess-1", "messages": [ { "role": "user", "content": "..." } ] }
```
→ `{ "accepted_ids": ["..."], "total_count": 1 }`

### `POST /stream/query`
```json
{ "session_id": "sess-1", "limit": 50, "offset": 0, "time_start": "...", "time_end": "..." }
```
→ `{ "messages": [ { "id", "role", "content", "timestamp" } ], "total": 42 }`

### `POST /stream/search`  (hybrid dense + lexical)
```json
{ "query": "neutron detector energy", "limit": 10 }
```
→ `{ "messages": [ { "id", "role", "content", "timestamp", "score" } ] }`

### `POST /stream/delete`
```json
{ "ids": ["..."] }            // or { "session_id": "sess-1" }
```
→ `{ "deleted_count": 3 }`

## Tier T1 — Atoms

### `POST /atoms/upsert`
```json
{ "id": "optional", "type": "fact", "content": "...", "background": "optional" }
```
→ `{ "id", "type", "content", "background", "created_at", "updated_at" }`

### `POST /atoms/query`
```json
{ "type": "fact", "limit": 50, "offset": 0 }
```
→ `{ "items": [ Atom ], "total": 10 }`

### `POST /atoms/search`  (hybrid dense + lexical)
```json
{ "query": "what temperature is the cryostat?", "limit": 10 }
```
→ `{ "items": [ { ...Atom, "score" } ] }`

### `POST /atoms/delete`
```json
{ "ids": ["..."] }
```
→ `{ "deleted_count": 1 }`

## Tier T2 — Scenes  (markdown blobs on local FS)

| Route | Body | Returns |
|-------|------|---------|
| `POST /scenes/ls`    | `{ "prefix": "projects/" }` | `{ "entries": [ { "path", "created_at", "updated_at" } ], "total" }` |
| `POST /scenes/read`  | `{ "path": "a/b.md" }`      | `{ "path", "content" }` |
| `POST /scenes/write` | `{ "path": "a/b.md", "content": "..." }` | `{ "path" }` |
| `POST /scenes/rm`    | `{ "path": "a/b.md" }`      | `{ "path" }` |

## Tier T3 — Core  (single markdown document)

| Route | Body | Returns |
|-------|------|---------|
| `POST /core/read`  | `{}`                  | `{ "content" }` |
| `POST /core/write` | `{ "content": "..." }`| `{ "ok": true }` |

## Health

### `GET /healthz`
→ `{ "ok": true, "tiers": ["stream", "atoms", "scenes", "core"] }`
