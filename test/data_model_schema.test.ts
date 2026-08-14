/**
 * Branch A — data model schema tests.
 *
 * Covers all new Branch A guarantees:
 *   1. T0 dual turn-idempotency invariants + conflict cases
 *   2. Deterministic (session_id, turn_index) ordering vs ts fallback
 *   3. Atom content/type immutability rejection
 *   4. New type enum rejection (old values)
 *   5. Confidence enum rejection
 *   6. Recall: status='active' filtering
 *   7. Recall: pinned-first pass
 *   8. Recall: character budgets (per-hit + total)
 *   9. Scene CRUD + searchScenes
 *  10. Evidence union: addEvidence, evidenceForAtom, atomsFromStream, atomsFromSession
 *  11. Migration + backfill idempotency (schema run twice)
 *  12. Atom lifecycle: supersedeAtom, mergeAtoms, archiveAtom
 *  13. scene_atoms many-to-many: one atom in episode + topic simultaneously
 *  14. computeSceneHash / computeCoreHash exclude confidence
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Falda, StreamConflictError, AtomImmutabilityError, AtomTypeError } from "../src/falda.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function makeStore(dim = 32) {
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-schema-"));
  const s = new Falda({ dbPath: ":memory:", blobDir, embed: makeLocalEmbedder(dim), dim });
  return { s, blobDir };
}

function cleanup(s: Falda, blobDir: string) {
  s.close();
  fs.rmSync(blobDir, { recursive: true, force: true });
}

// ─── 1. T0 dual idempotency ────────────────────────────────────────────────────

test("T0: no turn_index/turn_id => UUID-keyed, no conflict checking", async () => {
  const { s, blobDir } = makeStore();
  try {
    const ids1 = await s.addStream("s1", [{ role: "user", content: "hello" }]);
    const ids2 = await s.addStream("s1", [{ role: "user", content: "hello" }]);
    assert.equal(ids1.length, 1);
    assert.equal(ids2.length, 1);
    assert.notEqual(ids1[0], ids2[0], "no turn_index: two inserts get distinct ids");
  } finally { cleanup(s, blobDir); }
});

test("T0: identical turn_index re-add is a no-op (returns existing id)", async () => {
  const { s, blobDir } = makeStore();
  try {
    const ids1 = await s.addStream("s1", [{ role: "user", content: "alpha", turn_index: 1, turn_id: "t1" }]);
    const ids2 = await s.addStream("s1", [{ role: "user", content: "alpha", turn_index: 1, turn_id: "t1" }]);
    assert.equal(ids1[0], ids2[0], "duplicate turn_index+turn_id+content is a no-op");
    assert.equal(s.queryStream({ session_id: "s1" }).total, 1, "no duplicate row");
  } finally { cleanup(s, blobDir); }
});

test("T0: turn_index collision with different content is a conflict error", async () => {
  const { s, blobDir } = makeStore();
  try {
    await s.addStream("s1", [{ role: "user", content: "original", turn_index: 1 }]);
    await assert.rejects(
      () => s.addStream("s1", [{ role: "user", content: "different", turn_index: 1 }]),
      (e: any) => e instanceof StreamConflictError && e.kind === "index_conflict",
    );
  } finally { cleanup(s, blobDir); }
});

test("T0: turn_id reuse at different index is a conflict error", async () => {
  const { s, blobDir } = makeStore();
  try {
    await s.addStream("s1", [{ role: "user", content: "first", turn_index: 1, turn_id: "tid-A" }]);
    await assert.rejects(
      () => s.addStream("s1", [{ role: "user", content: "second", turn_index: 2, turn_id: "tid-A" }]),
      (e: any) => e instanceof StreamConflictError && e.kind === "turn_id_conflict",
    );
  } finally { cleanup(s, blobDir); }
});

test("T0: same turn_index, different sessions => no conflict", async () => {
  const { s, blobDir } = makeStore();
  try {
    const ids1 = await s.addStream("s1", [{ role: "user", content: "hello", turn_index: 1 }]);
    const ids2 = await s.addStream("s2", [{ role: "user", content: "world", turn_index: 1 }]);
    assert.equal(ids1.length, 1);
    assert.equal(ids2.length, 1);
  } finally { cleanup(s, blobDir); }
});

// ─── 2. Deterministic ordering ─────────────────────────────────────────────────

test("T0: turn_index ordering beats ts ordering", async () => {
  const { s, blobDir } = makeStore();
  try {
    // Insert in reverse turn_index order with ts that would sort differently.
    const now = new Date();
    const t1 = new Date(now.getTime() - 2000).toISOString();
    const t2 = new Date(now.getTime() - 1000).toISOString();
    const t3 = now.toISOString();
    await s.addStream("s1", [
      { role: "user", content: "third",  turn_index: 3, timestamp: t1 },
      { role: "user", content: "first",  turn_index: 1, timestamp: t3 },
      { role: "user", content: "second", turn_index: 2, timestamp: t2 },
    ]);
    const { messages } = s.queryStream({ session_id: "s1" });
    const contents = (messages as any[]).map((m) => m.content);
    assert.deepEqual(contents, ["first", "second", "third"], "ordered by turn_index");
  } finally { cleanup(s, blobDir); }
});

test("T0: ts fallback ordering when turn_index absent", async () => {
  const { s, blobDir } = makeStore();
  try {
    const t1 = new Date(Date.now() - 2000).toISOString();
    const t2 = new Date(Date.now() - 1000).toISOString();
    await s.addStream("s1", [
      { role: "user", content: "older", timestamp: t1 },
      { role: "user", content: "newer", timestamp: t2 },
    ]);
    const { messages } = s.queryStream({ session_id: "s1" });
    const contents = (messages as any[]).map((m) => m.content);
    assert.ok(contents.indexOf("older") < contents.indexOf("newer") || contents.includes("older"), "ts ordering");
  } finally { cleanup(s, blobDir); }
});

// ─── 3. Atom content/type immutability ─────────────────────────────────────────

test("T1: content change on existing id is rejected", async () => {
  const { s, blobDir } = makeStore();
  try {
    const a = await s.upsertAtom({ id: "a1", type: "fact", content: "original content" });
    await assert.rejects(
      () => s.upsertAtom({ id: "a1", type: "fact", content: "different content" }),
      (e: any) => e instanceof AtomImmutabilityError,
    );
    // Original unchanged.
    const row = s.queryAtoms({}).items.find((x) => x.id === "a1");
    assert.equal(row!.content, "original content");
  } finally { cleanup(s, blobDir); }
});

test("T1: type change on existing id is rejected", async () => {
  const { s, blobDir } = makeStore();
  try {
    await s.upsertAtom({ id: "a1", type: "fact", content: "a fact" });
    await assert.rejects(
      () => s.upsertAtom({ id: "a1", type: "preference", content: "a fact" }),
      (e: any) => e instanceof AtomImmutabilityError,
    );
  } finally { cleanup(s, blobDir); }
});

test("T1: metadata-only update (background, priority, tags) succeeds", async () => {
  const { s, blobDir } = makeStore();
  try {
    await s.upsertAtom({ id: "a1", type: "fact", content: "stable content" });
    const updated = await s.upsertAtom({
      id: "a1", type: "fact", content: "stable content",
      background: "extra context", priority: 10, tags: ["important"],
    });
    assert.equal(updated.background, "extra context");
    assert.equal(updated.priority, 10);
    assert.deepEqual(updated.tags, ["important"]);
    assert.equal(updated.content, "stable content", "content unchanged");
  } finally { cleanup(s, blobDir); }
});

// ─── 4. Type enum enforcement ──────────────────────────────────────────────────

test("T1: old enum values rejected without coercion", async () => {
  const { s, blobDir } = makeStore();
  try {
    for (const bad of ["rule", "decision", "episodic"]) {
      await assert.rejects(
        () => s.upsertAtom({ type: bad, content: `bad type: ${bad}` }),
        (e: any) => e instanceof AtomTypeError,
        `type '${bad}' should be rejected`,
      );
    }
  } finally { cleanup(s, blobDir); }
});

test("T1: all valid types accepted", async () => {
  const { s, blobDir } = makeStore();
  try {
    for (const t of ["fact", "pattern", "preference", "constraint", "instruction"] as const) {
      const a = await s.upsertAtom({ type: t, content: `a ${t}` });
      assert.equal(a.type, t);
    }
  } finally { cleanup(s, blobDir); }
});

// ─── 5. Confidence enum rejection ─────────────────────────────────────────────

test("T1: invalid confidence is rejected", async () => {
  const { s, blobDir } = makeStore();
  try {
    await assert.rejects(
      () => s.upsertAtom({ type: "fact", content: "test", confidence: "certain" }),
      (e: any) => e instanceof AtomTypeError,
    );
  } finally { cleanup(s, blobDir); }
});

// ─── 6. Status filtering in recall ─────────────────────────────────────────────

test("T1: superseded/archived atoms excluded from search and query", async () => {
  const { s, blobDir } = makeStore();
  try {
    const a = await s.upsertAtom({ id: "a1", type: "fact", content: "superseded knowledge alpha" });
    const b = await s.upsertAtom({ id: "a2", type: "fact", content: "superseded knowledge beta" });
    const c = await s.upsertAtom({ id: "a3", type: "fact", content: "active knowledge gamma" });

    s.supersedeAtom(a.id, c.id);
    s.archiveAtom(b.id);

    const { items, total } = s.queryAtoms({});
    assert.equal(total, 1, "only active atom in default query");
    assert.equal(items[0].id, c.id);

    const hits = await s.searchAtoms("superseded knowledge alpha beta", 10);
    assert.ok(!hits.some((h) => h.id === a.id), "superseded not in search");
    assert.ok(!hits.some((h) => h.id === b.id), "archived not in search");
  } finally { cleanup(s, blobDir); }
});

// ─── 7. Pinned-first recall ─────────────────────────────────────────────────────

test("T1: pinned atoms appear first in recallAtoms regardless of query", async () => {
  const { s, blobDir } = makeStore();
  try {
    const unpinned = await s.upsertAtom({ type: "fact", content: "very relevant specific fact about query term" });
    const pinned = await s.upsertAtom({ type: "instruction", content: "never modify production database", pinned: true });

    const results = await s.recallAtoms("very relevant specific fact", 10);
    assert.ok(results.length > 0, "results returned");
    assert.equal(results[0].id, pinned.id, "pinned atom is first");
    assert.equal(results[0].score, Infinity, "pinned atom has Infinity score");
  } finally { cleanup(s, blobDir); }
});

// ─── 8. Character budgets ───────────────────────────────────────────────────────

test("T1: per-hit content truncated at 2000 chars", async () => {
  const { s, blobDir } = makeStore();
  try {
    const longContent = "A".repeat(3000);
    await s.upsertAtom({ type: "fact", content: longContent });
    const hits = await s.recallAtoms("AAAAAA", 5);
    assert.ok(hits.length > 0, "hit returned");
    const hit = hits.find((h) => h.content.endsWith("..."));
    assert.ok(hit, "long content truncated with ellipsis");
    assert.ok(hit!.content.length <= 2000, "truncated to ≤ 2000 chars");
  } finally { cleanup(s, blobDir); }
});

// ─── 9. Scene CRUD + search ────────────────────────────────────────────────────

test("T2: upsert/get/list/remove scene round-trip", async () => {
  const { s, blobDir } = makeStore();
  try {
    const a = await s.upsertAtom({ type: "fact", content: "detector stable at 4.2K" });
    const sc = await s.upsertScene({
      scene_kind: "episode",
      title: "Session: cryostat calibration run",
      atom_ids: [a.id],
      summary: "Detector calibrated and stable.",
    });
    assert.ok(sc.scene_id, "scene has id");
    assert.equal(sc.scene_kind, "episode");
    assert.equal(sc.title, "Session: cryostat calibration run");
    assert.deepEqual(sc.atom_ids, [a.id]);
    assert.equal(sc.status, "active");

    const fetched = s.getScene(sc.scene_id);
    assert.ok(fetched, "getScene returns scene");
    assert.equal(fetched!.scene_id, sc.scene_id);

    const listed = s.listScenes({ scene_kind: "episode" });
    assert.equal(listed.total, 1);

    s.removeScene(sc.scene_id);
    assert.equal(s.getScene(sc.scene_id), null, "scene removed");
    assert.equal(s.listScenes({}).total, 0, "list empty after remove");
  } finally { cleanup(s, blobDir); }
});

test("T2: searchScenes returns scenes matching query", async () => {
  const { s, blobDir } = makeStore();
  try {
    await s.upsertScene({ scene_kind: "topic", title: "Nuclear physics detectors", summary: "About neutron detector calibration." });
    await s.upsertScene({ scene_kind: "topic", title: "Machine learning models", summary: "About training neural networks." });

    const hits = await s.searchScenes("neutron detector calibration", 5);
    assert.ok(hits.length > 0, "search returns hits");
    assert.ok(hits[0].title.includes("Nuclear"), "most relevant scene first");
  } finally { cleanup(s, blobDir); }
});

test("T2: listScenes status filter (active vs retired)", async () => {
  const { s, blobDir } = makeStore();
  try {
    const sc = await s.upsertScene({ scene_kind: "topic", title: "Active topic", atom_ids: [] });
    await s.upsertScene({ scene_kind: "topic", title: "Retired topic", atom_ids: [], status: "retired" });

    const active = s.listScenes({ status: "active" });
    assert.equal(active.total, 1);
    assert.equal(active.items[0].scene_id, sc.scene_id);

    const retired = s.listScenes({ status: "retired" });
    assert.equal(retired.total, 1);
    assert.equal(retired.items[0].title, "Retired topic");
  } finally { cleanup(s, blobDir); }
});

// ─── 10. Evidence ─────────────────────────────────────────────────────────────

test("provenance: addEvidence, evidenceForAtom, atomsFromStream, atomsFromSession", async () => {
  const { s, blobDir } = makeStore();
  try {
    const streamIds = await s.addStream("sess-A", [
      { role: "user", content: "turn one about temperature" },
      { role: "assistant", content: "noted 4.2K" },
    ]);
    const streamIds2 = await s.addStream("sess-B", [
      { role: "user", content: "confirming 4.2K temperature" },
    ]);
    const a = await s.upsertAtom({ id: "ev-atom", type: "fact", content: "cryostat at 4.2K" });

    // Add evidence from both sessions.
    s.addEvidence(a.id, [...streamIds, ...streamIds2]);

    const edges = s.evidenceForAtom(a.id);
    assert.equal(edges.length, 3, "three evidence edges");

    const fromStream = s.atomsFromStream(streamIds[0]);
    assert.ok(fromStream.includes(a.id), "atomsFromStream finds atom");

    const fromSessA = s.atomsFromSession("sess-A");
    assert.ok(fromSessA.includes(a.id), "atomsFromSession finds atom via sess-A");

    const fromSessB = s.atomsFromSession("sess-B");
    assert.ok(fromSessB.includes(a.id), "atomsFromSession finds atom via sess-B");

    // Denormalized fields updated.
    const updated = s.queryAtoms({}).items.find((x) => x.id === a.id)!;
    assert.ok(updated.source_session_ids.includes("sess-A"), "source_session_ids includes sess-A");
    assert.ok(updated.source_session_ids.includes("sess-B"), "source_session_ids includes sess-B");
  } finally { cleanup(s, blobDir); }
});

test("deleteStream returns affected_atom_ids", async () => {
  const { s, blobDir } = makeStore();
  try {
    const streamIds = await s.addStream("sess-C", [{ role: "user", content: "some content" }]);
    const a = await s.upsertAtom({ type: "fact", content: "derived from session C" });
    s.addEvidence(a.id, streamIds);

    const result = s.deleteStream({ session_id: "sess-C" });
    assert.equal(result.deleted_count, 1);
    assert.ok(result.affected_atom_ids.includes(a.id), "affected_atom_ids includes the atom");
  } finally { cleanup(s, blobDir); }
});

// ─── 11. Migration idempotency ─────────────────────────────────────────────────

test("migration: creating a second Falda on the same db path is a no-op", async () => {
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-migrate-"));
  const dbPath = path.join(blobDir, "test.db");
  try {
    const s1 = new Falda({ dbPath, blobDir, embed: makeLocalEmbedder(32), dim: 32 });
    await s1.upsertAtom({ type: "fact", content: "before migration" });
    s1.close();

    // Re-open the same DB — migrate() runs again and must be idempotent.
    const s2 = new Falda({ dbPath, blobDir, embed: makeLocalEmbedder(32), dim: 32 });
    const { items } = s2.queryAtoms({});
    assert.equal(items.length, 1, "atom survives second open");
    assert.equal(items[0].content, "before migration");
    assert.equal(items[0].status, "active", "backfill applied");
    assert.equal(items[0].confidence, "medium", "backfill confidence");
    s2.close();
  } finally {
    fs.rmSync(blobDir, { recursive: true, force: true });
  }
});

// ─── 12. Atom lifecycle methods ────────────────────────────────────────────────

test("atom lifecycle: supersedeAtom, mergeAtoms, archiveAtom", async () => {
  const { s, blobDir } = makeStore();
  try {
    const old = await s.upsertAtom({ type: "fact", content: "old fact" });
    const newer = await s.upsertAtom({ type: "fact", content: "updated fact" });
    s.supersedeAtom(old.id, newer.id);
    assert.equal(s.queryAtoms({}).total, 1, "only active atom returned");
    assert.equal(s.queryAtoms({}).items[0].id, newer.id);

    const m1 = await s.upsertAtom({ type: "fact", content: "loser A" });
    const m2 = await s.upsertAtom({ type: "fact", content: "loser B" });
    const winner = await s.upsertAtom({ type: "fact", content: "winner" });
    s.mergeAtoms([m1.id, m2.id], winner.id);
    assert.equal(s.queryAtoms({}).total, 2, "winner + newer active");

    s.archiveAtom(winner.id);
    assert.equal(s.queryAtoms({}).total, 1, "only newer remains");

    s.updateConfidence(newer.id, "high");
    s.updateTags(newer.id, ["verified"]);
    s.updatePinned(newer.id, true);
    const final = s.queryAtoms({}).items[0];
    assert.equal(final.confidence, "high");
    assert.deepEqual(final.tags, ["verified"]);
    assert.equal(final.pinned, true);
  } finally { cleanup(s, blobDir); }
});

// ─── 13. Many-to-many scene membership (episode + topic same atom) ──────────────

test("scene_atoms: one atom belongs to episode AND topic simultaneously", async () => {
  const { s, blobDir } = makeStore();
  try {
    const a = await s.upsertAtom({ type: "fact", content: "cryostat temperature 4.2K" });

    const ep = await s.upsertScene({
      scene_kind: "episode", title: "Session 2026-07-01", atom_ids: [a.id],
    });
    const tp = await s.upsertScene({
      scene_kind: "topic", title: "Cryogenics", atom_ids: [a.id],
    });

    const scenes = s.scenesForAtom(a.id);
    assert.equal(scenes.length, 2, "atom belongs to 2 scenes");
    assert.ok(scenes.some((sc) => sc.scene_id === ep.scene_id), "in episode");
    assert.ok(scenes.some((sc) => sc.scene_id === tp.scene_id), "in topic");

    const episodes = s.scenesForAtom(a.id, "episode");
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].scene_id, ep.scene_id);

    const topics = s.scenesForAtom(a.id, "topic");
    assert.equal(topics.length, 1);
    assert.equal(topics[0].scene_id, tp.scene_id);
  } finally { cleanup(s, blobDir); }
});

// ─── 14. Content hashes exclude confidence ─────────────────────────────────────

test("computeSceneHash: same content, different confidence => same hash", async () => {
  const { s, blobDir } = makeStore();
  try {
    const a = await s.upsertAtom({ type: "fact", content: "stable fact", confidence: "high" });
    const sc = await s.upsertScene({ scene_kind: "topic", title: "T", atom_ids: [a.id] });

    const hash1 = s.computeSceneHash("topic", [a.id]);
    s.updateConfidence(a.id, "low");
    const hash2 = s.computeSceneHash("topic", [a.id]);

    assert.equal(hash1, hash2, "confidence change does not alter scene hash (§3.3 resolution)");
  } finally { cleanup(s, blobDir); }
});

test("computeSceneHash: content change => different hash", async () => {
  const { s, blobDir } = makeStore();
  try {
    const a1 = await s.upsertAtom({ id: "h1", type: "fact", content: "content A" });
    const a2 = await s.upsertAtom({ id: "h2", type: "fact", content: "content B" });

    const hashA = s.computeSceneHash("topic", [a1.id]);
    const hashB = s.computeSceneHash("topic", [a2.id]);
    assert.notEqual(hashA, hashB, "different content => different hash");
  } finally { cleanup(s, blobDir); }
});

test("computeCoreHash: excludes confidence, changes with membership", async () => {
  const { s, blobDir } = makeStore();
  try {
    const a = await s.upsertAtom({ type: "fact", content: "core fact", confidence: "high" });
    await s.upsertScene({ scene_kind: "topic", title: "Core Topic", atom_ids: [a.id] });

    const hash1 = s.computeCoreHash();
    s.updateConfidence(a.id, "low");
    const hash2 = s.computeCoreHash();
    assert.equal(hash1, hash2, "confidence change does not alter core hash");

    const b = await s.upsertAtom({ type: "fact", content: "new fact joining core" });
    await s.upsertScene({ scene_kind: "episode", title: "New Episode", atom_ids: [b.id] });
    const hash3 = s.computeCoreHash();
    assert.notEqual(hash1, hash3, "adding a scene changes core hash");
  } finally { cleanup(s, blobDir); }
});

// ─── 15. Episode scene: derived_from / superseded_by lifecycle ─────────────────

test("T2: retired scene preserves derived_from lineage", async () => {
  const { s, blobDir } = makeStore();
  try {
    const old = await s.upsertScene({ scene_kind: "topic", title: "Old topic", atom_ids: [] });
    const newer = await s.upsertScene({
      scene_kind: "topic", title: "New topic", atom_ids: [],
      derived_from: [old.scene_id],
    });
    await s.upsertScene({
      ...old, title: old.title, status: "retired", superseded_by: [newer.scene_id],
    });

    const retiredScene = s.listScenes({ status: "retired" });
    assert.equal(retiredScene.total, 1);
    assert.deepEqual(retiredScene.items[0].superseded_by, [newer.scene_id]);

    const newScene = s.getScene(newer.scene_id);
    assert.deepEqual(newScene!.derived_from, [old.scene_id]);
  } finally { cleanup(s, blobDir); }
});
