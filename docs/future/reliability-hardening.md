# Reliability hardening — future work

**Status: proposed / future work. Not yet implemented.** This is a design/
tracking doc, not a changelog — nothing here has landed in `src/`. It
records a read-only audit of the failure and recovery paths (not the
nominal path), so the analysis isn't lost as tribal knowledge, in the same
spirit as `docs/future/auth-hardening.md`.

**Verification baseline at audit time:** `npm run build` succeeds; `npm
test` passes all 301 tests. The gaps below are concentrated in error
handling, crash recovery, and operational surfaces that a stable, mostly-
successful deployment does not normally exercise — model/embedding
outages, process restarts, deletes, and old-store upgrades.

## Ranked findings

### Critical

**1. L1 atom creation happens outside the documented atomic transaction. — ✅ addressed**
`docs/MODEL.md:923-939` and `src/distill/core.ts:8-11` both promise that
atom mutations, evidence, decisions, and the watermark commit as one unit.
In practice, new atoms are written via `upsertAtom()` *before*
`BEGIN IMMEDIATE` (`src/distill/core.ts:383-408`, transaction starts at
`src/distill/core.ts:410-412`), and `upsertAtom()` itself writes the atom
row and FTS entry before awaiting the embedding and inserting the vector
(`src/falda.ts:711-722`). On retry after a failure, an atom ID that
already exists is not re-added to `preparedAtoms`
(`src/distill/core.ts:394-407`), so the transactional half (evidence,
decisions, watermark) can proceed without ever attaching evidence to a
previously-created atom. Active atoms can end up without evidence edges,
episode membership derived from provenance can omit them, and lexical vs.
vector recall can disagree — while the decision audit and watermark still
claim the pass completed cleanly.

*Recommendation:* prepare embeddings outside the transaction, but commit
the atom row, FTS/vector index rows, evidence, lifecycle changes,
decisions, and watermark write together inside one synchronous
transaction. On replay, existing deterministic atom IDs must still enter
the transaction's prepared-operation set so evidence/index consistency can
be repaired.

**Landed:** `src/falda.ts` now exposes a shared, fully-synchronous atom
writer (`writeAtomWithEmbeddingSync`, private) used by both the public
mutation path and distillation, so there is exactly one code path that can
insert/repair an atom row plus its `atoms_fts`/`atoms_vec` index rows.
Index repair is delete-then-insert (not `INSERT OR IGNORE`), since
`atoms_fts.id` is `UNINDEXED`, not unique — a naive insert could leave
duplicate FTS rows behind. An explicit `ExistingAtomPolicy` distinguishes
the two callers' semantics when `id` already exists: `"update"` (public
`upsertAtom()` — overwrite mutable metadata) vs. `"preserve"`
(distillation replay via the new `@internal` `upsertDistilledAtomSync()` —
leave metadata/status untouched, repair only the index rows). `upsertAtom()`
now precomputes and validates the embedding (new `prepareAtomEmbedding()`)
*before* opening a `db.transaction(...).immediate()` that performs the
write, closing the public-path partial-write hazard as a side effect of
sharing the writer.

`src/distill/core.ts`'s L1 phase now does all LLM/embedding/candidate-
search work (fully async) first, then opens one
`db.transaction(() => {...}).immediate()` that: (a) ensures/repairs each
*unique* prepared atom via `upsertDistilledAtomSync()` — deliberately not
gated on "does this id already exist", so a historical orphaned atom (row
present, index rows missing) gets repaired on replay — then (b) performs
every candidate's evidence/lifecycle/decision write, then (c) advances the
watermark as the last statement. A throw anywhere in that callback rolls
back all of it, including the atom/index writes from step (a) — this is
the core fix. Counters and log lines are accumulated in local variables
and only applied to the result/emitted after the transaction durably
commits, so a rolled-back pass can never report partial success.

Two related correctness bugs surfaced and were fixed as part of sharing one
transaction: an "update" decision whose target is the atom's own
deterministic id ("update-to-self") now still attaches the pass's evidence
(previously it could silently drop it, since the old code diffed the same
id against itself); and a "merge" decision whose target list happens to
include the winning atom's own id no longer marks the winner `merged` too
(`mergeAtoms()` is now called with the target list minus the winner id).

Tests: `test/distill_l1_atomic.test.ts` — public `upsertAtom()` atomicity
on embed failure (new-atom and existing-atom/metadata-update cases),
distillation embed-failure atomicity (with a successful retry after
disarming), a mid-transaction rollback via an injected `addEvidence`
failure, legacy orphan index repair, duplicate-candidate index consistency
(one atom/index row, two decision rows, one `prepareAtomEmbedding` call),
update-to-self evidence attachment, and merge-self exclusion. All existing
tests continue to pass unchanged (`test/distill_core.test.ts`,
`test/distill_inspect.test.ts`, `test/distill_watermark_seq.test.ts`,
`test/data_model_schema.test.ts`).

**2. L2/L3 failures and lifecycle-only changes are not independently
retryable. — ✅ addressed**
A pass with no new stream turns returns immediately
(`src/distill/core.ts:257-261`), but the watermark advances at the end of
L1, *before* L2 (scenes) and L3 (Core) run
(`src/distill/core.ts:467-469,475-487`). If L2 throws, the worker
reschedules the job (`src/distill/worker.ts:153-164`), but the retried
pass sees no new turns and exits before L2/L3 ever run again, and the
worker marks it complete. L3 failures are swallowed and reported as pass
success (`src/distill/core.ts:767-783`); scene title/summary LLM failures
are also swallowed while the new `content_hash` is persisted anyway
(`src/distill/core.ts:682-712`), so a failed narration is never retried.
Out-of-band atom lifecycle changes (archive, direct supersession, merge,
hard delete, evidence deletion) are documented to regenerate on "the next
`distillOnce()` pass" (`src/falda.ts:726-754`), but a pass with no new T0
turns exits before reaching L2/L3 — so if no later turn ever arrives,
scenes/Core can remain permanently stale, contradicting
`docs/MODEL.md:940-947` (L2/L3 retryability) and `docs/MODEL.md:973-984`
(forgetting propagation).

*Recommendation:* separate the L1 cursor from downstream
reconciliation state. A job must be able to run L2/L3 even against an
empty T0 window. Persist a dirty/reconcile-needed flag and only mark a job
complete once all required downstream phases succeed; never advance a
scene's content hash when its requested narration failed.

**Landed:** a new `store_dirty` table (`src/distill/watermark.ts`'s
`initDirtySchema`/`markDirty`/`isDirty`/`clearDirty`), independent of
`distill_watermark`, tracks "L2/L3 must run even with an empty T0 window."
`Falda` gained a `storeKey` (`FaldaOptions.storeKey`, threaded from
`PoolManager.resolve()` via `storeKeyFor()`) and a private
`markStoreDirty()` called by every lifecycle method that can leave a scene
or core stale: `supersedeAtom`, `mergeAtoms` (when losers are non-empty),
`archiveAtom` (when a row was actually archived), `hardDeleteAtomsUnsafe`
(when rows were actually removed), and `deleteStream` (when
`affected_atom_ids` is non-empty) — a true no-op call to any of these does
NOT mark dirty.

`distillOnce`'s early-return now reads `isDirty()` alongside the existing
turns-vs-watermark check: only a store with zero new turns AND no dirty
flag is skipped. A dirty-only pass (zero new turns) skips extraction/
consolidation entirely (no LLM calls, no candidate search) and falls
through straight to L2/L3; the L1 transaction still runs but does nothing
and, critically, does not advance the watermark when there is no real
`lastTurn` (verified as a required test — a fabricated advance would
corrupt the L1 cursor).

L2/L3 failures are now tracked and propagated: a scene-narration failure
is still isolated per-scene (one scene's failure doesn't skip its
siblings) but is counted, and — the actual bug fix — `content_hash` is no
longer advanced for a scene whose narration call failed (previously the
new hash was persisted unconditionally, permanently defeating hash-gated
retry for that scene; this was caught by 3 latent test bugs this phase
uncovered — see below). A core-synthesis failure is tracked via the
existing `coreEffect === "failed"` value. After the existing best-effort
telemetry writes (unchanged — `distillation_passes`/effect rows are still
best-effort per `docs/MODEL.md §8.5`), if either L2 or L3 failed, the
function marks the store dirty again (in case it wasn't already) and
throws — this propagates through `distillOnce`'s existing failure path
(which sets `distillation_passes.status='failed'`) to
`src/distill/worker.ts`'s `runJob`, whose catch calls `failJob()` instead
of `completeJob()`, engaging the existing 30s→900s backoff / 8-attempt
dead-letter policy rather than silently reporting success. The dirty flag
is cleared only on the fully-clean path, so a retry (or the next sweep)
re-runs L2/L3 against current state — safe because L2/L3 are pure,
hash-gated functions of the active-atom/scene set.

A second, independently-discovered bug was fixed as part of this phase:
when a store's last active atom is forgotten (all atoms
archived/superseded/merged/deleted), the topic-scene clustering block was
skipped entirely (gated on `allAtomRows.length > 0`), so existing topic
scenes were never retired even though `docs/MODEL.md §8.7` requires it.
Fixed by adding an explicit zero-active-atoms branch that retires every
still-active topic scene.

`src/distill/worker.ts`'s sweep gate (`enqueueAll`) now enqueues a store
when it has undistilled turns **or** is flagged dirty, even with zero
undistilled turns — the only worker-side change. Per an explicit scope
decision: marking a store dirty does **not** itself enqueue or wake a job
(considered and deferred) — reconciliation waits for the next periodic
sweep (`FALDA_SWEEP_INTERVAL_MS`, default 5 min), matching the existing
passive-sweep latency for ordinary L1 work. `src/gateway.ts`'s
atom-lifecycle HTTP routes are unchanged.

Tests: `test/distill_l2_l3_reconcile.test.ts` (10 tests) — dirty-only
reconciliation with an empty T0 window, a fully-clean store remaining a
true no-op, L2 and L3 failures each failing the pass and leaving the store
dirty (with a successful retry that clears it), and dirty-marking coverage
for all five lifecycle methods including their no-op cases. 3 tests added
to `test/distill_worker.test.ts`: the sweep gate enqueuing a
dirty-but-caught-up store, a clean-and-caught-up store NOT being
over-enqueued, and an L2/L3 failure resulting in `failJob()` (pending,
`attempts > 0`) rather than `completeJob()`. Fixing this finding's
content-hash bug surfaced 3 pre-existing tests
(`test/distill_core.test.ts`'s "episode identity" and "sceneMatchThreshold
=0" tests, `test/distill_watermark_seq.test.ts`'s cross-session test) that
were silently relying on the swallowed-L2/L3-failure bug — their mock LLMs
didn't supply enough responses for the topic scene's narration, and the
old code masked that gap. All three were fixed by completing their mock
response sequences, not by relaxing any assertion.

**Considered, deferred:** no new `falda distill inspect`/`falda stats`
surface for `store_dirty` was added — the finding's recommendation and
this phase's confirmed scope only required correct reconciliation
behavior, not new operator-facing dirty-state visibility. Revisit if an
operational need for it emerges.

### High

**3. Queue jobs left `running` by a process crash are never recovered. — ✅ addressed**
`claimNext()` moves a job from `pending` to `running`
(`src/distill/queue.ts:122-136`) and only the active worker calls
`completeJob()`/`failJob()` (`src/distill/worker.ts:153-164`). There is no
lease, heartbeat, owner ID, or startup recovery pass — queue
initialization only creates/migrates schema (`src/distill/queue.ts:39-71`).
A crash, OOM kill, or host restart after claim but before completion
strands the job in `running` forever: it can't be reclaimed, a fresh
enqueue for the same store only coalesces against `pending` rows
(`src/distill/queue.ts:91-101`), and the retry/backoff/dead-letter policy
never applies to it. Named pools aren't swept at all
(`src/distill/worker.ts:36-38`), so a crashed pool job has no automatic
replacement.

*Recommendation:* add a lease (`claimed_at`/`lease_until`/worker id) and
requeue expired `running` jobs on startup or next claim attempt.

**Landed:** `distill_jobs` gained `lease_until`/`worker_id` columns
(additive migration, `src/distill/queue.ts`'s `initQueueSchema`).
`claimNext()` now stamps a fresh lease + worker id on every claim (fresh or
reclaimed) and its ready-job predicate also matches a `running` row whose
lease has expired or is `NULL` (the latter covers a job orphaned by a
pre-lease binary); `completeJob()`/`failJob()` clear the lease.
`startDistiller()` calls the new `recoverStaleJobs()` once at boot, before
the first sweep/drain tick, and logs how many jobs it recovered — so an
orphaned job doesn't have to wait for a fresh claim attempt to become
visible again. Lease duration defaults to 10 minutes
(`FALDA_DISTILL_LEASE_MS`), fixed for the claim's duration (no mid-run
heartbeat/renewal — see the tradeoff note in `src/distill/queue.ts`'s
`DEFAULT_LEASE_MS` doc comment). Named-pool jobs still aren't
auto-swept (unchanged; separate from this finding). Tests:
`test/distill_queue_lease.test.ts`, plus two boot-integration tests in
`test/distill_worker.test.ts`'s "startDistiller: crash recovery on
startup".

**4. Shutdown is not graceful; remote calls have no timeout. — ✅ addressed**
`ServeHandle.close()` stops timers and immediately closes listeners and
SQLite handles without waiting for in-flight HTTP/MCP requests or a
running distillation pass (`src/server.ts:173-178`); `DistillerHandle.stop()`
only clears timers, not `runJob()` (`src/distill/worker.ts:260-268`); no
`SIGTERM`/`SIGINT` handlers are installed (`src/server.ts:182-186`).
Compounding this, embedding and LLM fetches have no `AbortSignal`/timeout
(`src/embedder.ts:20-28`, `src/distill/llm.ts:38-46`), so a stalled
upstream can hold a request or a queue job open indefinitely and block
orderly shutdown.

*Recommendation:* install signal handlers that stop enqueuing new work,
await in-flight requests/jobs (with a bounded grace period), then close
storage. Add timeouts/cancellation to outbound embedding and LLM calls.

**Landed, remote-call timeouts:** `makeEmbedder()`/`makeLLM()` now pass
`AbortSignal.timeout(...)` on their `fetch` calls (`FALDA_EMBED_TIMEOUT_MS`
default 30s, `FALDA_LLM_TIMEOUT_MS` default 120s), surfacing a clear
timeout error that flows into the existing `failJob` backoff/dead-letter
path rather than hanging indefinitely. Tests: `test/remote_timeouts.test.ts`.

**Landed, graceful shutdown:** `DistillerHandle.stop()` is now async — it
stops the drain/sweep/prune timers and flips an internal `stopping` flag
(so a concurrent `wake()` or in-flight drain tick can no longer claim new
work), then awaits any job already in flight, bounded by
`FALDA_SHUTDOWN_GRACE_MS`/`shutdownGraceMs` (default 10s) so a stuck pass
cannot hang shutdown forever. `startHttpApi()` gained an `InFlightTracker`
that wraps every request-handler promise; `ServeHandle.close()` is now
async and, in order: stops the HTTP/MCP listeners from accepting new
connections, awaits in-flight HTTP handlers and `distiller.stop()` in
parallel (each independently bounded by the same grace period), then
closes the pool/queue/trace databases. `close()` is idempotent. `falda
serve`'s `IS_MAIN` entrypoint now installs `SIGTERM`/`SIGINT` handlers that
call `close()` and exit 0 on success (exit 1 on error); a second signal
during shutdown forces an immediate exit rather than waiting out the grace
period again. MCP relies on its own listener close rather than the same
in-flight tracking used for HTTP (the MCP SDK owns that request's
lifecycle). Tests: `test/graceful_shutdown.test.ts`,
"startDistiller: graceful stop()" in `test/distill_worker.test.ts`.

**5. Stream deletion leaves stale FTS/vector index rows. — ✅ addressed**
`addStream()` writes all three representations (row, FTS, vector;
`src/falda.ts:509-513,561-564`), but `deleteStream()` only removes
evidence and the primary `stream` row — never `stream_fts` or
`stream_vec` (`src/falda.ts:615-643`). Search resolves hits from the
stale indexes first (`src/falda.ts:1235-1252`), so deleted content can
still surface as ghost search results, and physically deleted text
remains recoverable from the index tables.

*Recommendation:* delete primary, FTS, vector, and evidence rows in one
transaction; add a test asserting deleted content is unreachable by both
lexical and vector search.

**Landed:** `deleteStream()` now runs entirely inside one
`db.transaction(...).immediate()` (finding-1 pattern), and both of its
resolution paths (`{ ids }` and `{ session_id }`) delete the matching
`stream_fts` and `stream_vec` rows alongside `atom_evidence` and the
primary `stream` row — so a deletion request removes all four
representations atomically or none of them. `deleteStream` is a
caller-invoked operation only (`POST /stream/delete`; nothing in the
distillation pipeline calls it), used for retraction, correction, or
privacy erasure of raw turn content (`docs/MODEL.md` §5.4); leaving the
FTS/vector rows behind meant "deleted" text was still physically
recoverable and still consumed `hybridStream`'s candidate slots
(`src/falda.ts:1430-1448`), which this closes. `markStoreDirty()`
(finding 2) still fires after the transaction commits, unchanged. The
deliberate no-cascade-to-atoms policy (`affected_atom_ids` returned,
atoms never auto-deleted/archived) is untouched.

A one-time repair also runs in `migrate()`: any `stream_fts`/`stream_vec`
row whose `id` has no matching primary `stream` row (an orphan left by a
pre-fix deletion) is removed on next store open. Idempotent — a store
with no history of the bug removes zero rows.

Tests (`test/data_model_schema.test.ts`): deleting by `ids` and by
`session_id` each purge `stream_fts`/`stream_vec` for exactly the deleted
turns, verified both via `searchStream()` (the deleted content is
unreachable and a sibling turn still surfaces) and via direct row counts
against the index tables (proving physical removal, not just a
join-filtered display); a fourth test seeds a pre-fix-style orphan
(primary row deleted, index rows left behind) and asserts it is gone
after reopening the store.

**6. Legacy-schema migration can fail before `migrate()` runs. — ✅ addressed**
`initSchema()` creates indexes against newer columns (`stream.seq`
`src/falda.ts:298`, `stream.turn_index` `src/falda.ts:300-303`,
`atoms.status`/`atoms.pinned` `src/falda.ts:325,327`) immediately at
construction (`src/falda.ts:247-259`), and only afterward does
`migrate()` add those columns to older tables (`src/falda.ts:428-501`).
SQLite cannot create an index on a column that doesn't yet exist in a
genuinely old table, so upgrading a pre-migration store can fail at
startup. The existing migration test only reopens a database already
created by the current schema (`test/data_model_schema.test.ts:455-474`)
— it doesn't exercise a real historical layout.

*Recommendation:* create base tables, add missing columns, and only then
create column-dependent indexes/constraints (or move to versioned
migrations). Add fixtures for every supported historical schema.

**Landed:** split store initialization into three ordered phases run
inside one `db.transaction(...).immediate()` — `initSchema()` (base
tables/virtual tables only, no indexes), `migrate()` (additive column
backfills, unchanged), `createIndexes()` (new — every ordinary index,
moved here in full rather than just the five previously-known offenders,
so a future migration that adds an indexed column can't reintroduce this
bug). `createIndexes()` guards the two UNIQUE turn indexes with
`assertNoDuplicateTurnKeys()`, which throws a new `LegacyMigrationError`
naming the offending `session_id`/`turn_index` (or `turn_id`) rather than
silently deduplicating historical data or letting a raw SQLite constraint
error surface. Wrapping all three phases in one immediate transaction
means a failed upgrade (including a `LegacyMigrationError`) leaves the
on-disk store byte-for-byte as it was, never half-migrated. Added
`test/migration_legacy.test.ts` with real on-disk historical fixtures
(built directly with `better-sqlite3`/`sqlite-vec`, bypassing `Falda`'s
constructor) for: the original pre-Branch-A layout (no
`turn_index`/`turn_id`/`seq`, no atom lifecycle columns), the
Branch-A/pre-`seq` layout, the pre-`render_hash`/pre-candidate-audit
layout, and two duplicate-key fixtures that must fail loudly. Confirmed
the fixtures reproduce the original bug by reverting the fix locally and
observing `no such column: seq` thrown at construction. `npm run build`
clean; `npm test` 364/364 (359 baseline + 5 new).

**7. `falda smoke` invokes a nonexistent npm script. — ✅ addressed**
Both `bin/falda smoke` (`bin/falda:117-119`) and `install.sh`
(`install.sh:88-95`) run `npm run smoke`, but `package.json` defines no
`smoke` script (`package.json:27-36`) — confirmed by `npm run build`
succeeding while `npm run smoke` reports `Missing script: "smoke"`. This
breaks the documented one-shot installer contract
(`install.sh:3-13`) and the `falda smoke` CLI command outright. (There is
a passing `test/smoke.test.ts` exercised via `npm test`, which likely
masked the missing dedicated script.)

*Recommendation:* add a `smoke` script to `package.json` (even if it just
runs `test/smoke.test.ts` directly), or update `bin/falda`/`install.sh` to
call the correct target.

**Landed:** added `"smoke": "tsx --test test/smoke.test.ts"` to
`package.json`'s `scripts`. `bin/falda smoke` and `install.sh`'s smoke
step both already invoked `npm run smoke` and check its exit code, so
neither needed a change — they now resolve correctly. Verified `npm run
smoke`, `./bin/falda smoke`, and `install.sh`'s smoke-step logic (`npm run
smoke 2>&1 | tail -4` + exit-code check) all pass. `smoke` remains a
from-source (dev) affordance — `test/` and `tsx` are not in the published
package's `files` allowlist or `dependencies`, matching how `bin/falda
build`/`install.sh` already assume a source checkout; not addressed by
this phase.

**8. Shipped external integrations still target the retired
unauthenticated/body-tenant API. — ✅ addressed**
The current server requires a bearer
token and selects tenant via `X-Falda-Tenant`
(`docs/API.md:10-24`, `src/gateway.ts:345-359`), but the shadow tap
(`integrations/external-source/falda_tap.py:43-48,90-97`), the dual-run
comparator (`integrations/external-source/compare_dualrun.py:19-24`), the
demo driver (`demo/falda_demo.sh:34-39,66-72`), and the public proxy
(`proxy/falda_access_proxy.py:149-164`) all still send no bearer token, and
some still place `tenant` in the request body, which the server no longer
reads. These will all receive `401`/be silently misrouted against the
current auth model. `docs/HARNESS_INTEGRATION.md` is internally
contradictory — it documents current auth in one section
(`docs/HARNESS_INTEGRATION.md:30-41`) but describes the old unauthenticated
contract elsewhere (`docs/HARNESS_INTEGRATION.md:88-101,145-169,217-230`).

*Recommendation:* update each integration to send `Authorization: Bearer`
+ `X-Falda-Tenant`, and reconcile `docs/HARNESS_INTEGRATION.md` to describe
one contract throughout. None of these surfaces are covered by CI
(`.github/workflows/ci.yml:27-34` runs only `npm ci && npm run build &&
npm test`), so add at least a smoke check per integration.

**Landed:** resolved by **retirement**, not by porting the four surfaces to
the current auth contract. All four were reference/operational tooling for
FALDA's retired unauthenticated era (a shadow-migration adapter pair, a
sales/demo script, and a public-facing proxy whose stated purpose — adding
auth in front of an unauthenticated gateway — no longer applies now that the
gateway has native bearer + `X-Falda-Tenant` auth); none are exercised by
the external-demo partners going forward. Removed entirely: `proxy/`,
`integrations/external-source/`, `demo/`, and the two tap-only launchd
templates (`deploy/launchd/com.stevens.falda-tap.plist.template`,
`deploy/launchd/com.example.falda-tap-openclaw.plist.template`) — this also
removed the repo's entire Python footprint (3 `.py` files) and its only
embedded-Python script (in the demo's heredoc). `docs/HARNESS_INTEGRATION.md`
was reconciled to the one current auth contract throughout (bearer +
`X-Falda-Tenant`, no body-tenant), and its shadow-capture sections (built on
the now-removed tap) were removed rather than ported — the guide now covers
only the live memory-provider path for each harness. Dangling references to
the removed paths were fixed in `.gitignore`, `.dockerignore`,
`src/mcp_auth.ts` (comments), `docs/MCP.md`, `integrations/opencode/README.md`,
`README.md`, and `docs/future/auth-hardening.md` (left as an analysis doc
with a note that the proxy is retired and historical, per an explicit scope
decision — not scrubbed of its comparison content). Note: this removes the
repo's only TLS-terminating public front-end pattern; a future public-facing
deployment would use a standard reverse proxy (nginx, Caddy) in front of the
existing in-process auth instead — recorded in `docs/future/auth-hardening.md`.

**9. OpenCode capture plugin can lose a turn on a failed flush. — ✅ addressed**
`flush()` deletes the pending message from local state *before* calling
FALDA (`integrations/opencode/plugin/falda-capture.ts:273-284`); on
failure it only reverts `flushedIds`, not the removed pending content
(`integrations/opencode/plugin/falda-capture.ts:285-290`). Unless OpenCode
happens to re-emit a full text-part update later, that turn is
permanently absent from FALDA — which undercuts the plugin's own stated
rationale that capture shouldn't depend on model/harness replay behavior
(`integrations/opencode/plugin/falda-capture.ts:7-19`). This path has no
automated test coverage.

*Recommendation:* restore the pending entry (not just `flushedIds`) on a
failed `callFaldaStreamAdd`, so a later retry or flush attempt can still
deliver it.

**Landed:** the pending-text/flush bookkeeping (previously three closure-
local `Map`/`Set`s and an inline `flush()` inside the plugin factory) was
extracted into a new, dependency-free module,
`integrations/opencode/plugin/capture-flush.ts`'s `CaptureFlushQueue`. Its
`flush()` now captures the pending entry and any prior `settledRole`
before removing them, and on a failed `send()` restores **both** (not
just the flushed-id marker) and rethrows — so a later text-part update,
settle event, or flush retry can still deliver the turn; nothing is lost
on a single failed attempt. `falda-capture.ts` now delegates to this
queue instead of managing the three maps/sets itself; its behavior
(feature set, event wiring, logging) is otherwise unchanged.

Extracting the state machine also closes the finding's "no automated test
coverage" gap: `integrations/` was previously untestable by `npm test`
because it type-imports `@opencode-ai/plugin`, which isn't installed in
this repo and isn't in `tsconfig.json`'s `include`. `capture-flush.ts` has
no such import, so `test/capture_flush.test.ts` (6 tests) can import and
exercise it directly: successful delivery clears state and is never
re-delivered; a failed `send()` restores both the pending entry and any
prior `settledRole` (verified by asserting the turn is still deliverable
afterward — the actual finding); a retry after a failure delivers exactly
once (no loss, no duplication); a text-part update between a failed
attempt and its retry (the full-accumulated-text overwrite behavior)
still delivers correctly; and blank/no-pending calls remain true no-ops.

### Medium

**10. No backup/restore or disaster-recovery procedure for the multi-file
durable state. — ✅ addressed** Durable state spans per-tenant and
per-pool SQLite databases in WAL mode (`src/falda.ts:253-257`), a separate
`distill_queue.db` and `recall_traces.db`
(`src/runtime.ts:107-119`), `pools.json`, and filesystem blobs
(`src/pools.ts:24-27`). WAL mode makes ad hoc file copying unsafe without
care. `docs/OPERATIONS.md` covers inspection, warnings, and re-embedding —
not backup, snapshotting, or restore validation.

*Recommendation:* document (and ideally script) a consistent-snapshot
backup procedure (e.g. SQLite online backup API or `VACUUM INTO`, plus
blob dir + `pools.json`), and a restore/verification runbook.

**Landed:** added `falda backup`/`falda restore` (`src/backup.ts`,
`src/restore.ts`), following the offline/read-only conventions of `falda
stats`/`falda reembed` (no `buildRuntime()`, no token file, no embedder;
reuses `listAllStores`/`inspectStore` from `src/stats.ts`). `falda backup
--out=DIR` snapshots every `falda.db`/`distill_queue.db`/
`recall_traces.db` with `VACUUM INTO` (one consistent, sidecar-free file,
safe to copy even against a live WAL-mode store — unlike `cp`), copies
`pools.json`/`EMBEDDING.json` and every store's blob directory, and writes
`backup-manifest.json` with a SHA-256 checksum of every captured file plus
the source root's locked embedding dimension. A declared-but-never-written
pool store backs up with no db/blobs, not an error. `falda restore
--from=DIR --root=DIR` verifies every checksum and rejects a target root
whose `EMBEDDING.json` dimension conflicts with the backup's before
copying anything; refuses a non-empty target root unless `--yes`
(restoring into a fresh root and swapping it into place is the
recommended path, documented alongside the flag); then runs a
post-restore verification pass (`inspectStore`) over every restored store.
Wired as flat `backup`/`restore` verbs in `bin/falda` and `package.json`
scripts, following the same `--dry-run`/`--yes` gate `falda reembed` uses
for destructive/consequential operations. Explicitly does not capture the
bearer token file (a secret outside `FALDA_ROOT`) — documented as a
separate operator concern. Added `test/backup.test.ts` (16 tests): store
selection/scoping, manifest completeness + checksum correctness, a
`VACUUM INTO` snapshot opening cleanly as an ordinary SQLite file, refusal
to back up into a non-empty `--out`, an unmaterialized-pool-store edge
case, a full backup→restore→`inspectStore`-parity roundtrip cross-checked
against the original root's own live report, a restored store opening
under a live `Falda` and returning the original stream/atom/core content,
root-level `distill_queue.db`/`recall_traces.db` restoring and reopening
correctly, the non-empty-target and dimension-mismatch rejections, and a
corrupted-backup checksum rejection. New top-level "Backing up and
restoring FALDA" section added to `docs/OPERATIONS.md` (placed after the
re-embedding runbook, same shape: rationale, numbered bash runbook, flag
tables, container variant, caveats). `npm run build` clean; `npm test`
380/380 (364 baseline + 16 new).

**Residual gap identified in a later audit, not yet addressed:** each
individual SQLite file is captured consistently (`VACUUM INTO`), but
`runBackup()` snapshots stores, blobs, and root-level files sequentially
with no cross-file lock or generation barrier
(`src/backup.ts:181-203`) — `writeCore()` also writes `core.md` directly
outside any of this (`src/falda.ts` — see finding 19's L3 Core-deletion
context for the same file). Against a live, actively-distilling deployment,
a backup can therefore capture, e.g., a `falda.db` whose `core_state` says
Core is current alongside a `core.md` file from a different point in time
(or briefly absent, per finding 19), or a `pools.json` that disagrees with
which stores were actually snapshotted. `docs/OPERATIONS.md`'s "captured
together and consistently" wording overstates this: the accurate guarantee
is per-file consistency, not a single coherent point-in-time image of the
whole root. The existing advice to stop `falda serve` before backing up for
a true point-in-time snapshot remains correct and is the recommended path
for anything relying on backup for migration rather than approximate
disaster recovery; this gap is about the *live*-backup claim specifically.
Not re-numbered as a separate finding since it's a caveat on already-landed
work, not a new code path — tracked here so the "Landed" note stays
accurate.

**11. HTTP surface accepts unbounded request bodies before authentication,
binds all interfaces, and has no rate limiting. — ⚠️ partially addressed**
The HTTP listener
concatenates the full request body into memory with no size limit,
timeout, or early auth check (`src/server.ts:81-89`); `handleRequest`
authenticates only after the full body is parsed
(`src/gateway.ts:343-345`). Both HTTP and MCP listeners call `.listen(port)`
with no host, binding all interfaces by default
(`src/server.ts:99,127`) — `docs/future/auth-hardening.md` Option C
already proposes a loopback-default bind; this finding is the same gap
observed independently, plus the missing body-size limit that Option C
doesn't cover.

*Recommendation:* enforce a request body size cap and reject
oversized/malformed bodies before JSON parsing; adopt `auth-hardening.md`
Option C (loopback-default bind, opt-out via env) and consider basic rate
limiting for exposed deployments.

**Landed (body cap + bind):** `startHttpApi()` now enforces
`FALDA_MAX_BODY_BYTES` (default 1 MiB, `<= 0` disables it) before both
JSON parsing and `handleRequest`'s auth check: an honestly-declared
oversized `Content-Length` is rejected immediately, and a streamed body
with no (or a lying) `Content-Length` is aborted mid-flight — `req.destroy()`
plus a `413` — the moment the running byte total exceeds the cap, so a
flood is never buffered in full regardless of what the caller claims.
Both `startHttpApi()` and `startMcp()` adopted `auth-hardening.md` Option C
literally: bind host defaults to `127.0.0.1` (`FALDA_BIND` /
`FALDA_MCP_BIND`), a deliberate breaking change for any deployment that
relied on the previous all-interfaces default without its own port-publish
discipline. A related implementation wrinkle surfaced during this phase:
passing an explicit host to Node's `net.Server#listen()` makes the bind
resolve asynchronously (an internal DNS lookup runs even for a literal IP
like `127.0.0.1`), unlike the previous host-less `listen(port, cb)` form,
which bound synchronously — so `startHttpApi()`/`startMcp()` now return
`Promise<Server>` (resolving on the `listening` event) rather than a bare
`Server`, and `serve()` awaits both, preserving every existing caller's
assumption that `.address()` is populated immediately after start.

**Container caveat, explicitly scoped as a deliberate tradeoff:** binding
loopback *inside* a container defeats `docker run -p`/compose port
publishing (Docker's forwarding connects to the container's own network
address, not its internal loopback interface) — so a hard loopback default
would have broken every existing containerized deployment of this image.
Resolved by keeping the server-level default at `127.0.0.1` (matching
Option C and protecting bare-host/no-compose-layer runs, the gap the
finding actually names) while making the *shipped* `Dockerfile` bake in
`FALDA_BIND=0.0.0.0`/`FALDA_MCP_BIND=0.0.0.0`, so `docker run -p
127.0.0.1:PORT:PORT ...` keeps working unmodified — the loopback-only
guarantee for a published port lives entirely in the publish spec, as it
already did before this change. Any other containerized/compose deployment
of this server (built from source rather than the published image, or
reached over a compose-internal network by service name rather than
published ports — the same reason `docker-setups/stacks/alpha-beta` needed
this) must set both env vars explicitly; documented in `README.md`,
`docs/API.md`, `docs/MCP.md`, `docs/INSTALL.md`, and
`integrations/opencode/README.md`.

**Deferred (rate limiting):** not implemented this phase. A real limiter
needs its own policy decision (per-token vs. per-IP keying, sliding-window
vs. token-bucket, `429`+`Retry-After` semantics, HTTP-only vs. also MCP,
on-by-default vs. opt-in) that deserves independent review rather than
riding alongside the body-cap/bind fixes above — tracked as a new backlog
item, finding 14 below.

Tests: `test/http_hardening.test.ts` — body under/over the cap (both the
`Content-Length` fast-path and a chunked flood with no honest
`Content-Length`, the latter also asserting the server stays healthy for a
subsequent request), the cap disabled via `<= 0`, the oversized-body
rejection happening before auth (a bad/missing token still gets `413`, not
`401`), and both listeners' loopback default plus override via `serve()`
options and `FALDA_BIND`. `npm run build` clean; `npm test` 388/388 (380
baseline + 8 new).

**Residual gap identified in a later audit, not yet addressed:** the "no
body cap on MCP" scoping decision above assumed authentication fully
protects the MCP listener from an unbounded body. That's true for the
*unauthenticated*-flood case this finding targeted, but not for an
*authenticated* one: `handleFaldaMcpRequest()` authenticates the bearer
token first (`src/mcp/server.ts:94-104`), then hands the request to the MCP
SDK's `StreamableHTTPServerTransport`, which buffers and fully parses the
JSON body (`await req.json()` inside the SDK) with no size limit of its
own. Any valid token — a compromised one, a buggy client, or simply a
caller that doesn't know better — can send an arbitrarily large MCP POST
body and force full in-memory buffering + JSON parsing before the SDK's own
handling runs, in the same process as the HTTP listener and the
distillation worker. This is a distinct defect from the deferred rate
limiting in finding 14 below (one request being unbounded, vs. request
*frequency* being unbounded) and was missed because "the SDK owns that
request's body stream" was read as "therefore already handled," not
"therefore needs its own explicit cap." *Recommendation:* wrap the request
stream in the same kind of byte-counting guard `startHttpApi()` already
uses before handing it to the SDK (or pre-read a capped body and supply it
via the SDK's `parsedBody` option), with its own env var if MCP's typical
payload size differs meaningfully from the JSON API's.

**12. Pool registry corruption is silently treated as an empty registry,
and writes aren't atomic. — ✅ addressed** A malformed/unreadable `pools.json` becomes
`{pools:{}}` with no error surfaced (`src/pools.ts:76-83`), and updates are
an unprotected read-modify-write that overwrites the file directly
(`src/pools.ts:82-84,97-105,112-124,127-137`). Concurrent admin requests
can lose each other's changes, and an interrupted write can make every
shared pool appear undeclared on next read even though the physical
databases remain on disk.

*Recommendation:* validate the registry at boot and fail loudly on
malformed content; write via temp-file + atomic rename.

**Landed:** `PoolManager.saveReg()` now writes through a new exported
`writeFileAtomic()` helper (`src/pools.ts`): write to a sibling `.tmp` file
in the same directory, `fsync` it, `rename()` over the target (same-
filesystem rename is atomic under POSIX — a reader or a crash mid-write
sees either the complete old file or the complete new one, never a
truncated mix), then best-effort `fsync` the parent directory; the temp
file is cleaned up on any failure. `loadReg()` no longer swallows a bad
read into `{pools:{}}`: a missing file is still the legitimate first-run
case, but a present-and-unreadable, invalid-JSON, or structurally-wrong
(new `validateRegistry()` — checks `pools` is an object, each entry's
`name` matches its key, `members` maps to valid `Access` values,
`created_at`/`updated_at` are strings) file now throws a new
`PoolError("corrupt_registry")` naming exactly what's wrong, from every
read path (`getPool`/`listPools`/`poolsForTenant`/`resolve`). This closes
the actual destructive bug: throwing before any mutator can reach
`saveReg()` means a corrupt-but-recoverable file can no longer be
permanently overwritten with an empty registry by the very next admin
write — it's left on disk for an operator to fix by hand or restore from a
`falda backup` snapshot.

New `requirePoolRegistry()` (`src/boot.ts`, mirroring
`enforceEmbeddingLock`/`requireTokenFile`'s existing fail-fast pattern) is
called from `buildRuntime()` right after those two: if `pools.json` exists
and is corrupt, `falda serve` logs a `FATAL` message and `process.exit(1)`
rather than booting a server that would report every declared pool as
missing. A missing file is a silent no-op (legitimate first boot).
Deliberately does not attempt to recover from a stray interrupted-write
`.tmp` file left in the directory — an unrenamed temp isn't guaranteed
complete either, so recovery is left to the operator rather than guessed
at automatically. `src/gateway.ts` maps the new `corrupt_registry` code to
`500` (a live server should never hit this at request time once boot
validation is in place; this is defense-in-depth for a registry corrupted
while already running). `src/stats.ts`'s layout section had the same
silent-swallow bug (`listPoolStores`/`inspectLayout`'s pool-count read) —
`inspectLayout` now surfaces a `warn`-level warning naming the corrupt file
instead of silently reporting zero pools (kept non-fatal, since `falda
stats` is a read-only inspector, not a boot gate).

**Explicitly out of scope (not attempted):** cross-process write locking.
Atomic rename makes each individual write all-or-nothing and safe against
concurrent *readers*, but two `falda serve` processes sharing one
`FALDA_ROOT` can still race as concurrent *writers* (last-writer-wins on
a true read-modify-write collision) — this matches the finding's actual
recommendation (temp-file + atomic rename, not locking); a true
multi-writer lock would be a larger, separate change. In-process, the pool-
admin mutators are synchronous JS and cannot interleave with each other.

Tests: `test/pool_registry.test.ts` (15 tests) — atomic writes leave no
temp file behind (including recovery in the presence of a stale leftover
temp from a hypothetical prior interrupted write); a corrupt registry
throws `corrupt_registry` from every read path and is never subsequently
overwritten (the core regression, verified via byte-identical on-disk
content after failed read/mutation attempts); six structurally-invalid-
but-valid-JSON shapes are rejected; a missing file remains a legitimate
first-run state; a fresh `PoolManager` reading the same root back proves
declare/update/grant roundtrip correctly; `requirePoolRegistry` exits(1)
on corrupt content and is a no-op on missing/valid content (mirroring
`test/mcp_auth.test.ts`'s `requireTokenFile` test style); `falda stats`'
layout section warns on a corrupt (not absent) registry. `npm run build`
clean; `npm test` 403/403 (388 baseline + 15 new).

**13. Schema/doc drift test compares shape, not semantics. — ✅ addressed**
The runtime-vs-doc schema comparison checks table/column names only
(`test/schema_doc_sync.test.ts:138-159`), not defaults, constraints, or
nullability. A concrete drift already exists: `docs/schema/tables.sql`
documents the passive-priority default as `100`, while the runtime schema
and migration both default it to `0`
(`src/distill/queue.ts:30-37,57-63` vs. `docs/schema/tables.sql:194-204`);
similarly `stream.seq` is documented as never-null post-migration but
declared nullable in the runtime DDL (`src/falda.ts:288-297` vs.
`docs/schema/tables.sql:31-34`).

*Recommendation:* compare normalized `sqlite_master.sql` (or explicit
default/`NOT NULL`/index assertions) rather than names alone; fix the two
known drifts above.

**Landed:** chose the explicit default/`NOT NULL`/index-assertion approach
over full normalized `sqlite_master.sql` text comparison — the latter fights
the `float[DIM]` vec0 placeholder, `CHECK` clause formatting, and
ALTER-appended columns landing at the end of `PRAGMA table_info` rather than
inline where the doc documents them (the same brittleness the original
name-only test was designed to avoid; its header comment already explained
why). `test/schema_doc_sync.test.ts`'s doc parser now also extracts each
column's `NOT NULL` presence and normalized `DEFAULT` literal (matching
`PRAGMA table_info`'s `dflt_value` string form, e.g. `"0"`, `"'active'"`,
`"'[]'"`), and each `CREATE [UNIQUE] INDEX` statement's name and (if
partial) normalized `WHERE` clause; the live-schema side reads the same
information via `PRAGMA table_info` and `sqlite_master.sql`. All three
databases' comparison tests now assert nullability, default, and index
(including partial-`WHERE`) parity in addition to the pre-existing name-set
checks. Scoped to ordinary tables only — FTS5/vec0 virtual tables report no
meaningful `notnull`/`dflt_value` via `PRAGMA table_info` regardless of their
declaring DDL, so those keep the original name-only check (documented in the
file's header comment); `sqlite_autoindex_*` rows (SQLite's own implicit
index for a `UNIQUE`/`PRIMARY KEY` constraint) are excluded from the index
comparison since they aren't a separately-declared `CREATE INDEX` and are
already covered by the column-level check. No PK-specific nullability
normalization was needed: SQLite reports a composite-`PRIMARY KEY` column as
`notnull:0` unless the column definition also carries an explicit
`NOT NULL` (which every such column in this schema already does), so a
literal "does the column text contain `NOT NULL`" parse applied identically
to both the doc and the live schema naturally agrees with `PRAGMA
table_info`.

Of the two "known drifts" this finding named, only one was still live by the
time this phase started: `distill_jobs.priority`'s documented default was
already corrected to `0` (matching `PRIORITY_PASSIVE`) by an earlier
finding's docs update, so no runtime or doc change was needed there — the
new semantic test now guards it going forward. `stream.seq`'s *DDL*
nullability was already consistent between runtime and doc (both declare it
nullable; SQLite cannot add a `NOT NULL` constraint via `ALTER TABLE`
without a full table rebuild, so the column is intentionally left nullable
at the schema level even though the seq-migration backfill and every current
write path always assign a value). The actual defect was a misleading
`docs/schema/tables.sql:33` comment ("never null after migration") that
implied a DDL guarantee that doesn't exist — reworded to state the accurate,
narrower guarantee (nullable in DDL; non-null in practice for all rows
written by current code).

Verified the guard actually catches drift (not just documents intent): with
`src/falda.ts` locally and temporarily edited to (a) change
`atoms.priority`'s default, (b) add `NOT NULL` to `atoms.background`, and
(c) drop the partial `WHERE` from `idx_atoms_pinned`, the corresponding new
assertion failed with a clear per-column/per-index message each time;
reverted after confirming each failure mode. Tests:
`test/schema_doc_sync.test.ts` (same 4 test blocks, extended with the new
assertions — no new top-level test count). `npm run build` clean; `npm test`
490/490 (unchanged from this phase's baseline, since prior in-repo work
already grew the suite from 403 to 490 before this finding was picked up).

**14. No rate limiting on the HTTP or MCP surfaces.** Split out of finding
11 as a deliberately deferred sub-item, not independently discovered: an
authenticated (or even unauthenticated-but-under-the-body-cap) caller can
send requests as fast as the network allows with no server-side throttle,
on either listener. Low risk for the current single-tenant-per-container
deployment model, but a real gap for any exposed or multi-tenant-per-token
deployment (e.g. a runaway or misbehaving agent loop hammering `/distill`
or `falda_recall`).

*Recommendation:* before implementing, resolve the open policy questions
this needs (not attempted here, since they weren't reviewed as part of
finding 11's scope): per-token vs. per-IP (or both) keying; sliding-window
vs. token-bucket algorithm; `429` + `Retry-After` response shape; whether
it applies to the MCP endpoint (the SDK owns that request's lifecycle,
unlike the plain HTTP listener) or HTTP only; and on-by-default vs.
opt-in via env (an opt-in default is lower-risk for existing deployments,
matching how `FALDA_MAX_BODY_BYTES` and the loopback-bind defaults in
finding 11 were rolled out).

### Later audit pass (2026-08-19) — findings 15–19

The following five findings were identified in a follow-up read-only audit
after findings 1–14 above had already landed (or, for 14, been deferred).
Numbered sequentially rather than re-sorted into the Critical/High/Medium
sections above, to avoid renumbering findings already referenced by commit
messages and `PLAN.md`; each carries its own severity tag instead.

**15. [High] The distillation worker can run more than one job concurrently
despite its single-worker design.** The timed `drain()` loop has no busy/in-flight
guard before claiming another job (`src/distill/worker.ts:246-256`); the
periodic timer that invokes it does not await the previous tick before
scheduling the next one (`src/distill/worker.ts:355`). The wake path
(`falda_distill`/`POST /distill`) has its own separate re-entrancy guard,
`waking` (`src/distill/worker.ts:264-284`), which does not exclude a timed
drain running at the same moment. Both paths write into the same single
`inFlight` variable (`src/distill/worker.ts:250-255,273-279`), so whichever
path started most recently silently overwrites the handle `stop()` awaits
(`src/distill/worker.ts:366-373`) — an earlier still-running job becomes
untracked. `enqueue()`'s coalescing only checks `pending` rows
(`src/distill/queue.ts:122-124`), not `running` ones, so a second
`falda_distill` call for a store already mid-pass creates or wakes a second
claim rather than being absorbed.

*Impact:* any pass that runs longer than `FALDA_DISTILL_DRAIN_MS` lets the
next timer tick start a second pass; a wake can independently overlap a
timed pass. Two concurrent passes against the same store can race L2 scene
creation/reconciliation and lifecycle writes, clear the dirty flag out of
order (finding 2), and leave conflicting `distillation_passes`
completion/failure rows. A graceful shutdown (finding 4) can also close
storage while an overwritten, no-longer-tracked pass is still writing to it,
since `stop()` can only await whichever job is in the `inFlight` slot at
that moment.

*Recommendation:* give the worker one authoritative "am I currently running
a job" state, checked and set atomically by both `drain()` and
`drainHighPriority()` before either claims a job — not two independent
`waking`/no-`inFlight`-guard checks. Track every in-flight job (not just the
most recent) so `stop()` can await all of them. Consider having `enqueue()`
also coalesce against `running` rows for the same `store_key`, or accept a
same-store overlapping claim as impossible only once the guard above is in
place. Existing tests cover wake-vs-wake overlap only
(`test/distill_worker.test.ts`); add timer-vs-timer and timer-vs-wake
overlap cases once fixed.

*Implementation plan:*

1. Replace the separate timed-drain and wake coordination with one exclusive
   execution lane represented by the authoritative `inFlight` promise. Both
   paths must synchronously acquire that lane before calling `claimNext()`, so
   at most one `runJob()` executes in the worker process.
2. Add a `wakeRequested` latch. A wake received while a timed or wake-triggered
   job is active must not overlap it, but must start an explicit-priority drain
   immediately after the active job finishes. Busy timer ticks are skipped
   rather than accumulated.
3. Preserve the existing scheduling contracts: timed drains claim at most one
   ready job per tick; wake drains claim only `PRIORITY_EXPLICIT` jobs and
   remain bounded by `MAX_WAKE_DRAIN_PER_CALL`; wake signals may coalesce, but
   queue rows remain the durable source of work.
4. Do not coalesce queue rows against a running job. A follow-up row can
   represent turns added after the active pass captured its input window and
   must remain pending until the exclusive lane is free.
5. Make shutdown set `stopping` before clearing timers and awaiting `inFlight`.
   Completion of the active lane must not launch a latched wake after shutdown
   starts, and no active promise may be overwritten or dropped from shutdown
   tracking.
6. Add regressions in `test/distill_worker.test.ts` for timer-vs-timer,
   timer-vs-wake, wake-vs-timer, wake-vs-wake, shutdown with a deferred wake,
   and a same-store follow-up job. Each overlap test must assert a maximum
   concurrency of one; the timer-vs-wake case must also prove the deferred
   explicit job starts without waiting for another timer tick.
7. Verify queue priority/lease behavior, worker metrics balance, and graceful
   shutdown alongside the full TypeScript typecheck, build, and test suite.

*Operational mitigation:* until this fix is deployed, configure
`FALDA_SHUTDOWN_GRACE_MS=600000` (10 minutes), above the observed 395.2-second
production tail, and ensure the deployment platform's termination timeout is
longer than the Falda grace period. Reassess this value only after phase timing
provides a representative service-time percentile.

**16. [High] Malformed LLM output during distillation is silently
discarded, and the pass still reports success.** Extraction output is parsed
line-by-line/as-a-JSON-array; any line or array element that fails
`validateCandidate()` is dropped with no error
(`src/distill/core.ts:93-138`) — the finding's line-scan branch has a bare
`catch { /* skip malformed line */ }`. If every line in a reply is
malformed, `candidates` is simply empty and the pass proceeds
(`src/distill/core.ts:456-462`), still advancing the watermark past the
source turns at the end of the same transaction
(`src/distill/core.ts:656-662`). Separately, a per-candidate consolidation
reply that fails to parse, or names an unrecognized `action`, is converted
into an applied `"skip"` decision rather than a retryable failure
(`src/distill/core.ts:147-168`) — the candidate's evidence is never
attached to any atom and the content only survives in
`consolidation_decisions.candidate_content`
(`src/distill/core.ts:643-653`), which no operator surface currently
compares against expectation. `docs/MODEL.md:842-848` documents that an
invalid `type`/`confidence` should fail extraction as a *retryable* error —
the implementation instead treats it as "nothing to see here."

*Impact:* a single transient malformed model reply (truncated output, a
model that ignores the "output ONLY JSON" instruction, an upstream hiccup
mid-generation) can permanently mark a batch of source turns as processed
while storing zero durable memories for them — the queue's retry/backoff
machinery (finding 3) never engages, because `distillOnce` returns
successfully. The same swallow can silently discard a *validly extracted*
candidate whose separate consolidation-decision call happened to come back
malformed, even though extraction itself succeeded.

*Recommendation:* treat a reply that is expected to contain output but
parses to zero usable items as a distinguishable failure mode (at minimum,
log it at `error` level and increment a countable metric/warning surfaced
by `falda distill inspect`/`falda stats`); consider making it retryable
(matching `docs/MODEL.md`'s documented contract) rather than an
indistinguishable, watermark-advancing no-op. The batched-consolidation
path (`consolidationBatchPrompt`/`parseConsolidationBatch`, merged after
finding 12) already falls back to `decideIndividually()` per undecided
candidate rather than silently skipping (`src/distill/core.ts:494-503`) —
extend that same "never silently drop a candidate" discipline to the
all-malformed-extraction and single-consolidation-parse-failure cases.

*Implementation plan:*

1. Update the extraction prompt to require `[]` for an intentional zero-candidate
   result. This removes the ambiguity between "nothing to extract" and
   "malformed/truncated response". Bump `PROMPT_VERSION`.
2. Make `parseCandidates` return a discriminated result (`ok/candidates` vs
   `error/reason`) instead of silently dropping bad output. Rules:
   - Strip one markdown fence as before.
   - `[]` → success with zero candidates (intentional empty extraction).
   - Blank/whitespace-only → failure.
   - Array starting with `[` but failing to parse → failure.
   - Valid array containing any invalid candidate object → failure (whole-response
     atomicity; no silent partial extraction).
   - JSON-lines: any object-looking line with invalid JSON or bad fields →
     failure. Surrounding non-object prose is tolerated if at least one valid
     object exists; fully prose-only is a failure.
3. Throw a `MalformedLLMOutputError` immediately after parsing if extraction
   failed, before any candidate retrieval, consolidation, embedding, or the L1
   transaction. The watermark is left unchanged; the worker's existing
   `failJob()` path engages retry/backoff.
4. Make `parseConsolidation` return `ConsolidationDecision | undefined`:
   - Valid `action: "skip"` remains a successful decision.
   - Missing JSON object, bad JSON, or unknown action → `undefined` (never
     synthesize a `skip`).
5. In `decideIndividually`, throw `MalformedLLMOutputError` when
   `parseConsolidation` returns `undefined`. This applies to both the
   historical single-candidate path and individual fallbacks after a batch.
6. No watermark, atom, evidence, decision, or dirty-flag write is made on any
   malformed path. Pass telemetry records failure via the existing
   `failJob`/`recordPassStart` path.
7. Preserve all existing tolerances: fenced JSON, JSON arrays, JSON-lines, and
   explicit `skip` decisions remain fully supported.
8. Add `test/distill_malformed_output.test.ts` with regressions for each
   failure mode, plus a worker-level retry integration test.
9. Verify `npm run typecheck`, `npm run build`, and all tests pass.

**17. [High] `falda restore` trusts manifest paths and leaves stale state
behind on in-place restore.** `readManifest()` only checks that `stores`/`top_level`
are arrays (`src/restore.ts:56-66`); nothing validates that any entry's
`rel_path` is a normalized, non-absolute, non-`..`-containing relative path
before it is joined to the backup directory for checksum verification
(`src/restore.ts:72-91`) or to the target root for copying
(`src/restore.ts:157-167`). A backup whose manifest has been tampered with
(or corrupted in a way that survives JSON parsing) can therefore make
`verifyManifestFiles()` read, hash, and report as "verified" a file outside
the backup directory, and make `runRestore()`'s `copyRecursive()` write to a
path outside `--root`. The manifest's own SHA-256 fields cannot catch this,
since whoever controls `rel_path` also controls the expected hash next to
it. Separately, `--yes` in-place restore (`src/restore.ts:149-168`) only
*copies* what the manifest lists — it never removes anything already
present in a non-empty target that the backup doesn't mention, including a
restored database's own stale `-wal`/`-shm` sidecars left over from before
the restore, or stores/blobs created in the target after the backup was
taken. `docs/OPERATIONS.md`'s runbook and `bin/falda restore --help`'s
usage text both describe `--yes` as a supported in-place mode without this
caveat.

*Impact:* restoring an untrusted, shared, or tampered backup is a
path-traversal risk (arbitrary read within the restoring process's
permissions during verification; arbitrary write during copy) — relevant
any time a backup is transferred between environments, stored in
shared/less-trusted storage, or handled by tooling that doesn't originate
from `falda backup` itself. Independently, even a fully trustworthy backup
restored `--yes` in place can leave the target in a state that is neither
the old data nor a clean copy of the backup — stale WAL frames can be
replayed by the next open of the "restored" database, and files unlisted in
an older/scoped backup silently survive the restore.

*Recommendation:* reject any manifest entry whose `rel_path` is empty,
absolute, contains `..` segments, or whose resolved path (backup-side and
target-side) does not remain strictly beneath the respective root; reject
duplicate destination paths and symlink entries. For in-place restore,
either remove it in favor of always staging into a fresh directory and
atomically swapping it into place (the already-recommended and
already-safer path), or, if retained, explicitly delete pre-existing
database sidecar files and document precisely what "restore in place" does
and does not purge.

**18. [Medium] Scene upserts commit structural/index changes before the
asynchronous embedding step, with no transaction spanning the whole
operation.**
`upsertScene()` writes the scene row and `scene_atoms` membership first
(`syncSceneStructure()`, synchronous, `src/falda.ts:1313-1365`), then
separately awaits `syncSceneRendering()` (`src/falda.ts:1380-1404`), which
deletes and rewrites the FTS row immediately, then — only if the render
hash changed — deletes the existing vector row and `await`s the embedder
before inserting a new one. No transaction wraps `upsertScene()`'s two
phases (contrast with finding 1's atom writer and finding 5's
`deleteStream()`, both of which do wrap their multi-representation writes
in one `db.transaction(...).immediate()`).

*Impact:* an embedder timeout or error during `syncSceneRendering()`
surfaces as a rejected `/scenes/upsert`/`falda_recall`-adjacent call, but
the scene's structural row, `scene_atoms` membership, and FTS entry have
already been committed — and, if a render-hash change triggered a
re-embed, the *previous* vector row has already been deleted before the
new one's embed call is awaited. A crash or transient failure at that exact
point leaves the scene with no vector row at all until a later pass
happens to touch it again. Distillation's own scene-narration callers tie
into finding 2's L2/L3 retry loop for eventual repair, but a direct
`/scenes/upsert` caller (or `falda_remember`'s scene-adjacent paths, if
any) has no automatic repair and, meanwhile, lexical (FTS) and vector
recall can disagree about a scene that partially failed.

*Recommendation:* apply the same pattern already used for atoms (finding 1)
and stream deletion (finding 5): compute/validate the embedding *before*
opening a transaction, then commit the scene row, `scene_atoms`, FTS
delete+insert, and vector delete+insert together inside one
`db.transaction(...).immediate()`, so a failure anywhere in the sequence
rolls back the whole upsert rather than leaving a partially-applied scene.

**19. [Medium] A failed Core-deletion during L3 is swallowed, and the pass
reports success with stale Core content left on disk.** When a pass determines no
active scenes remain, it attempts to delete `core.md` and clear
`core_state`; the `unlinkSync()` call is wrapped in a bare
`try { ... } catch {}` (`src/distill/core.ts:997-999`), and `core_state` is
cleared *unconditionally* immediately afterward regardless of whether the
delete actually succeeded. The pass then proceeds to its normal
finalization and, absent any other L2/L3 failure, clears the store's dirty
flag (`src/distill/core.ts:1087`) — finding 2's mechanism for scheduling a
retry.

*Impact:* a permissions error, a transient filesystem failure, or `core.md`
being open/locked by another process at the moment of deletion leaves the
stale Core file physically present and still returned by recall (T3),
while `core_state` — the record L3 uses to decide whether Core needs
regenerating/deleting — has already been cleared as if the deletion
succeeded. Because the dirty flag is also cleared on this path, no future
pass will retry the deletion unless some unrelated lifecycle mutation
happens to mark the store dirty again for an independent reason; with no
new turns arriving, the stale Core can persist indefinitely.

*Recommendation:* only clear `core_state` after `unlinkSync()` actually
succeeds (or the file was already absent); on a genuine delete failure,
record it the same way a narration/synthesis failure is recorded elsewhere
in this function (mark dirty, count as an L3 failure, let the existing
`l3Failed`/`markDirty` propagation at `src/distill/core.ts:1076-1085`
engage the retry path) rather than silently proceeding as if nothing went
wrong.

**20. [Medium] Batched consolidation prompts are unbounded on the input
side, and the OpenAI path had no output-truncation guard. — ✅ addressed**
`FALDA_DISTILL_CONSOLIDATION_BATCH` (found 15–19's context) bounds candidate
*count* per consolidation call, not built-prompt *size*: each candidate in a
chunk carries its own retrieved neighbour set — up to `candidateLimit`
(default 8) existing atoms with full `content` each
(`src/distill/prompts.ts:133-149`) — so a chunk's actual prompt size depends
on neighbour content, not candidate count alone, and nothing capped it.
Separately, the Anthropic path already throws when a reply is truncated
mid-JSON (`stop_reason: "max_tokens"`, `src/distill/llm.ts:148-157`), but the
OpenAI-compatible path (the default, self-hosted path) had no equivalent —
`makeOpenAILLM` returned `choices[0].message.content` unconditionally,
regardless of `finish_reason`.

*Impact:* an oversized batch (a verbose extraction pass paired with a large
`FALDA_DISTILL_CONSOLIDATION_BATCH`) could build a prompt that exceeds a
model's input window with no warning beforehand. On the OpenAI path, a
truncated reply was silently accepted as a successful call whose
batch-parser found nothing to resolve, thrashing into a full set of
per-candidate retries with no signal anywhere that truncation — not normal
malformed output — was the cause.

**Landed:** two independent fixes.

1. `makeOpenAILLM` (`src/distill/llm.ts`) now checks `finish_reason` and
   throws on `"length"`, mirroring the Anthropic path's guard, so the
   worker's `failJob`/backoff sees a truncated reply as a failure to retry
   rather than a successful pass over unusable output. The error names
   `FALDA_DISTILL_CONSOLIDATION_BATCH` as one *possible* cause, not the
   definitive one — the guard applies to every OpenAI-path call (extraction,
   synthesis, single-candidate consolidation too), not only batched
   consolidation. Also hardened: missing/non-string `message.content` now
   throws a clear error instead of a raw `TypeError`.
2. New `FALDA_DISTILL_CONSOLIDATION_MAX_CHARS` (`src/distill/core.ts`,
   default `0`/disabled) — an approximate char-count proxy for input size (no
   tokenizer is used; one would be model-specific and the self-hosted path
   can point at any model). When set positive, `distillOnce`'s batch-chunking
   (`packConsolidationChunks()`) becomes size-aware: candidates are still
   capped at `FALDA_DISTILL_CONSOLIDATION_BATCH` per chunk, but a chunk is
   closed early if adding the next candidate would push its *actual* built
   prompt (via the same `consolidationBatchPrompt` that gets sent) over the
   cap. This is a greedy pack, not a fixed split — it fills each chunk closer
   to the cap than blind halving, since per-candidate cost varies with
   neighbour-set size. A lone candidate whose own prompt already exceeds the
   cap is still sent alone (nothing smaller exists — dropping it would
   violate the batching feature's existing "never drop a candidate" rule);
   a verbose-mode log records this so an operator has a trail without
   failing the pass.

Left disabled by default (`<= 0`): a positive value is a second knob on top
of `FALDA_DISTILL_CONSOLIDATION_BATCH`, and a deployment that hasn't hit an
input-size problem shouldn't have its existing batch sizing silently
reshaped by a cap it never opted into.

Tests: `test/distill_llm_anthropic.test.ts` extended with the OpenAI
`finish_reason` cases (normal, `"length"`, message wording, missing
content); `test/distill_consolidation_batch.test.ts` extended with the
disabled-by-default, tight-cap-splits-a-chunk, lone-candidate-still-sent,
and unresolved-candidate-in-a-size-capped-chunk-still-falls-back cases. `npm
run build` clean; `npm test` 498/498 (490 baseline + 8 new).

### Note — not a code defect, but flag for rotation

`falda_tokens.json` in this checkout contains a bearer token with
`tenants: ["*"]` (wildcard/full-trust). It's git- and Docker-ignored
(`.gitignore:24-26`, `.dockerignore:7-9`), but anyone with filesystem
access to this checkout can use it against any deployment that accepts it.
Treat as compromised and rotate if this token is live anywhere.

## Relationship to existing `docs/future/` tracking

Several adjacent items are already tracked elsewhere and are **not**
duplicated here:

- Erasure/audited hard-delete (`Falda.hardDeleteAtomsUnsafe()`,
  `/atoms/delete`) — see `docs/future/open-questions.md` "Erasure
  implementation (§9)".
- Cross-tenant/shared-pool distillation attribution — see
  `docs/future/open-questions.md` "Cross-tenant pool distillation".
- Per-turn (vs. window-level) evidence attribution — see
  `docs/future/open-questions.md` "Per-turn provenance attribution (§5.2)".
- Usage-feedback → ranking/priority loop — see
  `docs/future/open-questions.md` "Usage feedback → ranking/priority
  (§8.10)".
- Loopback-default bind, constant-time token comparison, hashed tokens at
  rest, TLS/mTLS — see `docs/future/auth-hardening.md` Options A–D
  (finding 11 above independently reaches the same bind-address gap as
  Option C).

## Suggested sequencing

1. **Atomic distillation + downstream reconciliation** (findings 1, 2) —
   correctness of the core pipeline, highest severity.
2. **Queue crash recovery + graceful shutdown** (findings 3, 4) —
   operational reliability under restart/failure.
3. **Backup/restore runbook** (finding 10) — currently entirely absent.
4. **Request limits/timeouts + bind hardening** (findings 4, 11) — cheap,
   high defense-in-depth value. *(Finding 11's body-cap and bind-default
   sub-items landed; rate limiting split out as finding 14, deferred
   pending its own policy review.)*
5. **Integration smoke tests** (findings 7, 8, 9) — restore confidence in
   shipped-but-unverified surfaces.
6. Remaining medium items (5, 6, 13, 14) opportunistically alongside
   related work. *(Findings 12 and 13 landed: atomic writes + fail-loud
   registry validation for `pools.json`; semantic — not just name-set —
   schema/doc drift assertions. Finding 14, rate limiting, remains open.)*
7. **Later-audit findings 15–19** — not yet started. Suggested order by
   risk: **15** (worker concurrency — can corrupt in-flight distillation
   state and defeats graceful shutdown), **16** (malformed-LLM-output data
   loss — silent, permanent, and currently indistinguishable from normal
   operation), **17** (restore path-traversal/stale-state — conditional on
   restoring an untrusted or already-imperfect backup, but a real
   filesystem-boundary defect), then **18** and **19** (scene-upsert
   partial-commit and Core-deletion-swallow — both real but narrower-impact
   correctness gaps with existing partial mitigations via finding 2's
   retry loop for the distillation-triggered paths). The residual gaps
   recorded against findings 10 (backup coherence) and 11 (MCP body cap)
   above are caveats on already-landed work, not new implementation items,
   but should be resolved alongside 15–19 if this area gets picked up
   again.
8. **Finding 20** — batched-consolidation input-size cap and OpenAI-path
   truncation guard — landed. Independent of 15–19; picked up out of order
   since it was small and self-contained.
