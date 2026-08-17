---
name: falda-memory
description: Use when working in a project with FALDA memory connected — recalling prior facts, decisions, preferences or constraints from past sessions, or saving something durable worth remembering. Triggers on references to earlier work ("what did we decide", "as before", "remember that"), and before starting non-trivial work that past context would inform.
---

# FALDA memory

This project has a FALDA memory store connected via MCP (`falda_*` tools).

## Recalling

Before starting non-trivial work, call `falda_recall` with a natural-language
query. It assembles the best available context across all memory tiers —
facts, preferences, rules, past episodes, project core — in one call. You do
not need to decide which tier to query.

A small amount of memory context may already have been injected at the start
of a session, wrapped in a `<falda-auto-recall>` block. That is a
smaller-budget, best-effort recall fired before you asked for anything — not
a substitute for calling `falda_recall` yourself. Call it whenever you need
more than what is already there.

## Remembering

When you learn something durable worth keeping for future sessions — a fact,
pattern, preference, constraint, or standing instruction, not a transient
detail — call `falda_remember` with `{ content, type }`. The field is
`content`, not `text`.

Memory content is **immutable**. Each call records a new memory. To correct
something previously remembered, call `falda_remember` again with the
corrected content rather than expecting the old entry to be edited.

Valid types: `fact`, `pattern`, `preference`, `constraint`, `instruction`.
Out-of-set values are rejected.

## Forgetting

To stop recalling a memory that is outdated or wrong, call `falda_forget`
with its `atom_id` (from a `falda_remember` result or a `falda_recall` hit).
This only stops it surfacing — it is **not** privacy erasure, and historical
provenance is retained.

## What you do not need to do

- Raw conversation turns are captured automatically by hooks. Do not call
  `falda_stream_add` yourself except to backfill or annotate.
- Distillation into durable memories happens automatically — a hook triggers
  it as a session compacts, and a background worker runs periodically. You
  may call `falda_distill` at the end of a substantial session as a
  safeguard; it is asynchronous and returns a `job_id` you can poll with
  `falda_distill_status`. It is not something to call every turn.
- Scenes and core are maintained by the distillation pipeline and are not
  directly editable. They reach you through `falda_recall`.

## When recall looks wrong

If results seem off — for example, missing something you just saved — call
`falda_whoami` to confirm which tenant this connection resolves to. FALDA is
scoped per project, so a misconfigured `FALDA_TENANT` silently addresses a
different store.
