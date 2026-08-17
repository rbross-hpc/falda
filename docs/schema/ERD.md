# FALDA Entity-Relationship Diagram

Companion to `docs/schema/tables.sql` and `docs/MODEL.md` §14. This diagram
covers the **domain tables** — the four memory tiers, their edges, and the
audit tables that record why/what happened to them — all of which live in
one per-store `falda.db` (`docs/MODEL.md` §14.2).

**Deliberately excluded**, for readability, since they are operational
plumbing rather than domain knowledge (see `docs/MODEL.md` §14.3–14.4 for
their schema): `distill_jobs` (`distill_queue.db`), `recall_traces` /
`recall_trace_items` (`recall_traces.db`), and the FTS5/vec0 shadow tables
(`*_fts`, `*_vec`) — each is a 1:1 index alongside its owning table
(`stream`, `atoms`, `scenes`), not a distinct entity.

```mermaid
erDiagram
    STREAM ||--o{ ATOM_EVIDENCE : "referenced by (stream_id)"
    ATOMS  ||--o{ ATOM_EVIDENCE : "has evidence"
    ATOMS  ||--o{ SCENE_ATOMS   : "belongs to"
    SCENES ||--o{ SCENE_ATOMS   : "has members"
    ATOMS  ||--o{ ATOMS         : "supersedes (self-ref)"
    SCENES ||--o{ SCENES        : "derived_from / superseded_by (self-ref)"
    DISTILLATION_PASSES ||--o{ CONSOLIDATION_DECISIONS : "recorded during"
    DISTILLATION_PASSES ||--o{ PASS_SCENE_EFFECTS      : "recorded during"
    DISTILLATION_PASSES ||--o| PASS_CORE_EFFECTS       : "recorded during"
    ATOMS  ||--o{ CONSOLIDATION_DECISIONS : "decision targets (atom_id)"
    SCENES ||--o{ PASS_SCENE_EFFECTS      : "effect on (scene_id)"

    STREAM {
        text id PK
        text session_id
        text role
        text content
        text ts
        int turn_index "nullable, per-session"
        text turn_id "nullable, per-session idempotency"
        int seq "store-global order, never null"
    }

    ATOMS {
        text id PK
        text type "fact|pattern|preference|constraint|instruction"
        text content "immutable"
        text background
        int priority "0-100, lower=higher boost"
        text confidence "high|medium|low"
        int pinned "boolean"
        text status "active|superseded|merged|archived"
        text tags "JSON array"
        text supersedes FK "-> atoms.id"
        text source_turn_ids "denormalized"
        text source_session_ids "denormalized"
        text created_at
        text updated_at
    }

    ATOM_EVIDENCE {
        text atom_id PK_FK "-> atoms.id"
        text stream_id PK_FK "-> stream.id"
        text added_at
    }

    SCENES {
        text scene_id PK
        text scene_kind "episode|topic"
        text title "never null"
        text atom_ids "JSON array, denormalized membership"
        text summary "secondary, optional"
        text content_hash "gates title/summary regen"
        text render_hash "gates embedding regen only"
        text status "active|retired"
        text derived_from FK "-> scenes.scene_id, split lineage"
        text superseded_by FK "-> scenes.scene_id, merge lineage"
        text created_at
        text updated_at
    }

    SCENE_ATOMS {
        text scene_id PK_FK "-> scenes.scene_id"
        text atom_id PK_FK "-> atoms.id"
    }

    CONSOLIDATION_DECISIONS {
        text id PK
        text pass_id FK "-> distillation_passes.pass_id"
        text action "store|update|merge|skip"
        text atom_id FK "-> atoms.id, nullable"
        text target_ids "JSON array"
        text rationale
        text decided_at
        text candidate_type
        text candidate_content
        text candidate_confidence
    }

    DISTILLATION_PASSES {
        text pass_id PK "deterministic: hash(store_key, watermark range)"
        text store_key
        int watermark_start
        int watermark_end
        text started_at
        text completed_at
        text status "running|done|failed"
        int input_turn_count
        int candidate_count
        text error
        text model
        text prompt_version
        text distiller_version
    }

    PASS_SCENE_EFFECTS {
        text pass_id PK_FK "-> distillation_passes.pass_id"
        text scene_id PK_FK "-> scenes.scene_id"
        text scene_kind
        text title
        text effect "created|updated|retired|unchanged"
        int members_before
        int members_after
        text added_json
        text removed_json
        int summary_regenerated "boolean"
        int embedding_regenerated "boolean"
    }

    PASS_CORE_EFFECTS {
        text pass_id PK_FK "-> distillation_passes.pass_id"
        text effect "unchanged|regenerated|deleted|failed"
        text old_input_hash
        text new_input_hash
        int old_chars
        int new_chars
    }

    DISTILL_WATERMARK {
        text store_key PK
        text last_processed_id
        text last_processed_ts
        int last_processed_seq "compared against stream.seq"
        text updated_at
    }

    CORE_STATE {
        text store_key PK
        text input_hash "last L3 input hash"
        text generated_at
    }
```

## Notes on relationships not expressible as plain foreign keys

- **`ATOMS.supersedes`** and **`SCENES.derived_from` / `SCENES.superseded_by`**
  are lineage pointers, not enforced `REFERENCES` constraints in the actual
  DDL (`docs/schema/tables.sql`) — they may point at a retired/superseded
  row that is intentionally never deleted (`docs/MODEL.md` §3.3, §6.3, §9).
- **`ATOMS.source_turn_ids` / `source_session_ids`** are denormalized JSON
  summaries of `ATOM_EVIDENCE`, not an independent relationship — the join
  table is the canonical edge (`docs/MODEL.md` §5.1).
- **`SCENES.atom_ids`** is a denormalized JSON summary of `SCENE_ATOMS`, kept
  for the same reason — `scene_atoms` is the canonical, reverse-lookup-
  indexed membership edge (`docs/MODEL.md` §6.1).
- **Episode-scene membership** is not stored as an explicit relationship at
  all — it is a *computed projection* of `ATOM_EVIDENCE` joined through
  `stream.session_id` (`docs/MODEL.md` §5.6, §6.2), materialized into
  `SCENE_ATOMS`/`SCENES.atom_ids` by the L2 pass, not a separate source of
  truth.
- **`DISTILL_WATERMARK`** and **`CORE_STATE`** have no foreign keys to any
  other table shown here — each is a single operational row keyed by
  `store_key`, describing pipeline progress against the *whole* store
  rather than any one entity in it.
