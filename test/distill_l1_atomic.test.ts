/**
 * Finding 1 — atomic L1 distillation (docs/future/reliability-hardening.md).
 *
 * Verifies that atom rows, their atoms_fts/atoms_vec index rows, evidence
 * edges, lifecycle changes (supersede/merge), consolidation_decisions, and
 * the watermark advance all commit in ONE synchronous SQLite transaction —
 * or none of them do — for both the public upsertAtom() path and the
 * distillation L1 pipeline (src/distill/core.ts).
 *
 * Kept separate from the large distill_core.test.ts so the atomicity
 * scenarios stay readable together. Reuses its store/mock-LLM conventions.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Falda } from "../src/falda.js";
import { distillOnce } from "../src/distill/core.js";

function makeStore(embed: (text: string) => Promise<number[]>, dim = 32) {
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-l1-atomic-"));
  const s = new Falda({ dbPath: ":memory:", blobDir, embed, dim });
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

/** Deterministic local-style embedder, wrapped so tests can arm/disarm a
 *  failure mode without touching production code. */
function makeControllableEmbedder(dim: number) {
  let shouldFail = false;
  const calls: string[] = [];
  const embed = async (text: string): Promise<number[]> => {
    calls.push(text);
    if (shouldFail) throw new Error("injected embed failure");
    const v = new Array(dim).fill(0);
    for (let i = 0; i < text.length; i++) v[i % dim] += text.charCodeAt(i) / 255;
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
  return {
    embed,
    arm: () => { shouldFail = true; },
    disarm: () => { shouldFail = false; },
    get callCount() { return calls.length; },
    /** Count how many embed() calls received exactly this text — lets tests
     *  distinguish "was the atom content embedded once" from unrelated L2
     *  scene-title/summary embed calls that happen later in the same pass. */
    countCallsFor(text: string) { return calls.filter((c) => c === text).length; },
  };
}

function atomIdFromContent(type: string, content: string): string {
  return "l1-" + createHash("sha256").update(`${type}:${content}`).digest("hex").slice(0, 24);
}

function counts(db: Database.Database, id: string) {
  return {
    atoms: (db.prepare("SELECT COUNT(*) c FROM atoms WHERE id=?").get(id) as any).c,
    fts: (db.prepare("SELECT COUNT(*) c FROM atoms_fts WHERE id=?").get(id) as any).c,
    vec: (db.prepare("SELECT COUNT(*) c FROM atoms_vec WHERE id=?").get(id) as any).c,
  };
}

// ─── Test 1 — Public atom upsert is atomic on embed failure ───────────────────

describe("Finding 1: public upsertAtom() atomicity", () => {
  test("new atom: embed failure leaves zero rows in atoms/atoms_fts/atoms_vec", async () => {
    const emb = makeControllableEmbedder(32);
    emb.arm();
    const { s, blobDir } = makeStore(emb.embed);
    try {
      const id = atomIdFromContent("fact", "never persisted");
      await assert.rejects(() => s.upsertAtom({ id, type: "fact", content: "never persisted" }));
      const db = (s as any).db as Database.Database;
      const c = counts(db, id);
      assert.equal(c.atoms, 0, "no atom row");
      assert.equal(c.fts, 0, "no fts row");
      assert.equal(c.vec, 0, "no vec row");
    } finally { cleanup(s, blobDir); }
  });

  test("existing atom: embed failure during metadata update leaves metadata/indexes untouched", async () => {
    const emb = makeControllableEmbedder(32);
    const { s, blobDir } = makeStore(emb.embed);
    try {
      const a = await s.upsertAtom({ id: "a1", type: "fact", content: "stable content", priority: 100 });
      const db = (s as any).db as Database.Database;
      const before = counts(db, "a1");
      assert.equal(before.atoms, 1);
      assert.equal(before.fts, 1);
      assert.equal(before.vec, 1);

      emb.arm();
      await assert.rejects(() => s.upsertAtom({
        id: "a1", type: "fact", content: "stable content", priority: 999, tags: ["changed"],
      }));

      const after = counts(db, "a1");
      assert.deepEqual(after, before, "index row counts unchanged");
      const row = db.prepare("SELECT * FROM atoms WHERE id=?").get("a1") as any;
      assert.equal(row.priority, 100, "metadata not partially applied");
      assert.equal(JSON.parse(row.tags).length, 0, "tags not partially applied");
    } finally { cleanup(s, blobDir); }
  });
});

// ─── Test 2 — Distillation embedding failure writes no L1 state ──────────────

describe("Finding 1: distillation embed-failure atomicity", () => {
  test("embed failure during L1 write phase leaves no candidate-owned row", async () => {
    const emb = makeControllableEmbedder(32);
    const { s, blobDir } = makeStore(emb.embed);
    try {
      await s.addStream("sess-1", [{ role: "user", content: "the widget ships in Q3" }]);

      const candidateContent = "The widget ships in Q3.";
      const newId = atomIdFromContent("fact", candidateContent);

      const llm = makeMockLLM([
        `{"type":"fact","content":"${candidateContent}","confidence":"high"}`,
        `{"action":"store","target_ids":[],"rationale":"New fact."}`,
      ]);

      // Arm failure only after extraction+consolidation have already
      // consumed their LLM responses — prepareAtomEmbedding() runs next
      // and is where this test's injected failure fires.
      const originalLlmCall = llm;
      let llmCalls = 0;
      const wrappedLlm = async (p: string) => {
        llmCalls++;
        if (llmCalls === 2) emb.arm(); // arm right after consolidation response is requested
        return originalLlmCall(p);
      };

      await assert.rejects(() => distillOnce(s, wrappedLlm, { storeKey: "embed-fail:self" }));

      const db = (s as any).db as Database.Database;
      const c = counts(db, newId);
      assert.equal(c.atoms, 0, "no atom row");
      assert.equal(c.fts, 0, "no fts row");
      assert.equal(c.vec, 0, "no vec row");
      assert.equal(
        (db.prepare("SELECT COUNT(*) c FROM atom_evidence").get() as any).c, 0,
        "no evidence row",
      );
      assert.equal(
        (db.prepare("SELECT COUNT(*) c FROM consolidation_decisions").get() as any).c, 0,
        "no decision row",
      );
      assert.equal(
        (db.prepare("SELECT COUNT(*) c FROM distill_watermark").get() as any).c, 0,
        "watermark not advanced",
      );
      // A failed telemetry row is allowed and must not fail this test.
      const passRow = db.prepare("SELECT status FROM distillation_passes").get() as any;
      if (passRow) assert.equal(passRow.status, "failed");

      // Retry after disarming: a fresh pass completes fully.
      emb.disarm();
      const llm2 = makeMockLLM([
        `{"type":"fact","content":"${candidateContent}","confidence":"high"}`,
        `{"action":"store","target_ids":[],"rationale":"New fact."}`,
        "Widget session", "Widget shipping date discussed.",
        "Widget topic", "Widget shipping facts.",
        "# Core\n\nWidget ships in Q3.",
      ]);
      const result = await distillOnce(s, llm2, { storeKey: "embed-fail:self" });
      assert.equal(result.atoms_stored, 1);

      const c2 = counts(db, newId);
      assert.equal(c2.atoms, 1);
      assert.equal(c2.fts, 1);
      assert.equal(c2.vec, 1);
      assert.ok(
        (db.prepare("SELECT COUNT(*) c FROM atom_evidence WHERE atom_id=?").get(newId) as any).c > 0,
        "evidence present after successful retry",
      );
      assert.ok(
        (db.prepare("SELECT COUNT(*) c FROM distill_watermark").get() as any).c > 0,
        "watermark advanced after successful retry",
      );
    } finally { cleanup(s, blobDir); }
  });
});

// ─── Test 3 — Mid-transaction failure rolls everything back ──────────────────

describe("Finding 1: mid-transaction rollback", () => {
  test("addEvidence throwing inside the L1 transaction rolls back atom/index/decision/watermark writes", async () => {
    const emb = makeControllableEmbedder(32);
    const { s, blobDir } = makeStore(emb.embed);
    try {
      await s.addStream("sess-1", [{ role: "user", content: "the reactor runs cold" }]);
      const candidateContent = "The reactor runs cold.";
      const newId = atomIdFromContent("fact", candidateContent);

      const llm = makeMockLLM([
        `{"type":"fact","content":"${candidateContent}","confidence":"high"}`,
        `{"action":"store","target_ids":[],"rationale":"New fact."}`,
      ]);

      const original = s.addEvidence.bind(s);
      (s as any).addEvidence = () => { throw new Error("injected L1 failure"); };
      try {
        await assert.rejects(() => distillOnce(s, llm, { storeKey: "rollback-test:self" }));
      } finally {
        (s as any).addEvidence = original;
      }

      const db = (s as any).db as Database.Database;
      const c = counts(db, newId);
      assert.equal(c.atoms, 0, "no atom row survives rollback");
      assert.equal(c.fts, 0, "no fts row survives rollback");
      assert.equal(c.vec, 0, "no vec row survives rollback");
      assert.equal(
        (db.prepare("SELECT COUNT(*) c FROM atom_evidence").get() as any).c, 0,
        "no evidence row survives rollback",
      );
      assert.equal(
        (db.prepare("SELECT COUNT(*) c FROM consolidation_decisions").get() as any).c, 0,
        "no decision row survives rollback",
      );
      assert.equal(
        (db.prepare("SELECT COUNT(*) c FROM distill_watermark").get() as any).c, 0,
        "watermark not advanced",
      );
    } finally { cleanup(s, blobDir); }
  });
});

// ─── Test 4 — Legacy orphan repair ────────────────────────────────────────────

describe("Finding 1: legacy orphan repair", () => {
  test("a pre-existing atom with missing FTS/vec rows is repaired on replay", async () => {
    const emb = makeControllableEmbedder(32);
    const { s, blobDir } = makeStore(emb.embed);
    try {
      const content = "Legacy config lives in /etc/legacy.conf.";
      const id = atomIdFromContent("fact", content);

      const created = await s.upsertAtom({ id, type: "fact", content });
      assert.equal(created.id, id);

      const db = (s as any).db as Database.Database;
      assert.equal(
        (db.prepare("SELECT COUNT(*) c FROM atom_evidence WHERE atom_id=?").get(id) as any).c, 0,
        "no evidence yet",
      );

      // Simulate the worst historical partial-write state.
      db.prepare("DELETE FROM atoms_fts WHERE id=?").run(id);
      db.prepare("DELETE FROM atoms_vec WHERE id=?").run(id);
      assert.deepEqual(counts(db, id), { atoms: 1, fts: 0, vec: 0 });

      await s.addStream("sess-1", [{ role: "user", content: "reminder: legacy config in /etc/legacy.conf" }]);

      const llm = makeMockLLM([
        `{"type":"fact","content":"${content}","confidence":"high"}`,
        `{"action":"store","target_ids":[],"rationale":"Recall matched nothing — indexes absent."}`,
        "Legacy session", "Legacy config discussed.",
        "Legacy topic", "Legacy config facts.",
        "# Core\n\nLegacy config in /etc/legacy.conf.",
      ]);

      const result = await distillOnce(s, llm, { storeKey: "orphan-repair:self" });

      const c = counts(db, id);
      assert.equal(c.atoms, 1, "exactly one atoms row");
      assert.equal(c.fts, 1, "exactly one fts row after repair");
      assert.equal(c.vec, 1, "exactly one vec row after repair");
      assert.ok(
        (db.prepare("SELECT COUNT(*) c FROM atom_evidence WHERE atom_id=?").get(id) as any).c > 0,
        "evidence attached to the new stream turn",
      );
      const decisions = db.prepare(
        "SELECT COUNT(*) c FROM consolidation_decisions WHERE pass_id=?"
      ).get(result.pass_id) as any;
      assert.equal(decisions.c, 1, "one decision row for the pass");
      assert.ok(
        (db.prepare("SELECT COUNT(*) c FROM distill_watermark").get() as any).c > 0,
        "watermark advanced",
      );
      const row = db.prepare("SELECT * FROM atoms WHERE id=?").get(id) as any;
      assert.equal(row.content, content, "existing metadata preserved");
    } finally { cleanup(s, blobDir); }
  });
});

// ─── Test 5 — Normal index consistency and duplicate candidates ──────────────

describe("Finding 1: duplicate-candidate index consistency", () => {
  test("two identical candidates produce one atom, one index row each, two decisions", async () => {
    const emb = makeControllableEmbedder(32);
    const { s, blobDir } = makeStore(emb.embed);
    try {
      await s.addStream("sess-1", [{ role: "user", content: "the fridge is set to 4 degrees" }]);
      const content = "The fridge is set to 4 degrees.";
      const id = atomIdFromContent("fact", content);

      const llm = makeMockLLM([
        // Extraction returns the SAME candidate twice on two lines.
        [
          `{"type":"fact","content":"${content}","confidence":"high"}`,
          `{"type":"fact","content":"${content}","confidence":"high"}`,
        ].join("\n"),
        `{"action":"store","target_ids":[],"rationale":"New fact."}`,
        `{"action":"store","target_ids":[],"rationale":"New fact (duplicate candidate)."}`,
        "Fridge session", "Fridge temperature discussed.",
        "Fridge topic", "Fridge facts.",
        "# Core\n\nFridge at 4 degrees.",
      ]);

      // Spy on prepareAtomEmbedding() specifically — the method core.ts
      // calls once per UNIQUE non-skip atom id during L1's precompute
      // phase. searchAtoms() also embeds candidate.content once per
      // candidate as part of consolidation recall, which is unrelated,
      // expected, per-candidate behavior — spying on the narrower internal
      // method avoids conflating the two.
      const originalPrepare = s.prepareAtomEmbedding.bind(s);
      const prepareCalls: string[] = [];
      (s as any).prepareAtomEmbedding = async (content: string) => {
        prepareCalls.push(content);
        return originalPrepare(content);
      };

      const result = await distillOnce(s, llm, { storeKey: "dup-candidate:self" });

      const db = (s as any).db as Database.Database;
      const c = counts(db, id);
      assert.equal(c.atoms, 1, "exactly one atom row");
      assert.equal(c.fts, 1, "exactly one fts row");
      assert.equal(c.vec, 1, "exactly one vec row");
      assert.ok(
        (db.prepare("SELECT COUNT(*) c FROM atom_evidence WHERE atom_id=?").get(id) as any).c > 0,
        "evidence present",
      );

      const decisions = db.prepare(
        "SELECT id FROM consolidation_decisions WHERE pass_id=? ORDER BY id"
      ).all(result.pass_id) as any[];
      assert.equal(decisions.length, 2, "two decision rows recorded");
      assert.notEqual(decisions[0].id, decisions[1].id, "distinct ordinal decision ids");

      assert.equal(result.atoms_stored, 1, "atoms_stored counts one actual new atom, not two candidate ops");

      // prepareAtomEmbedding() is called once per UNIQUE non-skip atom id,
      // not once per write-op — so the duplicate candidate must not cause a
      // second call for the same content, even though candidate search
      // (unrelated, per-candidate) does embed it twice.
      assert.equal(
        prepareCalls.filter((c) => c === content).length, 1,
        "prepareAtomEmbedding called exactly once for the unique deterministic id",
      );
    } finally { cleanup(s, blobDir); }
  });
});

// ─── Test 6 — Update-to-self attaches evidence ────────────────────────────────

describe("Finding 1: update-to-self", () => {
  test("update decision targeting the same deterministic id attaches evidence without supersede", async () => {
    const emb = makeControllableEmbedder(32);
    const { s, blobDir } = makeStore(emb.embed);
    try {
      const content = "The sensor calibrates at 4.2K.";
      const id = atomIdFromContent("fact", content);
      await s.upsertAtom({ id, type: "fact", content });

      await s.addStream("sess-1", [{ role: "user", content: "confirmed: sensor calibrates at 4.2K" }]);

      const llm = makeMockLLM([
        `{"type":"fact","content":"${content}","confidence":"high"}`,
        `{"action":"update","target_ids":["${id}"],"rationale":"Reconfirms existing fact."}`,
        "Calib session", "Calibration reconfirmed.",
        "Calib topic", "Calibration facts.",
        "# Core\n\nSensor at 4.2K.",
      ]);

      const result = await distillOnce(s, llm, { storeKey: "update-self:self" });

      const db = (s as any).db as Database.Database;
      const row = db.prepare("SELECT status FROM atoms WHERE id=?").get(id) as any;
      assert.equal(row.status, "active", "atom remains active");
      assert.ok(
        (db.prepare("SELECT COUNT(*) c FROM atom_evidence WHERE atom_id=?").get(id) as any).c > 0,
        "current stream evidence attached",
      );
      const decision = db.prepare(
        "SELECT * FROM consolidation_decisions WHERE pass_id=?"
      ).get(result.pass_id) as any;
      assert.ok(decision, "decision recorded");
      assert.equal(decision.action, "update");
      assert.equal(result.atoms_updated, 0, "no replacement occurred");
    } finally { cleanup(s, blobDir); }
  });
});

// ─── Test 7 — Merge never merges its own winner ───────────────────────────────

describe("Finding 1: merge-self exclusion", () => {
  test("merge target list including the winner's own id does not mark the winner merged", async () => {
    const emb = makeControllableEmbedder(32);
    const { s, blobDir } = makeStore(emb.embed);
    try {
      const content = "Facts A and B describe the same durable configuration.";
      const winnerId = atomIdFromContent("fact", content);
      // Pre-create the winner under its own deterministic id — search must
      // be able to surface it as a candidate target for the LLM to name it
      // in target_ids (mirroring how recall could resurface the exact
      // deterministic id as one of "existing" candidates).
      await s.upsertAtom({ id: winnerId, type: "fact", content });
      const other = await s.upsertAtom({ id: "other-atom", type: "fact", content: "Fact B, phrased differently." });

      await s.addStream("sess-1", [{ role: "user", content: "A and B are the same configuration" }]);

      const llm = makeMockLLM([
        `{"type":"fact","content":"${content}","confidence":"high"}`,
        // Target list includes BOTH the winner's own deterministic id and the other atom.
        `{"action":"merge","target_ids":["${winnerId}","${other.id}"],"rationale":"Same configuration."}`,
        "Merge session", "Merged facts.",
        "Merge topic", "Merged facts summary.",
        "# Core\n\nMerged configuration.",
      ]);

      const result = await distillOnce(s, llm, { storeKey: "merge-self:self" });

      const db = (s as any).db as Database.Database;
      const winnerRow = db.prepare("SELECT status FROM atoms WHERE id=?").get(winnerId) as any;
      assert.equal(winnerRow.status, "active", "winner remains active");
      const otherRow = db.prepare("SELECT status FROM atoms WHERE id=?").get(other.id) as any;
      assert.equal(otherRow.status, "merged", "other target becomes merged");

      assert.ok(
        (db.prepare("SELECT COUNT(*) c FROM atom_evidence WHERE atom_id=?").get(winnerId) as any).c > 0,
        "winner receives evidence",
      );

      const decision = db.prepare(
        "SELECT * FROM consolidation_decisions WHERE pass_id=?"
      ).get(result.pass_id) as any;
      const targetIds = JSON.parse(decision.target_ids);
      assert.deepEqual(targetIds.sort(), [other.id, winnerId].sort(), "decision target list recorded as given");

      assert.equal(result.atoms_merged, 1, "atoms_merged counts the one actual lifecycle merge");
    } finally { cleanup(s, blobDir); }
  });
});
