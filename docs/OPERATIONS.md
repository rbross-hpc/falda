# Interrogating a deployment: `falda stats`

`falda stats` is a read-only, offline report of everything under
`FALDA_ROOT`: per-store tier counts (T0 stream / T1 atoms / T2 scenes / T3
core), the distillation queue's job backlog, recall-usage metrics, and
on-disk config/layout — plus a `warnings` section that flags the cheap,
high-value problems an operator actually cares about (dead-lettered
distillation jobs, a stale pending backlog, an embedding-lock mismatch, a
missing token file, an empty store).

```bash
falda stats                                   # human-readable, everything
falda stats --json                            # machine-readable, everything
falda stats --tenant=my-agent                 # scope to one tenant's self store
falda stats --pool=shared-corpus              # scope to one shared pool
falda stats --section=queue,recall            # only these sections
FALDA_ROOT=/data falda stats                  # point at a specific root
```

Or directly: `tsx src/stats.ts [args]` / `node dist/stats.js [args]` /
`npm run stats -- [args]`.

## Why this is safe to run against a live deployment

`falda stats` never goes through `buildRuntime()` (`src/runtime.ts`) and
never constructs a `PoolManager`/`Falda` instance. Instead it:

- **Enumerates stores by walking the filesystem directly** — self stores
  under `<root>/tenants/<t>/self/falda.db`, pool stores from
  `<root>/pools.json` — the same on-disk contract `PoolManager` uses
  (`docs/POOLS.md`), without needing write access to create `tenants/`/
  `pools/` directories on an otherwise-empty root.
- **Opens every SQLite file read-only** (`better-sqlite3` with
  `{ readonly: true, fileMustExist: true }`) and runs plain `COUNT`/
  `GROUP BY` SQL against the ordinary tables (`stream`, `atoms`, `scenes`,
  `distill_jobs`, `recall_traces`, ...) — never the `_fts`/`_vec` virtual
  tables, so it never needs to load the `sqlite-vec` extension.
- **Never calls an embedder.** No `FALDA_EMBED_BASE_URL` needs to be
  reachable, and no `EMBEDDING.json` mismatch will crash it (unlike
  `falda serve`, which calls `process.exit(1)` on a mismatch via
  `enforceEmbeddingLock` — `src/boot.ts`). `stats` reports a mismatch as a
  warning instead.
- **Never requires a token file.** This is a host-side diagnostic, not a
  request that needs a bearer token — it's meant to be run by whoever has
  filesystem access to `FALDA_ROOT`, not by an agent.
- **Degrades gracefully.** A missing `distill_queue.db`/`recall_traces.db`/
  `pools.json`, an unmaterialized pool store, or one corrupt store file are
  all reported inline rather than aborting the whole report.

Because of all of the above, `falda stats` can run concurrently with a live
`falda serve` process without contention risk beyond ordinary SQLite
read-concurrency (WAL mode, which every `Falda` store already uses).

## Sections

| Section  | Reports |
|----------|---------|
| `stores` | Per store (self + pool): stream turn count and head `seq`, atom counts by status (`active`/`superseded`/`merged`/`archived`) plus pinned count, scene counts by kind/status (`episode`/`topic` × `active`/`retired`), core presence + size. |
| `queue`  | `distill_jobs` grouped by status (`pending`/`running`/`done`/`dead`), the full dead-letter list (store_key, attempts, error), and the oldest pending job's age. |
| `recall` | Per `store_key`: trace count and item count from `recall_traces.db` (see `docs/RECALL_TRACES.md`). Coarser than `computeRecallMetrics()` (no usage-rate breakdown) — this is an inventory view, not the tuning view `/recalls/metrics` gives one authenticated tenant. |
| `layout` | Presence of `distill_queue.db`, `recall_traces.db`, `pools.json` (+ pool count), `EMBEDDING.json` (+ locked model/dim), and the resolved token file path. |

Omit `--section` to run all four.

## Warnings

`warnings[]` (in both human and `--json` output) is populated by the
section handlers above and carries a `level` of `warn` or `error`:

- **error** — at least one distillation job is dead-lettered (max attempts
  exhausted, `src/distill/queue.ts`); a store failed to open (corrupt file,
  permissions); `EMBEDDING.json`'s locked `dim` doesn't match this shell's
  `FALDA_DIM` (the same check `enforceEmbeddingLock` makes at server boot —
  a `falda serve` started with this env would refuse to start).
- **warn** — the oldest pending distillation job has been waiting an
  unusually long time (default threshold: 15 minutes — check whether
  `falda serve`'s worker is actually running); `EMBEDDING.json`'s model
  doesn't match `FALDA_EMBED_MODEL`; no token file found at the resolved
  `FALDA_TOKENS` path; no stores found at all under the given root.

The process exits `1` if any `error`-level warning is present (`0`
otherwise), so `falda stats` is usable directly in a health-check/CI
context: `falda stats --json | jq` or `falda stats; echo $?`.

## What this is not

- Not a repair tool — `falda stats` only reads and reports; it never
  mutates a store, the queue, or the token file.
- Not a substitute for `GET /healthz` — `healthz` proves a `falda serve`
  process is alive and answering; `stats` inspects the data on disk
  regardless of whether any server process is currently running.
- Not a per-tenant/authenticated view — `stats` sees every store under
  `FALDA_ROOT` at once, which is why it's a filesystem-access tool for
  operators, not something exposed over MCP or the HTTP API (which are
  scoped to one authenticated tenant/pool per request, by design — see
  `docs/API.md`/`docs/MCP.md`).
