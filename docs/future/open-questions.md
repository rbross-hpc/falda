# FALDA open questions and deferred work

These items were carried forward from `docs/MODEL.md` §13 at the time
Branches A–C landed and the implementation plan was closed out. None of them
block the shipped system, but each is worth tracking for a future design
pass.

## Deferred by design — revisit later

**Cross-tenant pool distillation (§2, §13):**
The in-process distillation pipeline currently distills `self` stores only.
Distilling a shared pool raises: whose LLM/embedder credentials run the
worker, and how a pool turn's contributing tenant is attributed in provenance.
See `docs/POOLS.md` "What this contract does NOT yet include."

**Session focus, full session-lifecycle table, and ramp/idle/final triggers (§4.3, §8.8):**
Episodes (§6.2) use only `session_id`/`turn_index` and deliberately do not
wait on this. These are a natural companion and should land together if ever
adopted.

**Richer episode semantics (§6.2):**
Episodes bounded by more than raw session structure (e.g. incorporating
`focus`, sub-session boundaries) once a session model exists.

**`project` and `thread` scene kinds (§6.2):**
Plausible future organizational dimensions with no defined derivation method
yet. Cross-kind multi-membership itself (an atom in an episode *and* a topic
simultaneously) is **not** deferred — it is the baseline invariant.

**Multi-membership within the `topic` kind (§6.2):**
An atom assigned to more than one topic cluster at once (soft clustering).
Episode membership is already many-to-many by construction; this item is
specifically about relaxing topic's one-per-atom rule.

**Erasure implementation (§9):**
The model is specified (hard-delete with tombstoned audit rows). The full
audited erasure path is not built. `Falda.hardDeleteAtomsUnsafe()` exists
as an interim physical-delete method (reachable via gateway `/atoms/delete`)
but it produces no audit record, so it is not safe for privacy erasure — it
is named to make this obvious. The production erasure path should tombstone
`consolidation_decisions`, sweep FTS/vec indexes, and optionally remove T0
turns that solely supported the deleted atom(s).

~~**Public cross-tier context endpoint (§6.5, §8.9)**~~ — **shipped.**
`assembleContext()` (`src/distill/context.ts`) now backs the public
`falda_recall` MCP tool and `POST /recall` (§ simplify-mcp-surface,
§ recall-feedback-loop). See `docs/MODEL.md` §8.9/§8.10 and
`docs/RECALL_TRACES.md`.

**Recall-trace dropped-candidate capture (§8.10, §ⓘ recall-feedback-loop):**
Traces currently record only items that made it into the assembled
context — not candidates considered and cut by a tier's budget, nor
candidates that never made the ranked-search cutoff at all. Distinguishing
"retrieved but budget-cut" from "never retrieved" is necessary before
tier-budget tuning can be evidence-based, but extending
`recall_trace_items` with `candidate | selected | dropped_budget |
dropped_rank` states is a superset of the current schema (additive, not
breaking) — deferred until budget tuning becomes a concrete question with
real usage data behind it.

**Usage feedback → ranking/priority (§8.10):**
Recall traces + `POST /recall/usage` collect usage telemetry now, but
nothing reads it back into `priority`, recall re-rank weights, tier
budgets, or clustering. Usage is noisy (pinned instructions can be
critical but rarely "used" in a detectable way; supporting context can be
legitimately unused most turns) — closing this loop before there is a real
body of data to evaluate it against would risk the system adapting to
noise. Revisit once `docs/RECALL_TRACES.md`'s aggregate queries have run
against real traffic.

**OpenCode automatic usage reporting (§8.10):**
`POST /recall/usage` exists, but no harness currently calls it
automatically — the opencode capture plugin (`integrations/opencode/`)
only forwards T0 turns today. Determining what a harness can reliably
report (content-appeared-in-context vs. true citation) needs its own
design pass before wiring auto-reporting; ship trace capture first, decide
signal quality once there's a concrete integration to design against.

**Cross-store aggregate recall metrics (§8.10):**
`POST /recalls/metrics` is scoped to one caller's own `store_key`, matching
the per-tenant auth model. A cross-tenant/cross-store aggregate view (e.g.
"T2 usage rate across all tenants") would be a research/admin capability
outside that model — not designed yet.

**Per-turn provenance attribution (§5.2):**
Evidence edges currently use window-level attribution. Per-turn attribution
(the extractor stating which specific turn(s) support a given atom) needs a
structured-output contract from the extractor.

**T3 core-synthesis prompt growth (§8.4, `docs/SCALE.md` §6):**
The L3 prompt grows linearly with the number of active scenes. Not bounded
in the current implementation. See SCALE.md §6 for future options.

**Scene reconciliation audit table (§6.3):**
The lighter `status`/`derived_from`/`superseded_by` columns are adopted
instead. A full per-pass audit trail (analogous to `consolidation_decisions`)
is a possible future strengthening.

## Needs empirical / further design work before freezing

**Recall re-rank weights and recency half-life (§7.2):**
`w_recency=0.10`, `w_priority=0.15`, `w_confidence=0.05`, 30-day half-life
are starting points from kioku, not validated constants. Needs a small
retrieval evaluation set and tuning pass before trusting as defaults.

**Whether RRF and metadata terms should be normalized (§7.2):**
An option (min-max both to [0,1] before combining), not a decision.

**Topic-reconciliation match/reorg thresholds (§6.3):**
Configurable but currently guessed. Should be tuned against the same
retrieval eval set.

**Consolidation candidate limit and per-pass cost ceiling (§8.2):**
Default 8 candidates, configurable. Right value depends on observed atom
volumes per store.
