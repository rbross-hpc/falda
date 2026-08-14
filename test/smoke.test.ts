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
    assert.equal(s.deleteStream({ session_id: "sess-1" }), 3, "T0 delete by session");

    // T1 Atoms
    const a1 = await s.upsertAtom({ type: "fact", content: "Cryostat target temperature is 4.2 K." });
    const a2 = await s.upsertAtom({ type: "preference", content: "Report calibration drift as a percentage." });
    assert.ok(a1.id && a2.id, "T1 upsert returns atom");
    const a1b = await s.upsertAtom({ id: a1.id, type: "fact", content: "Cryostat target temperature is 4.2 K (LHe)." });
    assert.equal(a1b.id, a1.id, "T1 upsert updates in place");
    assert.equal(s.queryAtoms({ type: "fact" }).total, 1, "T1 query by type");
    const aHit = await s.searchAtoms("what temperature is the cryostat", 3);
    assert.ok(aHit.length > 0, "T1 hybrid search returns hits");
    assert.equal(s.deleteAtoms([a2.id]), 1, "T1 delete by id");

    // T2 Scenes
    s.writeScene("projects/sns/run-2026-06-22.md", "# Run summary\nDetector stable.");
    assert.ok(
      s.readScene("projects/sns/run-2026-06-22.md")!.includes("Detector stable"),
      "T2 scene read round-trips",
    );
    assert.equal(s.listScenes("projects/").entries.length, 1, "T2 scene ls finds it");
    s.removeScene("projects/sns/run-2026-06-22.md");
    assert.equal(s.readScene("projects/sns/run-2026-06-22.md"), null, "T2 scene rm");

    // T3 Core
    s.writeCore("# Agent core\nDomain: experimental nuclear physics.");
    assert.ok(s.readCore().includes("nuclear physics"), "T3 core round-trips");
  } finally {
    s.close();
    fs.rmSync(blobDir, { recursive: true, force: true });
  }
});
