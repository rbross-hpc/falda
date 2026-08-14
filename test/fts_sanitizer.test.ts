import { test } from "node:test";
import assert from "node:assert/strict";
import { Falda } from "../src/falda.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("FTS query sanitizer: adversarial probes never throw", async () => {
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-fts-"));
  const s = new Falda({ dbPath: ":memory:", blobDir, embed: makeLocalEmbedder(768), dim: 768 });
  try {
    await s.addStream("t", [
      { role: "user", content: "memory system dual run between SOURCE and FALDA" },
      { role: "assistant", content: "the distiller promotes atoms and scenes" },
    ]);
    const probes = [
      "memory system dual run",
      "SOURCE AND FALDA",
      'distiller "scenes"',
      "atoms-and-scenes (promote)",
      "OR NOT *",
      "",
    ];
    for (const q of probes) {
      await assert.doesNotReject(
        () => s.searchStream(q, 3),
        `probe [${q}] should not throw`,
      );
    }
  } finally {
    s.close();
    fs.rmSync(blobDir, { recursive: true, force: true });
  }
});
