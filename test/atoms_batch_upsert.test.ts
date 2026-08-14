import { test } from "node:test";
import assert from "node:assert/strict";
import { Falda } from "../src/falda.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("atoms upsert: single insert is searchable", async () => {
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-atoms-"));
  const s = new Falda({ dbPath: ":memory:", blobDir, embed: makeLocalEmbedder(768), dim: 768 });
  try {
    const one = await s.upsertAtom({ id: "a", type: "fact", content: "batch shape compatible atom" });
    assert.equal(one.id, "a", "single upsert failed");
    const hits = await s.searchAtoms("batch shape", 3);
    assert.ok(hits.some((h) => h.id === "a"), "inserted atom not searchable");
  } finally {
    s.close();
    fs.rmSync(blobDir, { recursive: true, force: true });
  }
});
