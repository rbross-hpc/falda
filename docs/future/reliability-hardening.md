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

**6. Legacy-schema migration can fail before `migrate()` runs.**
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
unauthenticated/body-tenant API.** The current server requires a bearer
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
durable state.** Durable state spans per-tenant and per-pool SQLite
databases in WAL mode (`src/falda.ts:253-257`), a separate
`distill_queue.db` and `recall_traces.db`
(`src/runtime.ts:107-119`), `pools.json`, and filesystem blobs
(`src/pools.ts:24-27`). WAL mode makes ad hoc file copying unsafe without
care. `docs/OPERATIONS.md` covers inspection, warnings, and re-embedding —
not backup, snapshotting, or restore validation.

*Recommendation:* document (and ideally script) a consistent-snapshot
backup procedure (e.g. SQLite online backup API or `VACUUM INTO`, plus
blob dir + `pools.json`), and a restore/verification runbook.

**11. HTTP surface accepts unbounded request bodies before authentication,
binds all interfaces, and has no rate limiting.** The HTTP listener
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

**12. Pool registry corruption is silently treated as an empty registry,
and writes aren't atomic.** A malformed/unreadable `pools.json` becomes
`{pools:{}}` with no error surfaced (`src/pools.ts:76-83`), and updates are
an unprotected read-modify-write that overwrites the file directly
(`src/pools.ts:82-84,97-105,112-124,127-137`). Concurrent admin requests
can lose each other's changes, and an interrupted write can make every
shared pool appear undeclared on next read even though the physical
databases remain on disk.

*Recommendation:* validate the registry at boot and fail loudly on
malformed content; write via temp-file + atomic rename.

**13. Schema/doc drift test compares shape, not semantics.** The
runtime-vs-doc schema comparison checks table/column names only
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
   high defense-in-depth value.
5. **Integration smoke tests** (findings 7, 8, 9) — restore confidence in
   shipped-but-unverified surfaces.
6. Remaining medium items (5, 6, 12, 13) opportunistically alongside
   related work.
