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

**1. L1 atom creation happens outside the documented atomic transaction.**
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

**2. L2/L3 failures and lifecycle-only changes are not independently
retryable.** A pass with no new stream turns returns immediately
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

**4. Shutdown is not graceful; remote calls have no timeout. — partially addressed**
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

**Landed (remote-call timeouts only):** `makeEmbedder()`/`makeLLM()` now
pass `AbortSignal.timeout(...)` on their `fetch` calls
(`FALDA_EMBED_TIMEOUT_MS` default 30s, `FALDA_LLM_TIMEOUT_MS` default
120s), surfacing a clear timeout error that flows into the existing
`failJob` backoff/dead-letter path rather than hanging indefinitely. Tests:
`test/remote_timeouts.test.ts`. The graceful-shutdown half (signal
handlers, awaiting in-flight work before closing storage) is tracked
separately as the next phase of this same finding.

**5. Stream deletion leaves stale FTS/vector index rows.**
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

**7. `falda smoke` invokes a nonexistent npm script.**
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

**9. OpenCode capture plugin can lose a turn on a failed flush.**
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
