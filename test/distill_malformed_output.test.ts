/**
 * docs/future/reliability-hardening.md finding 16: malformed LLM output during
 * distillation must fail the pass retryably, never silently advance the watermark.
 *
 * Before the fix, parseCandidates silently dropped malformed/invalid objects and
 * returned an empty array, and parseConsolidation synthesized action:"skip" for
 * any malformed response. Both left the watermark advancing on a "successful"
 * pass that stored zero memories.
 *
 * After the fix:
 *   - Blank, prose-only, malformed JSON, or invalid-field extraction → throw
 *     before L1, watermark unchanged, job rescheduled via failJob.
 *   - Explicit `[]` → success, zero candidates, watermark advances normally.
 *   - Malformed/unknown-action consolidation response → throw before L1,
 *     watermark unchanged.
 *   - Explicit `action:"skip"` → success, decision recorded, watermark advances.
 *   - Malformed individual fallback after a batch unresolved entry → throw.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PoolManager } from "../src/pools.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { initQueueSchema, enqueue, getJob } from "../src/distill/queue.js";
import { startDistiller } from "../src/distill/worker.js";
import { initWatermarkSchema, getWatermark } from "../src/distill/watermark.js";
import { distillOnce } from "../src/distill/core.js";
import type { LLMFnWithModel } from "../src/distill/llm.js";

const VALID_CANDIDATE = `{"type":"fact","content":"The sensor reads nominal.","confidence":"high"}`;
const VALID_CONSOLIDATION = `{"action":"store","target_ids":[],"rationale":"New fact."}`;

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "falda-malformed-"));
}
function cleanup(root: string) {
  fs.rmSync(root, { recursive: true, force: true });
}
function makePool(root: string) {
  return new PoolManager({ root, embed: makeLocalEmbedder(32), dim: 32 });
}
function makeLlm(...responses: string[]): LLMFnWithModel {
  let i = 0;
  return Object.assign(
    async (_prompt: string) => {
      if (i >= responses.length) throw new Error("stub LLM: no more responses");
      return responses[i++];
    },
    { model: "stub" },
  );
}

async function waitFor(pred: () => boolean, ms = 3000, step = 15) {
  const dl = Date.now() + ms;
  while (!pred() && Date.now() < dl) await new Promise((r) => setTimeout(r, step));
  return pred();
}

// Helper: run distillOnce directly against a store that has one turn.
async function runDistillOnce(root: string, llm: LLMFnWithModel) {
  const pools = makePool(root);
  const store = pools.resolve("proj", undefined, true);
  await store.addStream("sess", [{ role: "user", content: "the sensor reads nominal" }]);
  await distillOnce(store, llm, {
    storeKey: "proj:self", verbose: false,
    model: "stub", promptVersion: "test", distillerVersion: "test",
  });
  return { store, db: (store as any).db as Database.Database };
}

// ─── Extraction failures ──────────────────────────────────────────────────────

describe("finding 16: malformed extraction → retryable failure, watermark unchanged", () => {
  test("blank response fails the pass and leaves the watermark absent", async () => {
    const root = makeTempRoot();
    try {
      await assert.rejects(
        () => runDistillOnce(root, makeLlm("")),
        (e: any) => /malformed|extraction/i.test(e.message),
        "blank extraction must throw before L1",
      );
      const pools = makePool(root);
      const store = pools.resolve("proj", undefined, true);
      const db = (store as any).db as Database.Database;
      initWatermarkSchema(db);
      const wm = getWatermark(db, "proj:self");
      assert.equal(wm, null, "watermark must not advance on malformed extraction");
    } finally { cleanup(root); }
  });

  test("prose-only response fails the pass", async () => {
    const root = makeTempRoot();
    try {
      await assert.rejects(
        () => runDistillOnce(root, makeLlm("I found no durable memories in this conversation.")),
        (e: any) => /malformed|extraction/i.test(e.message),
      );
      const pools = makePool(root);
      const db = (pools.resolve("proj", undefined, true) as any).db as Database.Database;
      initWatermarkSchema(db);
      assert.equal(getWatermark(db, "proj:self"), null, "watermark must not advance");
    } finally { cleanup(root); }
  });

  test("malformed JSON line fails the pass", async () => {
    const root = makeTempRoot();
    try {
      await assert.rejects(
        () => runDistillOnce(root, makeLlm('{"type":"fact","content":"x"')),
        (e: any) => /malformed|extraction/i.test(e.message),
      );
    } finally { cleanup(root); }
  });

  test("invalid type field fails the pass", async () => {
    const root = makeTempRoot();
    try {
      await assert.rejects(
        () => runDistillOnce(root, makeLlm('{"type":"observation","content":"x","confidence":"high"}')),
        (e: any) => /malformed|extraction/i.test(e.message),
      );
    } finally { cleanup(root); }
  });

  test("invalid confidence field fails the pass", async () => {
    const root = makeTempRoot();
    try {
      await assert.rejects(
        () => runDistillOnce(root, makeLlm('{"type":"fact","content":"x","confidence":"certain"}')),
        (e: any) => /malformed|extraction/i.test(e.message),
      );
    } finally { cleanup(root); }
  });

  test("mixed valid and invalid candidates in array fails the pass atomically", async () => {
    const root = makeTempRoot();
    try {
      // One good, one bad — the whole extraction must fail, not partially succeed.
      const response = JSON.stringify([
        { type: "fact", content: "good one", confidence: "high" },
        { type: "BOGUS", content: "bad one", confidence: "high" },
      ]);
      await assert.rejects(
        () => runDistillOnce(root, makeLlm(response)),
        (e: any) => /malformed|extraction/i.test(e.message),
        "array with any invalid candidate must fail the whole pass",
      );
      const pools = makePool(root);
      const db = (pools.resolve("proj", undefined, true) as any).db as Database.Database;
      initWatermarkSchema(db);
      assert.equal(getWatermark(db, "proj:self"), null, "no partial extraction must be committed");
    } finally { cleanup(root); }
  });

  test("explicit [] succeeds with zero candidates and advances the watermark", async () => {
    const root = makeTempRoot();
    try {
      // [] is the intentional empty-extraction sentinel introduced by the fix.
      await assert.doesNotReject(
        () => runDistillOnce(root, makeLlm("[]")),
        "explicit [] must succeed",
      );
      const pools = makePool(root);
      const db = (pools.resolve("proj", undefined, true) as any).db as Database.Database;
      initWatermarkSchema(db);
      const wm = getWatermark(db, "proj:self");
      assert.ok(wm !== null, "watermark must advance after intentional empty extraction");
      assert.ok((wm!.last_processed_seq ?? 0) > 0, "watermark seq must be set");

      // No atoms should have been stored.
      const atomCount = (db.prepare("SELECT COUNT(*) c FROM atoms").get() as any).c as number;
      assert.equal(atomCount, 0, "zero atoms must be stored for an empty extraction");
    } finally { cleanup(root); }
  });

  test("fenced JSON is still accepted (existing tolerance preserved)", async () => {
    const root = makeTempRoot();
    try {
      const fenced = "```json\n" + VALID_CANDIDATE + "\n```";
      // Supply enough responses for L2/L3 (scene title, summary, core) so
      // the pass can run all the way through without stub-LLM exhaustion.
      const err = await runDistillOnce(root, makeLlm(
        fenced, VALID_CONSOLIDATION,
        "Sensor Nominal",           // scene title
        "The sensor was nominal.",  // scene summary
        "# Proj\nNominal.",         // core
      )).then(() => null, (e: Error) => e);
      // Extraction and consolidation must not have been the source of failure.
      if (err) {
        assert.ok(
          !/malformed|extraction|consolidation/i.test(err.message),
          `fenced JSON must not fail extraction/consolidation; got: ${err.message}`,
        );
      }
    } finally { cleanup(root); }
  });

  test("JSON array of valid candidates is still accepted", async () => {
    const root = makeTempRoot();
    try {
      const arr = JSON.stringify([
        { type: "fact", content: "The sensor reads nominal.", confidence: "high" },
      ]);
      const err = await runDistillOnce(root, makeLlm(
        arr, VALID_CONSOLIDATION,
        "Sensor Nominal",
        "The sensor was nominal.",
        "# Proj\nNominal.",
      )).then(() => null, (e: Error) => e);
      if (err) {
        assert.ok(
          !/malformed|extraction|consolidation/i.test(err.message),
          `JSON array must not fail extraction/consolidation; got: ${err.message}`,
        );
      }
    } finally { cleanup(root); }
  });
});

// ─── Consolidation failures ───────────────────────────────────────────────────

describe("finding 16: malformed consolidation → retryable failure, watermark unchanged", () => {
  test("prose consolidation response fails the pass", async () => {
    const root = makeTempRoot();
    try {
      await assert.rejects(
        () => runDistillOnce(root, makeLlm(VALID_CANDIDATE, "I think you should store this.")),
        (e: any) => /malformed|consolidation/i.test(e.message),
      );
      const pools = makePool(root);
      const db = (pools.resolve("proj", undefined, true) as any).db as Database.Database;
      initWatermarkSchema(db);
      assert.equal(getWatermark(db, "proj:self"), null, "watermark must not advance on malformed consolidation");
    } finally { cleanup(root); }
  });

  test("unknown action fails the pass (not silently treated as skip)", async () => {
    const root = makeTempRoot();
    try {
      await assert.rejects(
        () => runDistillOnce(root, makeLlm(
          VALID_CANDIDATE,
          '{"action":"obliterate","target_ids":[],"rationale":"gone"}',
        )),
        (e: any) => /malformed|consolidation/i.test(e.message),
        "unknown action must fail the pass, not become a skip",
      );
      const pools = makePool(root);
      const db = (pools.resolve("proj", undefined, true) as any).db as Database.Database;
      initWatermarkSchema(db);
      assert.equal(getWatermark(db, "proj:self"), null);
    } finally { cleanup(root); }
  });

  test("malformed JSON consolidation response fails the pass", async () => {
    const root = makeTempRoot();
    try {
      await assert.rejects(
        () => runDistillOnce(root, makeLlm(VALID_CANDIDATE, '{"action":"store"')),
        (e: any) => /malformed|consolidation/i.test(e.message),
      );
    } finally { cleanup(root); }
  });

  test("explicit skip action succeeds and advances the watermark", async () => {
    const root = makeTempRoot();
    try {
      const skipDecision = '{"action":"skip","target_ids":[],"rationale":"redundant"}';
      await assert.doesNotReject(
        () => runDistillOnce(root, makeLlm(VALID_CANDIDATE, skipDecision)),
        "explicit skip must succeed",
      );
      const pools = makePool(root);
      const db = (pools.resolve("proj", undefined, true) as any).db as Database.Database;
      initWatermarkSchema(db);
      const wm = getWatermark(db, "proj:self");
      assert.ok(wm !== null, "watermark must advance on a successful skip");

      // Skip decision recorded but no atom stored.
      const atomCount = (db.prepare("SELECT COUNT(*) c FROM atoms").get() as any).c as number;
      assert.equal(atomCount, 0, "no atom for a skipped candidate");
      const decCount = (db.prepare("SELECT COUNT(*) c FROM consolidation_decisions").get() as any).c as number;
      assert.equal(decCount, 1, "skip decision must be recorded in consolidation_decisions");
    } finally { cleanup(root); }
  });
});

// ─── Worker-level retry integration ──────────────────────────────────────────

describe("finding 16: malformed output engages queue retry, watermark stays put", () => {
  test("a job whose extraction is malformed is rescheduled via failJob, watermark unchanged", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      const store = pools.resolve("proj", undefined, true);
      await store.addStream("sess", [{ role: "user", content: "the sensor reads nominal" }]);

      // Blank extraction — always malformed.
      const badLlm: LLMFnWithModel = Object.assign(
        async () => "",
        { model: "stub" },
      );

      const jobId = enqueue(queueDb, "proj:self");
      const distiller = startDistiller(queueDb, pools, badLlm, {
        drainIntervalMs: 20,
        sweepIntervalMs: 60_000,
      });
      try {
        const attempted = await waitFor(() => (getJob(queueDb, jobId)?.attempts ?? 0) > 0, 3000);
        assert.ok(attempted, "job was claimed and attempted");
        const job = getJob(queueDb, jobId)!;
        assert.equal(job.status, "pending", "malformed extraction must reschedule via failJob, not complete");
        assert.ok(job.error && /malformed|extraction/i.test(job.error), `error must identify malformed extraction; got: ${job.error}`);

        // Watermark must not have advanced.
        const db = (store as any).db as Database.Database;
        initWatermarkSchema(db);
        assert.equal(getWatermark(db, "proj:self"), null, "watermark must not advance on malformed extraction");
      } finally {
        await distiller.stop();
      }
    } finally { cleanup(root); }
  });

  test("a job whose consolidation is malformed is rescheduled, watermark unchanged", async () => {
    const root = makeTempRoot();
    try {
      const pools = makePool(root);
      const queueDb = new Database(":memory:");
      initQueueSchema(queueDb);
      const store = pools.resolve("proj", undefined, true);
      await store.addStream("sess", [{ role: "user", content: "the sensor reads nominal" }]);

      let callCount = 0;
      const badConsolLlm: LLMFnWithModel = Object.assign(
        async () => {
          callCount++;
          if (callCount === 1) return VALID_CANDIDATE; // extraction
          return "prose response not JSON"; // consolidation
        },
        { model: "stub" },
      );

      const jobId = enqueue(queueDb, "proj:self");
      const distiller = startDistiller(queueDb, pools, badConsolLlm, {
        drainIntervalMs: 20,
        sweepIntervalMs: 60_000,
      });
      try {
        const attempted = await waitFor(() => (getJob(queueDb, jobId)?.attempts ?? 0) > 0, 3000);
        assert.ok(attempted, "job was attempted");
        const job = getJob(queueDb, jobId)!;
        assert.equal(job.status, "pending", "malformed consolidation must reschedule, not complete");
        assert.ok(job.error && /malformed|consolidation/i.test(job.error), `error: ${job.error}`);

        const db = (store as any).db as Database.Database;
        initWatermarkSchema(db);
        assert.equal(getWatermark(db, "proj:self"), null, "watermark must not advance on malformed consolidation");
      } finally {
        await distiller.stop();
      }
    } finally { cleanup(root); }
  });
});
