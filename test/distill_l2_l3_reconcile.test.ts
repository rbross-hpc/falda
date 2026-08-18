/**
 * Finding 2 — independently retryable L2/L3 reconciliation
 * (docs/future/reliability-hardening.md).
 *
 * Verifies:
 *   - a store flagged dirty (out-of-band lifecycle mutation, or a previous
 *     failed L2/L3 attempt) gets its scenes/core reconciled on the next
 *     distillOnce() pass even with zero new stream turns, without
 *     fabricating a watermark advance;
 *   - a store with no dirty flag and no new turns remains a true no-op;
 *   - a scene-narration (L2) or core-synthesis (L3) failure fails the pass
 *     (propagates as a thrown error, matching src/distill/worker.ts's
 *     failJob() path) rather than being silently swallowed as success, and
 *     leaves the store dirty so the next attempt retries;
 *   - each lifecycle-mutation method (supersedeAtom, mergeAtoms,
 *     archiveAtom, hardDeleteAtomsUnsafe, deleteStream) marks the store
 *     dirty, and a no-op deleteStream (no atoms affected) does not.
 *
 * Reuses test/distill_l1_atomic.test.ts's conventions (makeStore,
 * makeMockLLM, the (store as any).db escape hatch).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Falda } from "../src/falda.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { distillOnce } from "../src/distill/core.js";

function makeStore(storeKey = "reconcile-test:self", dim = 32) {
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-l2l3-"));
  const s = new Falda({ dbPath: ":memory:", blobDir, embed: makeLocalEmbedder(dim), dim, storeKey });
  return { s, blobDir };
}

function cleanup(s: Falda, blobDir: string) {
  s.close();
  fs.rmSync(blobDir, { recursive: true, force: true });
}

function makeMockLLM(responses: string[]): (prompt: string) => Promise<string> {
  const queue = [...responses];
  return async (prompt: string): Promise<string> => {
    const r = queue.shift();
    if (r === undefined) throw new Error(`Mock LLM ran out of responses (prompt: ${prompt.slice(0, 80)})`);
    return r;
  };
}

/** store_dirty is created lazily by the first markStoreDirty() call — a
 *  brand-new store has no such table yet, which is equivalent to "clean". */
function isStoreDirty(db: Database.Database, storeKey: string): boolean {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_dirty'"
  ).get();
  if (!tableExists) return false;
  return !!db.prepare("SELECT 1 FROM store_dirty WHERE store_key=?").get(storeKey);
}

// ─── Test 1 — Lifecycle-only dirty triggers reconciliation with empty T0 ──────

describe("Finding 2: dirty-only reconciliation pass", () => {
  test("archiving an atom with no new turns still triggers L2/L3 on the next pass", async () => {
    const storeKey = "archive-dirty:self";
    const { s, blobDir } = makeStore(storeKey);
    try {
      await s.addStream("sess-1", [{ role: "user", content: "the widget ships in Q3" }]);
      const llm1 = makeMockLLM([
        `{"type":"fact","content":"The widget ships in Q3.","confidence":"high"}`,
        `{"action":"store","target_ids":[],"rationale":"New fact."}`,
        "Widget session", "Widget shipping discussed.",
        "Widget topic", "Widget shipping facts.",
        "# Core\n\nWidget ships in Q3.",
      ]);
      const r1 = await distillOnce(s, llm1, { storeKey });
      assert.equal(r1.atoms_stored, 1);

      const atom = s.queryAtoms({}).items[0];
      const db = (s as any).db as Database.Database;
      assert.equal(isStoreDirty(db, storeKey), false, "clean after a fully successful pass");

      // Out-of-band lifecycle mutation, no new stream turn added.
      const changed = s.archiveAtom(atom.id);
      assert.equal(changed, 1);
      assert.equal(isStoreDirty(db, storeKey), true, "archiving marks the store dirty");

      // Second distillOnce: LLM supplies ONLY L2/L3 responses — no
      // extraction/consolidation responses — proving L1 correctly does
      // nothing for an empty T0 window.
      const llm2 = makeMockLLM([
        // No episode narration needed (episode retires — see below), but a
        // topic scene retirement also needs no LLM call. Core synthesis
        // runs because active scenes now differ (the atom's scenes empty out).
        "# Core\n\n(no durable knowledge)",
      ]);
      const r2 = await distillOnce(s, llm2, { storeKey });
      assert.equal(r2.turns_processed, 0, "no new turns processed");

      assert.equal(isStoreDirty(db, storeKey), false, "dirty flag cleared after clean reconciliation");

      const scenes = db.prepare("SELECT * FROM scenes WHERE status='active'").all() as any[];
      for (const sc of scenes) {
        const memberIds: string[] = JSON.parse(sc.atom_ids ?? "[]");
        assert.ok(!memberIds.includes(atom.id), "archived atom no longer an active member of any scene");
      }
    } finally { cleanup(s, blobDir); }
  });

  test("a clean store with no new turns and no dirty flag is a true no-op", async () => {
    const storeKey = "clean-noop:self";
    const { s, blobDir } = makeStore(storeKey);
    try {
      await s.addStream("sess-1", [{ role: "user", content: "stable fact" }]);
      const llm1 = makeMockLLM([
        `{"type":"fact","content":"Stable fact.","confidence":"high"}`,
        `{"action":"store","target_ids":[],"rationale":"New."}`,
        "Session", "Summary.",
        "Topic", "Topic summary.",
        "# Core\n\nStable fact.",
      ]);
      await distillOnce(s, llm1, { storeKey });

      const db = (s as any).db as Database.Database;
      assert.equal(isStoreDirty(db, storeKey), false);

      let calls = 0;
      const throwingLlm = async () => { calls++; throw new Error("must not be called"); };
      const r2 = await distillOnce(s, throwingLlm, { storeKey });
      assert.equal(calls, 0, "LLM never invoked on a fully clean no-op pass");
      assert.equal(r2.turns_processed, 0);
    } finally { cleanup(s, blobDir); }
  });
});

// ─── Test 2 — L2/L3 failures fail the pass, dirty stays set ───────────────────

describe("Finding 2: L2/L3 failure propagation", () => {
  test("a scene narration failure fails the pass and leaves the store dirty", async () => {
    const storeKey = "l2-fail:self";
    const { s, blobDir } = makeStore(storeKey);
    try {
      const db = (s as any).db as Database.Database;
      await s.addStream("sess-1", [{ role: "user", content: "the reactor runs cold" }]);

      // Extraction+consolidation succeed; scene title call throws.
      const llm = makeMockLLM([
        `{"type":"fact","content":"The reactor runs cold.","confidence":"high"}`,
        `{"action":"store","target_ids":[],"rationale":"New fact."}`,
        // Deliberately no more responses — scene title call throws
        // "ran out of responses", simulating an L2 LLM failure.
      ]);

      await assert.rejects(() => distillOnce(s, llm, { storeKey }));

      const pass = db.prepare("SELECT status FROM distillation_passes ORDER BY started_at DESC LIMIT 1").get() as any;
      assert.ok(pass, "a distillation_passes row exists for the failed attempt");
      assert.equal(pass.status, "failed", "pass status reflects the failure");

      assert.equal(isStoreDirty(db, storeKey), true, "store remains dirty after a failed L2 attempt");

      // Retry with a fully-succeeding LLM: succeeds and clears dirty.
      const llmRetry = makeMockLLM([
        "Reactor session", "Reactor discussed.",
        "Reactor topic", "Reactor facts.",
        "# Core\n\nReactor runs cold.",
      ]);
      const result = await distillOnce(s, llmRetry, { storeKey });
      assert.equal(result.turns_processed, 0, "retry is a dirty-only pass, no new turns");
      assert.equal(isStoreDirty(db, storeKey), false, "dirty cleared after a successful retry");
    } finally { cleanup(s, blobDir); }
  });

  test("a core synthesis failure fails the pass and leaves the store dirty", async () => {
    const storeKey = "l3-fail:self";
    const { s, blobDir } = makeStore(storeKey);
    try {
      const db = (s as any).db as Database.Database;
      await s.addStream("sess-1", [{ role: "user", content: "the cryostat is stable" }]);

      // Extraction+consolidation+scene narration succeed; core synthesis
      // call throws (mock runs out of responses).
      const llm = makeMockLLM([
        `{"type":"fact","content":"The cryostat is stable.","confidence":"high"}`,
        `{"action":"store","target_ids":[],"rationale":"New fact."}`,
        "Cryostat session", "Cryostat discussed.",
        "Cryostat topic", "Cryostat facts.",
        // No core-synthesis response supplied — L3 call throws.
      ]);

      await assert.rejects(() => distillOnce(s, llm, { storeKey }));

      const pass = db.prepare("SELECT status FROM distillation_passes ORDER BY started_at DESC LIMIT 1").get() as any;
      assert.equal(pass.status, "failed");
      assert.equal(isStoreDirty(db, storeKey), true, "store remains dirty after a failed L3 attempt");

      // Scenes should have succeeded and NOT need renarration again — the
      // retry only needs to resynthesize core.
      const llmRetry = makeMockLLM(["# Core\n\nCryostat is stable."]);
      const result = await distillOnce(s, llmRetry, { storeKey });
      assert.equal(result.core_regenerated, true, "core regenerated on retry");
      assert.equal(isStoreDirty(db, storeKey), false, "dirty cleared after a successful retry");
    } finally { cleanup(s, blobDir); }
  });
});

// ─── Test 3 — markStoreDirty coverage for each lifecycle mutation ─────────────

describe("Finding 2: lifecycle mutations mark the store dirty", () => {
  test("supersedeAtom marks dirty", async () => {
    const storeKey = "dirty-supersede:self";
    const { s, blobDir } = makeStore(storeKey);
    try {
      const db = (s as any).db as Database.Database;
      const a = await s.upsertAtom({ type: "fact", content: "old fact" });
      const b = await s.upsertAtom({ type: "fact", content: "new fact" });
      assert.equal(isStoreDirty(db, storeKey), false);
      s.supersedeAtom(a.id, b.id);
      assert.equal(isStoreDirty(db, storeKey), true);
    } finally { cleanup(s, blobDir); }
  });

  test("mergeAtoms marks dirty when losers are non-empty", async () => {
    const storeKey = "dirty-merge:self";
    const { s, blobDir } = makeStore(storeKey);
    try {
      const db = (s as any).db as Database.Database;
      const a = await s.upsertAtom({ type: "fact", content: "fact A" });
      const b = await s.upsertAtom({ type: "fact", content: "fact B" });
      assert.equal(isStoreDirty(db, storeKey), false);
      s.mergeAtoms([a.id], b.id);
      assert.equal(isStoreDirty(db, storeKey), true);
    } finally { cleanup(s, blobDir); }
  });

  test("mergeAtoms with an empty loser list does NOT mark dirty (no-op)", async () => {
    const storeKey = "dirty-merge-empty:self";
    const { s, blobDir } = makeStore(storeKey);
    try {
      const db = (s as any).db as Database.Database;
      const a = await s.upsertAtom({ type: "fact", content: "fact A" });
      s.mergeAtoms([], a.id);
      assert.equal(isStoreDirty(db, storeKey), false);
    } finally { cleanup(s, blobDir); }
  });

  test("archiveAtom marks dirty only when an atom was actually archived", async () => {
    const storeKey = "dirty-archive:self";
    const { s, blobDir } = makeStore(storeKey);
    try {
      const db = (s as any).db as Database.Database;
      const a = await s.upsertAtom({ type: "fact", content: "archivable fact" });
      const noop = s.archiveAtom("nonexistent-id");
      assert.equal(noop, 0);
      assert.equal(isStoreDirty(db, storeKey), false, "no-op archive does not mark dirty");
      const changed = s.archiveAtom(a.id);
      assert.equal(changed, 1);
      assert.equal(isStoreDirty(db, storeKey), true);
    } finally { cleanup(s, blobDir); }
  });

  test("hardDeleteAtomsUnsafe marks dirty only when rows were actually removed", async () => {
    const storeKey = "dirty-harddelete:self";
    const { s, blobDir } = makeStore(storeKey);
    try {
      const db = (s as any).db as Database.Database;
      const noop = s.hardDeleteAtomsUnsafe(["nonexistent-id"]);
      assert.equal(noop, 0);
      assert.equal(isStoreDirty(db, storeKey), false, "no-op hard-delete does not mark dirty");
      const a = await s.upsertAtom({ type: "fact", content: "doomed fact" });
      const removed = s.hardDeleteAtomsUnsafe([a.id]);
      assert.equal(removed, 1);
      assert.equal(isStoreDirty(db, storeKey), true);
    } finally { cleanup(s, blobDir); }
  });

  test("deleteStream marks dirty only when it affected some atom's evidence", async () => {
    const storeKey = "dirty-deletestream:self";
    const { s, blobDir } = makeStore(storeKey);
    try {
      const db = (s as any).db as Database.Database;
      const ids = await s.addStream("sess-1", [{ role: "user", content: "irrelevant chatter" }]);
      // No evidence attached to this turn yet — deleting it affects zero atoms.
      const noop = s.deleteStream({ ids });
      assert.equal(noop.affected_atom_ids.length, 0);
      assert.equal(isStoreDirty(db, storeKey), false, "deleting evidence-free turns does not mark dirty");

      const ids2 = await s.addStream("sess-1", [{ role: "user", content: "evidenced turn" }]);
      const a = await s.upsertAtom({ type: "fact", content: "evidenced fact" });
      s.addEvidence(a.id, ids2);
      const result = s.deleteStream({ ids: ids2 });
      assert.equal(result.affected_atom_ids.length, 1);
      assert.equal(isStoreDirty(db, storeKey), true, "deleting a turn with evidence marks dirty");
    } finally { cleanup(s, blobDir); }
  });
});
