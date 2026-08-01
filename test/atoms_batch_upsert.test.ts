import { Falda } from "../src/falda.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

async function main() {
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-atoms-"));
  const s = new Falda({ dbPath: ":memory:", blobDir, embed: makeLocalEmbedder(768), dim: 768 });
  try {
    const one = await s.upsertAtom({ id: "a", type: "fact", content: "batch shape compatible atom" });
    if (one.id !== "a") throw new Error("single upsert failed");
    const hits = await s.searchAtoms("batch shape", 3);
    if (!hits.some((h) => h.id === "a")) throw new Error("inserted atom not searchable");
    console.log("ATOMS UPSERT SMOKE GREEN");
  } finally {
    s.close();
    fs.rmSync(blobDir, { recursive: true, force: true });
  }
}
main();
