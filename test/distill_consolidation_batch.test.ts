/**
 * Batched consolidation decisions (docs/future/distill-consolidation-batching.md).
 *
 * Distillation used to make one consolidation call per candidate atom, each
 * re-sending the same ~250-token instruction block. These tests cover the
 * batched replacement: the prompt that carries N candidates, the parser that
 * maps decisions back by explicit index, and the fallback that re-issues an
 * individual call for any candidate the batch failed to resolve.
 *
 * Correlation is by explicit index and never by array position: a dropped
 * decision costs one candidate, but a misattributed one writes a wrong
 * consolidation into memory silently.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseConsolidationBatch, distillOnce } from "../src/distill/core.js";
import { consolidationBatchPrompt, consolidationPrompt } from "../src/distill/prompts.js";
import { Falda } from "../src/falda.js";
import { makeLocalEmbedder } from "../src/embedder.js";

describe("parseConsolidationBatch", () => {
  test("maps a well-formed array by explicit index", () => {
    const raw = JSON.stringify([
      { candidate: 0, action: "store", target_ids: [], rationale: "new" },
      { candidate: 1, action: "skip", target_ids: [], rationale: "redundant" },
    ]);
    const out = parseConsolidationBatch(raw, 2);
    assert.equal(out.length, 2);
    assert.equal(out[0]?.action, "store");
    assert.equal(out[1]?.action, "skip");
    assert.equal(out[1]?.rationale, "redundant");
  });

  test("uses the stated index, not array position", () => {
    // Deliberately out of order: position 0 declares candidate 1.
    const raw = JSON.stringify([
      { candidate: 1, action: "merge", target_ids: ["a", "b"], rationale: "unify" },
      { candidate: 0, action: "store", target_ids: [], rationale: "new" },
    ]);
    const out = parseConsolidationBatch(raw, 2);
    assert.equal(out[0]?.action, "store", "candidate 0 got its own decision");
    assert.equal(out[1]?.action, "merge", "candidate 1 got its own decision");
    assert.deepEqual(out[1]?.target_ids, ["a", "b"]);
  });

  test("leaves a candidate unresolved when its index is missing", () => {
    const raw = JSON.stringify([
      { candidate: 0, action: "store", target_ids: [], rationale: "new" },
    ]);
    const out = parseConsolidationBatch(raw, 3);
    assert.equal(out[0]?.action, "store");
    assert.equal(out[1], undefined, "candidate 1 unresolved");
    assert.equal(out[2], undefined, "candidate 2 unresolved");
  });

  test("drops an out-of-range index rather than misapplying it", () => {
    const raw = JSON.stringify([
      { candidate: 7, action: "merge", target_ids: ["x"], rationale: "oops" },
      { candidate: -1, action: "store", target_ids: [], rationale: "oops" },
    ]);
    const out = parseConsolidationBatch(raw, 2);
    assert.deepEqual(out, [undefined, undefined]);
  });

  test("keeps the first of a duplicated index", () => {
    const raw = JSON.stringify([
      { candidate: 0, action: "store", target_ids: [], rationale: "first" },
      { candidate: 0, action: "merge", target_ids: ["z"], rationale: "second" },
    ]);
    const out = parseConsolidationBatch(raw, 1);
    assert.equal(out[0]?.rationale, "first");
  });

  test("rejects an unknown action as unresolved", () => {
    const raw = JSON.stringify([
      { candidate: 0, action: "obliterate", target_ids: [], rationale: "no" },
    ]);
    assert.deepEqual(parseConsolidationBatch(raw, 1), [undefined]);
  });

  test("returns all-unresolved for a completely malformed reply", () => {
    assert.deepEqual(parseConsolidationBatch("I'm afraid I can't do that.", 2),
      [undefined, undefined]);
  });

  test("tolerates code fences and a line-delimited body", () => {
    const raw = "```json\n" +
      `{"candidate":0,"action":"store","target_ids":[],"rationale":"a"},\n` +
      `{"candidate":1,"action":"skip","target_ids":[],"rationale":"b"}\n` +
      "```";
    const out = parseConsolidationBatch(raw, 2);
    assert.equal(out[0]?.action, "store");
    assert.equal(out[1]?.action, "skip");
  });

  test("coerces non-string target_ids and a missing rationale", () => {
    const raw = JSON.stringify([{ candidate: 0, action: "merge", target_ids: [1, 2] }]);
    const out = parseConsolidationBatch(raw, 1);
    assert.deepEqual(out[0]?.target_ids, ["1", "2"]);
    assert.equal(out[0]?.rationale, "");
  });

  test("bare single-object reply with non-empty target_ids resolves correctly", () => {
    const raw = JSON.stringify({ candidate: 0, action: "merge", target_ids: ["a", "b"], rationale: "x" });
    const out = parseConsolidationBatch(raw, 1);
    assert.equal(out[0]?.action, "merge");
    assert.deepEqual(out[0]?.target_ids, ["a", "b"]);
  });

  test("prose-wrapped array still parses via the array path", () => {
    const raw = 'Here is the result: [{"candidate":0,"action":"store","target_ids":[],"rationale":"n"}]';
    const out = parseConsolidationBatch(raw, 1);
    assert.equal(out[0]?.action, "store");
  });
});

describe("consolidationBatchPrompt", () => {
  const items = [
    {
      candidate: { type: "fact", content: "Deploy script lives in bin/release.", confidence: "high" },
      existing: [{ id: "atom-1", type: "fact", content: "Deploys are manual.", confidence: "medium" }],
    },
    {
      candidate: { type: "preference", content: "Ryan prefers squashed commits.", confidence: "high" },
      existing: [],
    },
  ];

  test("includes every candidate and its own existing memories", () => {
    const p = consolidationBatchPrompt(items);
    assert.ok(p.includes("Deploy script lives in bin/release."), "candidate 0 content");
    assert.ok(p.includes("Ryan prefers squashed commits."), "candidate 1 content");
    assert.ok(p.includes("atom-1"), "candidate 0's retrieved neighbour id");
    assert.ok(p.includes("Deploys are manual."), "candidate 0's neighbour content");
  });

  test("numbers the candidates so decisions can be correlated by index", () => {
    const p = consolidationBatchPrompt(items);
    assert.ok(/Candidate 0\b/.test(p), "candidate 0 is labelled");
    assert.ok(/Candidate 1\b/.test(p), "candidate 1 is labelled");
  });

  test("sends the instruction block once, not once per candidate", () => {
    const p = consolidationBatchPrompt(items);
    const occurrences = p.split("memory consolidation assistant").length - 1;
    assert.equal(occurrences, 1, "shared instructions appear exactly once");
  });

  test("is materially shorter than the per-candidate prompts it replaces", () => {
    const batched = consolidationBatchPrompt(items).length;
    const individual = items
      .map((i) => consolidationPrompt(i.candidate, i.existing).length)
      .reduce((a, b) => a + b, 0);
    assert.ok(batched < individual,
      `batched (${batched}) should be shorter than ${individual} across separate prompts`);
  });

  test("renders an empty existing list without crashing", () => {
    const p = consolidationBatchPrompt([{ candidate: items[1].candidate, existing: [] }]);
    assert.ok(p.includes("(none)"), "empty neighbour set is rendered explicitly");
  });
});

function makeStore(dim = 32) {
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-batch-"));
  const s = new Falda({ dbPath: ":memory:", blobDir, embed: makeLocalEmbedder(dim), dim });
  return { s, blobDir };
}
function cleanup(s: Falda, blobDir: string) {
  s.close();
  fs.rmSync(blobDir, { recursive: true, force: true });
}

/** Records every prompt it is given, and replies from a queue. */
function makeRecordingLLM(responses: string[]) {
  const prompts: string[] = [];
  const queue = [...responses];
  const fn = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    const r = queue.shift();
    if (r === undefined) throw new Error(`Mock LLM ran out (prompt: ${prompt.slice(0, 60)})`);
    return r;
  };
  return { fn, prompts };
}

const TWO_CANDIDATES = JSON.stringify([
  { type: "fact", content: "Fact one.", confidence: "high" },
  { type: "fact", content: "Fact two.", confidence: "high" },
]);
// Scene title, scene summary (episode), scene title, scene summary (topic), core.
const TAIL = ["Session", "Summary.", "Topic", "Topic summary.", "# Core"];

describe("distillOnce: batched consolidation", () => {
  test("two candidates cost one consolidation call, not two", async () => {
    const { s, blobDir } = makeStore();
    try {
      await s.addStream("sess-1", [{ role: "user", content: "two facts" }]);
      const { fn, prompts } = makeRecordingLLM([
        TWO_CANDIDATES,
        JSON.stringify([
          { candidate: 0, action: "store", target_ids: [], rationale: "new" },
          { candidate: 1, action: "store", target_ids: [], rationale: "new" },
        ]),
        ...TAIL,
      ]);
      const result = await distillOnce(s, fn, { storeKey: "batch:self" });
      assert.equal(result.atoms_stored, 2, "both candidates stored");
      const consolidationPrompts = prompts.filter((p) =>
        p.includes("memory consolidation assistant"));
      assert.equal(consolidationPrompts.length, 1, "exactly one consolidation call");
      assert.ok(consolidationPrompts[0].includes("Candidate 1"), "it was the batched prompt");
    } finally { cleanup(s, blobDir); }
  });

  test("an unresolved candidate falls back to one individual call", async () => {
    const { s, blobDir } = makeStore();
    try {
      await s.addStream("sess-1", [{ role: "user", content: "two facts" }]);
      const { fn, prompts } = makeRecordingLLM([
        TWO_CANDIDATES,
        // Batch resolves candidate 0 only.
        JSON.stringify([{ candidate: 0, action: "store", target_ids: [], rationale: "new" }]),
        // Individual retry for candidate 1, in today's single-decision format.
        `{"action":"store","target_ids":[],"rationale":"retried"}`,
        ...TAIL,
      ]);
      const result = await distillOnce(s, fn, { storeKey: "batch-fb:self" });
      assert.equal(result.atoms_stored, 2, "the unresolved candidate was not lost");
      const consolidationPrompts = prompts.filter((p) =>
        p.includes("memory consolidation assistant"));
      assert.equal(consolidationPrompts.length, 2, "one batched call plus one retry");
      assert.ok(!consolidationPrompts[1].includes("Candidate 0"),
        "the retry used the single-candidate prompt");
    } finally { cleanup(s, blobDir); }
  });

  test("FALDA_DISTILL_CONSOLIDATION_BATCH=1 restores one call per candidate", async () => {
    const prev = process.env.FALDA_DISTILL_CONSOLIDATION_BATCH;
    process.env.FALDA_DISTILL_CONSOLIDATION_BATCH = "1";
    const { s, blobDir } = makeStore();
    try {
      await s.addStream("sess-1", [{ role: "user", content: "two facts" }]);
      const { fn, prompts } = makeRecordingLLM([
        TWO_CANDIDATES,
        `{"action":"store","target_ids":[],"rationale":"new"}`,
        `{"action":"store","target_ids":[],"rationale":"new"}`,
        ...TAIL,
      ]);
      const result = await distillOnce(s, fn, { storeKey: "batch-off:self" });
      assert.equal(result.atoms_stored, 2);
      const consolidationPrompts = prompts.filter((p) =>
        p.includes("memory consolidation assistant"));
      assert.equal(consolidationPrompts.length, 2, "back to one call per candidate");
      assert.ok(consolidationPrompts.every((p) => !p.includes("Candidate 0")),
        "the batched prompt was not used");
    } finally {
      cleanup(s, blobDir);
      if (prev === undefined) delete process.env.FALDA_DISTILL_CONSOLIDATION_BATCH;
      else process.env.FALDA_DISTILL_CONSOLIDATION_BATCH = prev;
    }
  });

  test("a single candidate uses the single-candidate prompt, unchanged", async () => {
    const { s, blobDir } = makeStore();
    try {
      await s.addStream("sess-1", [{ role: "user", content: "one fact" }]);
      const { fn, prompts } = makeRecordingLLM([
        `{"type":"fact","content":"Only fact.","confidence":"high"}`,
        `{"action":"store","target_ids":[],"rationale":"new"}`,
        ...TAIL,
      ]);
      const result = await distillOnce(s, fn, { storeKey: "batch-one:self" });
      assert.equal(result.atoms_stored, 1);
      const consolidationPrompts = prompts.filter((p) =>
        p.includes("memory consolidation assistant"));
      assert.equal(consolidationPrompts.length, 1);
      assert.ok(!consolidationPrompts[0].includes("Candidate 0"),
        "N=1 short-circuits to the single-candidate path");
    } finally { cleanup(s, blobDir); }
  });

  test("chunks at the configured batch size", async () => {
    const prev = process.env.FALDA_DISTILL_CONSOLIDATION_BATCH;
    process.env.FALDA_DISTILL_CONSOLIDATION_BATCH = "2";
    const { s, blobDir } = makeStore();
    try {
      await s.addStream("sess-1", [{ role: "user", content: "three facts" }]);
      const three = JSON.stringify([
        { type: "fact", content: "F1.", confidence: "high" },
        { type: "fact", content: "F2.", confidence: "high" },
        { type: "fact", content: "F3.", confidence: "high" },
      ]);
      const { fn, prompts } = makeRecordingLLM([
        three,
        // Chunk 1: candidates 0 and 1 (indices are chunk-local).
        JSON.stringify([
          { candidate: 0, action: "store", target_ids: [], rationale: "n" },
          { candidate: 1, action: "store", target_ids: [], rationale: "n" },
        ]),
        // Chunk 2: candidate 2, addressed as index 0 of its own chunk.
        JSON.stringify([{ candidate: 0, action: "store", target_ids: [], rationale: "n" }]),
        ...TAIL,
      ]);
      const result = await distillOnce(s, fn, { storeKey: "batch-chunk:self" });
      assert.equal(result.atoms_stored, 3, "all three stored across two chunks");
      const consolidationPrompts = prompts.filter((p) =>
        p.includes("memory consolidation assistant"));
      assert.equal(consolidationPrompts.length, 2, "ceil(3/2) = 2 batched calls");
    } finally {
      cleanup(s, blobDir);
      if (prev === undefined) delete process.env.FALDA_DISTILL_CONSOLIDATION_BATCH;
      else process.env.FALDA_DISTILL_CONSOLIDATION_BATCH = prev;
    }
  });

  test("exactly BATCH candidates still fit in one call", async () => {
    const prev = process.env.FALDA_DISTILL_CONSOLIDATION_BATCH;
    process.env.FALDA_DISTILL_CONSOLIDATION_BATCH = "2";
    const { s, blobDir } = makeStore();
    try {
      await s.addStream("sess-1", [{ role: "user", content: "two facts" }]);
      const { fn, prompts } = makeRecordingLLM([
        TWO_CANDIDATES,
        JSON.stringify([
          { candidate: 0, action: "store", target_ids: [], rationale: "n" },
          { candidate: 1, action: "store", target_ids: [], rationale: "n" },
        ]),
        ...TAIL,
      ]);
      const result = await distillOnce(s, fn, { storeKey: "batch-exact:self" });
      assert.equal(result.atoms_stored, 2);
      const consolidationPrompts = prompts.filter((p) =>
        p.includes("memory consolidation assistant"));
      assert.equal(consolidationPrompts.length, 1, "N == BATCH is a single chunk");
    } finally {
      cleanup(s, blobDir);
      if (prev === undefined) delete process.env.FALDA_DISTILL_CONSOLIDATION_BATCH;
      else process.env.FALDA_DISTILL_CONSOLIDATION_BATCH = prev;
    }
  });

  test("a reversed-order chunk reply lands on the right candidates", async () => {
    // Discriminating test: if decisions were mapped by array POSITION instead of
    // by their stated index, chunk 1's first element (candidate 1, skip) would be
    // applied to candidate 0 — storing F2 and dropping F1, the exact inverse of
    // what this asserts.
    const prev = process.env.FALDA_DISTILL_CONSOLIDATION_BATCH;
    let s: any, blobDir: string | undefined;
    try {
      process.env.FALDA_DISTILL_CONSOLIDATION_BATCH = "2";
      ({ s, blobDir } = makeStore());
      await s.addStream("sess-1", [{ role: "user", content: "three facts" }]);
      const three = JSON.stringify([
        { type: "fact", content: "F1.", confidence: "high" },
        { type: "fact", content: "F2.", confidence: "high" },
        { type: "fact", content: "F3.", confidence: "high" },
      ]);
      const { fn } = makeRecordingLLM([
        three,
        // Chunk 1 (candidates 0,1) — deliberately reversed, and mixing actions.
        JSON.stringify([
          { candidate: 1, action: "skip", target_ids: [], rationale: "drop F2" },
          { candidate: 0, action: "store", target_ids: [], rationale: "keep F1" },
        ]),
        // Chunk 2 (candidate 2), addressed as index 0 of its own chunk.
        JSON.stringify([{ candidate: 0, action: "store", target_ids: [], rationale: "keep F3" }]),
        ...TAIL,
      ]);
      const result = await distillOnce(s, fn, { storeKey: "batch-misattrib:self" });
      assert.equal(result.atoms_stored, 2, "F1 and F3 stored, F2 skipped");
      const contents = s.queryAtoms({}).items.map((a: any) => a.content).sort();
      assert.ok(contents.some((c: string) => c.includes("F1")), "F1 was stored");
      assert.ok(contents.some((c: string) => c.includes("F3")), "F3 was stored");
      assert.ok(!contents.some((c: string) => c.includes("F2")), "F2 was skipped, not stored");
    } finally {
      if (s) cleanup(s, blobDir!);
      if (prev === undefined) delete process.env.FALDA_DISTILL_CONSOLIDATION_BATCH;
      else process.env.FALDA_DISTILL_CONSOLIDATION_BATCH = prev;
    }
  });
});
