/**
 * FALDA smoke test — exercises every tier and the hybrid recall path,
 * fully offline (deterministic local embedder, in-memory SQLite).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Falda } from "../src/falda.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("FALDA smoke: all tiers", async () => {
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-"));
  const s = new Falda({ dbPath: ":memory:", blobDir, embed: makeLocalEmbedder(768), dim: 768 });

  try {
    // T0 Stream
    const ids = await s.addStream("sess-1", [
      { role: "user", content: "We deployed the spallation neutron detector at 14.7 MeV." },
      { role: "assistant", content: "Logged. Calibration drift was under 2%." },
      { role: "user", content: "Remember the cryostat target temperature is 4.2 K." },
    ]);
    assert.equal(ids.length, 3, "T0 add returns ids");
    assert.equal(s.queryStream({ session_id: "sess-1" }).total, 3, "T0 query by session");
    const sHit = await s.searchStream("neutron detector energy", 2);
    assert.ok(sHit.length > 0, "T0 hybrid search returns hits");
    const del = s.deleteStream({ session_id: "sess-1" });
    assert.equal(del.deleted_count, 3, "T0 delete by session");

    // T1 Atoms (new enum, new fields)
    const a1 = await s.upsertAtom({ type: "fact", content: "Cryostat target temperature is 4.2 K." });
    const a2 = await s.upsertAtom({ type: "preference", content: "Report calibration drift as a percentage." });
    assert.ok(a1.id && a2.id, "T1 upsert returns atom");
    assert.equal(a1.status, "active", "T1 atom has active status");
    assert.equal(a1.confidence, "medium", "T1 atom has default confidence");
    // Metadata-only update (background) is allowed.
    const a1b = await s.upsertAtom({ id: a1.id, type: "fact", content: "Cryostat target temperature is 4.2 K.", background: "LHe bath" });
    assert.equal(a1b.id, a1.id, "T1 metadata update keeps same id");
    assert.equal(a1b.background, "LHe bath", "T1 background updated");
    assert.equal(s.queryAtoms({ type: "fact" }).total, 1, "T1 query by type");
    const aHit = await s.searchAtoms("what temperature is the cryostat", 3);
    assert.ok(aHit.length > 0, "T1 hybrid search returns hits");

    // T2 Scenes (id-addressed)
    const sc = await s.upsertScene({
      scene_kind: "episode",
      title: "Session 2026-06-22",
      atom_ids: [a1.id],
    });
    assert.ok(sc.scene_id, "T2 scene has id");
    assert.equal(sc.scene_kind, "episode", "T2 scene kind correct");
    assert.equal(sc.title, "Session 2026-06-22", "T2 scene title correct");
    const fetched = s.getScene(sc.scene_id);
    assert.ok(fetched, "T2 scene getScene returns scene");
    assert.deepEqual(fetched!.atom_ids, [a1.id], "T2 scene atom_ids correct");
    const listed = s.listScenes({ scene_kind: "episode" });
    assert.equal(listed.total, 1, "T2 listScenes finds episode");
    s.removeScene(sc.scene_id);
    assert.equal(s.getScene(sc.scene_id), null, "T2 removeScene removes it");

    // T3 Core
    s.writeCore("# Agent core\nDomain: experimental nuclear physics.");
    assert.ok(s.readCore().includes("nuclear physics"), "T3 core round-trips");
  } finally {
    s.close();
    fs.rmSync(blobDir, { recursive: true, force: true });
  }
});
