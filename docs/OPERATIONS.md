# Interrogating a deployment: `falda stats`

`falda stats` is a read-only, offline report of everything under
`FALDA_ROOT`: per-store tier counts (T0 stream / T1 atoms / T2 scenes / T3
core), the distillation queue's job backlog, recall-usage metrics, and
on-disk config/layout — plus a `warnings` section that flags the cheap,
high-value problems an operator actually cares about (dead-lettered
distillation jobs, a stale pending backlog, an embedding-lock mismatch, a
missing token file, an empty store).

```bash
falda stats                                   # human-readable, everything OFFLINE (see below)
falda stats --json                            # machine-readable, everything offline
falda stats --tenant=my-agent                 # scope to one tenant's self store
falda stats --pool=shared-corpus              # scope to one shared pool
falda stats --section=queue,recall            # only these sections
FALDA_ROOT=/data falda stats                  # point at a specific root
falda stats --section=timing --token=<tok>    # since-startup timing histograms (needs a running falda serve)
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

**Exception: `--section=timing`.** Since-startup timing histograms
(`src/metrics.ts`) live only in the memory of a running `falda serve`
process — they are not written to disk, by design (they reset on every
restart). This one section therefore breaks the "always offline" rule: it
makes an authenticated `POST /metrics` call against a running server
(`--url`/`FALDA_URL`, default `http://localhost:8077`, and
`--token`/`FALDA_TOKEN`). If no server is reachable or the token is
rejected, the section reports `unavailable` with a reason and the report
still completes normally (a warning, not a crash) — every other section is
unaffected. `timing` is never included unless explicitly requested via
`--section=timing` (or a list containing it), so a plain `falda stats`
never makes a network call.

## Sections

| Section  | Reports |
|----------|---------|
| `stores` | Per store (self + pool): stream turn count and head `seq`, atom counts by status (`active`/`superseded`/`merged`/`archived`) plus pinned count, scene counts by kind/status (`episode`/`topic` × `active`/`retired`), core presence + size. |
| `queue`  | `distill_jobs` grouped by status (`pending`/`running`/`done`/`dead`), the full dead-letter list (store_key, attempts, error), and the oldest pending job's age. |
| `recall` | Per `store_key`: trace count and item count from `recall_traces.db` (see `docs/RECALL_TRACES.md`). Coarser than `computeRecallMetrics()` (no usage-rate breakdown) — this is an inventory view, not the tuning view `/recalls/metrics` gives one authenticated tenant. |
| `layout` | Presence of `distill_queue.db`, `recall_traces.db`, `pools.json` (+ pool count), `EMBEDDING.json` (+ locked model/dim), and the resolved token file path. |
| `timing` | **Live server only** (see above) — since-process-startup histograms for `recall_ms` (assembleContext wall time), `distill_pending_ms` (queue enqueue → claim), and `distill_service_ms` (distillOnce wall time). Plus three foreground-latency histograms split by whether a distillation pass was in flight at observation time (`distill_active=true/false`): `http_request_ms` (gateway `handleRequest` wall time, excluding `/metrics` itself), `mcp_request_ms` (whole MCP request wall time), and `stream_add_ms` (`addStream` wall time, from both the HTTP and MCP ingestion entry points) — this is the signal for whether long-running distill passes are stalling foreground requests. Fixed predetermined bins, no percentiles (raw samples aren't retained) — count/min/max/mean per histogram. Resets on every `falda serve` restart. |

Omit `--section` to run the four offline sections (`stores`, `queue`,
`recall`, `layout`). `timing` is opt-in only — pass it explicitly (e.g.
`--section=timing` or `--section=queue,timing`).

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

Both are process-startup checks — they run once per `falda serve` process
boot, not per-request.

# Re-embedding after a model/dimension change

`enforceEmbeddingLock` (`src/boot.ts`) refuses to boot any server process
whose `FALDA_EMBED_MODEL`/`FALDA_DIM` no longer match a store's locked
`EMBEDDING.json` manifest — its error message has always pointed at
"re-embed the store and update the manifest." `falda reembed` is that
command.

```bash
# 1. Stop every `falda serve` process against this root.

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

# Backing up and restoring FALDA

Durable state under `FALDA_ROOT` spans several files that must be captured
together and consistently: every self-tenant/pool `falda.db` (WAL mode,
`src/falda.ts`), `distill_queue.db` and `recall_traces.db`
(`src/runtime.ts`), `pools.json`/`EMBEDDING.json`, and each store's blob
directory (`core.md`, `scenes/*.md`). **A plain `cp` of these files is not
safe** — WAL mode means a file copied mid-checkpoint, or without its
`-wal`/`-shm` sidecars, can be corrupt or missing recent writes.
`falda backup` and `falda restore` snapshot every SQLite file with
[`VACUUM INTO`](https://www.sqlite.org/lang_vacuum.html#vacuuminto), which
produces one consistent, sidecar-free file safe to copy even while the
store is open, then copy the JSON config and blob trees, and write a
manifest with a SHA-256 checksum of every captured file.

**Not backed up:** the bearer token file. It lives outside `FALDA_ROOT`
(`src/runtime.ts` `resolveTokensPath`) and is a secret, not application
data — back it up through your own secret-management path, separately.

```bash
# 1. Take a backup (safe to run against a live deployment — every SQLite
#    file is snapshotted with VACUUM INTO, not copied raw):
falda backup --root=/data --out=/backups/falda-2026-08-18

# 2. (elsewhere / later) Restore into a FRESH root and verify:
falda restore --from=/backups/falda-2026-08-18 --root=/data-restored

# 3. Point FALDA_ROOT at the restored root and start `falda serve` there
#    once you're satisfied with the verification output from step 2, or
#    swap it into place of the original /data.
```

Or directly (e.g. inside the `falda` container in a Compose deployment):
`node dist/backup.js --out=/backups/... ` / `node dist/restore.js
--from=/backups/... --root=...`, same pattern as `node dist/reembed.js`
above.

## `falda backup`

| Flag | Effect |
|------|--------|
| `--root=DIR` | Pool root to back up (default: `FALDA_ROOT` env or `./falda-data`) |
| `--out=DIR` | Destination directory for the backup — must not already exist and be non-empty (a backup is always written into a fresh directory) |
| `--tenant=T` | Only back up this tenant's self store (plus root-level files) |
| `--pool=P` | Only back up this declared pool's store (plus root-level files) |
| `--dry-run` | List which stores/files would be captured; no writes |

What it captures, per store (every self-tenant + declared pool under
`--root`, or one selected via `--tenant`/`--pool`) plus root-level files:

1. `falda.db` via `VACUUM INTO` — skipped (not an error) for a declared
   pool whose store has never been written to, since it has no db file yet.
2. The store's blob directory (`core.md`, `scenes/*.md`), copied as-is.
3. `pools.json`, `EMBEDDING.json`, `distill_queue.db` (`VACUUM INTO`),
   `recall_traces.db` (`VACUUM INTO`) — whichever of these root-level files
   exist.
4. `backup-manifest.json`, listing every captured file's relative path,
   byte size, and SHA-256 checksum, plus the backup's `falda_version` and
   the root's locked embedding dimension/model from `EMBEDDING.json` (if
   any).

## `falda restore`

| Flag | Effect |
|------|--------|
| `--from=DIR` | Backup directory, as written by `falda backup --out=DIR` |
| `--root=DIR` | Target root to restore into (default: `FALDA_ROOT` env or `./falda-data`) |
| `--dry-run` | Verify the backup and report what would be restored; no writes |
| `--yes` | Required to restore into a **non-empty** target root |

What it does:

1. Reads `backup-manifest.json` and verifies every listed file's byte size
   and SHA-256 checksum against the backup directory — a corrupt or
   tampered backup is rejected before anything is copied.
2. Refuses if the target root already has an `EMBEDDING.json` whose `dim`
   disagrees with the backup's locked dimension — restoring a snapshot
   taken at one dimension into a root locked to a different one would
   leave the `vec0` tables inconsistent with the lock (same rationale as
   `falda reembed`, `src/boot.ts` `enforceEmbeddingLock`).
3. Refuses a non-empty target root unless `--yes` — **restoring into a
   fresh directory and swapping it into place of the original is the
   recommended path**, not restoring in place over a live root.
4. Copies every captured file into the target root's original layout, then
   runs a post-restore verification pass (the same `inspectStore` `falda
   stats` uses) over every restored store and reports tier counts —
   confirm these match what you expect before starting `falda serve`
   against the restored root.

Caveats:

- **Run with the server stopped**, both when taking a backup meant to
  represent a specific point in time for a planned migration/decommission,
  and always before restoring — `falda restore` does not coordinate with a
  running server, and copying files into a root a live process is writing
  to is unsupported.
- **`distill_watermark`/`core_state`/`store_dirty` rows ride along inside
  each restored `falda.db`** but are explicitly disposable operational
  cursors (`src/distill/watermark.ts`) — if you ever needed to restore an
  older backup than the last one taken, losing recent progress on those
  only costs an extra reconciliation pass on next boot, never data.
- **The bearer token file is never included** — restoring a root does not
  restore who's allowed to talk to it; provision the token file for the
  restored deployment separately.

# Reviewing distillation quality: `falda distill inspect`

A successful LLM call is not evidence of successful distillation.
`falda distill inspect` is a read-only, offline report of what
distillation *decided* — not merely whether the job ran — so an operator
can audit semantic behavior after the fact: which candidate memories were
extracted, whether each was stored/updated/merged/skipped and why, what
old memories were replaced or absorbed, what T0 evidence supports the
result, how T2 scene membership changed, whether T3 core regenerated, and
whether anything about the pass looks suspicious enough to review by hand.

```bash
falda distill inspect                              # last 10 passes, all stores
falda distill inspect --tenant=my-agent            # scope to one tenant's self store
falda distill inspect --last=5
falda distill inspect --since=24h
falda distill inspect --pass=<pass-id>
falda distill inspect --action=merge,update        # the two destructive actions
falda distill inspect --action=skip --evidence     # what got thrown away, and why
falda distill inspect --random=20                  # sample decisions for spot review
falda distill inspect --json | jq .
falda distill inspect --pass=<pass-id> --export-fixture=case.json
```

Or directly: `tsx src/inspect/cli.ts [args]` / `node dist/inspect/cli.js
[args]` / `npm run distill-inspect -- [args]`.

## What it reads (and does not write)

`falda distill inspect` opens each in-scope store's `falda.db` **read-only**
(`{ readonly: true }`), the same store-enumeration/scoping convention as
`falda stats`/`falda reembed` (`--root`/`--tenant`/`--pool` over
`FALDA_ROOT`, no token/auth layer — this is a filesystem-access tool for
operators, not an authenticated per-tenant API surface). It never opens a
`PoolManager`, never calls an embedder, and executes no `INSERT`/`UPDATE`/
`DELETE` statement anywhere in `src/inspect/` — a store is byte-identical
before and after any `inspect` invocation, including `--export-fixture`
(the fixture file is the only write, and it lives outside the store).

It reads four tables that `distillOnce()` (`src/distill/core.ts`) now
populates on every pass, alongside the existing `atoms`/`scenes`/`stream`:

- **`distillation_passes`** — one row per pass: timing, watermark range,
  input turn count, candidate count, job status, and provenance (`model`,
  `prompt_version`, `distiller_version`) so a bad decision can be
  attributed to the policy that produced it.
- **`consolidation_decisions`** — extended with `candidate_type`/
  `candidate_content`/`candidate_confidence`. This is the fix for a real
  gap: previously a `skip` decision recorded only its rationale — the
  candidate memory it rejected was unrecoverable. Now every decision,
  including skip, retains the candidate that was proposed.
- **`pass_scene_effects`** / **`pass_core_effects`** — per-pass T2/T3
  effect log: which scenes were created/updated/retired (with member
  before/after counts and added/removed atom ids) and whether T3 core was
  regenerated/deleted/unchanged (with old/new input hash and char count).

**Only passes distilled after this feature was deployed are visible.**
`distillation_passes` did not exist before; there is no way to
retroactively reconstruct pass timing, provenance, or scene/core effects
for older passes, and `inspect` does not attempt to synthesize a degraded
view from `consolidation_decisions` alone — a pass with no
`distillation_passes` row simply does not appear.

## Selectors

Selectors compose (e.g. `--since=7d --action=merge --evidence`):

| Flag | Effect |
|------|--------|
| `--root=DIR` / `--tenant=T` / `--pool=P` | Store scope — same as `falda stats` |
| `--last=N` | Most recent N passes. Default `10`, applied only when no other selector (`--since`/`--pass`/`--random`) already narrows the result — so `--since=24h` on its own shows every matching pass, not just 10 of them. |
| `--since=24h\|7d\|30m` | Passes started within the given duration (`m`/`h`/`d`/`w` units) |
| `--pass=ID` | Exact pass lookup |
| `--action=A[,A...]` | Only passes/decisions with action `store`, `update`, `merge`, and/or `skip` — narrows both which passes are listed and which decisions are shown within them |
| `--status=running\|done\|failed` | Job status — `failed` surfaces passes where `distillOnce` threw, with the error message, distinct from the recall/queue health `falda stats` already reports |
| `--random=N` | Sample N **decisions** at random (not cryptographic — a full shuffle is unnecessary here), grouped by owning pass, honoring `--action`/store scope |
| `--evidence` | Include T0 evidence turns per decision |
| `--verbose` | Expand evidence truncation limits (10→50 turns, 1000→5000 chars/turn), show unchanged scenes, include `decided_at` timestamps |
| `--json` | Structured JSON — same DTOs as the human renderer, not a separate representation |
| `--export-fixture=PATH` | Write a replayable evaluation fixture (requires `--pass`) |

## Evidence resolution

- **store/update/merge** (a durable atom exists): evidence is the atom's
  full `atom_evidence → stream` chain — every turn that ever contributed
  to that atom, including prior passes for an atom that's been updated
  more than once.
- **skip** (no durable atom was ever created): evidence falls back to the
  pass's own turn window (`watermark_start`, `watermark_end`] — the only
  evidence a rejected candidate ever had.

Defaults: 10 evidence turns per decision, 1000 chars per turn, with an
explicit `truncated` flag (and a "…(truncated)" marker in human output)
when either limit is hit. `--verbose` raises both ceilings.

## Warnings are heuristics, not judgments

`falda distill inspect` computes anomaly signals to direct attention —
`large_extraction`, `empty_extraction`, `large_merge`,
`atom_growth_spike`, `rapid_supersession`, `scene_churn`, `core_churn` —
purely by reading already-persisted state; computing them never mutates
anything. Thresholds are configurable per deployment without a rebuild:

| Env | Default | Meaning |
|-----|---------|---------|
| `FALDA_INSPECT_WARN_LARGE_EXTRACTION_RATIO` | `1.5` | `candidate_count / input_turn_count` above this warns |
| `FALDA_INSPECT_WARN_EMPTY_EXTRACTION_MIN_TURNS` | `5` | zero candidates from at least this many turns warns |
| `FALDA_INSPECT_WARN_LARGE_MERGE_ATOMS` | `3` | a merge absorbing at least this many atoms warns |
| `FALDA_INSPECT_WARN_ATOM_GROWTH_SPIKE` | `10` | atoms stored in a single pass at/above this warns |
| `FALDA_INSPECT_WARN_RAPID_SUPERSESSION_MINUTES` | `60` | an atom updated/merged away within this many minutes of its own creation warns |
| `FALDA_INSPECT_WARN_SCENE_CHURN_FRACTION` | `0.5` | scene membership `(added+removed)/max(before,after)` above this warns |
| `FALDA_INSPECT_WARN_CORE_CHURN_FRACTION` | `0.5` | core char-count relative change above this warns |

## Fixture export — turning a bad decision into a regression test

`falda distill inspect --pass=<id> --export-fixture=case.json` (optionally
narrowed with `--action`) writes one JSON object per matched decision:
the T0 evidence, the extracted candidate, the existing atoms presented to
consolidation, the applied decision (action/target_ids/rationale), the
resulting atom id, and the model/prompt/distiller version that produced
it. This is deliberately decoupled from any store mutation — exporting a
fixture never approves, rejects, or otherwise changes the decision it
describes; it exists purely so a mistake found by inspection can become a
future `distillOnce` regression case.

## What this is not

- Not a mutation tool — `falda distill inspect` has no approve/reject/undo.
  If inspection reveals a decision that should be corrected, that requires
  a separate, explicit action through the existing atom lifecycle (see
  `Falda.supersedeAtom`/`archiveAtom` in `src/falda.ts`), not this command.
- Not a substitute for `falda stats`'s `queue` section — `stats` answers
  "did distillation execute" (job status, dead-letter, backlog age);
  `inspect` answers "what did successful distillation decide."

# Previewing a recall: `falda show recall`

`falda stats` and `falda distill inspect` are deliberately offline: no
embedder, no running server, filesystem access only. Showing a *recall* is
different — a real recall needs the configured embedder for dense search,
and the running `falda` server already has it wired. `falda show recall`
is a normal authenticated HTTP client against that server, not another
offline inspector.

```bash
# What did the last recall for this tenant return? (the common case)
falda show recall --tenant=my-agent --token=<tok>
falda show recall --tenant=my-agent --token=<tok> --last   # same thing, spelled explicitly

# A specific past recall, by the recall_id falda_recall/POST /recall returned
falda show recall --tenant=my-agent --recall-id=<id> --token=<tok>

# Fire a NEW recall and show it
falda show recall --tenant=my-agent --query="deployment tooling" --token=<tok>
falda show recall --tenant=my-agent --topic=<scene-id-or-title-substring> --token=<tok>

# Point at a non-default server / read the token from FALDA_TOKEN instead
FALDA_URL=http://localhost:8077 FALDA_TOKEN=<tok> falda show recall --tenant=my-agent
```

Or directly: `tsx src/show/recall.ts [args]` / `node dist/show/recall.js
[args]` / `npm run show-recall -- [args]`.

In a Compose deployment, run it inside the `falda` container the same way
you'd run `falda stats`:

```bash
docker compose exec -e FALDA_ROOT=/data falda \
  node dist/show/recall.js --tenant=my-agent --token=<tok>
```

## "What did the last prompt's recall return?"

With no selector — or explicitly `--last`, which takes no value and exists
so this can be said out loud rather than relying on the absence of every
other flag — `falda show recall` fetches the **most recent** recall trace
for the addressed tenant/pool (`POST /recalls/reconstruct {recall_id:
"latest"}`) and re-renders it. This answers "what memory did the agent's
last recall actually pull" without needing to already know a `recall_id`.

**This is a reconstruction, not a recording.** A recall trace
(`docs/RECALL_TRACES.md`) never stored the rendered text an agent
originally saw — only the query, budget, and each admitted item's
`{tier, id, source, score, chars}`. `falda show recall` re-fetches each
item's *current* content from the store and re-renders it with today's
tier caps. If memory has changed since (an atom superseded/merged/
archived, a scene retired, core regenerated or deleted — most commonly
because a distillation pass ran in between), the output says so under
"Stale items" rather than silently showing stale or missing content:

```
Recall 7014deff-...
2026-08-15T20:24:23.978Z  mode=explicit  query="deploy script location"
budget: 69 / 6000 chars

(reconstructed from current memory — not a byte-faithful replay of what was originally returned)

## Pinned
always run tests before merging

## Relevant facts/preferences/rules
The deploy script lives in bin/release

Stale items (changed since this recall):
  T1 3f8a...: superseded
```

If a tenant/pool has never made a recall, the command says so plainly
rather than erroring — this is an expected state for a fresh store.

## Firing a fresh recall

`--query="..."` or `--topic=<id-or-substring>` run a real, new
`POST /recall` and print today's result — this is a genuine recall (it
writes a new trace, same as `falda_recall`/any other client), not a
preview. `--topic` is for "show me a recall from the appropriate topic"
without composing a query string yourself: it resolves server-side to an
active **topic** scene (exact `scene_id`, else a case-insensitive title
substring — `src/recall/topic.ts`) and recalls using that scene's title.

## What this is not

- Not offline — requires the `falda` server running and a valid bearer
  token, unlike `falda stats`/`falda distill inspect`.
- Not a byte-faithful replay — see "Stale items" above. If a future need
  arises for exact historical replay, that would require persisting
  rendered text at recall time (a trace schema change), which this
  command deliberately does not do.
- `--query`/`--topic` mode writes a new recall trace like any other
  recall; the default "show the last one" / `--recall-id` mode does not.
