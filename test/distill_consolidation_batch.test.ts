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

import { parseConsolidationBatch, parseConsolidation, distillOnce } from "../src/distill/core.js";
import { consolidationBatchPrompt, consolidationPrompt } from "../src/distill/prompts.js";
import { Falda } from "../src/falda.js";
import { makeLocalEmbedder } from "../src/embedder.js";

// Helpers: build allowed-target-id sets for parseConsolidationBatch tests.
// Each entry is a set of the IDs that were shown to the LLM for that candidate.
function noTargets(): ReadonlySet<string> { return new Set(); }
function withTargets(...ids: string[]): ReadonlySet<string> { return new Set(ids); }

describe("parseConsolidationBatch", () => {
  test("maps a well-formed array by explicit index", () => {
    const raw = JSON.stringify([
      { candidate: 0, action: "store", target_ids: [], rationale: "new" },
      { candidate: 1, action: "skip", target_ids: [], rationale: "redundant" },
    ]);
    const out = parseConsolidationBatch(raw, [noTargets(), noTargets()]);
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
    const out = parseConsolidationBatch(raw, [noTargets(), withTargets("a", "b")]);
    assert.equal(out[0]?.action, "store", "candidate 0 got its own decision");
    assert.equal(out[1]?.action, "merge", "candidate 1 got its own decision");
    assert.deepEqual(out[1]?.target_ids, ["a", "b"]);
  });

  test("leaves a candidate unresolved when its index is missing", () => {
    const raw = JSON.stringify([
      { candidate: 0, action: "store", target_ids: [], rationale: "new" },
    ]);
    const out = parseConsolidationBatch(raw, [noTargets(), noTargets(), noTargets()]);
    assert.equal(out[0]?.action, "store");
    assert.equal(out[1], undefined, "candidate 1 unresolved");
    assert.equal(out[2], undefined, "candidate 2 unresolved");
  });

  test("drops an out-of-range index rather than misapplying it", () => {
    const raw = JSON.stringify([
      { candidate: 7, action: "merge", target_ids: ["x"], rationale: "oops" },
      { candidate: -1, action: "store", target_ids: [], rationale: "oops" },
    ]);
    const out = parseConsolidationBatch(raw, [noTargets(), noTargets()]);
    assert.deepEqual(out, [undefined, undefined]);
  });

  // ─── Duplicate candidate indices ────────────────────────────────────────────
  //
  // Not known to occur with real model output (no observed incident as of
  // this writing) — defensive handling for a plausible malformed reply, not
  // a fix for a real one. Behavior: keep the first VALID decision, never
  // trigger individual-retry fallback for the duplicated candidate itself,
  // and report every duplicated index via the optional onDuplicateIndex
  // callback so the caller can surface a non-fatal, auditable warning.

  describe("duplicate candidate indices", () => {
    test("two valid conflicting entries: keeps the first, reports occurrence count 2", () => {
      const raw = JSON.stringify([
        { candidate: 0, action: "store", target_ids: [], rationale: "first" },
        { candidate: 0, action: "store", target_ids: [], rationale: "second" },
      ]);
      const dups: Array<[number, number]> = [];
      const out = parseConsolidationBatch(raw, [noTargets()], (idx, count) => dups.push([idx, count]));
      assert.equal(out[0]?.rationale, "first", "first valid decision retained");
      assert.deepEqual(dups, [[0, 2]]);
    });

    test("valid first, structurally invalid second: first is retained, duplicate still reported", () => {
      const raw = JSON.stringify([
        { candidate: 0, action: "store", target_ids: [], rationale: "first" },
        { candidate: 0, action: "obliterate", target_ids: [], rationale: "second" },
      ]);
      const dups: Array<[number, number]> = [];
      const out = parseConsolidationBatch(raw, [noTargets()], (idx, count) => dups.push([idx, count]));
      assert.equal(out[0]?.rationale, "first");
      assert.deepEqual(dups, [[0, 2]]);
    });

    test("structurally invalid first, valid second: the later valid decision is accepted", () => {
      const raw = JSON.stringify([
        { candidate: 0, action: "obliterate", target_ids: [], rationale: "first" },
        { candidate: 0, action: "store", target_ids: [], rationale: "second" },
      ]);
      const dups: Array<[number, number]> = [];
      const out = parseConsolidationBatch(raw, [noTargets()], (idx, count) => dups.push([idx, count]));
      assert.equal(out[0]?.action, "store");
      assert.equal(out[0]?.rationale, "second", "no earlier valid decision existed to keep");
      assert.deepEqual(dups, [[0, 2]]);
    });

    test("three occurrences: first valid retained, one warning reports count 3", () => {
      const raw = JSON.stringify([
        { candidate: 0, action: "store", target_ids: [], rationale: "first" },
        { candidate: 0, action: "skip", target_ids: [], rationale: "second" },
        { candidate: 0, action: "store", target_ids: [], rationale: "third" },
      ]);
      const dups: Array<[number, number]> = [];
      const out = parseConsolidationBatch(raw, [noTargets()], (idx, count) => dups.push([idx, count]));
      assert.equal(out[0]?.rationale, "first");
      assert.deepEqual(dups, [[0, 3]], "exactly one callback invocation per duplicated index");
    });

    test("duplicate candidate alongside an unrelated uniquely-indexed candidate", () => {
      const raw = JSON.stringify([
        { candidate: 0, action: "store", target_ids: [], rationale: "first" },
        { candidate: 0, action: "store", target_ids: [], rationale: "second" },
        { candidate: 1, action: "skip", target_ids: [], rationale: "unaffected" },
      ]);
      const dups: Array<[number, number]> = [];
      const out = parseConsolidationBatch(raw, [noTargets(), noTargets()], (idx, count) => dups.push([idx, count]));
      assert.equal(out[0]?.rationale, "first");
      assert.equal(out[1]?.action, "skip", "unrelated candidate is unaffected by the other's duplication");
      assert.deepEqual(dups, [[0, 2]], "only the duplicated index is reported");
    });

    test("line-delimited duplicate entries behave like JSON-array duplicates", () => {
      const raw = [
        `{"candidate":0,"action":"store","target_ids":[],"rationale":"first"},`,
        `{"candidate":0,"action":"store","target_ids":[],"rationale":"second"}`,
      ].join("\n");
      const dups: Array<[number, number]> = [];
      const out = parseConsolidationBatch(raw, [noTargets()], (idx, count) => dups.push([idx, count]));
      assert.equal(out[0]?.rationale, "first");
      assert.deepEqual(dups, [[0, 2]]);
    });

    test("out-of-range or non-integer repeated values do not produce duplicate warnings", () => {
      const raw = JSON.stringify([
        { candidate: 7, action: "store", target_ids: [], rationale: "a" },
        { candidate: 7, action: "store", target_ids: [], rationale: "b" },
        { candidate: -1, action: "store", target_ids: [], rationale: "c" },
        { candidate: -1, action: "store", target_ids: [], rationale: "d" },
      ]);
      const dups: Array<[number, number]> = [];
      const out = parseConsolidationBatch(raw, [noTargets()], (idx, count) => dups.push([idx, count]));
      assert.deepEqual(out, [undefined]);
      assert.deepEqual(dups, [], "out-of-range indices are dropped, not counted as duplicates");
    });

    test("no callback provided: duplicate handling still keeps the first valid decision", () => {
      const raw = JSON.stringify([
        { candidate: 0, action: "store", target_ids: [], rationale: "first" },
        { candidate: 0, action: "store", target_ids: [], rationale: "second" },
      ]);
      const out = parseConsolidationBatch(raw, [noTargets()]);
      assert.equal(out[0]?.rationale, "first", "omitting onDuplicateIndex must not change application behavior");
    });
  });

  test("rejects an unknown action as unresolved", () => {
    const raw = JSON.stringify([
      { candidate: 0, action: "obliterate", target_ids: [], rationale: "no" },
    ]);
    assert.deepEqual(parseConsolidationBatch(raw, [noTargets()]), [undefined]);
  });

  test("returns all-unresolved for a completely malformed reply", () => {
    assert.deepEqual(
      parseConsolidationBatch("I'm afraid I can't do that.", [noTargets(), noTargets()]),
      [undefined, undefined],
    );
  });

  test("tolerates code fences and a line-delimited body", () => {
    const raw = "```json\n" +
      `{"candidate":0,"action":"store","target_ids":[],"rationale":"a"},\n` +
      `{"candidate":1,"action":"skip","target_ids":[],"rationale":"b"}\n` +
      "```";
    const out = parseConsolidationBatch(raw, [noTargets(), noTargets()]);
    assert.equal(out[0]?.action, "store");
    assert.equal(out[1]?.action, "skip");
  });

  test("non-string target_id entries are now invalid (no coercion)", () => {
    const raw = JSON.stringify([{ candidate: 0, action: "merge", target_ids: [1, 2] }]);
    const out = parseConsolidationBatch(raw, [withTargets("1", "2")]);
    assert.equal(out[0], undefined, "numeric target_ids must not be coerced to strings");
  });

  test("missing rationale is tolerated as empty string", () => {
    const raw = JSON.stringify([{ candidate: 0, action: "store", target_ids: [] }]);
    const out = parseConsolidationBatch(raw, [noTargets()]);
    assert.equal(out[0]?.action, "store");
    assert.equal(out[0]?.rationale, "");
  });

  test("bare single-object reply with valid merge targets resolves correctly", () => {
    const raw = JSON.stringify({ candidate: 0, action: "merge", target_ids: ["a", "b"], rationale: "x" });
    const out = parseConsolidationBatch(raw, [withTargets("a", "b")]);
    assert.equal(out[0]?.action, "merge");
    assert.deepEqual(out[0]?.target_ids, ["a", "b"]);
  });

  test("prose-wrapped array still parses via the array path", () => {
    const raw = 'Here is the result: [{"candidate":0,"action":"store","target_ids":[],"rationale":"n"}]';
    const out = parseConsolidationBatch(raw, [noTargets()]);
    assert.equal(out[0]?.action, "store");
  });

  // ─── Strict cardinality validation ─────────────────────────────────────────

  test("store with a non-empty target_ids is unresolved", () => {
    const raw = JSON.stringify([{ candidate: 0, action: "store", target_ids: ["a"], rationale: "r" }]);
    assert.equal(parseConsolidationBatch(raw, [withTargets("a")])[0], undefined);
  });

  test("skip with a non-empty target_ids is unresolved", () => {
    const raw = JSON.stringify([{ candidate: 0, action: "skip", target_ids: ["a"], rationale: "r" }]);
    assert.equal(parseConsolidationBatch(raw, [withTargets("a")])[0], undefined);
  });

  test("update with zero targets is unresolved", () => {
    const raw = JSON.stringify([{ candidate: 0, action: "update", target_ids: [], rationale: "r" }]);
    assert.equal(parseConsolidationBatch(raw, [noTargets()])[0], undefined);
  });

  test("update with two targets is unresolved", () => {
    const raw = JSON.stringify([{ candidate: 0, action: "update", target_ids: ["a", "b"], rationale: "r" }]);
    assert.equal(parseConsolidationBatch(raw, [withTargets("a", "b")])[0], undefined);
  });

  test("merge with zero targets is unresolved", () => {
    const raw = JSON.stringify([{ candidate: 0, action: "merge", target_ids: [], rationale: "r" }]);
    assert.equal(parseConsolidationBatch(raw, [noTargets()])[0], undefined);
  });

  test("merge with one target is unresolved", () => {
    const raw = JSON.stringify([{ candidate: 0, action: "merge", target_ids: ["a"], rationale: "r" }]);
    assert.equal(parseConsolidationBatch(raw, [withTargets("a")])[0], undefined);
  });

  test("merge with duplicate target ids is unresolved", () => {
    const raw = JSON.stringify([{ candidate: 0, action: "merge", target_ids: ["a", "a"], rationale: "r" }]);
    assert.equal(parseConsolidationBatch(raw, [withTargets("a")])[0], undefined, "dupes must not satisfy 2+ count");
  });

  // ─── Candidate-local membership ─────────────────────────────────────────────

  test("target not in allowed set is unresolved", () => {
    const raw = JSON.stringify([{ candidate: 0, action: "update", target_ids: ["unknown"], rationale: "r" }]);
    assert.equal(parseConsolidationBatch(raw, [withTargets("a", "b")])[0], undefined);
  });

  test("target from another candidate's set is unresolved", () => {
    // candidate 0 is allowed ["a"]; candidate 1 is allowed ["b"].
    // candidate 0 tries to use "b" — must be rejected.
    const raw = JSON.stringify([
      { candidate: 0, action: "update", target_ids: ["b"], rationale: "cross" },
      { candidate: 1, action: "skip",   target_ids: [],    rationale: "ok" },
    ]);
    const out = parseConsolidationBatch(raw, [withTargets("a"), withTargets("b")]);
    assert.equal(out[0], undefined, "cross-candidate target must be rejected");
    assert.equal(out[1]?.action, "skip", "valid candidate is unaffected");
  });

  test("one valid + one unknown merge target is unresolved (no partial membership)", () => {
    const raw = JSON.stringify([{ candidate: 0, action: "merge", target_ids: ["a", "invented"], rationale: "r" }]);
    assert.equal(parseConsolidationBatch(raw, [withTargets("a", "b")])[0], undefined);
  });

  test("missing target_ids field is unresolved", () => {
    const raw = JSON.stringify([{ candidate: 0, action: "store", rationale: "r" }]);
    assert.equal(parseConsolidationBatch(raw, [noTargets()])[0], undefined);
  });

  test("scalar target_ids is unresolved", () => {
    const raw = JSON.stringify([{ candidate: 0, action: "update", target_ids: "a", rationale: "r" }]);
    assert.equal(parseConsolidationBatch(raw, [withTargets("a")])[0], undefined);
  });
});

// ─── parseConsolidation (single-candidate path) ─────────────────────────────
//
// Single and batch consolidation share one validator
// (validateConsolidationDecision), so this suite deliberately mirrors the
// cardinality/membership matrix above to prove both entry points enforce an
// identical strict contract, not just the batch path exercised above.

describe("parseConsolidation", () => {
  test("store with zero targets is valid", () => {
    const dec = parseConsolidation(
      JSON.stringify({ action: "store", target_ids: [], rationale: "new" }),
      noTargets(),
    );
    assert.equal(dec?.action, "store");
    assert.deepEqual(dec?.target_ids, []);
  });

  test("skip with zero targets is valid", () => {
    const dec = parseConsolidation(
      JSON.stringify({ action: "skip", target_ids: [], rationale: "redundant" }),
      noTargets(),
    );
    assert.equal(dec?.action, "skip");
  });

  test("update with exactly one allowed target is valid", () => {
    const dec = parseConsolidation(
      JSON.stringify({ action: "update", target_ids: ["a"], rationale: "refresh" }),
      withTargets("a", "b"),
    );
    assert.equal(dec?.action, "update");
    assert.deepEqual(dec?.target_ids, ["a"]);
  });

  test("merge with two distinct allowed targets is valid", () => {
    const dec = parseConsolidation(
      JSON.stringify({ action: "merge", target_ids: ["a", "b"], rationale: "unify" }),
      withTargets("a", "b"),
    );
    assert.equal(dec?.action, "merge");
    assert.deepEqual(dec?.target_ids, ["a", "b"]);
  });

  test("missing rationale normalizes to empty string", () => {
    const dec = parseConsolidation(JSON.stringify({ action: "store", target_ids: [] }), noTargets());
    assert.equal(dec?.rationale, "");
  });

  test("non-string rationale normalizes to empty string", () => {
    const dec = parseConsolidation(
      JSON.stringify({ action: "store", target_ids: [], rationale: 42 }),
      noTargets(),
    );
    assert.equal(dec?.rationale, "");
  });

  test("tolerates a fenced JSON object", () => {
    const raw = "```json\n" + JSON.stringify({ action: "store", target_ids: [], rationale: "n" }) + "\n```";
    const dec = parseConsolidation(raw, noTargets());
    assert.equal(dec?.action, "store");
  });

  test("tolerates a prose-wrapped JSON object", () => {
    const raw = `Here is my decision: ${JSON.stringify({ action: "skip", target_ids: [], rationale: "r" })} — done.`;
    const dec = parseConsolidation(raw, noTargets());
    assert.equal(dec?.action, "skip");
  });

  test("no JSON object present is invalid", () => {
    assert.equal(parseConsolidation("I cannot decide.", noTargets()), undefined);
  });

  test("malformed JSON is invalid", () => {
    assert.equal(parseConsolidation("{action: store, target_ids: []", noTargets()), undefined);
  });

  test("non-object JSON is invalid", () => {
    assert.equal(parseConsolidation(JSON.stringify(["store"]), noTargets()), undefined);
  });

  test("unknown action is invalid", () => {
    const raw = JSON.stringify({ action: "obliterate", target_ids: [], rationale: "no" });
    assert.equal(parseConsolidation(raw, noTargets()), undefined);
  });

  test("missing target_ids is invalid", () => {
    const raw = JSON.stringify({ action: "store", rationale: "r" });
    assert.equal(parseConsolidation(raw, noTargets()), undefined);
  });

  test("scalar target_ids is invalid", () => {
    const raw = JSON.stringify({ action: "update", target_ids: "a", rationale: "r" });
    assert.equal(parseConsolidation(raw, withTargets("a")), undefined);
  });

  test("non-string target entry is invalid (no coercion)", () => {
    const raw = JSON.stringify({ action: "update", target_ids: [1], rationale: "r" });
    assert.equal(parseConsolidation(raw, withTargets("1")), undefined);
  });

  test("duplicate target ids are invalid", () => {
    const raw = JSON.stringify({ action: "merge", target_ids: ["a", "a"], rationale: "r" });
    assert.equal(parseConsolidation(raw, withTargets("a")), undefined);
  });

  test("target not in the allowed set is invalid", () => {
    const raw = JSON.stringify({ action: "update", target_ids: ["invented"], rationale: "r" });
    assert.equal(parseConsolidation(raw, withTargets("a", "b")), undefined);
  });

  test("store with non-empty target_ids is invalid", () => {
    const raw = JSON.stringify({ action: "store", target_ids: ["a"], rationale: "r" });
    assert.equal(parseConsolidation(raw, withTargets("a")), undefined);
  });

  test("skip with non-empty target_ids is invalid", () => {
    const raw = JSON.stringify({ action: "skip", target_ids: ["a"], rationale: "r" });
    assert.equal(parseConsolidation(raw, withTargets("a")), undefined);
  });

  test("update with zero targets is invalid", () => {
    const raw = JSON.stringify({ action: "update", target_ids: [], rationale: "r" });
    assert.equal(parseConsolidation(raw, noTargets()), undefined);
  });

  test("update with two targets is invalid", () => {
    const raw = JSON.stringify({ action: "update", target_ids: ["a", "b"], rationale: "r" });
    assert.equal(parseConsolidation(raw, withTargets("a", "b")), undefined);
  });

  test("merge with zero targets is invalid", () => {
    const raw = JSON.stringify({ action: "merge", target_ids: [], rationale: "r" });
    assert.equal(parseConsolidation(raw, noTargets()), undefined);
  });

  test("merge with one target is invalid", () => {
    const raw = JSON.stringify({ action: "merge", target_ids: ["a"], rationale: "r" });
    assert.equal(parseConsolidation(raw, withTargets("a")), undefined);
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

  test("a duplicated candidate index keeps the first valid decision and warns once, without a fallback call", async () => {
    const { s, blobDir } = makeStore();
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => { warnings.push(String(msg)); };
    try {
      await s.addStream("sess-1", [{ role: "user", content: "two facts" }]);
      const { fn, prompts } = makeRecordingLLM([
        TWO_CANDIDATES,
        // Candidate 0 appears twice with conflicting decisions; candidate 1
        // is uniquely indexed. Both entries for candidate 0 are structurally
        // valid, so the parser must keep the FIRST ("store") and ignore the
        // second ("skip") rather than treating duplication as unresolved.
        JSON.stringify([
          { candidate: 0, action: "store", target_ids: [], rationale: "first" },
          { candidate: 0, action: "skip", target_ids: [], rationale: "second" },
          { candidate: 1, action: "store", target_ids: [], rationale: "unaffected" },
        ]),
        ...TAIL,
      ]);
      const result = await distillOnce(s, fn, { storeKey: "batch-dup:self" });

      assert.equal(result.atoms_stored, 2, "both candidates stored: dup kept its first (store), other unaffected");
      const consolidationPrompts = prompts.filter((p) =>
        p.includes("memory consolidation assistant"));
      assert.equal(consolidationPrompts.length, 1, "no individual fallback call for the duplicated candidate");

      assert.equal(warnings.length, 1, "exactly one duplicate-index warning");
      assert.match(warnings[0], /candidate 0/, "warning identifies the duplicated candidate's global index");
      assert.match(warnings[0], /2 times/, "warning reports the occurrence count");
      assert.ok(
        !warnings[0].includes("Fact one.") && !warnings[0].includes("Fact two."),
        "warning does not leak candidate/memory content",
      );
    } finally {
      console.warn = originalWarn;
      cleanup(s, blobDir);
    }
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

describe("distillOnce: consolidation input-size cap (FALDA_DISTILL_CONSOLIDATION_MAX_CHARS)", () => {
  function withEnv(name: string, value: string | undefined, fn: () => Promise<void>) {
    const prev = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    return fn().finally(() => {
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    });
  }

  test("disabled by default: an unset cap reproduces fixed-stride chunking", async () => {
    await withEnv("FALDA_DISTILL_CONSOLIDATION_BATCH", "2", async () => {
      await withEnv("FALDA_DISTILL_CONSOLIDATION_MAX_CHARS", undefined, async () => {
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
            JSON.stringify([
              { candidate: 0, action: "store", target_ids: [], rationale: "n" },
              { candidate: 1, action: "store", target_ids: [], rationale: "n" },
            ]),
            JSON.stringify([{ candidate: 0, action: "store", target_ids: [], rationale: "n" }]),
            ...TAIL,
          ]);
          const result = await distillOnce(s, fn, { storeKey: "batch-cap-off:self" });
          assert.equal(result.atoms_stored, 3);
          const consolidationPrompts = prompts.filter((p) =>
            p.includes("memory consolidation assistant"));
          assert.equal(consolidationPrompts.length, 2,
            "with no char cap, chunking is governed by batch size alone (ceil(3/2) = 2)");
        } finally { cleanup(s, blobDir); }
      });
    });
  });

  test("a tight cap splits a chunk that would otherwise fit by count alone", async () => {
    await withEnv("FALDA_DISTILL_CONSOLIDATION_BATCH", "3", async () => {
      // Long candidate content (no retrieved neighbours needed) drives up
      // each chunk's built-prompt size deterministically, independent of
      // search-retrieval behaviour. The cap is set to fit exactly one such
      // candidate's own chunk but not two.
      const bigContent = "F1 " + "x".repeat(400) + ".";
      const oneCandidatePrompt = consolidationBatchPrompt([
        { candidate: { type: "fact", content: bigContent, confidence: "high" }, existing: [] },
      ]);
      const cap = oneCandidatePrompt.length + 20; // fits one, not two
      await withEnv("FALDA_DISTILL_CONSOLIDATION_MAX_CHARS", String(cap), async () => {
        const { s, blobDir } = makeStore();
        try {
          await s.addStream("sess-1", [{ role: "user", content: "three facts" }]);
          const three = JSON.stringify([
            { type: "fact", content: bigContent, confidence: "high" },
            { type: "fact", content: bigContent.replace("F1", "F2"), confidence: "high" },
            { type: "fact", content: bigContent.replace("F1", "F3"), confidence: "high" },
          ]);
          const { fn, prompts } = makeRecordingLLM([
            three,
            // Cap forces one candidate per chunk -> three individual-shaped
            // batch calls (each carrying just "Candidate 0").
            JSON.stringify([{ candidate: 0, action: "store", target_ids: [], rationale: "n" }]),
            JSON.stringify([{ candidate: 0, action: "store", target_ids: [], rationale: "n" }]),
            JSON.stringify([{ candidate: 0, action: "store", target_ids: [], rationale: "n" }]),
            ...TAIL,
          ]);
          const result = await distillOnce(s, fn, { storeKey: "batch-cap-tight:self" });
          assert.equal(result.atoms_stored, 3, "no candidate was dropped by the size cap");
          const consolidationPrompts = prompts.filter((p) =>
            p.includes("memory consolidation assistant"));
          assert.equal(consolidationPrompts.length, 3,
            "the cap forced three single-candidate chunks instead of one batch of three");
          // Content check, not just count: an unresolved-candidate fallback
          // to decideIndividually() also lands in this filter and could
          // coincidentally match the same call count as three genuinely
          // size-capped one-candidate chunks. Only a chunk holding more than
          // one candidate would ever mention "Candidate 1" — assert none do,
          // proving every batch call really was size 1, not a single
          // 3-candidate batch plus two individual retries.
          assert.ok(consolidationPrompts.every((p) => !p.includes("Candidate 1")),
            "no chunk held more than one candidate — the cap forced true 1-candidate chunks, " +
            "not a single 3-candidate batch that happened to need per-candidate fallback");
        } finally { cleanup(s, blobDir); }
      });
    });
  });

  test("a lone candidate exceeding the cap is still sent, not dropped", async () => {
    await withEnv("FALDA_DISTILL_CONSOLIDATION_BATCH", "5", async () => {
      await withEnv("FALDA_DISTILL_CONSOLIDATION_MAX_CHARS", "1", async () => {
        const { s, blobDir } = makeStore();
        try {
          await s.addStream("sess-1", [{ role: "user", content: "two facts" }]);
          const { fn, prompts } = makeRecordingLLM([
            TWO_CANDIDATES,
            // Cap of 1 char forces every candidate into its own chunk.
            JSON.stringify([{ candidate: 0, action: "store", target_ids: [], rationale: "n" }]),
            JSON.stringify([{ candidate: 0, action: "store", target_ids: [], rationale: "n" }]),
            ...TAIL,
          ]);
          const result = await distillOnce(s, fn, { storeKey: "batch-cap-tiny:self" });
          assert.equal(result.atoms_stored, 2, "both candidates were sent despite exceeding the cap");
          const consolidationPrompts = prompts.filter((p) =>
            p.includes("memory consolidation assistant"));
          assert.equal(consolidationPrompts.length, 2, "each candidate got its own chunk");
          // Content check: with the cap disabled, both candidates would land
          // in one 2-candidate chunk instead, whose single decideIndividually
          // fallback (for the one unresolved index) happens to also produce
          // 2 consolidation-labelled calls and 2 stored atoms — so count
          // alone does not discriminate cap-enabled from cap-disabled here.
          // Only a genuine 2-candidate batch chunk would ever mention
          // "Candidate 1".
          assert.ok(consolidationPrompts.every((p) => !p.includes("Candidate 1")),
            "each candidate was sent in its own 1-candidate chunk, not batched together " +
            "and resolved via individual-retry fallback");
        } finally { cleanup(s, blobDir); }
      });
    });
  });

  test("an unresolved candidate in a size-capped chunk still falls back individually", async () => {
    await withEnv("FALDA_DISTILL_CONSOLIDATION_BATCH", "5", async () => {
      await withEnv("FALDA_DISTILL_CONSOLIDATION_MAX_CHARS", "1", async () => {
        const { s, blobDir } = makeStore();
        try {
          await s.addStream("sess-1", [{ role: "user", content: "two facts" }]);
          const { fn, prompts } = makeRecordingLLM([
            TWO_CANDIDATES,
            // Candidate 0's own 1-candidate chunk fails to resolve...
            JSON.stringify([]),
            // ...so it retries individually, in the single-decision format.
            `{"action":"store","target_ids":[],"rationale":"retried"}`,
            // Candidate 1's own 1-candidate chunk resolves normally.
            JSON.stringify([{ candidate: 0, action: "store", target_ids: [], rationale: "n" }]),
            ...TAIL,
          ]);
          const result = await distillOnce(s, fn, { storeKey: "batch-cap-fallback:self" });
          assert.equal(result.atoms_stored, 2, "no candidate lost across the size-capped + retry path");
          const consolidationPrompts = prompts.filter((p) =>
            p.includes("memory consolidation assistant"));
          // Content check: with the cap disabled, both candidates would be
          // sent in one 2-candidate chunk, and an all-unresolved reply for
          // that chunk degrades to the same 2-candidate-stored outcome via
          // decideIndividually() for both — so atoms_stored alone does not
          // discriminate cap-enabled chunking (two separate 1-candidate
          // batch calls) from cap-disabled chunking (one 2-candidate batch
          // call plus individual retries). Only a genuine 2-candidate batch
          // chunk would ever mention "Candidate 1".
          assert.ok(consolidationPrompts.every((p) => !p.includes("Candidate 1")),
            "each candidate was size-capped into its own 1-candidate chunk");
        } finally { cleanup(s, blobDir); }
      });
    });
  });
});
