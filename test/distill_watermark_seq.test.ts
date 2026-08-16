/**
 * Watermark seq tests — verifies that distillOnce uses a global monotonic
 * sequence cursor, not a timestamp cursor, so cross-session turns are never
 * silently skipped.
 *
 * Scenario reproduced from the bug report:
 *   session A: turns added first (seq 1, 2, 3 ... enough to fill the window)
 *   session B: turns added after A but with earlier timestamps (seq 4, 5)
 *   (or in any insertion order — seq is what matters, not ts)
 *
 * With the old timestamp cursor, a window that happened to contain only
 * session-A turns would advance last_processed_ts to A's latest ts, leaving
 * session-B turns below the watermark if B's timestamps were earlier.
 *
 * With the seq cursor, the window is simply "seq > last_processed_seq",
 * ordering globally by insertion order. Every turn is guaranteed to be
 * processed exactly once.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Falda } from "../src/falda.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { distillOnce } from "../src/distill/core.js";
import { initWatermarkSchema, getWatermark } from "../src/distill/watermark.js";

function makeStore(dim = 32) {
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-seq-"));
  const s = new Falda({ dbPath: ":memory:", blobDir, embed: makeLocalEmbedder(dim), dim });
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
    if (r === undefined) throw new Error(`Mock LLM out of responses (prompt: ${prompt.slice(0, 60)})`);
    return r;
  };
}

describe("distill watermark: seq-based cursor", () => {
  test("stream turns carry monotonically increasing seq", async () => {
    const { s, blobDir } = makeStore();
    try {
      const ids1 = await s.addStream("sess-A", [
        { role: "user", content: "alpha turn one" },
        { role: "user", content: "alpha turn two" },
      ]);
      const ids2 = await s.addStream("sess-B", [
        { role: "user", content: "beta turn one" },
      ]);
      const db = (s as any).db;
      const rows = db.prepare("SELECT id, seq FROM stream ORDER BY seq").all() as any[];
      assert.equal(rows.length, 3);
      assert.ok(rows[0].seq < rows[1].seq, "seq increases");
      assert.ok(rows[1].seq < rows[2].seq, "seq increases");
      assert.ok(ids1.includes(rows[0].id));
      assert.ok(ids1.includes(rows[1].id));
      assert.ok(ids2.includes(rows[2].id));
    } finally { cleanup(s, blobDir); }
  });

  test("queryStreamSeq respects afterSeq and ordering", async () => {
    const { s, blobDir } = makeStore();
    try {
      await s.addStream("sess-A", [
        { role: "user", content: "turn one" },
        { role: "user", content: "turn two" },
        { role: "user", content: "turn three" },
      ]);
      const all = s.queryStreamSeq({ afterSeq: 0 });
      assert.equal(all.length, 3);
      assert.ok(all[0].seq < all[1].seq && all[1].seq < all[2].seq, "globally ordered");

      const after1 = s.queryStreamSeq({ afterSeq: all[0].seq });
      assert.equal(after1.length, 2);
      assert.equal(after1[0].id, all[1].id);
    } finally { cleanup(s, blobDir); }
  });

  test("cross-session: turns from session B not skipped when session A fills window", async () => {
    const { s, blobDir } = makeStore();
    try {
      // Add session A turns first (they get lower seq values).
      await s.addStream("sess-A", [
        { role: "user", content: "alpha one" },
        { role: "user", content: "alpha two" },
        { role: "user", content: "alpha three" },
      ]);
      // Add session B turns after A (they get higher seq values).
      await s.addStream("sess-B", [
        { role: "user", content: "beta one" },
        { role: "user", content: "beta two" },
      ]);

      const db = (s as any).db;
      initWatermarkSchema(db);

      // Build a mock LLM that provides responses for one pass of A-only turns
      // (windowSize=3 → covers all of sess-A, none of sess-B).
      // Pass 1: extraction + consolidation for 3 turns + scene generation.
      const llmPass1 = makeMockLLM([
        // extraction
        `{"type":"fact","content":"alpha content.","confidence":"low"}`,
        // consolidation
        `{"action":"store","target_ids":[],"rationale":"New fact."}`,
        // L2: episode title/summary for sess-A
        "Alpha session", "Alpha session summary.",
        // L3: core
        "# Core\nAlpha.",
      ]);

      const r1 = await distillOnce(s, llmPass1, {
        storeKey: "test:cross-session",
        windowSize: 3,
      });
      assert.equal(r1.turns_processed, 3, "pass 1 processes exactly 3 turns (sess-A)");

      // Watermark should be at seq 3 (the 3rd turn of sess-A).
      const wm1 = getWatermark(db, "test:cross-session");
      assert.ok(wm1?.last_processed_seq != null, "seq watermark set");
      const seqAfterPass1 = wm1!.last_processed_seq!;
      assert.equal(seqAfterPass1, 3, "watermark at seq 3 after first pass");

      // Pass 2 must pick up sess-B turns (seq 4 and 5).
      const llmPass2 = makeMockLLM([
        // extraction for 2 sess-B turns
        `{"type":"fact","content":"beta content.","confidence":"low"}`,
        // consolidation
        `{"action":"store","target_ids":[],"rationale":"New fact."}`,
        // L2: episode for sess-A (still active), episode for sess-B (new)
        "Alpha session", "Alpha summary.",
        "Beta session", "Beta session summary.",
        // L3: core (structure changed)
        "# Core\nAlpha and Beta.",
      ]);

      const r2 = await distillOnce(s, llmPass2, {
        storeKey: "test:cross-session",
        windowSize: 3,
      });
      assert.equal(r2.turns_processed, 2, "pass 2 processes exactly the 2 sess-B turns");

      const wm2 = getWatermark(db, "test:cross-session");
      assert.ok(wm2!.last_processed_seq! > seqAfterPass1, "watermark advanced after pass 2");
    } finally { cleanup(s, blobDir); }
  });

  test("watermark advances to lastTurn.seq inside the L1 transaction", async () => {
    const { s, blobDir } = makeStore();
    try {
      await s.addStream("sess-X", [
        { role: "user", content: "turn A" },
        { role: "user", content: "turn B" },
      ]);
      const db = (s as any).db;
      initWatermarkSchema(db);

      const llm = makeMockLLM([
        `{"type":"fact","content":"Fact A.","confidence":"high"}`,
        `{"action":"store","target_ids":[],"rationale":"New."}`,
        `{"type":"fact","content":"Fact B.","confidence":"high"}`,
        `{"action":"store","target_ids":[],"rationale":"New."}`,
        "Session X", "Session summary.",
        "Topic", "Topic summary.",
        "# Core\nFacts.",
      ]);

      await distillOnce(s, llm, { storeKey: "wm-test:self", windowSize: 10 });

      const wm = getWatermark(db, "wm-test:self");
      assert.ok(wm != null);
      assert.equal(wm!.last_processed_seq, 2, "watermark is at seq 2 after 2 turns");

      // Second pass: no new turns → should be a no-op.
      const llm2 = makeMockLLM([]);
      const r2 = await distillOnce(s, llm2, { storeKey: "wm-test:self", windowSize: 10 });
      assert.equal(r2.turns_processed, 0, "second pass is a no-op");
    } finally { cleanup(s, blobDir); }
  });
});

describe("Falda.streamHeadSeq", () => {
  test("returns 0 for an empty store", () => {
    const { s, blobDir } = makeStore();
    try {
      assert.equal(s.streamHeadSeq(), 0);
    } finally { cleanup(s, blobDir); }
  });

  test("returns the highest seq after turns are added", async () => {
    const { s, blobDir } = makeStore();
    try {
      await s.addStream("sess-1", [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ]);
      assert.equal(s.streamHeadSeq(), 2);
      await s.addStream("sess-2", [{ role: "user", content: "third" }]);
      assert.equal(s.streamHeadSeq(), 3, "seq is global across sessions, monotonically increasing");
    } finally { cleanup(s, blobDir); }
  });
});
