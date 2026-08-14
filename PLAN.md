# FALDA implementation plan

> **Status: temporary.** This is the execution checklist for the data model
> described in `docs/MODEL.md`. It is deleted (along with `docs/MODEL.md`
> §14) once Branch C lands — at that point the model is the shipped system,
> not a plan for one.

Each branch below is implemented, tested, and merged (`--no-ff`) to `master`
individually, in order — these are sequenced branches, not GitHub PRs. Every
branch: its own git worktree off current `master` → implement → `npm run
build` → `npm test` → commit → merge `--no-ff` to `master` → remove the
worktree and delete the branch → **push is left to the human**, never done by
the agent. The next branch starts only after the prior one has merged.

Section references below (`§N`) are to `docs/MODEL.md`.

## Runtime decision

Single TypeScript runtime. The distill worker (Branch 2) runs **in-process**,
inside the gateway, calling the store directly through `PoolManager` — no
Python, no self-HTTP call, no bearer token to itself. This is forced by two
requirements the model already commits to, not a style preference:

- §8.5's L1 atomicity (atom writes + evidence edges + audit rows + watermark
  advance in **one** transaction) requires sharing `better-sqlite3`'s
  synchronous transaction with the store — only possible in-process.
- §8.7/§8.8's worker model explicitly rules out a self-HTTP round trip.

Both existing distillers (`src/distiller.ts`, `falda_distiller.py`) are
HTTP-client sidecars — exactly the coupling this plan removes. They are
hard-deleted in Branch 3, no deprecation shim.

## Decisions locked for all branches

- Backfill existing atoms on migration: `status=active, priority=100,
  confidence=medium, pinned=false`.
- Distillation triggers: interval + on-demand only (§8.8; ramp/idle/final
  deferred, §13).
- `falda_distiller.py` and `src/distiller.ts`: hard-deleted in Branch 3, no
  deprecation shim.
- New MCP tool names: `falda_distill`, `falda_distill_status`.
- Agent-written atoms via `falda_atoms_upsert` default `confidence=medium`
  when omitted; changed `content`/`type` on an existing id is a **rejected
  error**, never an in-place rewrite (§3.3). `type` enum is switched, hard,
  in Branch 1 to `fact|pattern|preference|constraint|instruction` (§3.1) —
  the current shipped enum (`fact/preference/rule/decision/episodic/
  instruction`) is replaced outright, no coercion, no alias layer.
- Provenance keys on `stream.id` (`stream_id`), never `turn_id` (§5.1).
- Scene membership cardinality is per-kind: episodes many-to-many
  (evidence-derived), topics one-per-atom (§6.2) — not a single global
  partition.
- Confidence is recall-only; it does not enter the T2/T3 content hash or
  prompts (§3.3, §6.4, §8.4).
- A private cross-tier context-assembly function ships in Branch 2 for the
  evaluation harness (§8.9); the public endpoint stays deferred.
- Branch 1 ships T2 **storage** (schema, CRUD, search) with no populator;
  Branch 2 ships **derivation** (episode projection, topic clustering,
  hysteresis, lazy summaries). The interim — scene tools exist but return
  nothing until Branch 2 lands — is accepted, not worked around.
- Cross-tenant pool distillation, session lifecycle/focus, erasure, extra
  scene kinds (`project`/`thread`), multi-topic-per-atom, and the public
  unified context-assembly endpoint are out of scope for all branches (§13).
- No linter exists in this repo; "lint/typecheck" means `npm run build`
  (`tsc`, strict) + `npm test`.

## Grounding facts (current shipped code, as of branch start)

- `Falda` (`src/falda.ts`): synchronous `better-sqlite3` + `sqlite-vec`.
  Schema is create-once `IF NOT EXISTS` only — **no migration infra exists**
  (no `PRAGMA table_info` guard, no `ALTER TABLE`, no version table). Branch
  0/1 introduces it.
- Tables today: `stream(id,session_id,role,content,ts)`,
  `atoms(id,type,content,background,created_at,updated_at)`, plus
  `stream_fts`/`atoms_fts` (FTS5) and `stream_vec`/`atoms_vec` (`vec0`). No
  `scenes` table — scenes are path-addressed files under `blobDir/scenes/`;
  core is `blobDir/core.md`.
- `hybrid(kind, query, limit)` (`src/falda.ts`) is generic over
  `"stream"|"atoms"` with `RRF_K=60`; extending to `"scenes"` is a third
  `_fts`/`_vec` pair through the same function.
- Gateway default port is `FALDA_PORT=8077` (docs previously said 8078 —
  fixed in Branch 3). Auth via `WRITE_ROUTES` set + `TokenStore`/`Principal`
  (`src/mcp_auth.ts`).
- MCP tool `falda_atoms_upsert` currently allows
  `fact/preference/rule/decision/episodic/instruction` (divergent from
  §3.1); T2/T3 are read-only on MCP today (`falda_scenes_ls/read`,
  `falda_core_read`; no scene/core write tools).
- None of `atom_evidence`, `consolidation_decisions`, `distill_jobs`, or a
  per-store watermark table exist in code — all are `docs/MODEL.md`-only
  until Branch 1/2 land them.
- Tests: `node:test` via `tsx --test test/*.test.ts` (`npm test`), one file
  per concern, full suite wired into CI on every matrix cell (Branch 0).

---

## Branch 0 — `chore/test-runner-node-test` (test infra) — done

Migrated all 7 existing test files to `node:test`
(`describe`/`test`/`before`/`after` + `node:assert/strict`), added a single
`npm test` (`tsx --test test/*.test.ts`) replacing the five separate
`smoke`/`test:pools`/`test:mcp`/`test:gateway`/`test:mcp-auth` scripts, and
wired the full suite into `ci.yml` on every matrix cell (including the two
previously-orphaned `atoms_batch_upsert` and `fts_sanitizer` tests). No
behavior change; this branch exists purely so later branches' "tests added
to CI" claims are actually true.

## Branch 1 — `feature/data-model-schema` (schema + recall foundation)

**Prereq:** migration infra in `Falda` — a helper that inspects
`PRAGMA table_info`/`sqlite_master` and applies additive
`ALTER TABLE`/`CREATE ... IF NOT EXISTS` idempotently (safe to run on both a
fresh DB and an existing one). All schema changes below go through it, with
the backfill defaults from "Decisions locked" above.

**T0 stream (§4.2, §5.4)**
- Add `turn_index` (nullable), `turn_id` (nullable).
- `UNIQUE(session_id, turn_index) WHERE turn_index IS NOT NULL` and
  `UNIQUE(session_id, turn_id) WHERE turn_id IS NOT NULL` — both, not one.
- `addStream` becomes idempotent/conflict-aware: identical
  `(session_id, turn_index, turn_id, content)` is a no-op; a collision on
  one unique key while disagreeing on the other is a rejected conflict.
  Ordering is `(session_id, turn_index)` when present, else `ts` (unchanged
  fallback).
- `deleteStream` returns the set of affected atom ids (needs the provenance
  edge below to compute).
- Thread optional `turn_index`/`turn_id` through `/stream/add` (gateway) and
  `falda_stream_add` (MCP) — backward-compatible for callers that omit them.
  New conflict → HTTP 409 (gateway) / `isError` (MCP).

**T1 atoms (§3)**
- Add columns: `priority`, `confidence`, `pinned`, `status`, `tags` (JSON),
  `supersedes`, `source_turn_ids` (JSON), `source_session_ids` (JSON).
- New `type` enum `fact|pattern|preference|constraint|instruction`,
  enforced at both the store layer and the MCP tool schema — reject
  out-of-set, no coercion (hard switch, per "Decisions locked").
- Lifecycle methods: `supersedeAtom`, `mergeAtoms`, `archiveAtom`,
  `updateConfidence`, `updateTags`, `updatePinned`.
- `upsertAtom`: reject a `content`/`type` change on an existing id (§3.3);
  metadata-only changes (tags/confidence/priority/pinned/status) succeed in
  place; `confidence` defaults to `medium` when omitted on a new atom.

**Provenance (§5)**
- `atom_evidence(atom_id, stream_id, added_at)`, FK on `stream.id` — never
  `turn_id` (§5.1). Methods: `evidenceForAtom(atom_id)`,
  `atomsFromStream(stream_id)`, `atomsFromSession(session_id)` (joins
  through `stream.session_id`). `source_turn_ids`/`source_session_ids` on
  the atom row are derived from this join at write time (denormalized, not
  independently authoritative).

**Audit (§5.5, §8.2)**
- Create `consolidation_decisions` table (schema only). **Not populated** in
  this branch — Branch 2's consolidation logic populates it.

**T2 scenes — storage only (§6.1)**
- `scenes(scene_id, scene_kind[episode|topic], title NOT NULL, atom_ids
  JSON, summary NULLABLE, content_hash, status[active|retired],
  derived_from, superseded_by, created_at, updated_at)`.
- `scene_atoms(scene_id, atom_id)` many-to-many join table, used from the
  start (not deferred) so cross-kind membership needs no later migration.
- `scenes_fts` + `scenes_vec` virtual tables; extend `hybrid()` to accept
  `"scenes"` as a third kind.
- Id-addressed methods: `upsertScene`, `getScene`, `listScenes` (filterable
  by `scene_kind`/`status`), `removeScene`, `scenesForAtom(atom_id)`,
  `searchScenes`.
- **Breaking, intentional:** remove the path-addressed
  `readScene`/`writeScene`/`removeScene`/`listScenes` methods, the gateway
  routes `/scenes/{ls,read,write,rm}`, and the MCP tools
  `falda_scenes_ls`/`falda_scenes_read`; replace with the id-addressed
  routes/tools above. No populator yet in this branch — scenes exist as an
  empty, queryable table until Branch 2. Accepted per "Decisions locked."

**Recall (§7)**
- Parameterized blended re-rank: `w_recency`, `w_priority`, `w_confidence`,
  recency half-life all config, not hardcoded, from day one (§7.2).
- `status='active'` filtering on all recall paths (§7.3).
- Character budgets: 2000/hit, 12000 total, applied in ranked order (§7.4).
- Pinned-first pass: active `pinned=true` atoms fetched unconditionally
  within a reserved budget slice before query-ranked recall runs (§7.5).

**Migration:** additive `ALTER TABLE`/`CREATE ... IF NOT EXISTS` guarded by
schema introspection; run idempotently (safe to call twice); backfill per
"Decisions locked."

**Tests (added to `test/`, wired into `npm test`/CI):**
- Both turn-idempotency invariants + their conflict cases.
- Deterministic `(session_id, turn_index)` ordering vs. `ts` fallback.
- Content/type immutability rejection on `upsertAtom`.
- New `type` enum rejection (old enum values now rejected, not coerced).
- Recall re-rank ordering with configured weights.
- Pinned-first behavior (budget reservation, unconditional inclusion).
- Status filtering (superseded/merged/archived excluded from recall).
- Character budget enforcement (per-hit truncation, total cap).
- Scene CRUD + `searchScenes` against manually-seeded rows.
- Evidence union correctness (`atomsFromStream`/`atomsFromSession` joins).
- Migration + backfill idempotency (schema helper run twice is a no-op the
  second time; backfill values land correctly on pre-existing rows).

**Acceptance:** `npm run build` clean; `npm test` green; no behavior change
for existing callers beyond the two documented, intentional breaks (T2 API
replacement; `upsertAtom` content/type + enum rejection).

## Branch 2 — `feature/distill-core` (distill core + queue + triggers)

**New `src/distill/` module** (pure — no env reads, no HTTP calls inside
`core.ts`/`context.ts`):

- `prompts.ts` — extraction / consolidation / scene-title / scene-summary /
  core-synthesis prompts; single source of truth for `VALID_TYPES`.
- `core.ts` — `distillOnce(store, llm, opts)`:
  - **L1 extract**: LLM call over a window of new turns →
    `{type, content, confidence}` candidates; out-of-set `type`/`confidence`
    is a retryable failure, never coerced (§8.2).
  - **L1 consolidate**: recall-based merge/update/skip/store decision per
    candidate, fixed candidate limit (default 8, configurable) + per-pass
    cost ceiling; degradation rules (a merge naming stale targets degrades
    to store; a no-op merge degrades to skip); evidence population + union
    on update/merge (§5.3); confidence re-assessed, never inherited, on
    merge; `consolidation_decisions` populated with pass-id-derived keys
    (idempotent under replay).
  - **L2 organize**: episode membership recomputed directly from
    `atom_evidence` grouped by session (§5.6) — deterministic, many-to-many,
    no clustering, no hysteresis; topic membership via embedding clustering
    over `atoms_vec` + hysteresis reconciliation against existing `topic`
    scenes (match threshold vs. reorg threshold, both config, §6.2–§6.3),
    with `derived_from`/`superseded_by` set on split/merge/retire. Both
    kinds get mechanical provisional titles at creation.
  - **Lazy title/summary + re-embed pass**: hash-gated on the exact §6.4
    `content_hash` definition (`hash(scene_kind + sorted(active member atom
    id+content))`); gate covers both the LLM call and the re-embedding.
  - **L3**: core synthesis over all active scene structure, hash-gated on
    the exact §8.4 hash (`hash(for each active scene sorted by scene_id:
    scene_kind + title + sorted(member atom id+content))`); empty-scene
    retirement and empty-store core deletion (§8.7, §9).
- `context.ts` — private `assembleContext(store, query, budget)` (§8.9):
  pinned atoms → query-ranked atoms → query-ranked scenes (both kinds) →
  core excerpt, budget-trimmed in that priority order. Not exposed via
  gateway or MCP in this branch — internal, eval-harness-only.
- `watermark.ts` — per-store watermark table + deterministic pass-id
  derivation from `(store, watermark_start, watermark_end)` (or a hash of
  the window's turn ids), per §8.5.
- `queue.ts` — per-store `distill_jobs` table: `enqueue` (coalesces
  duplicate pending jobs for the same store), `claimNext`, `complete`,
  `fail` (30s→900s doubling backoff, 8-attempt ceiling → `dead` row).
- `cli.ts` — `--once` backfill mode and a daemon/interval mode.

**Transaction boundary (§8.5):** L1's atom mutations + evidence edges +
`consolidation_decisions` rows + watermark advance commit as one
`better-sqlite3` transaction — all or nothing, replay-safe (content-hash
atom ids make a re-run of an already-committed window a no-op). L2/L3 run
independently, outside that transaction, retried freely because they are
pure functions of the current active-atom/scene set (hash-gating makes an
unchanged pass free).

**Gateway (`src/gateway.ts`):** in-process background worker draining
`distill_jobs` via `PoolManager.resolve(...)` → `distillOnce` directly (no
self-HTTP, no bearer token to itself); self-enqueue interval timer; new
authenticated `POST /distill` route added to `WRITE_ROUTES`. **`self`
stores only** in this branch — pool distillation stays deferred (§2, §13).

**MCP (`src/mcp.ts`):** new tools `falda_distill` (enqueue, returns a job
id — asynchronous, no synchronous "distill now" guarantee, §8.8) and
`falda_distill_status` (poll by job id). Neither ever distills inline or
writes T2/T3 in-process from the MCP handler.

**Evaluation harness:** extend with `(query, budget) → expected assembled
context` cases alongside the existing `(query → expected atoms)` shape
(§8.9, §7.2), exercising `assembleContext` directly — this is what makes the
retrieval eval meaningful beyond atom ranking, per the locked decision.

**Tests (added to `test/`, wired into `npm test`/CI):**
- Extract→consolidate action correctness for all four actions
  (store/update/merge/skip) including degradation rules, with evidence
  union verified.
- `consolidation_decisions` idempotency under a replayed pass id.
- Watermark-transaction atomicity: simulate a failure between L1 stages and
  confirm the watermark did not advance and no partial atom state landed.
- Type/confidence rejection at the extraction boundary.
- An atom produced by a merge of multi-session evidence appears in every
  corresponding episode scene (not just one) — the concrete case §6.2 turns
  on.
- Topic derivation from embedding clusters; hysteresis reconciliation both
  below and above the reorg threshold; retirement sets
  `derived_from`/`superseded_by` correctly.
- A newly-created scene is usable (listable, searchable) by its provisional
  title before any lazy title/summary pass has run.
- Hash-gate skip using the exact §6.4/§8.4 hash definitions, including: an
  unchanged scene skips its re-embedding too, and a confidence-only atom
  change does **not** dirty a scene (this is the specific contradiction
  MODEL.md v4 resolved — needs a regression test).
- `assembleContext` budget trimming and tier-priority ordering.
- Queue coalesce/backoff/dead-letter behavior.
- Concurrent-write conflict during an in-flight pass (§8.6).
- `/distill` (gateway) and `falda_distill`/`falda_distill_status` (MCP)
  enqueue + auth (write-route gating, tenant/pool checks).

**Acceptance:** `npm run build` clean; full suite green; distillation runs
end-to-end on a `self` store; Branch 1's empty-scene interim closes (scenes
now populate via L2).

## Branch 3 — `feature/distill-retire-docs` (retire + reconcile + docs)

- **Hard-delete** `src/distiller.ts` and `falda_distiller.py`; remove any
  npm scripts or install-doc references to them.
- Update docs to match the shipped system:
  - `README.md` — distillation section + env var table.
  - `docs/API.md` — document `/distill`, the new id-addressed T2 routes;
    correct the gateway port (`8077`, not `8078`).
  - `docs/MCP.md` — document `falda_distill`, `falda_distill_status`,
    `falda_scenes_search`, and the new atom `type` enum.
  - `docs/POOLS.md` — correct pool-ownership language per §2; note
    cross-tenant pool distillation as the still-open §13 item.
  - `docs/SCALE.md` — mark delivered phase items; add the §8.4
    core-token-growth scale risk as a known, accepted limitation.
  - `docs/HARNESS_INTEGRATION.md` — remove the Python-distiller setup
    instructions.
- Remove `docs/MODEL.md` §14 and this file (`PLAN.md`). Before deleting,
  check whether any of §13's still-open items should be copied into
  `docs/future/` rather than disappearing with the plan doc.
- Confirm the `origin-clean` CI guard still passes and the full test suite
  is green after all deletions.

**Acceptance:** `npm run build` clean; `npm test` green; both old
distillers gone from the tree; docs describe only the shipped system; no
dangling references to `PLAN.md` or MODEL.md §14 remain.
