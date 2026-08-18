# FALDA API

All routes are `POST` with a JSON body and JSON response, except `/healthz` (`GET`).
Default port: `8077` (`FALDA_PORT`). Served by `falda serve`, which runs
this HTTP API alongside the MCP endpoint from one shared runtime — see
`docs/MCP.md`. Pass `--no-mcp` for an HTTP-API-only process.

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
re-evaluate or archive them. Deletion removes the raw turn, its search/
vector index rows, and its evidence edges atomically — deleted content is
not recoverable from search after this call succeeds.

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

## Cross-tier recall

### `POST /recall`
```json
{ "query": "...", "budget": 6000, "pool": "optional-pool-name" }
```
or, to recall from a specific active topic without composing your own query:
```json
{ "topic": "<scene_id-or-title-substring>", "budget": 6000 }
```
→ `{ "recall_id": "...", "context": "...", "items": [...], "truncated": false, "total_chars": 1234 }`

Exactly one of `query`/`topic` is required. `topic` resolves server-side
(`src/recall/topic.ts`) to an active **topic** scene — first an exact
`scene_id` match, else a case-insensitive substring match against active
topic titles (most recently updated wins on multiple matches) — and uses
that scene's title as the recall query. No match → `404`.

Assembles context across all four tiers in one call (pinned atoms first,
then query-ranked atoms, relevant scenes, a core excerpt — see
`src/distill/context.ts` and `docs/MODEL.md` §8.9), trimmed to `budget`
characters (default 6000). `context` is the same rendered, sectioned text
(`## Pinned` / `## Relevant facts...` / `## Related episodes/topics` /
`## Project/persona core`) the MCP `falda_recall` tool returns
(`src/recall/render.ts` — one renderer, shared by both surfaces). Each
entry in `items` is `{ tier: "T1"|"T2"|"T3", id, kind, source, chars,
score? }` in the order it was admitted (rank order).

`recall_id` identifies this specific invocation for later usage feedback
(see "Recall traces" below). It is **best-effort**: if trace persistence
fails for any reason, `recall_id` is simply omitted from the response —
the recall itself always succeeds or fails independently of telemetry.

## Recall traces

Telemetry attached to a prior `/recall` call — never memory mutation. See
`docs/RECALL_TRACES.md` for the full model (schema, usage-state machine,
retention, evaluation queries). Not exposed as an MCP tool: usage
reporting is a harness/runtime responsibility, not something a model
should be prompted to call after every recall.

### `POST /recall/usage`
```json
{
  "recall_id": "...",
  "used":   [{ "tier": "T1", "id": "atom-123" }],
  "unused": [{ "tier": "T2", "id": "scene-88" }]
}
```
→ `{ "updated": [{tier,id}], "unchanged": [{tier,id}] }`

Both `used` and `unused` are optional — report only what you know.
Anything not listed keeps its current state (`unknown` if never reported).
Transitions: `unknown → used` and `unknown → unused` are always allowed;
re-reporting the same state is an idempotent no-op; a request that
contradicts an item's already-stored terminal state (`used → unused` or
vice versa), or that lists the same item in both `used` and `unused` in
one call, is rejected with `409` and **no items in that call are changed**.
An unrecognized `{tier,id}` (not part of this recall) → `400`. A
`recall_id` that doesn't exist, or belongs to a different tenant/pool, →
`404` (no existence oracle — the two cases are indistinguishable).

### `POST /recalls/get`
```json
{ "recall_id": "..." }
```
→
```json
{
  "recall_id": "...", "query": "...", "policy_snapshot": {...},
  "requested_budget": 6000, "used_budget": 4210, "created_at": "...",
  "items": [
    { "tier": "T1", "id": "atom-123", "rank": 0, "source": "pinned", "score": null, "chars": 88, "usage": "used" }
  ]
}
```
Single-trace inspection — admin/debug, not part of the compact MCP surface.
Ownership-scoped like `/distill/status`; `404` for missing or cross-store ids.

### `POST /recalls/reconstruct`
```json
{ "recall_id": "latest" }
```
or a specific past recall:
```json
{ "recall_id": "..." }
```
→
```json
{
  "trace": { "recall_id": "...", "query": "...", "created_at": "...", "items": [...] },
  "context": "## Pinned\n...",
  "stale_items": [{ "tier": "T1", "id": "atom-123", "reason": "superseded" }]
}
```
Re-renders a past trace's items against **current** memory — backing
`falda show recall` (`docs/OPERATIONS.md` "Previewing a recall"), the
"what did the last prompt's recall return" use case. `recall_id: "latest"`
means "the most recent trace for my store" (`src/recall/traces.ts`'s
`getLatestRecallTraceForStore`), so a caller doesn't need to already know
a `recall_id`. `404` if `latest` and this store has never made a recall,
or if an explicit `recall_id` doesn't exist / belongs to another store (no
existence oracle, same as `/recalls/get`).

**This is not a byte-faithful replay.** A trace never stored the rendered
text an agent originally saw — only the query, budget, and each admitted
item's `{tier, id, source, score, chars}`. Reconstruction re-fetches each
item's *current* content and re-renders it with today's per-item caps
(`src/recall/reconstruct.ts`). Anything that no longer resolves the way it
did at recall time — an atom superseded/merged/archived, a scene retired,
core regenerated-then-deleted — is listed in `stale_items` with a
`reason` (`not_found`/`superseded`/`merged`/`archived`/`retired`/
`deleted`) instead of being silently dropped or shown as stale text.
Read-only: writes no new trace, unlike `/recall` itself.

### `POST /recalls/metrics`
```json
{}
```
→ `RecallMetrics` for the caller's own store_key: trace/item counts, usage
rate by tier (T1/T2/T3) and by `source` (pinned/ranked/scene/core), usage
rate by rank position, and a `chars.unused_ratio` context-efficiency
measure. Usage rate is `used / (used + unused)` — items still `unknown`
(no report received) are excluded from the denominator, since silence is
not evidence of non-use. See `docs/RECALL_TRACES.md` for the full field
list and example queries.

## Distillation

### `POST /distill`
```json
{ "pool": "optional-pool-name" }
```
→ `{ "job_id": "...", "store_key": "..." }`

Enqueues a distillation job for the addressed store, at EXPLICIT priority
(claimed ahead of the worker's own passive-sweep jobs — see
`src/distill/queue.ts`), and immediately wakes the worker to drain it rather
than waiting for the next scheduled drain tick. `store_key` is always derived
from the authenticated tenant + pool (never from a body field) to prevent
cross-tenant enqueue. Duplicate pending jobs for the same store are
coalesced — a second explicit enqueue on top of an already-pending passive
job upgrades that job's priority in place rather than creating a duplicate
(returns the existing job id either way). Asynchronous — does not wait for
distillation to complete. Drained by the single in-process distillation
worker started by `falda serve` — see the README's "Distillation" section
and `FALDA_DRAIN_INTERVAL_MS`/`FALDA_SWEEP_INTERVAL_MS`.

### `POST /distill/status`
```json
{ "job_id": "..." }
```
→ DistillJob object (`{ id, store_key, status, attempts, next_attempt_at, error, priority, origin, ... }`)

Status values: `pending | running | done | dead`. `priority` distinguishes an
explicit request (`falda_distill`/`POST /distill`) from the worker's own
passive sweep; `origin` records which surface enqueued it (`sweep | http |
mcp`) — both are informational, surfaced for operator visibility (e.g. `falda
distill inspect`), and do not need to be interpreted by API callers.

### `POST /metrics`
```json
{}
```
→ `MetricsSnapshot`:
```json
{
  "started_at": "2026-08-16T00:00:00.000Z",
  "recall_ms": { "count": 12, "min": 3, "max": 410, "mean": 55.2, "buckets": [...] },
  "distill_pending_ms": { ... },
  "distill_service_ms": { ... },
  "http_request_ms": { "active": { ... }, "idle": { ... } },
  "mcp_request_ms": { "active": { ... }, "idle": { ... } },
  "stream_add_ms": { "active": { ... }, "idle": { ... } }
}
```

Since-process-startup timing histograms (`src/metrics.ts`): `recall_ms`
(`assembleContext` wall time, observed on every `falda_recall`/`POST
/recall`), `distill_pending_ms` (queue enqueue → claim), and
`distill_service_ms` (`distillOnce` wall time) are plain histograms. Fixed
predetermined bins, no raw samples retained (fixed memory footprint) — hence
count/min/max/mean rather than percentiles.

`http_request_ms` (whole `handleRequest` wall time for every gateway route
except `/metrics` itself), `mcp_request_ms` (whole MCP request wall time,
including handshake/list calls), and `stream_add_ms` (`addStream` wall time,
observed at both the HTTP `/stream/add` and MCP `falda_stream_add` entry
points) are each a `TaggedHistogram`: `{ active, idle }`, split by whether a
distillation pass (`distillOnce`) was in flight at the moment of
observation. This is the foreground-latency signal for "is a running distill
pass stalling requests?" — `active` and `idle` are each themselves the same
count/min/max/mean/buckets shape as a plain histogram.

Resets to zero on every `falda serve` restart — this is in-process
telemetry, not a durable store. Process-global (not addressed by `{tenant,
pool}`): any authenticated token may read it. Backs `falda stats
--section=timing` (`docs/OPERATIONS.md`).

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
