# FALDA Data Model — Concepts

Status: **design doc.** Describes the target data model after aligning FALDA's
memory model with [`shinzui/kioku`](https://github.com/shinzui/kioku)'s concepts
(see `docs/user/concepts.md`, `docs/user/distillation.md`, `docs/user/recall.md`
in that repo). Parts of this doc describe the *current* shipped model
(`src/falda.ts`, `src/pools.ts`); parts describe the *target* model this doc's
final section plans to implement. Each section says which it is.

This page is the mental model behind FALDA. Read it once; the rest of the
codebase and docs assume it.

## 1. The four tiers

FALDA is four strata, each a refinement of the one below:

```
 T3  Core     ── one distilled persona/project profile per store
       ▲         "who/what is this, and what's durable about it"
 T2  Scenes   ── readable markdown blocks summarizing a store's atoms
       ▲
 T1  Atoms    ── concise, durable memory sentences
       ▲
 T0  Stream   ── raw conversation/observation turns — the floor
```

| Tier | Name   | What it is                              | Storage (current, `src/falda.ts`) |
|------|--------|------------------------------------------|-------------------------------------|
| T0   | Stream | raw conversation/observation turns       | SQLite `stream` table + FTS5 + sqlite-vec |
| T1   | Atoms  | distilled atomic memories                | SQLite `atoms` table + FTS5 + sqlite-vec |
| T2   | Scenes | synthesized episode summaries            | markdown blob files                 |
| T3   | Core   | long-lived persona/project profile       | one markdown blob file (`core.md`)  |

**Tiers are not the same axis as atom `type`** (§3). A tier says *where* a
memory lives in the durability/synthesis pipeline. `type` is a label on T1
atoms only (`fact`, `pattern`, …). T0/T2/T3 have no `type` field. This
distinction is easy to blur — kioku's own naming collides "L1 atom type
`episodic`" against no such collision (kioku has no `episodic` type); FALDA's
*current* MCP tool schema does have an `episodic` atom type that reads like a
tier name and is being retired in favor of kioku's five types (§3) precisely
to remove this confusion.

## 2. Scope: tenant + pool

FALDA partitions memory by **(tenant, pool)** — see `docs/POOLS.md` for the
full contract. This is FALDA's equivalent of kioku's "scope."

- **tenant** — agent/project identity, selected per-request via
  `X-Falda-Tenant`. Always required, no default.
- **pool** — `self` (private, default) or a named, explicitly-declared shared
  pool. Sharing is opt-in; touching an undeclared pool is an error.

Isolation is **physical**, not predicate-based: each `(tenant, pool)` resolves
to its own SQLite file + blob directory (`src/pools.ts`). There is no shared
table with a tenant column a forgotten `WHERE` could leak. A store literally
cannot open another store's files.

Every tier — stream, atoms, scenes, core — is scoped to one `(tenant, pool)`
store. Distillation (§6) runs per-store: one store's T0 promotes into that
same store's T1/T2/T3. There is currently no cross-store ("pool-wide")
distillation; see `docs/POOLS.md` "Pool-scoped distillation" for that gap.

## 3. Memory (T1 Atom)

*(Target model — see §9 Branch A. Fields marked "current" already exist.)*

An atom is one durable thing an agent has learned.

| Field | Meaning | Status |
|---|---|---|
| `id` | Stable identifier | current |
| `type` | One of `fact \| pattern \| preference \| constraint \| instruction` | current column, **new enum** |
| `content` | The memory text itself | current |
| `background` | Optional free-text supporting context | current |
| `priority` | Importance signal: `0` = maximum recall boost ("always inject" convention), `100` = default/no boost | **new** |
| `confidence` | `high`, `medium`, or `low` | **new** |
| `status` | `active`, `superseded`, `merged`, or `archived` | **new** |
| `tags` | A set of free-form labels (JSON array) | **new** |
| `supersedes` | Id of the memory this one replaces, if any | **new** |
| `created_at` / `updated_at` | Timestamps | current |

### 3.1 Atom types

- **fact** — a stable truth (e.g. "the deploy script lives in `bin/release`").
- **pattern** — a recurring behavior or workflow.
- **preference** — a stated like/dislike.
- **constraint** — a hard rule ("never touch the `legacy/` directory").
- **instruction** — a standing directive ("always run the formatter before committing").

This replaces FALDA's current three divergent vocabularies (the shipped MCP
enum `fact/preference/rule/decision/episodic/instruction`, the Python
sidecar's `persona/episodic/instruction`, and `src/distiller.ts`'s
`fact/preference/rule/decision`) with one set, adopted verbatim from kioku.
`rule → constraint`; `decision` and `episodic` are dropped (an episodic
memory is a `fact` about something that happened, not a separate type — the
T2 *Scene* tier is where episodic narrative actually lives). Legacy `persona`
atoms map to `fact`.

`type` and `confidence` outside the allowed sets are **rejected**, not
silently coerced to a default — a bad value fails the write loudly rather
than corrupting the vocabulary.

### 3.2 Priority and confidence

- **priority**: `0` is a convention meaning "always inject," and the maximum
  boost; `100` is default/no boost. Values are clamped `0`–`100`.
- **confidence**: `high | medium | low`. Agent-written atoms (via
  `falda_atoms_upsert`) default to `medium` when omitted.

Both feed recall re-ranking (§5) — they are not merely metadata.

### 3.3 Lifecycle

A memory starts **active**. From there:

- **superseded** — replaced by a newer memory (the new one records
  `supersedes`; nothing is edited in place).
- **merged** — folded into another memory (a winner absorbs one or more
  losers).
- **archived** — retired without a replacement.

Superseded, merged, and archived are **terminal**. Only `active` memories are
returned by recall (§5). `status`, `confidence`, and `tags` can be updated in
place while a memory is active.

**Forgetting propagates.** Superseding, archiving, or merging a memory — or
changing its **confidence** — schedules regeneration of that store's T2 scene
(and, transitively, its T3 core), so forgotten or downgraded content does not
survive downstream. Changing only a memory's **tags** does not: tags feed
neither the scene's source hash nor its prompt (§6.3).

When the last active memory in a store is forgotten, the store's scene(s) and
core **are deleted**, not regenerated to empty. There is nothing left to
summarize.

### 3.4 Idempotency

A duplicate atom write that matches what already happened succeeds as a
no-op. A conflicting one (same id, different content/type) updates in place
under FALDA's current `upsertAtom` semantics — FALDA does not adopt kioku's
full event-sourced conflict model here; the `atoms` table remains the
authoritative row store (see §9 "Scope calls").

### 3.5 Consolidation audit

Every distillation decision that creates, supersedes, or merges an atom is
recorded in a `consolidation_decisions` audit table: the action actually
applied, its targets, the resulting atom id, and a rationale. The audit key
is deterministic, so a re-run distillation pass does not duplicate audit
rows. See §6.2.

## 4. Evidence (T0 Stream)

*(§4.1 is current; §4.2 is target — see §9 Branch A.)*

### 4.1 Current fields

| Field | Meaning |
|---|---|
| `id` | Row identifier |
| `session_id` | Which session/conversation this turn belongs to |
| `role` | Turn role (`user`, `assistant`, …) |
| `content` | Turn text |
| `ts` | Timestamp |

`session_id` is already captured, indexed, and queryable/deletable by session
(`src/falda.ts`). This is the one piece of kioku's T0 model FALDA already had
before this design pass.

### 4.2 New fields — deterministic ordering + idempotency

| Field | Meaning |
|---|---|
| `turn_index` | Strictly-increasing index within a session (nullable — legacy callers may omit it) |
| `turn_id` | Idempotency token for this turn, independent of the row `id` |

Two problems this fixes:

- **Ordering.** Today, stream reads order by `ts` (an ISO timestamp string).
  Two turns recorded in the same millisecond, or under clock skew, can
  reorder — which corrupts the transcript a distillation pass reconstructs.
  `turn_index`, when present, orders `(session_id, turn_index)` instead.
- **Idempotency.** Today, `/stream/add` blindly inserts; a retried capture
  (a network hiccup in a capture plugin, a replayed worker call) silently
  double-counts turns. With `turn_index` supplied:
  - same `(session_id, turn_index)` + identical content/`turn_id` → **no-op**
    (returns the existing id);
  - same `(session_id, turn_index)` + **different** content/`turn_id` →
    **rejected as a conflict** — a stale or out-of-order turn cannot silently
    overwrite a committed one.

A unique index on `(session_id, turn_index)` (partial: `WHERE turn_index IS
NOT NULL`) enforces this without constraining callers who don't supply an
index — they keep today's UUID-id, `ts`-ordered behavior exactly.

### 4.3 Explicitly not adopted (this pass)

kioku's T0/Session model additionally has: a session `focus`/topic field, a
full session lifecycle (`start → running → awaiting → completed/failed`),
delegation/continuation lineage between sessions, and per-turn tool-summary +
token-count metadata. None of these land in this pass. `focus` and a session
lifecycle table are natural companions to the ramp/idle/final distillation
triggers (§6.4) deferred in §9 — they will land together, if ever. Lineage
and per-turn token accounting are judged out of scope for FALDA's use case
(scientific-agent memory, not multi-agent delegation orchestration).

## 5. Recall

*(Target model — see §9 Branch A. FALDA already has hybrid FTS+vector+RRF;
the re-ranking, status filter, and character budgets are new.)*

Recall answers "what does this store know that's relevant to this query?"
FALDA's recall is **hybrid**:

- **Lexical** — SQLite FTS5, BM25-ranked.
- **Dense** — sqlite-vec, cosine distance.
- **Fusion** — both, combined via **Reciprocal Rank Fusion** (`rrf(rank) = 1
  / (60 + rank)`; a candidate absent from a channel contributes `0` for it),
  then **re-ranked** by recency, priority, and confidence, then trimmed to a
  character budget.

### 5.1 Blended score

```
score =  rrf(ftsRank)
       + rrf(vecRank)
       + 0.10 · recencyDecay(createdAt)
       + 0.15 · priorityWeight(priority)
       + 0.05 · confidenceWeight(confidence)
```

- **Recency decay**: exponential, 30-day half-life —
  `exp(-ln2 · ageDays / 30)`.
- **Priority weight**: `priority ≤ 0` → `1`. Otherwise
  `clamp01(1 − priority/100)` — lower numeric priority scores higher.
- **Confidence weight**: `high → 1.0`, `medium → 0.6`, `low → 0.3`.

The two best possible RRF terms total roughly `0.033`, while the three
metadata terms can contribute up to `0.30` combined — so priority and
confidence can dominate the final ordering. They do not, however, bypass
candidate selection: an atom must still surface via the lexical or vector
channel before priority/confidence can affect its rank. Priority `0`'s
"always inject" label is a convention for callers, not a guarantee.

### 5.2 Status filtering

Recall only ever returns `status = 'active'` atoms (§3.3). Superseded,
merged, and archived atoms are excluded, full stop — they remain in the
table (and in the consolidation audit trail) but are invisible to recall.

### 5.3 Character budgets

- **Per-atom cap**: 2000 characters. Longer content is truncated to 1997
  characters plus a trailing `...`.
- **Total cap**: 12000 characters across all returned hits. Hits are added
  in ranked order until the next one would exceed the total; the rest are
  dropped.

A high `limit` therefore does not guarantee that many hits — the character
budget can cut the list short, always after ranking, so the highest-value
hits are kept.

## 6. The distillation pipeline (T0 → T3)

*(Target model — see §9 Branches A and B. Today, promotion is done by two
divergent, unauthenticated-with-current-gateway external scripts,
`falda_distiller.py` and `src/distiller.ts`; both are retired by this plan.)*

Raw evidence is noisy. Distillation refines it upward, one tier at a time,
per `(tenant, pool)` store.

### 6.1 L0 — the evidence floor

T0 stream turns (§4) are the raw material. A distillation pass reads new
turns since a per-store watermark; if none, the pass is skipped before any
LLM call.

### 6.2 L1 — extract, then consolidate

A pass over a store's new evidence has two stages:

**1. Extract.** An LLM call reads a window of new turns and proposes
candidate atoms: `{type, content, priority, confidence}` (§3). An `type` or
`confidence` outside the allowed set fails the extraction rather than being
coerced — a retryable failure, not silent corruption.

**2. Consolidate.** For each candidate atom, a second pass looks at existing
active atoms in the same store (candidates found via recall, §5) and decides
one action:

| Action | Effect |
|---|---|
| **store** | The atom is new → record it. |
| **update** | An existing atom should be refreshed → a *new* atom is recorded that supersedes the old one; nothing is edited in place. |
| **merge** | Several existing atoms collapse into one → the same mechanism, every target merged into the winner. |
| **skip** | Redundant, transient, or low-value → drop it. |

The pass records what it **applied**, not what was requested: a merge naming
targets that no longer exist degrades to a store; one whose only target is
its own prior copy degrades to a skip. Every decision is written to the
`consolidation_decisions` audit table (§3.5) with a deterministic key, so a
re-fired pass does not duplicate rows.

### 6.3 L2 — scenes

A store's active atoms are folded into a single markdown **scene**: a title
naming the dominant topic, plus a short narrative body. Regeneration is
**content-hashed** — the pass hashes the store's active atoms; if unchanged
since the last regeneration, the LLM call is skipped entirely.

### 6.4 L3 — core

A store's scene(s) are distilled into the **core** document: the durable
profile of what this tenant/pool is — stable preferences, constraints,
project facts, patterns. Grounded only in scene text; not invented. Also
content-hashed and skipped when unchanged.

FALDA keeps the name **Core** for this tier (kioku calls the equivalent tier
"Persona"). `falda_core_read`/`falda_core_write` and the `core.md` blob are
unchanged by this alignment — only the *mechanics* producing core content
change. See §9 "FALDA ↔ kioku crosswalk."

### 6.5 Forgetting and emptying

Per §3.3: a lifecycle change to an atom (supersede/archive/merge/confidence)
schedules scene regeneration; every scene regeneration schedules core
regeneration. When a store's last active atom is forgotten, its scene and
core are **deleted**, not regenerated empty.

### 6.6 Triggers

Distillation runs off a **per-store job queue**, never inline on a write.
Multiple surfaces can enqueue a job for a store:

- a **gateway-internal timer** (interval-based),
- the gateway's `POST /distill` route,
- the MCP tool `falda_distill`,
- a CLI backfill (`--once`).

A single **in-gateway background worker** drains the queue and calls the
distill core directly against the resolved store (`PoolManager`) — no
self-HTTP call, no bearer token to itself. The MCP server only *enqueues*;
it never runs extraction/consolidation/scene/core writes in-process. This
preserves the existing rule that T2/T3 are curated by distillation, not by
freehand agent tool calls (`docs/MCP.md`).

kioku additionally fires L1 on session **ramp/idle/final** events and
regenerates L2/L3 on every underlying change (debounced). FALDA's first
pass uses interval + on-demand triggers only; ramp/idle/final is deferred
until a session-lifecycle table exists (§4.3, §9).

## 7. Auth and addressing (unchanged by this doc)

Every tier operation, at every tier, is addressed by `(tenant, pool)` and
gated by the shared bearer-token `TokenStore`/`Principal` model
(`src/mcp_auth.ts`) — see `docs/API.md` and `docs/MCP.md` "Authentication."
This doc does not change auth; it is listed here only so the model diagram
in §8 is complete.

## 8. How the pieces fit

```
   host / agent runtime
      │  records turns / atoms directly
      ▼
  Falda (src/falda.ts)  ──►  SQLite (stream, atoms) + FTS5 + sqlite-vec
      │                              │
      │                    hybrid recall (FTS + vector + RRF + re-rank)
      ▼                              │
  gateway (:8078) / MCP (:8079)  ◄───┘  same PoolManager, same auth, two surfaces
      │
      │  enqueue                              enqueue
      ▼                                       ▼
  distill job queue (per-store)  ◄── POST /distill, falda_distill, timer, CLI
      │
      ▼
  gateway-internal worker: L0 turns ──► L1 extract+consolidate ──► atom events
        │  lifecycle change (supersede/archive/merge/confidence) schedules…
        ▼
  L2 regenerate (or delete) scene
        │  every scene regeneration schedules…
        ▼
  L3 regenerate (or delete) core
```

## 9. FALDA ↔ kioku crosswalk

| Concept | kioku | FALDA |
|---|---|---|
| Pyramid | L0 Evidence → L1 Atoms → L2 Scenes → L3 Persona | T0 Stream → T1 Atoms → T2 Scenes → **T3 Core** |
| Atom types | `fact \| pattern \| preference \| constraint \| instruction` | same (adopted verbatim) |
| Priority | `0` = always-inject … `100` = default | same |
| Confidence | `high \| medium \| low` | same |
| Status lifecycle | active/superseded/merged/archived | same |
| Partitioning | "scope" (namespace, or namespace:kind:ref) | `(tenant, pool)` |
| Source of truth | event-sourced aggregate; rows are projections | **row store** (`atoms`/`stream` tables are authoritative) — event-sourcing is **not** adopted |
| Recall re-rank | RRF + recency + priority + confidence | same formula, adopted verbatim |
| Distillation trigger | ramp/idle/final session timers + change-hash regen | **interval + on-demand enqueue** (queue + in-gateway worker); ramp/idle/final deferred |
| Session model | full lifecycle aggregate, focus, lineage | **not adopted** this pass beyond existing `session_id` + new `turn_index`/`turn_id` (§4) |
| LLM/embeddings | hard-coded Claude Haiku 4.5 | pluggable (`selectEmbedder`, any OpenAI-compatible chat endpoint) |
| Workspace mirroring | `.kioku/scenes/*.md`, `.kioku/persona/*.md` | FALDA already stores scenes/core as blob files directly (no separate mirror step needed) |

FALDA deliberately does **not** adopt: full event-sourcing, session
delegation/continuation lineage, per-turn token-count metadata, or renaming
T3 Core to "Persona." These are judged unnecessary complexity for FALDA's
scope (scientific-agent memory across many tenants/pools), not oversights.

---

## 10. Phased implementation plan

> **Status: temporary.** This section describes three planned implementation
> branches. It will be split out of this doc (to `docs/future/` or deleted)
> once all three branches have landed, so this doc stays a timeless
> description of the model rather than a changelog.

Each branch is implemented, tested, linted, and merged (`--no-ff`) to
`master` individually — these are branches to merge in sequence, not GitHub
PRs. Decisions locked for all three:

- Backfill existing atoms on migration: `status=active, priority=100,
  confidence=medium`.
- Distillation triggers: interval + on-demand only (ramp/idle/final
  deferred, see §6.6).
- `falda_distiller.py` and `src/distiller.ts`: **hard-deleted** in Branch C,
  no deprecation shim.
- New MCP tool name: `falda_distill`.
- Agent-written atoms via `falda_atoms_upsert` default `confidence=medium`
  when omitted.

### Branch A — schema + recall foundation (`feature/data-model-schema`)

- **T0**: add `turn_index`, `turn_id`; partial unique index on
  `(session_id, turn_index)`; idempotent/conflict-aware `addStream`
  (identical re-add = no-op, conflicting re-add = rejected); deterministic
  `(session_id, turn_index)` ordering when present, falling back to `ts`.
  New `StreamConflict`-style error → HTTP 409 (gateway) / `isError` (MCP).
  Thread optional `turn_index`/`turn_id` through `/stream/add` and
  `falda_stream_add` (both backward-compatible — omitted fields behave
  exactly as today).
- **T1**: add `priority`, `confidence`, `status`, `tags`, `supersedes`
  columns; lifecycle methods (`supersedeAtom`, `mergeAtoms`, `archiveAtom`,
  `updateConfidence`, `updateTags`); new `consolidation_decisions` audit
  table.
- **Recall**: add the blended re-rank (§5.1), `status='active'` filtering
  (§5.2), character budgets (§5.3).
- **Migration**: additive `ALTER TABLE` guarded by `PRAGMA table_info`
  (existing DBs upgrade in place); backfill existing atom rows per the
  decision above.
- `falda_atoms_upsert`: new `type` enum (§3.1: `fact/pattern/preference/
  constraint/instruction`); `confidence` defaults to `medium` when omitted.
- Tests: turn idempotency + conflict rejection, deterministic ordering,
  recall re-rank ordering, status filtering, character budgets, migration +
  backfill. Added to CI.
- No behavior change for existing callers — every new field is optional or
  defaulted.

### Branch B — distill core + queue + triggers (`feature/distill-core`)

- New `src/distill/` module:
  - `core.ts` — `distillOnce(store, llm, opts)`: two-stage L1 extract +
    consolidate (§6.2), L2/L3 hash-skip regeneration (§6.3–6.4), empty-store
    scene/core deletion (§6.5). Pure — no env reads, no HTTP.
  - `watermark.ts` — per-store watermark (not process-local).
  - `prompts.ts` — extraction/consolidation/scene/core prompts; single
    source for `VALID_TYPES`.
  - `queue.ts` — per-store `distill_jobs` table: `enqueue` (coalesces
    duplicate pending jobs), `claimNext`, `complete`, `fail` (backoff 30s→
    900s doubling, 8-attempt ceiling → `dead`).
  - `cli.ts` — `--once` backfill / daemon mode, replacing both retired
    runners for standalone/cron use.
- **Gateway** (`src/gateway.ts`): in-process background worker draining the
  queue via `PoolManager.resolve` → `distillOnce`; self-enqueue interval
  timer; new authenticated `POST /distill` route (added to `WRITE_ROUTES`).
- **MCP** (`src/mcp.ts`): new tool `falda_distill` — enqueues a job for the
  request's tenant/pool, returns job status. Never distills inline; never
  writes T2/T3 in-process.
- Tests: extract→consolidate action correctness (store/update/merge/skip +
  degradation rules), audit-table idempotency, watermark skip, type/
  confidence rejection, scene/core hash-skip, queue coalesce/backoff/dead-
  letter, `/distill` + `falda_distill` enqueue + auth. Added to CI.

### Branch C — retire + reconcile + docs (`feature/distill-retire-docs`)

- **Hard-delete** `src/distiller.ts` and `falda_distiller.py`.
- Update `README.md` (distillation section + env table), `docs/API.md`
  (document `/distill`), `docs/MCP.md` (document `falda_distill`),
  `docs/POOLS.md` (revisit "pool-scoped distillation" note), `docs/SCALE.md`
  (mark relevant phase-4 items delivered), `docs/HARNESS_INTEGRATION.md`
  (remove Python-distiller setup instructions).
- Remove the temporary §10 from this doc (move to `docs/future/` or delete,
  per whichever is still relevant at that point).
