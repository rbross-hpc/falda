# Recall traces (usage feedback loop)

Every `falda_recall` / `POST /recall` invocation is traceable, and usage
feedback attaches to that trace rather than mutating the memories it
references. This is telemetry about *retrieval*, not part of the durable
memory model (T0–T3) — it lives in its own SQLite file
(`recall_traces.db`, alongside `distill_queue.db` under `FALDA_ROOT`),
with its own retention policy, and a trace-persistence failure can never
fail the recall that produced it (best-effort).

**Why this exists:** without it, usage data arrives with no record of
which retrieval policy (weights, tier budgets) produced it. Six months
into tuning, you'd have no way to tell "this atom was never useful" apart
from "this atom was useful under a policy we've since changed." Every
trace snapshots the policy that was actually in effect.

**The principle this design follows:** instrument now, don't adapt yet.
Traces and usage reports are collected starting today, but nothing in
FALDA automatically raises/lowers atom priority, re-weights ranking, or
changes tier budgets based on usage. That's future work, deliberately
deferred until there's a real body of data — usage is noisy (a pinned
instruction can be critical but rarely "used" in a detectable way; a
retrieved atom can be true-but-redundant this turn and essential next
turn), and closing the feedback loop before understanding the current
system's behavior would produce a system that's already adapting to noise
before anyone can tell whether the underlying budgets/weights are sound.

## Data model

```
recall_traces
  recall_id           TEXT PRIMARY KEY      -- UUID, one per invocation
  store_key           TEXT NOT NULL         -- "<tenant>:<pool|self>"
  tenant              TEXT NOT NULL
  pool                TEXT                  -- NULL for the tenant's private store
  query               TEXT NOT NULL
  requested_budget    INTEGER
  used_budget         INTEGER               -- assembleContext()'s total_chars
  policy_snapshot     TEXT NOT NULL         -- JSON, see below
  created_at          TEXT NOT NULL

recall_trace_items
  recall_id  TEXT NOT NULL
  ordinal    INTEGER NOT NULL   -- rank/admission order, 0-indexed
  tier       TEXT NOT NULL      -- "T1" | "T2" | "T3"
  item_id    TEXT NOT NULL      -- atom id / scene id / "core"
  source     TEXT NOT NULL      -- "pinned" | "ranked" | "scene" | "core"
  score      REAL
  chars      INTEGER
  usage      TEXT NOT NULL DEFAULT 'unknown'  -- "unknown" | "used" | "unused"
  PRIMARY KEY (recall_id, ordinal)
```

Only items that actually made it into the assembled context are recorded
— candidates cut by the tier budget are not (yet) captured. That means
today's traces can answer "was this atom retrieved and used" but not "was
this atom retrieved and then dropped for budget reasons, vs. never
retrieved at all." Extending the trace with `candidate` / `selected` /
`dropped_budget` / `dropped_rank` states is a natural next step once the
budget-tuning question becomes concrete — it's a superset of the current
schema, not a breaking change.

## Policy snapshot

```json
{
  "weights": { "recency": 0.10, "priority": 0.15, "confidence": 0.05 },
  "budgets": { "pinned": 0.20, "atoms": 0.40, "scenes": 0.25, "core": 0.15 },
  "recency_half_life_days": 30,
  "version": "1"
}
```

`version` (`RETRIEVAL_POLICY_VERSION`, `src/recall/policy.ts`) bumps only
when the *shape or meaning* of `weights`/`budgets` changes — not on every
tuning pass. The numeric values themselves are already captured verbatim
on every trace, so comparing two traces' `policy_snapshot` fields directly
tells you whether they ran under the same effective policy.

## Usage states and transitions

`usage` starts `'unknown'` for every item on every trace. It stays
`'unknown'` forever unless a `POST /recall/usage` report arrives — silence
is not evidence that a memory was useless, so `unknown` is never
conflated with `'unused'`.

| From | To | Allowed |
|---|---|---|
| `unknown` | `used` | yes |
| `unknown` | `unused` | yes |
| `used` | `used` | yes (idempotent no-op) |
| `unused` | `unused` | yes (idempotent no-op) |
| `used` | `unused` | **rejected** (409, `conflict`) |
| `unused` | `used` | **rejected** (409, `conflict`) |

A rejected report changes nothing — the whole call is atomic, and the
error names the conflicting `{tier, id}` pairs so the caller can decide
how to resolve it rather than FALDA silently overwriting a prior report.
An item id not present on the trace (a typo, or an id from a different
recall) → 400 `unknown_items`. A `recall_id` that doesn't exist, or
belongs to a different tenant/pool's `store_key`, → 404 — indistinguishable
from "doesn't exist" (no existence oracle, matching `/distill/status`).

## Who reports usage

**Not the model, via a normal MCP tool.** There is deliberately no
`falda_report_usage` tool registered anywhere (default or `full`
toolset) — relying on the model to remember to call a reporting tool
after every `falda_recall` both burns a turn and depends on the model
faithfully self-instrumenting, which is unreliable. `POST /recall/usage`
is a harness/plugin-facing HTTP endpoint instead — the intended flow is:

```
opencode / Falda capture plugin
    -> falda_recall()            (agent-visible)
    -> gets recall_id + items
    -> agent performs the task
    -> plugin/runtime reports which recalled items were used
       via POST /recall/usage    (not agent-visible)
```

As of this writing the opencode integration does not yet call
`/recall/usage` automatically — determining what it can reliably report
(e.g. "this atom's content appeared verbatim in a tool call" vs. true
citation) is future integration work. Trace capture ships now regardless,
so there is no artifact left un-instrumented while that integration work
happens.

## Retention

`recall_traces.db` can grow much faster than durable memory — every
recall writes a row per admitted item, not just per session. Pruned on
the same interval as the existing distillation worker tick (no separate
timer): `FALDA_RECALL_TRACE_RETENTION_DAYS` (default `90`; `<= 0` disables
pruning and retains indefinitely). See `src/recall/retention.ts` and
`src/distill/worker.ts`.

## Evaluation queries

`POST /recalls/metrics` (scoped to the caller's own `store_key`) computes:

- `by_tier.T1/T2/T3` — usage rate per tier (does T2 pull its weight vs T1?
  is core inclusion earning its budget?).
- `by_source` — pinned vs. ranked vs. scene vs. core.
- `by_rank` — usage rate by admission-order position (are later-ranked
  items ever used, or is the budget wasted on them?).
- `chars.unused_ratio` — `(total_chars - used_chars) / total_chars`, a
  rough context-efficiency measure across all recalls for the store.

The same shape can be computed directly against `recall_traces.db` with
SQL, e.g. usage rate by atom type (joining back to the tenant's `atoms`
table by `item_id`) or by scene kind (joining `scenes` by `item_id`) —
`computeRecallMetrics` (`src/recall/metrics.ts`) intentionally stays
generic (tier/source/rank/chars) rather than growing tenant-schema-aware
joins; those are one-off analysis queries, not a stable API surface.
