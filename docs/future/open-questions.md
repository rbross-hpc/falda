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
The model is specified (hard-delete with tombstoned audit rows). The hard-
delete path is not built. Anything currently calling itself "forget" or
"delete" is logical forgetting only.

**Public cross-tier context endpoint (§6.5, §8.9):**
A public, budget-assembled cross-tier context call (pinned + ranked atoms +
relevant scenes in one call). The private `assembleContext()` function exists
in `src/distill/context.ts` for the evaluation harness; the public endpoint
stays deferred.

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
