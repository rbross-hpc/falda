# FALDA Data Model — Concepts

Status: **shipped.** Describes the FALDA data model as implemented.
FALDA's memory model with [`shinzui/kioku`](https://github.com/shinzui/kioku)
(see that repo's `docs/user/concepts.md`, `docs/user/distillation.md`,
`docs/user/recall.md`) — and after three rounds of design review. The first
round **diverges** from kioku in several places where copying its constants
or conventions would have imported unresolved ambiguities (every such
divergence is called out explicitly; see §12 for the full crosswalk). The
second round **reframes T2** from a second summarization step into a
distinct *organizational* layer, so that each tier does a genuinely
different kind of work instead of three tiers repeating "summarize the
level below" at decreasing granularity — see §1 for the reframe and §6 for
what it means concretely. The third round fixes a contradiction the
reframe introduced (scene membership was described as both per-kind and
"one scene overall" — see §6.2), pins the provenance foreign key to a row
that always exists (§5.1), removes a dangling confidence/content-hash
inconsistency (§3.3), defines the T2/T3 content hashes precisely (§6.1,
§8.4), gives scenes a lifecycle for reorganization (§6.1), and pulls a
private cross-tier context-assembly function forward into Branch B so the
model can be evaluated as a whole, not just atom-by-atom (§8.9, §13).

This doc describes the FALDA data model as shipped in `src/falda.ts`,
`src/pools.ts`, `src/distill/`, and related files. A few points are
explicitly **not yet resolved** — see §13 — because they need empirical work
(a retrieval eval set) or further design (context assembly, erasure) before
they can be pinned.

This page is the mental model behind FALDA. Read it once; the rest of the
codebase and docs assume it.

## 1. The four tiers, on two axes

FALDA is four strata — but they are not four steps of the same operation
getting progressively shorter. Reading them that way is exactly what made
an earlier version of this design describe T2 as "a cluster of atoms,
summarized" and T3 as "a summary of those summaries": two tiers doing the
same kind of work (summarization) at different granularities, which made T2
redundant in everything but size. That is a real design flaw, not a framing
nitpick, and this section states the corrected model.

There are **three distinct transformations** stacked here — evidence into
knowledge, knowledge into organization, organization into compression — not
one summarization operation repeated three times:

```
 T3  Core      ── COMPRESSION: one durable persona/project profile per store
       ▲          "who/what is this, and what's durable about it" — genuinely
       │          compressed from structure, not "a shorter version of T2"
       │
 T2  Scenes    ── ORGANIZATION: kinded groupings of atoms — episodes, topics
       ▲          "how is what I know structured?" — membership + kind is
       │          the artifact; a narrative summary is a secondary rendering
       │
 T1  Atoms     ── KNOWLEDGE: concise, durable memory sentences
       ▲          "what do I know?" — a transformation of KIND from T0, not
       │          a shorter version of it
       │
 T0  Stream    ── EVIDENCE: raw conversation/observation turns — the floor
```

- **T0 → T1 is a transformation of kind: evidence → knowledge.** A turn is
  something that was *said*; an atom is something that is *known*. This is
  already not mere compression — it's typed, discrete, durable propositions
  extracted from unstructured evidence (§8.1–8.2).
- **T1 → T2 is organization, not compression.** T2's job is to answer *"how
  is what I know structured — what episodes, topics, projects, or threads
  does it belong to?"* Its primary artifact is **membership and kind**
  (which atoms belong to which named grouping, and what kind of grouping
  that is), not prose. A human-readable summary of a scene is a useful,
  optional *rendering* of that structure — it is not the reason the scene
  exists. See §6.
- **T2 → T3 is genuine compression.** Core synthesizes across the
  *structure* T2 provides (kinds, titles, and their member atoms) into one
  durable, always-loadable profile. Because T3 compresses over organized
  knowledge rather than over a set of prose summaries, it is not
  "summarizing a summary" — it is doing the one genuinely compressive step
  in the whole pipeline. See §8.4.

| Tier | Name   | Kind of work | What it is | Storage (target) |
|------|--------|--------------|------------|-------------------|
| T0   | Stream | evidence | raw conversation/observation turns | SQLite `stream` table + FTS5 + sqlite-vec |
| T1   | Atoms  | knowledge (evidence→kind transformation) | distilled atomic memories | SQLite `atoms` table + FTS5 + sqlite-vec |
| T2   | Scenes | organization (structure, not summarization) | kinded groupings of atoms (episodes, topics), each with membership + an optional summary | SQLite `scenes` table + FTS5 + sqlite-vec, + best-effort markdown mirror |
| T3   | Core   | compression | one long-lived persona/project profile per store, synthesized from T2's structure | one markdown blob file (`core.md`) |

**Tiers are not the same axis as atom `type`** (§3). A tier says *where* a
memory lives and *what kind of transformation* produced it. `type` is a
label on T1 atoms only (`fact`, `pattern`, …). T0/T2/T3 have no `type`
field.

**Why this reframe, concretely:** under the two-axis model, T2 has a reason
to exist independent of T3 — an agent can browse or recall *by episode* or
*by topic* (§6.5, §7) whether or not a core document has ever been
synthesized, and a scene is useful the moment its membership is known, even
before an LLM has written a word of summary (§6.1). T3 remains the one tier
whose entire job is compression, which is also what makes it the tier
FALDA is comfortable leaving as an accepted scale risk for now (§8.4) —
there is exactly one compressive step to bound, not two.

## 2. Scope: tenant + pool, and what a pool actually is

FALDA partitions memory by **(tenant, pool)** — see `docs/POOLS.md` for the
full contract. This is FALDA's equivalent of kioku's "scope," but the
ownership model needs to be stated precisely, because it is easy to
misdescribe (an earlier version of this doc did).

- **tenant** — an agent/project identity, selected per-request via
  `X-Falda-Tenant`. Always required, no default.
- **pool** — either the reserved private namespace `self`, or the name of an
  explicitly-declared **shared resource**.

**A named pool is an independent shared resource, not a namespace scoped
beneath a tenant.** Pool identity is the pool *name* alone — there is
exactly one physical store per pool name (`root/pools/<name>/`), and every
tenant on its member roster reads and writes that same store. `(tenant,
pool)` is an **access grant**, not a storage address: the tenant supplies
authorization and an attribution identity (see §5), not a separate physical
location. This is distinct from `self`, where the pair genuinely *is* the
physical address (`root/tenants/<tenant>/self/`) because no sharing is
possible there.

Stated this way, the two "physical separation" properties in this doc are
about two different things and both hold simultaneously:

- **`self` stores are physically isolated per tenant** — no shared table, no
  predicate-based leak risk (`src/pools.ts`).
- **A named pool is physically *shared* by design** among its declared
  members — that is the entire point of declaring one. It is isolated from
  every *other* tenant and every *other* pool, but not from its own members.

Sharing is opt-in and explicit: a pool exists only after being declared with
a member roster; touching an undeclared pool is an error, never an
autovivify. Per-member access is `none | read | readwrite`.

Every tier — stream, atoms, scenes, core — is scoped to one physical store
(one `self`, or one named pool). Distillation (§8) runs per-store. **This
plan's initial branches implement distillation only for `self` stores.**
Distilling a shared pool raises questions this doc intentionally defers
(§13): whose LLM/embedder credentials run the pool's worker, and how
provenance (§5) attributes a pool turn to the tenant that contributed it.

## 3. Memory (T1 Atom)

*(Implemented — `src/falda.ts`.)**

An atom is one durable thing an agent has learned.

| Field | Meaning | Status |
|---|---|---|
| `id` | Stable identifier | current |
| `type` | One of `fact \| pattern \| preference \| constraint \| instruction` | current column, **new enum** |
| `content` | The memory text itself. **Immutable** once written (§3.3). | current |
| `background` | Optional free-text supporting context for humans — not a structured-data sink (§3.5) | current |
| `priority` | Re-rank boost signal, `0`–`100` (§3.2) | **new** |
| `confidence` | `high \| medium \| low` — evidential fidelity, not truth (§3.2) | **new** |
| `pinned` | Boolean. If true, always included in a pinned-first recall pass (§7.5) | **new** |
| `status` | `active \| superseded \| merged \| archived` | **new** |
| `tags` | Free-form labels (JSON array); filter-only, does not affect ranking or regeneration (§3.2) | **new** |
| `supersedes` | Id of the atom this one replaces, if any | **new** |
| `source_turn_ids` / `source_session_ids` | Denormalized provenance summary — see §5 | **new** |
| `created_at` / `updated_at` | Timestamps | current |

### 3.1 Atom types

- **fact** — a stable truth (e.g. "the deploy script lives in `bin/release`").
- **pattern** — a recurring behavior or workflow.
- **preference** — a stated like/dislike.
- **constraint** — a hard rule ("never touch the `legacy/` directory").
- **instruction** — a standing directive ("always run the formatter before committing").

Adopted verbatim from kioku, replacing FALDA's three prior divergent
vocabularies (the shipped MCP enum, the Python sidecar's, and
the now-deleted `src/distiller.ts` — see §12 for the mapping). `type` outside this set is
**rejected**, not silently coerced.

### 3.2 Priority, confidence, and pinning

These three fields are easy to conflate. They answer three different
questions, and this doc pins each one precisely because an earlier version
left two of them ambiguous enough to be actively misleading.

**Priority** answers *"how much should this atom be boosted in ranking,
relative to other relevant atoms?"* It is a re-rank weight, `0`–`100`,
clamped. Lower is higher-boost; `0` is the maximum. **Priority `0` is named
`critical`, not "always inject."** An earlier draft used kioku's "always
inject" convention for priority `0` and then had to admit, in the same
breath, that priority only affects re-ranking *after* candidate selection —
so it never actually guarantees inclusion. That is a real contradiction, not
a documentation nuance, and copying it would have kept a broken promise in
the model. `critical` claims exactly what priority `0` delivers: maximum
boost, nothing more.

Priority is **not extractor-assigned**. The L1 extraction LLM call does not
set `priority` — an LLM-assigned, per-atom, heavily-weighted ranking signal
would be a noisy, non-reproducible input feeding the highest-leverage term
in the recall formula (§7.2), which is precisely the failure mode this
review is trying to avoid elsewhere. Instead: **priority is caller/policy
set.** Atoms written directly by an agent or operator (`falda_atoms_upsert`)
may set it explicitly. Atoms produced by distillation get a **type-derived
default** (e.g. `constraint`/`instruction` default higher than
`fact`/`pattern`/`preference`); the exact defaults are a tuning parameter,
not fixed by this doc.

**Pinning** answers a different question: *"must this atom be present in
every recall result for this store, regardless of the query?"* This is
what "always inject" was actually reaching for, and it needs its own
mechanism, not an overloaded priority value. `pinned` is a plain boolean,
mutable independent of `type`/`priority`. Recall's pinned-first pass (§7.5)
fetches all active pinned atoms unconditionally, within a reserved budget,
before running query-dependent ranking on the rest. A standing instruction
like "never modify production" should be `pinned=true`, not `priority=0`.

**Confidence** answers a third, still-different question, and its meaning
is the one most likely to be guessed wrong: **confidence is the atom's
confidence that it accurately and faithfully represents its supporting
evidence — not a general truth probability, and not a freshness signal.**
An atom can be `high`-confidence (it faithfully captures what the source
turns said) and still be stale (the fact changed since); staleness is
handled entirely by **age** (recency decay, §7.2) and **supersession**
(§3.3), deliberately kept separate. Concretely:

- During L1 extraction, `confidence` is the model's assessment of
  summarization fidelity to the turns it was drawn from — a judgment LLMs
  are reasonably good at — never an epistemic claim about whether the fact
  is true, which they are not reliable judges of.
- Confidence is only strictly meaningful when an atom has supporting
  evidence to be faithful *to* (§5). An atom written with **no** evidence
  edge (agent-authored via `falda_atoms_upsert`, or imported) has no
  fidelity to assess. Such atoms default to `medium`: a neutral value, not
  an assertion of moderate fidelity. They are never auto-verified.
- On consolidation **merge/update** (§8.2), confidence is **re-assessed**
  against the union of absorbed evidence, not inherited from either parent
  — a merge can raise confidence (corroborating evidence) or lower it (the
  merged claim over-generalizes what any one turn supports).

`confidence` outside `high|medium|low` is rejected, not coerced.

### 3.3 Immutability and lifecycle

**An atom's proposition — its `content` and `type` — is immutable once the
atom exists.** Metadata (`tags`, `confidence`, `status`, `priority`,
`pinned`) may be updated in place. Changing the proposition itself always
means recording a **new, superseding atom**; nothing is ever rewritten to
say something different than what it originally said.

This closes a real inconsistency in the previously merged version of this
doc: distillation's "update" action already worked this way (a new atom
supersedes the old one), but direct writes via `falda_atoms_upsert` used
the same `id` to silently rewrite content/type in place — a second,
contradictory notion of atom identity living behind a different API path.
Two identity models meant provenance and audit history depended on which
door a caller walked through. There is now one rule, enforced regardless of
call path: **`falda_atoms_upsert` on an existing id with changed
`content` or `type` is rejected as an error** ("content is immutable; the
caller must record a new atom and supersede, rather than being silently
allowed to mutate a proposition in place"). Metadata-only changes to an
existing id continue to succeed. Callers using content-hash-derived ids
(as the distiller does) get this for free: different content naturally
produces a different id.

A memory starts **active**. From there:

- **superseded** — replaced by a newer atom (the new one records
  `supersedes`).
- **merged** — folded into another atom (a winner absorbs one or more
  losers).
- **archived** — retired without a replacement.

Superseded, merged, and archived are **terminal**. Only `active` atoms are
returned by recall (§7.3).

**Forgetting propagates, and it is logical, not erasure — see §9 for the
distinction.** Superseding, archiving, or merging an atom dirties every T2
scene that has that atom as a member (§6), which transitively dirties T3
core — because those lifecycle transitions change *which atoms are active
members* of a scene, and scene/core hashes are defined over exactly that
membership (§6.1, §8.4). Changing **confidence**, **tags**, or
**priority**/**pinned** does **not** dirty anything downstream: confidence
is recall-only metadata (§3.2) and is deliberately excluded from the T2/T3
content hash and prompts — an earlier draft of this doc claimed a
confidence change dirties scenes while *also* defining the scene hash as
covering only content + status, which are two claims that cannot both be
true; this doc keeps the hash definition and drops the propagation claim.
Tags are filter-only and never feed a hash or prompt either. Priority/
pinned affect ranking only, not what a scene or core says.

When a store's last active atom is forgotten, every scene that would be
left with zero active members is **deleted**, not regenerated empty; if
that empties the store entirely, core is deleted too. There is nothing left
to summarize — see §9 for what this does and does not remove from the
store.

### 3.4 Idempotency

A duplicate atom write that matches what already happened succeeds as a
no-op. Because content/type are immutable (§3.3), "matches what already
happened" is unambiguous: same id, same content, same type. Anything else
targeting an existing id is a metadata update or a rejected conflict — there
is no third case.

### 3.5 `background` is not a structured-data sink

`background` is optional free text for a human or agent to read — it is
**not** where priority, provenance, or source information belongs. An
earlier iteration of the distillation sidecar packed
`priority=…;src=distiller;at=…` into `background`, because no structured
field existed yet. Now that `priority`, `confidence`, `source_turn_ids`, and
timestamps are real columns (§3, §5), `background` goes back to being what
its name says: free-text context, nothing parsed out of it by any code
path.

## 4. Evidence (T0 Stream)

*(Implemented — `src/falda.ts`.)**

### 4.1 Current fields

| Field | Meaning |
|---|---|
| `id` | Row identifier |
| `session_id` | Which session/conversation this turn belongs to |
| `role` | Turn role (`user`, `assistant`, …) |
| `content` | Turn text |
| `ts` | Timestamp |

`session_id` is already captured, indexed, and queryable/deletable by
session (`src/falda.ts`).

### 4.2 New fields — deterministic ordering + full idempotency

| Field | Meaning |
|---|---|
| `turn_index` | Strictly-increasing index within a session (nullable — legacy callers may omit it) |
| `turn_id` | Idempotency token for this turn, independent of the row `id` |

Two problems this fixes, and **two invariants**, not one, are enforced:

- **Ordering.** Stream reads today order by `ts` (an ISO timestamp string);
  same-millisecond writes or clock skew can reorder turns and corrupt the
  transcript a distillation pass reconstructs. When `turn_index` is
  present, ordering is `(session_id, turn_index)` instead, falling back to
  `ts` when absent.
- **Idempotency has two invariants, both enforced by a unique index each:**
  1. `UNIQUE(session_id, turn_index) WHERE turn_index IS NOT NULL` — the
     same index cannot be recorded twice with different content: a stale or
     out-of-order retry cannot silently overwrite a committed turn.
  2. `UNIQUE(session_id, turn_id) WHERE turn_id IS NOT NULL` — the same
     idempotency token cannot be reused at a *different* index. An earlier
     version of this doc enforced only the first invariant; kioku enforces
     both, and dropping the second would let a caller's replay logic
     silently double-record a turn under a new index while believing its
     `turn_id` guaranteed idempotency.

Given both indexes: re-adding an identical `(session_id, turn_index,
turn_id, content)` is a no-op; anything that collides on one unique key
while disagreeing on the other is a rejected conflict. Callers that omit
`turn_index`/`turn_id` entirely keep today's UUID-id, `ts`-ordered,
no-idempotency behavior exactly.

### 4.3 Explicitly not adopted (this pass)

kioku's T0/Session model additionally has: a session `focus`/topic field, a
full session lifecycle (`start → running → awaiting → completed/failed`),
delegation/continuation lineage between sessions, and per-turn tool-summary
+ token-count metadata. None of these land in this pass — see §13.

## 5. Provenance: the atom → evidence edge

*(Implemented in `src/falda.ts` and `src/distill/core.ts`.)* This section did not exist in
the first version of this doc. T1 atoms carry `type`, `content`,
`background`, `priority`, `confidence`, `status`, `tags`, and supersession
— but nothing that says *what evidence supports this specific memory*. The
`consolidation_decisions` audit table (§8.2) records **why a distillation
decision was made**; that is not the same fact as **what evidence a memory
is grounded in**, and the model needs both, kept explicitly distinct.

### 5.1 The edge

**The edge references `stream.id`, not `turn_id`.** `stream.id` is the
row's primary key and always exists (`src/falda.ts`); `turn_id` (§4.2) is
an *optional* external idempotency token that is null for every legacy turn
and for any caller that doesn't supply one. A provenance foreign key must
reference the identifier that is always present, not the one that is
sometimes absent — keying the edge on `turn_id` would leave provenance
unrepresentable for exactly the turns FALDA already has.

The join table is therefore `atom_evidence(atom_id, stream_id, added_at)`,
with `stream_id → stream.id`, plus a denormalized `source_turn_ids` /
`source_session_ids` JSON summary on the atom row for cheap single-atom
reads (derived from joining through `stream_id` at write time, not
independently authoritative). The join table is the canonical edge and
supports both directions: `evidenceForAtom(atom_id)` and
`atomsFromStream(stream_id)` / `atomsFromSession(session_id)` (the latter
via a join through `stream.session_id`). `turn_id` and `turn_index`, where
present, are reachable transitively through `stream_id → stream`, so
nothing is lost by not storing them directly on the edge.

### 5.2 Granularity

Extraction (§8.2) runs over a **window** of turns, not one turn at a time,
so the honest unit of attribution today is *"this atom was distilled from
this window of turns,"* not a specific sentence within it. The edge records
window-level attribution now. Per-turn attribution (the extractor stating
exactly which turn(s) support a given atom) is future work (§13) — it would
need a structured-output contract from the extractor and is not required
for the provenance edge to be useful.

### 5.3 Population

- **store** (§8.2): the new atom's evidence = the extraction window's turns.
- **update / merge** (§8.2): the winning atom's evidence = the **union** of
  every absorbed atom's prior evidence, plus the current window's turns.
  Provenance is never dropped across consolidation — an atom's evidence
  trail survives every supersession in its lineage.
- **skip**: no evidence recorded (no atom was written).

### 5.4 Deletion policy

`deleteStream` can remove T0 turns that atoms depend on. Deletion does
**not** cascade to delete or archive the dependent atoms automatically.
Instead, `deleteStream` **returns the set of atom ids whose evidence was
affected** by the deletion, so a caller (or a reconciliation pass) can
choose to re-evaluate them. The memory survives; its provenance is flagged
stale rather than silently dangling or aggressively cascaded.

### 5.5 Provenance vs. audit — not the same table

- **`atom_evidence`** answers *"what supports this atom existing, with this
  content?"* — the evidence.
- **`consolidation_decisions`** (§8.2) answers *"why did a distillation
  pass take this specific action (store/update/merge/skip)?"* — the
  decision, its targets, and its rationale.

An atom can have rich evidence and a terse audit rationale, or vice versa.
Neither substitutes for the other, and a future verification pass — "does
this atom still faithfully represent its evidence?" (§3.2) — reads
`atom_evidence`, not `consolidation_decisions`.

### 5.6 Provenance is also what defines episode membership

`atom_evidence`, joined through `stream_id` to `stream.session_id`, is not
only an audit/verification trail — it is the **authoritative definition**
of which sessions an atom's evidence spans, and therefore of which episode
scenes (§6.2) that atom belongs to. Episode membership is not a separate
piece of state that could drift from provenance; it is a live projection of
it: *the episode scenes for atom A are exactly the distinct sessions
reachable from A's `atom_evidence` rows.* This is what makes an atom
produced by a **merge or update** (§5.3) correctly and automatically belong
to every session any of its absorbed evidence traces back to, with no
separate bookkeeping — see §6.2 for why this specifically breaks a
single-episode-per-atom assumption, and why the fix is to make episode
membership many-to-many rather than to constrain provenance union.

## 6. Scenes (T2): the organizational layer

*(Implemented in `src/falda.ts`.)** This is
the largest structural change from the first version of this doc, in two
stages. The first stage replaced one path-addressed markdown blob per store
with a set of clustered summaries. That was progress, but it was still a
*summarization* tier, one step removed from core — "a cluster of atoms,
summarized" is only a smaller version of "a store, summarized." The second
stage, reflected here, changes what a scene fundamentally *is*: not a
summary at a different granularity, but a **named organizational unit** —
membership plus a kind — of which a narrative summary is one optional,
secondary rendering. See §1 for why this distinction is the point.

### 6.1 Schema

| Field | Meaning |
|---|---|
| `scene_id` | Stable identifier |
| `scene_kind` | `episode \| topic` (§6.2) — what *kind* of organizational unit this is |
| `title` | Label naming the unit. **Always populated** — provisional/mechanical at creation, optionally replaced by an LLM label later (§6.4). Never null. |
| `atom_ids` | Membership (JSON array) — **the primary artifact of a scene** |
| `summary` | Narrative markdown body — **secondary**, optional, hash-gated (§6.4). Absent until the first lazy pass runs. |
| `content_hash` | Canonical hash of exactly the L2 summary prompt's input (§6.4) — used to hash-gate regeneration (§8.3) |
| `status` | `active \| retired` (§6.3) |
| `derived_from` / `superseded_by` | Prior/successor `scene_id`(s) recorded across a split, merge, or reorganization (§6.3) |
| `created_at` / `updated_at` | Timestamps |

**Membership and kind are primary; the summary is not what makes a scene
useful or valid.** A scene with members, a `scene_kind`, and a title is a
complete, recallable-by-membership, browsable-by-kind unit the moment its
structure is derived — "the episode from this session" or "the topic this
atom belongs to" is a meaningful answer with zero LLM calls involved. The
summary is a rendering of that structure for humans/agents who want prose,
generated lazily and only when `content_hash` changes (§6.4). This
inversion — structure first, narrative second and optional — is what §1
means by T2 being organization rather than a second round of summarization.

**`title` is never null, by a two-stage rule, so no code path has to
special-case an unnamed scene:** at creation, `title` is set
**mechanically** from the grouping itself — e.g. `Session <session_id>` for
an episode, `Topic <n>` for a topic cluster, with no LLM call. The lazy
summary pass (§6.4) may **replace** this provisional title with an
LLM-written label when it runs, but a scene is fully identifiable, listable,
and searchable on its provisional title from the moment it exists. (An
earlier draft left `title` implicitly LLM-only while also claiming a scene
needs zero LLM calls to be useful — the provisional title is what resolves
that contradiction, in preference to making `title` nullable.)

Membership is also recorded in a `scene_atoms(scene_id, atom_id)` join
table for efficient reverse lookup (`scenesForAtom(atom_id)`), which is what
makes forgetting-propagation (§3.3) surgical: an atom's lifecycle change
dirties exactly the scenes that reference it, not every scene in the store.
This join table is many-to-many, and — unlike an earlier draft of this
doc — that is exploited from the start, not deferred: see §6.2 for why an
atom legitimately belongs to more than one scene simultaneously once
`episode` and `topic` are both first-class dimensions.

Storage is SQLite (rows are authoritative), with a **best-effort** rendered
markdown mirror written to `blobDir/scenes/<scene_id>.md` whenever a summary
is (re)generated, so a scene remains directly readable as a file. The
mirror is a convenience cache; if the write fails, distillation still
succeeds and the row remains the source of truth.

The previous path-addressed scene API
(`/scenes/{ls,read,write,rm}` keyed by a file `path`) is **replaced**, not
extended, by an id-addressed entity API — this is a deliberate breaking
change, on the grounds that the T2 surface was read-only for
agents and lightly used, so a clean break now is cheaper than carrying two
addressing schemes forward.

### 6.2 Two kinds, two derivation methods, two different membership rules

A scene's `scene_kind` says what *kind* of organizational relationship
groups its members — and, deliberately, different kinds are derived
differently and have **different membership cardinality**, because
"what groups these atoms" is not one question and the two kinds this
model starts with are not analogous relationships:

- **`episode`** — **evidence-derived and many-to-many.** An atom belongs to
  the episode scene for *every* session appearing among its
  `atom_evidence` rows (§5.6) — not at most one. This is not a design
  preference; it is forced by consolidation (§5.3): when an update or merge
  unions two atoms' evidence, the resulting atom's evidence can legitimately
  span multiple sessions (atom A's evidence might trace to sessions 17 and
  22), and an atom whose evidence spans two sessions genuinely belongs to
  both sessions' episodes — collapsing it into one would silently discard
  provenance that the model otherwise goes out of its way to preserve
  (§5.3, §5.5). Episode membership therefore needs **no clustering and no
  reconciliation hysteresis** (§6.3 applies only to `topic`): it is a
  deterministic, always-consistent projection of the evidence graph,
  recomputed trivially from `atom_evidence` on every pass. Episode scenes
  use only T0's existing `session_id` (§4.2, §5.1) — no `focus`, no session
  lifecycle (§4.3); those remain deferred (§13).
- **`topic`** — **semantic and, initially, one-per-atom.** Derived from
  **embedding clustering** over `atoms_vec` (which already exists for
  recall): atoms that are semantically close, independent of when they were
  recorded, form a topic, and — to start — each atom is assigned to at most
  one topic cluster. Unlike episode membership, this *is* a genuine
  reconciliation problem (which cluster does an atom belong to, and did
  that assignment change), so topic membership is what §6.3's
  hysteresis-based reconciliation governs. Multiple simultaneous topic
  memberships per atom (soft clustering) is a plausible future refinement,
  deferred (§13) because it complicates reconciliation immediately for
  benefit that isn't yet demonstrated.

**The correct invariant is therefore per-kind, not global:** an atom may
belong to **many** episode scenes (one per contributing session) **and**
**at most one** topic scene, simultaneously — not "at most one scene
overall." An earlier draft of this section asserted a single global
partition "for now, deferred later"; that was self-contradicting on two
counts — it collapsed the very episode/topic distinction this tier exists
to represent (§1), and it was incompatible with evidence union regardless
of any later relaxation. There is no simpler version of this invariant to
defer to; the `scene_atoms` join table already supports it exactly as
written, so implementing the artificial single-partition rule first would
have been more work, not less.

`project` and `thread` are plausible future kinds (goal-bounded and
cross-session-continuity groupings, respectively) but have no defined
derivation method yet — a project isn't recoverable from embeddings or
session boundaries alone — so they are explicitly deferred (§13) rather
than added as labels with no real derivation behind them.

An LLM call is used only to write a scene's **title (optionally, replacing
the provisional one) and, lazily, its summary** (§6.4) — never to decide
membership. Membership derivation is mechanical for both kinds (a
provenance projection for episodes, clustering for topics), which keeps it
deterministic and (for episodes) essentially free, and reserves the LLM for
what it's good at: naming and narrating a structure that already exists.

### 6.3 Reconciliation across passes: stable identity with hysteresis (topics only)

**This section applies to `topic` scenes.** Episode scenes need no
reconciliation — membership is recomputed as a direct, deterministic
projection of `atom_evidence` on every pass (§6.2, §5.6), and an episode
scene's identity is simply keyed by its session (stable by construction,
nothing to reconcile).

**Topic scene identity across passes is stabilized, not naively
recomputed.** Re-deriving topic clusters from scratch on every pass would
reassign `scene_id`s constantly, defeating hash-gated regeneration (§6.4,
§8.3) and making topic scenes useless as durable, independently-recallable
targets (§6.5). Naive permanently-fixed identity is just as wrong the other
direction — an early bad clustering would ossify. The rule is a
**reconcile-with-hysteresis** step run every pass:

1. Re-cluster the store's current active atoms fresh.
2. Match each new cluster against existing `topic` scenes by membership
   overlap; a match above a **match threshold** keeps the prior `scene_id`
   (atoms may have joined or left, but it is judged "the same topic," and
   only regenerates its summary if `content_hash` changed).
3. A proposed reorganization of existing topic scenes (a split, a merge, or
   a reassignment) only takes effect if it clears a separate, higher
   **reorg threshold** — enough net membership churn, or a new cluster
   large/cohesive enough to justify disruption. Below that bar, the prior
   scene structure wins even if the fresh clustering would have drawn
   slightly different lines.
4. A new cluster with no adequate match spawns a new `scene_id`; an
   existing topic scene with no matching cluster is **retired**
   (`status='retired'`), not deleted — see below.

Both thresholds are configuration, not fixed constants — see §13 (they
belong in the same eval-driven tuning pass as the recall weights, §7.2).

**Reorganizations are recorded, not silent, because topic scenes are
durable external references.** A caller (or a prior recall result) may hold
a `scene_id` across a pass in which that topic was split, merged into
another, or retired outright. `status='retired'` plus `derived_from` /
`superseded_by` (§6.1) record the transition: a split sets `derived_from`
on the new scenes to point back at the retired parent; a merge sets
`superseded_by` on the retired scenes to point at the winner. A stale
external reference to a retired `scene_id` therefore resolves to an
explainable lineage instead of a silent 404 or an unexplained content
change under the same id. This is deliberately lighter than a full
`scene_reconciliation` audit table (analogous to how atom supersession
(§3.3) is tracked via columns, not a separate table) — the lineage columns
are enough to answer "what happened to this scene," which is the actual
requirement.

An episode scene has an analogous but simpler lifecycle: it is retired only
when no atom's evidence traces to its session anymore (the natural
consequence of the same-session atoms all being forgotten, §3.3), and it
has no split/merge case — a session's identity does not change — so
`derived_from`/`superseded_by` are always null for `episode` scenes.

### 6.4 Title and summary generation is a separate, lazy, hash-gated step

Because membership is primary (§6.1), narrative generation is decoupled
from reconciliation: a scene's structure (membership, kind, provisional
title) can update on every pass, while its **LLM-written title (if any) and
summary** only regenerate when `content_hash` changes — and a brand-new
scene can exist, be recalled by membership, and be browsed by kind under
its provisional title before an LLM has ever run against it, if the worker
hasn't reached that step yet. This is the same hash-gating discipline as
L3 (§8.4), now applied as an *optional, separable* pass rather than a
mandatory part of forming a scene.

**`content_hash` is defined precisely as a canonical serialization of
exactly the L2 summary prompt's input** — concretely, for a given scene:
`hash(scene_kind + sorted(active member atom id + content))`. This is
stated exactly (not just "a hash of member atoms' content + status", which
an earlier draft used) because the hash's only job is to answer "would the
prompt produce different input than last time" — if the hash covers more
or less than the prompt actually consumes, hash-gating either regenerates
unnecessarily or (worse) silently skips a regeneration the prompt's input
actually needed. Per §3.3's resolution, `confidence` is **not** part of
this hash (or the prompt): confidence remains recall-only metadata (§3.2).

### 6.5 Scene recall

Scenes are independently recallable, not just a T3 input: a scene's `title`
(provisional or LLM-written, §6.1) is embedded and FTS-indexed as soon as
the scene exists, re-indexed if the title or `summary` (§6.4) is later
replaced, giving a `searchScenes` / `falda_scenes_search` hybrid-recall path
(§7.1's fusion applies equally here). Because scenes are kinded, recall can
also be **scoped by kind or by specific episode/topic** — "what happened in
this session" or "what does this store know about topic X" are now
answerable directly against T2's structure, not just as a byproduct of
reading T3. A per-tier search tool per tier (stream/atoms/scenes) remains
available as an advanced/debug surface (`FALDA_MCP_TOOLSET=full`); the
default agent-facing recall surface is now the public, unified
budget-assembled cross-tier `falda_recall` MCP tool (`src/mcp/tools/recall.ts`),
built directly on the `assembleContext()` machinery described in §8.9 —
the previously-private/experimental Branch B assembly is what backs it.

## 7. Recall

*(Implemented in `src/falda.ts`. FALDA has hybrid FTS+vector+RRF;
everything past fusion below is new, and — per design review — explicitly
**not frozen**; see §7.2's caveat.)*

Recall answers "what does this store know that's relevant to this query?"
for atoms, and (§6.5) for scenes.

### 7.1 Hybrid fusion

- **Lexical** — SQLite FTS5, BM25-ranked.
- **Dense** — sqlite-vec, cosine distance.
- **Fusion** — both combined via Reciprocal Rank Fusion,
  `rrf(rank) = 1 / (60 + rank)` (a candidate absent from a channel
  contributes `0` for it).

### 7.2 Blended score — parameterized, not frozen

```
score =  rrf(ftsRank)
       + rrf(vecRank)
       + w_recency  · recencyDecay(createdAt)
       + w_priority · priorityWeight(priority)
       + w_confidence · confidenceWeight(confidence)
```

with provisional starting values `w_recency=0.10, w_priority=0.15,
w_confidence=0.05`, a 30-day recency half-life, `priorityWeight` = `1` at
`priority≤0` else `clamp01(1 − priority/100)`, and `confidenceWeight` =
`high→1.0, medium→0.6, low→0.3` — all adopted from kioku as **starting
points**, not as validated constants.

**This is a deliberate, explicit divergence from simply copying kioku.**
kioku intentionally lets metadata outweigh RRF, and FALDA's formula
structurally does the same thing here — that part is a faithful adoption.
But the specific magnitudes were not re-derived: the two best possible RRF
terms total roughly `0.033`, while the three metadata terms can contribute
up to `0.30` combined. At those magnitudes, **a barely-relevant
recent/high-priority atom can outrank a strongly-relevant old/default-
priority one**, and FALDA's candidate pools are not narrow enough to make
this a non-issue in practice. Metadata is meant to *break ties and bias
among relevant candidates*, not to override relevance outright — and at
these specific constants, it can.

**Consequences for this plan:**

- `w_recency`, `w_priority`, `w_confidence`, and the recency half-life are
  **configuration**, not hardcoded, from the first implementation.
- **These weights must not be treated as final.** Before they are frozen (or
  even trusted as sane defaults for production use), FALDA needs a small
  retrieval evaluation set — labeled `(query → expected atoms)` pairs across
  a few representative store shapes — and a scoring harness to tune against.
  Guessing at kioku's numbers a second time, even with a config knob
  attached, is not a substitute for measuring.
- One structural option worth evaluating (not decided here): **normalizing**
  the fused RRF score and the metadata terms onto comparable scales (e.g.
  both min-max'd to `[0,1]`) before combining, so weights become
  interpretable as "metadata may contribute at most X% of a fully-relevant
  hit's score" rather than opaque additive magnitudes.

Priority and confidence never bypass candidate selection — an atom must
still surface via the lexical or vector channel before either term can
affect its rank (see §7.5 for the one path that *does* bypass ranking:
pinning).

### 7.3 Status filtering

Recall only ever returns `status = 'active'` atoms/scenes (§3.3). Superseded,
merged, and archived atoms are excluded, full stop — they remain in the
table (and in the evidence/audit trail, §5.5) but are invisible to recall.

### 7.4 Character budgets

- **Per-hit cap**: 2000 characters. Longer content is truncated to 1997
  characters plus a trailing `...`.
- **Total cap**: 12000 characters across all returned hits, applied in
  ranked order after §7.2's scoring, so a high `limit` does not guarantee
  that many hits if the budget fills first.

### 7.5 Pinned-first recall

Recall for a store first fetches every **active, `pinned=true`** atom
(§3.2) unconditionally, within a reserved slice of the total character
budget, **before** running query-dependent ranked recall (§7.1–7.2) on the
remainder. This is the mechanism for reliable standing instructions (e.g.
"never modify production") — it does not depend on priority, ranking, or
candidate selection at all. If the number of pinned atoms threatens to
consume the whole budget, that is a caller-visible signal to prune pinning,
not a silent truncation the caller can't see.

## 8. The distillation pipeline (T0 → T3)

*(Implemented in `src/distill/core.ts`. The two prior external distillers,
`falda_distiller.py` and `src/distiller.ts`, have been hard-deleted.)*

Raw evidence is noisy. Distillation refines it upward, one tier at a time,
per store (§2).

### 8.1 L0 — the evidence floor

T0 stream turns (§4) are the raw material. A pass reads new turns since a
per-store watermark (§8.5); if none, the pass is skipped before any LLM
call.

### 8.2 L1 — extract, then consolidate

**1. Extract.** An LLM call reads a window of new turns and proposes
candidate atoms: `{type, content, confidence}` (§3) — **not** `priority`,
which is policy/type-derived, never extractor-assigned (§3.2). A `type` or
`confidence` outside its allowed set fails the extraction rather than being
coerced — a retryable failure, not silent corruption.

**2. Consolidate.** For each candidate atom, a second pass finds existing
active atoms in the same store as merge/update candidates via recall (§7),
with a **fixed candidate limit** (kioku uses 8; FALDA's default is the
same, configurable) and a **per-pass cost ceiling** on total candidate
comparisons / LLM decisions, so one large extraction window cannot trigger
unbounded consolidation cost. A narrower candidate window risks missing a
real duplicate (storing a near-dupe); a broader one costs more per pass —
this tradeoff is exactly the kind of thing the retrieval eval set (§7.2)
should inform, not a one-time guess.

The consolidation decision, per candidate atom:

| Action | Effect |
|---|---|
| **store** | The atom is new → record it, with evidence = this window (§5.3). |
| **update** | An existing atom should be refreshed → a *new* atom is recorded that supersedes the old one (§3.3); evidence = union of the old atom's evidence + this window (§5.3); confidence is re-assessed, not inherited (§3.2). |
| **merge** | Several existing atoms collapse into one → same mechanism as update, every target merged into the winner, evidence unioned across all absorbed atoms. |
| **skip** | Redundant, transient, or low-value → drop it; no evidence recorded. |

The pass records what it **applied**, not what was requested: a merge
naming targets that no longer exist degrades to a store; one whose only
target is its own prior copy degrades to a skip. Every applied action is
recorded in `consolidation_decisions` (§5.5) with a deterministic key
derived from the pass id (§8.5), so a re-fired pass does not duplicate
audit rows.

### 8.3 L2 — organize into scenes

Per §6.2–§6.3: for **episodes**, membership is recomputed directly from
`atom_evidence` grouped by session (§5.6) — deterministic, many-to-many, no
clustering, no hysteresis. For **topics**, active atoms are clustered by
embedding and reconciled against existing `topic` scenes with hysteresis
(§6.3). Both produce or update scene **structure** (membership, kind,
provisional title) for every store with new/changed atoms; neither, by
itself, requires an LLM call. **Title/summary generation is a separate,
lazy step** (§6.4): only a scene whose `content_hash` (§6.4's precise
definition) has changed gets an LLM-written title/summary, and only when
the worker performs that pass. Regeneration is **hash-gated end-to-end**:
`content_hash` gates both the LLM call *and* the scene's own re-embedding
(§6.5) — an unchanged scene costs nothing on a given pass, not even an
embedding call.

### 8.4 L3 — compress into core

A store's scene **structure** — its kinds, titles, and member atoms —
across **all** of a store's active scenes, is synthesized into the core
document: the durable profile of what this tenant/pool store is. This is
the one genuinely compressive step in the pipeline (§1): T3 is built from
organized knowledge (kind + title + the atoms each unit actually contains),
not from a set of independently-written prose summaries stacked on top of
each other, which is what made an earlier version of T2/T3 feel redundant.
Grounded only in scene structure and its member atoms, not invented.

**The core hash is defined precisely, for the same reason §6.4 defines the
scene hash precisely:** it must cover exactly what the T3 prompt consumes,
nothing more or less. Concretely:
`hash(for each active scene sorted by scene_id: scene_kind + title +
sorted(member atom id + content)))`. Confidence is excluded, per §3.3's
resolution. Skipped (no LLM call) when unchanged since the last synthesis.

**Known scale risk, accepted for now:** synthesizing across *all* active
scenes means the core-synthesis prompt still grows as a store accumulates
scenes, even though structured input is more compact per scene than N
independent prose summaries would have been. This is not bounded in the
initial implementation; it is noted here as a scale risk (cross-reference
`docs/SCALE.md`) rather than solved. Future options include ranking/
selecting a token-bounded subset of scenes (recency/size-weighted) or an
intermediate rollup tier — neither is adopted now.

FALDA keeps the name **Core** for this tier (kioku's equivalent is
"Persona"); see §12.

### 8.5 Execution semantics: pass ids, transactions, retries

This section did not exist in the first version of this doc, which
described the queue's retry/backoff/dead-lettering shape without stating
what is atomic or when the watermark moves — leaving genuine ambiguity
about what happens if, say, extraction succeeds, three atoms are
consolidated, and scene generation then fails and the job retries.

The rule: **execution is at-least-once; every step must be idempotent under
replay.**

- Each distillation input window gets a **stable, deterministic pass id**
  (derived from `(store, watermark_start, watermark_end)` or a hash of the
  window's turn ids). Audit keys (§8.2) and any pass-scoped dedup derive
  from it, so a replayed pass cannot duplicate work.
- **L1 is one atomic unit.** The atom mutations for a pass — every
  store/supersede/merge, their evidence edges (§5.3), their
  `consolidation_decisions` rows, **and the watermark advance** — commit in
  a single SQLite transaction. Either all of it lands, or none of it does.
  A crash before commit simply re-runs the identical window on the next
  attempt (the watermark hasn't moved); content-hash-derived atom ids make
  that re-run a no-op wherever an atom was already durably written by some
  other path. A crash *after* commit cannot leave atoms written but the
  watermark stale, because they are the same transaction — the scenario of
  "atoms committed, watermark not advanced" cannot occur.
- **L2 and L3 are independently retryable**, deliberately outside L1's
  transaction, because they are **pure functions of the current active-atom
  set / scene set** (their hash-gating, §6.2/§8.3/§8.4, is exactly what
  makes this safe). If scene generation fails after L1 has committed, L1 is
  not rolled back and does not re-run; the next attempt (retry or the next
  regularly enqueued pass) recomputes scenes from the now-current atom
  state, and hash-gating means it costs nothing extra if nothing relevant
  changed in between.
- Retry/backoff/dead-lettering (unchanged from the original design): 30s
  doubling to a 900s cap, an 8-attempt ceiling, after which the job becomes
  a visible `dead` row instead of retrying indefinitely.

### 8.6 Concurrency with live writes

The in-gateway worker (§8.7) distills a store while agents may concurrently
write new turns/atoms to that same store. The pass window is defined by
**`turn_index`/watermark boundaries** (§4.2), never by wall-clock time, so
a turn's position relative to a pass is unambiguous. A turn arriving with an
index at or below an already-committed watermark is a **T0 conflict**
(§4.2) — the same idempotency/ordering guarantee that protects against
duplicate writes also protects the distillation window from being redefined
out from under a running pass.

### 8.7 Forgetting and emptying (pipeline view)

Per §3.3/§6.1: a lifecycle change to an atom (supersede/archive/merge)
dirties every scene that has it as a member — for an atom with evidence
spanning multiple sessions, that means every episode scene for each of
those sessions, plus its one topic scene, per §6.2. A scene's regeneration
dirties core; a scene's **retirement** (episode: no atom's evidence traces
to its session anymore; topic: no matching cluster survived reconciliation,
§6.3) also dirties core, since core is synthesized over the active scene
set. When a store's last active atom is forgotten, every now-empty scene is
retired, and if that empties the store, core is deleted too — see §9 for
what "retired"/"deleted" does and does not mean.

### 8.8 Triggers

Distillation runs off a **per-store job queue**, never inline on a write.
Multiple surfaces can enqueue a job for a store:

- a **gateway-internal timer** (interval-based),
- the gateway's `POST /distill` route,
- the MCP tool `falda_distill`,
- a CLI backfill (`--once`).

A single **in-gateway background worker** drains the queue and calls the
distill core directly against the resolved store (`PoolManager`) — no
self-HTTP call, no bearer token to itself. The MCP server only *enqueues*;
it never runs extraction/consolidation/scene/core writes in-process,
preserving the rule that T2/T3 are curated by distillation, not by freehand
agent tool calls.

`falda_distill` is **asynchronous**: it returns a job id, not a completion
result. A companion tool, `falda_distill_status`, allows polling. There is
no synchronous "distill now, then read the fresh core" guarantee — an agent
that needs freshly-distilled context must poll or accept eventual
consistency.

kioku additionally fires L1 on session **ramp/idle/final** events and
regenerates L2/L3 on every underlying change (debounced). FALDA's first
pass uses **interval + on-demand triggers only**; ramp/idle/final is
deferred (§13) until a session-lifecycle table exists (§4.3).

### 8.9 Cross-tier context assembly (now the public `falda_recall` surface)

The retrieval evaluation set (§7.2, §13) was originally scoped to atom
ranking alone — but atom ranking cannot answer the question that actually
determines whether this four-tier hierarchy is worth its complexity: *given
a query and a fixed context budget (e.g. 12K/20K characters), what
combination of pinned atoms, query-relevant atoms, relevant episode/topic
scenes, and core content should an agent actually receive?* That is the
only test that can show whether scenes add retrieval value beyond raw
atoms, whether core crowds out specifics a scene or atom would have
supplied better, or whether the same fact is being redundantly served from
two tiers at once.

Branch B therefore introduced `assembleContext(store, query, budget)`
(`src/distill/context.ts`), originally private/evaluation-only, whose only
consumer was the retrieval evaluation harness. It performs, in one call:
the pinned-first pass (§7.5), query-ranked atom recall (§7.1–7.2),
query-ranked scene recall scoped across both kinds (§6.5), and a core
excerpt, trimmed to the budget in that priority order. The evaluation set
was extended accordingly: alongside `(query → expected atoms)` labels, it
gained `(query, budget) → expected assembled context` cases that surface
tier redundancy or crowding directly.

That function is now also the implementation behind the public
`falda_recall` MCP tool (§ simplify-mcp-surface, `src/mcp/tools/recall.ts`):
the compact agent-facing default tool set exposes recall/remember/forget/
distill/whoami instead of per-tier tools, and `falda_recall` is the single
retrieval entry point built directly on `assembleContext`, extended with
structured per-hit provenance (`{tier, id, score?}`) and a `truncated` flag
so a caller can tell tier/identity apart from the rendered text without the
model needing to choose which tier to query. The per-tier tools
(`falda_atoms_search`, `falda_scenes_search`, ...) remain available under
`FALDA_MCP_TOOLSET=full` for diagnostics/admin use — see `docs/MCP.md`.

## 9. Forgetting vs. erasure

*(Logical forgetting is implemented; erasure is specified but not yet built — see §13.)* "Forgetting propagates" (§3.3, §8.7) is correct as a
statement about **recall**, but it is not the same claim as **data
deletion**, and the model needs to say so explicitly rather than let the
word "forget" carry an implicit privacy guarantee it doesn't (yet) keep.

- **Logical forgetting** (what this plan implements): an atom's `status`
  moves to `superseded | merged | archived`. It is excluded from recall
  (§7.3) and its scenes/core regenerate without it (§8.7); a scene left
  with zero active members moves to `status='retired'` (§6.3) rather than
  being deleted outright, preserving its lineage for anyone still holding
  its `scene_id`. The atom's row, its `atom_evidence` edges, its
  `consolidation_decisions` history, its FTS/vector index entries, the
  retired scene's row and lineage columns, and the T0 turns that produced
  it are all **retained**. "Forgotten" here means *"the agent will not
  recall this unprompted,"* not *"this data no longer exists anywhere in
  the store."*

- **Evidence deletion / privacy erasure** (specified, **not** built in this
  plan's initial branches): a hard-delete operation that removes an atom's
  row, its `atom_evidence` edges, its vector and FTS index entries, and
  optionally the T0 turns that solely supported it — with the
  `consolidation_decisions` row tombstoned/redacted rather than left
  pointing at data that no longer exists. This is a privileged,
  **deliberately audited** operation: it is the one path allowed to break
  the immutability/provenance guarantees this doc otherwise holds firm
  everywhere else (§3.3, §5.5), and doing so must itself leave a record
  that an erasure happened, even though the erased content does not.

Anything calling itself "forget," "delete," or "remove" in the current
implementation is logical forgetting only, until an erasure path exists and
is explicitly invoked as such.

## 10. Auth and addressing (unchanged by this doc)

Every tier operation, at every tier, is addressed by `(tenant, pool)` and
gated by the shared bearer-token `TokenStore`/`Principal` model
(`src/mcp_auth.ts`) — see `docs/API.md` and `docs/MCP.md` "Authentication."
This doc does not change auth; it is listed here only so the diagram in
§11 is complete.

## 11. How the pieces fit

```
   host / agent runtime
      │  records turns / atoms directly
      ▼
  Falda (src/falda.ts)  ──►  SQLite: stream, atoms, scenes  (+ FTS5 + sqlite-vec, all three tiers)
      │                              │        │
      │                    hybrid recall (FTS + vector + RRF + re-rank + pinned-first)
      ▼                              │        │
  gateway (:8078) / MCP (:8079)  ◄───┴────────┘  same PoolManager, same auth, two surfaces
      │
      │  enqueue                              enqueue
      ▼                                       ▼
  distill job queue (per-store)  ◄── POST /distill, falda_distill, timer, CLI
      │
      ▼
  gateway-internal worker: L0 turns ──► L1 extract+consolidate ──► atom events (+ evidence edges)
        │  lifecycle change (supersede/archive/merge) dirties scenes referencing the atom
        ▼
  L2 organize: episodes ← atom_evidence projection (many-to-many, no hysteresis)
               topics   ← embedding clusters, reconciled with hysteresis (one-per-atom)
        │  ──► (lazily, hash-gated) regenerate changed titles/summaries ──► scene embeddings
        ▼
  L3 compress: synthesize core from active scene structure (kind+title+member atoms) ──► (or delete) core
```

## 12. FALDA ↔ kioku crosswalk

| Concept | kioku | FALDA | Divergence? |
|---|---|---|---|
| Pyramid | L0 Evidence → L1 Atoms → L2 Scenes → L3 Persona, four steps of the same summarization operation at decreasing granularity | T0 Stream → T1 Atoms → T2 Scenes → **T3 Core**, but **two distinct transformations** (knowledge, then organization, then compression — §1), not one operation repeated | **structural divergence** — kioku's `scope.kind` (`intention/repo/group/agent`) is partial prior art for *kinded* grouping, but applied at the scope level, not as T2's defining property |
| Atom types | `fact \| pattern \| preference \| constraint \| instruction` | same | none — adopted verbatim |
| Priority `0` label | "always inject" (acknowledged non-literal) | **`critical`** — same mechanism, honest name; a separate `pinned` boolean covers true always-include | **deliberate divergence** — kioku's own wording is a wart, not copied |
| Priority assignment | not specified | **caller/policy-set or type-derived default; never extractor-assigned** | FALDA adds this constraint |
| Confidence | `high \| medium \| low` | same values; **explicitly defined as evidential fidelity, not truth probability**, freshness handled separately by age+supersession | FALDA makes this explicit; kioku doesn't define it against evidence this precisely |
| Status lifecycle | active/superseded/merged/archived | same | none |
| Atom identity / mutability | event-sourced; rows are projections | **row store is authoritative**, but **content/type are immutable post-write**; a changed proposition is always a new, superseding atom | FALDA gets kioku's immutability guarantee without adopting full event sourcing |
| Provenance | ties memories to sessions/turns as L0 evidence | explicit **`atom_evidence`** edge table (window-level), separate from the decision audit trail | FALDA is more explicit here |
| Scenes | one scene per scope, whole-scope summary; scenes are a summarization tier; atom→scene is implicitly 1:1 | **zero-to-many kinded organizational units per store** (`episode`, `topic`); membership is the primary artifact, title/summary is a secondary/lazy rendering; independently recallable and browsable by kind; **membership cardinality is per-kind** — an atom belongs to many episode scenes (one per contributing session, evidence-derived) and at most one topic scene | **FALDA diverges from and extends kioku** — kioku's one-scene-per-scope was too coarse *and* the wrong kind of tier; FALDA also derives episode membership directly from provenance (§5.6) rather than clustering, since consolidation's evidence-union rule (§5.3) makes a single-session atom model incorrect for merged atoms |
| Partitioning | "scope" (namespace, or namespace:kind:ref) | `(tenant, pool)`; **a named pool is an independent shared resource**, not a tenant sub-namespace | clarified, not changed, from the originally merged doc |
| Recall re-rank | RRF + recency + priority + confidence, constants fixed | same formula shape; **weights are configuration, not frozen constants**, pending a retrieval eval set | **deliberate divergence** — same structure, not the same trust in the specific numbers |
| Distillation trigger | ramp/idle/final session timers + change-hash regen | **interval + on-demand enqueue** (queue + in-gateway worker); ramp/idle/final deferred | scoped down for now |
| Distillation execution | not documented at this level of detail here | explicit pass-id + L1-atomic-transaction + hash-gated-L2/L3 retry semantics (§8.5) | FALDA is more explicit here |
| Forgetting | scene/persona deletion on empty scope | same, but **explicitly named "logical forgetting,"** distinguished from a specified-but-unbuilt erasure path (§9) | FALDA is more explicit here |
| Session model | full lifecycle aggregate, focus, lineage | **not adopted** this pass beyond `session_id` + `turn_index`/`turn_id` (§4) | deferred, not rejected |
| LLM/embeddings | hard-coded Claude Haiku 4.5 | pluggable (`selectEmbedder`, any OpenAI-compatible chat endpoint) | intentional |
| Workspace mirroring | `.kioku/scenes/*.md`, `.kioku/persona/*.md` | scenes/core stored as rows/blobs directly; markdown mirror is best-effort, not the source of truth | minor |

FALDA deliberately does **not** adopt: full event-sourcing, session
delegation/continuation lineage, per-turn token-count metadata, or renaming
T3 Core to "Persona." These are judged unnecessary complexity for FALDA's
scope, not oversights. Where this doc diverges from kioku's specific
constants or conventions (priority naming, recall weights), the divergence
is deliberate and stated, not an oversight either — see the table above.

## 13. Open questions and explicitly deferred work

Carried forward rather than silently dropped. None of these block Branch A
(§13); several should inform a future design pass.

**Deferred by design, revisit later:**
- Cross-tenant **pool distillation** (§2): whose credentials run a shared
  pool's worker, and how a pool turn's contributing tenant is attributed in
  provenance. Initial branches distill `self` stores only.
- Session **`focus`**, a full session-lifecycle table, and **ramp/idle/
  final** distillation triggers (§4.3, §8.8) — natural companions, land
  together if ever. Note: episodes (§6.2) use only `session_id`/
  `turn_index` and deliberately do **not** wait on this.
- **Richer episode semantics** — episodes bounded by more than raw session
  structure (e.g. incorporating `focus`, sub-session boundaries) once a
  session model exists (§6.2).
- **`project` and `thread` scene kinds** (§6.2) — plausible future
  organizational dimensions with no defined derivation method yet
  (goal-boundedness and cross-session continuity aren't recoverable from
  embeddings or session structure alone). Note: cross-kind multi-membership
  itself (an atom in an episode *and* a topic simultaneously) is **no
  longer deferred** — it is the baseline invariant as of this revision
  (§6.2). What remains deferred here is only *adding more kinds*.
- **Multi-membership *within* the `topic` kind** (§6.2) — an atom assigned
  to more than one topic cluster at once (soft clustering). Episode
  membership is already many-to-many by construction (§6.2, §5.6); this
  item is specifically about relaxing topic's one-per-atom rule.
- **Erasure** implementation (§9) — the model is specified; the hard-delete
  path is not built.
- ~~A **public**, budget-assembled **cross-tier context** endpoint~~ —
  **no longer deferred.** `assembleContext()` (`src/distill/context.ts`,
  §8.9) now backs the public `falda_recall` MCP tool
  (`src/mcp/tools/recall.ts`), the default agent-facing retrieval surface.
  Per-tier search tools (`falda_atoms_search`, etc.) remain available
  behind `FALDA_MCP_TOOLSET=full` for diagnostics.
- **Per-turn** (rather than window-level) provenance attribution (§5.2).
- T3's **unbounded scene-set token growth** (§8.4) — noted as a scale risk,
  not solved.
- A dedicated `scene_reconciliation` **audit table** (§6.3) — the lighter
  `status`/`derived_from`/`superseded_by` columns are adopted instead for
  now; a full per-pass audit trail (analogous to
  `consolidation_decisions`) is a possible future strengthening if lineage
  columns prove insufficient to explain a reorganization.

**Needs empirical / further design work before freezing:**
- The recall re-rank weights, recency half-life, and the topic-reconciliation
  match/reorg thresholds (§7.2, §6.3) all need a retrieval evaluation set
  and a tuning pass before they should be trusted as defaults, let alone
  frozen. As of §8.9, this evaluation set explicitly includes budgeted
  cross-tier assembly quality, not just atom ranking.
- Whether RRF and metadata terms should be **normalized** onto comparable
  scales before combining (§7.2) — an option, not a decision.
- The consolidation candidate limit and per-pass cost ceiling (§8.2) are
  provisional; the right values depend on observed atom volumes per store.

