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

# Startup embedding verification

Two boot-time safeguards close gaps that used to let a misconfigured
embedder corrupt or silently degrade recall (`src/boot.ts`):

- **`selectEmbedder` no longer has to silently fall back.** If
  `FALDA_EMBED` is unset and no `FALDA_EMBED_BASE_URL` is configured, the
  default is still the deterministic local embedder (so a first run "just
  works" offline) — but setting `FALDA_EMBED_STRICT=1` turns that specific
  case into a startup `FATAL` instead. Recommended for production
  deployments where an accidentally-unset `FALDA_EMBED_BASE_URL` should
  never be able to quietly downgrade recall to the fake embedder rather
  than failing loudly. Off by default so `falda smoke`/the test suite are
  unaffected; `FALDA_EMBED=local` remains a valid explicit opt-in even with
  strict mode on.
- **`probeEmbedder` calls the configured remote embedder once at boot**
  (`src/runtime.ts`, before `enforceEmbeddingLock`) and asserts the
  returned vector's length matches `FALDA_DIM`. This catches two things
  `enforceEmbeddingLock` cannot see on its own (it only compares env
  strings against the on-disk `EMBEDDING.json` manifest, never calls the
  embedder): a down/unreachable endpoint, and an endpoint that's up but
  actually serving a different model/dimension than `FALDA_DIM` claims.
  Skipped for the local embedder. On a fresh `FALDA_ROOT` (no
  `EMBEDDING.json` yet), this means the manifest `enforceEmbeddingLock`
  writes on first boot is written from a network-verified dimension, not
  taken on faith from the env.

Both are process-startup checks — they run once per `falda serve`/
`gateway`/`mcp`/distill-cli process boot, not per-request.

# Re-embedding after a model/dimension change

`enforceEmbeddingLock` (`src/boot.ts`) refuses to boot any server process
whose `FALDA_EMBED_MODEL`/`FALDA_DIM` no longer match a store's locked
`EMBEDDING.json` manifest — its error message has always pointed at
"re-embed the store and update the manifest." `falda reembed` is that
command.

```bash
# 1. Stop every FALDA process (serve/gateway/mcp/distill-cli) against this root.

# 2. Preview what would be affected (no writes):
FALDA_ROOT=/data FALDA_DIM=1024 FALDA_EMBED=remote \
FALDA_EMBED_BASE_URL=http://qwen-embedder:8000/v1 FALDA_EMBED_MODEL=Qwen3-Embedding-0.6B \
falda reembed --dry-run

# 3. Run it for real:
FALDA_ROOT=/data FALDA_DIM=1024 FALDA_EMBED=remote \
FALDA_EMBED_BASE_URL=http://qwen-embedder:8000/v1 FALDA_EMBED_MODEL=Qwen3-Embedding-0.6B \
falda reembed --yes

# 4. Restart falda serve with the same FALDA_EMBED*/FALDA_DIM env — it will
#    boot clean against the EMBEDDING.json falda reembed just wrote.
```

Or directly, e.g. inside the `falda` container in a Compose deployment where
`bin/falda` isn't on `PATH` but `dist/` is (same pattern as `docker compose
exec falda node dist/stats.js`): `node dist/reembed.js --dry-run` / `node
dist/reembed.js --yes`, with the target `FALDA_EMBED*`/`FALDA_DIM` passed via
`docker compose exec -e ...` or already set as the container's environment.

What it does, per store (every self-tenant + declared pool under
`FALDA_ROOT`, or one selected via `--tenant=T`/`--pool=P`):

1. Probes the newly configured embedder first (same `probeEmbedder` check
   as server boot) — aborts before touching any store if it's down or
   returns the wrong dimension.
2. Drops and recreates `atoms_vec`/`scenes_vec`/`stream_vec` at the new
   dimension — the dimension is baked into the `vec0` schema
   (`embedding float[${dim}]`), so a dim change cannot be done as a
   row-level update — then re-embeds every atom/scene/turn's existing
   content, unchanged, into the rebuilt tables.
3. Once every targeted store succeeds, overwrites `EMBEDDING.json` with
   the new model/dim.

Flags:

| Flag | Effect |
|------|--------|
| `--root=DIR` | Pool root (default: `FALDA_ROOT` env or `./falda-data`) |
| `--tenant=T` | Only re-embed this tenant's self store |
| `--pool=P` | Only re-embed this declared pool's store |
| `--dry-run` | List targeted stores; no writes, no embedder probe side effects beyond the probe itself |
| `--yes` | Required to actually run — omitting it prints the list of targeted stores and exits `1` |

Caveats:

- **Run with the server stopped.** There is no application-level lock
  across the multi-statement rebuild; a write racing the rebuild isn't
  lost (source-of-truth `atoms`/`scenes`/`stream` tables are untouched)
  but might not get a vector until the next `falda reembed` or a normal
  upsert touches it.
- **Content is never touched or re-derived** — this only rebuilds vector
  indexes from existing atom/scene/turn content. It does not re-run
  distillation or regenerate scene titles/summaries.
- **Idempotent per store** — if interrupted partway through a multi-store
  run, re-running is safe; each store's rebuild is a full drop+recreate+
  repopulate from source tables, not an incremental diff.
- **One manifest per root, not per store** — `EMBEDDING.json` is written
  once after all targeted stores finish, so a `--tenant`/`--pool`-scoped
  run still updates the root-level lock; make sure every store under that
  root is actually being migrated together (or plan a separate
  `FALDA_ROOT` per differently-configured deployment).
