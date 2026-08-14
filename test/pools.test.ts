/**
 * FALDA pool test — proves multi-tenant isolation + opt-in shared-pool semantics.
 * Fully offline (deterministic local embedder, temp root on disk).
 *
 * Guarantees under test:
 *   1. Private "self" stores are physically isolated per tenant (no bleed).
 *   2. Sharing is opt-in: touching an undeclared pool errors.
 *   3. Non-members are denied (not_a_member).
 *   4. Read-only members cannot write (read_only).
 *   5. A readwrite member's write is visible to another (read) member — and ONLY
 *      through the pool, never through either member's private self store.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PoolManager, PoolError } from "../src/pools.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let root: string;
let pm: PoolManager;

async function throwsCode(fn: () => Promise<any> | any, code: string) {
  await assert.rejects(async () => fn(), (e: any) => e instanceof PoolError && e.code === code);
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-pools-"));
  pm = new PoolManager({ root, embed: makeLocalEmbedder(768), dim: 768 });
});

after(() => {
  pm.closeAll();
  fs.rmSync(root, { recursive: true, force: true });
});

test("1. private self isolation", async () => {
  const kSelf = pm.resolve("kukla", undefined, true);
  const oSelf = pm.resolve("ollie", undefined, true);
  await kSelf.upsertAtom({ id: "k1", type: "fact", content: "kukla private: OSTI corpus is 278,645 papers." });
  await oSelf.upsertAtom({ id: "o1", type: "fact", content: "ollie private: LUCID-100 is 91 of 91 parsed." });
  assert.notEqual(kSelf, oSelf, "self stores are distinct objects");
  assert.equal(pm.resolve("kukla", undefined, false).queryAtoms({}).total, 1, "kukla self sees only its own atom");
  assert.equal(pm.resolve("ollie", undefined, false).queryAtoms({}).total, 1, "ollie self sees only its own atom");
  const kHasO = await pm.resolve("kukla", undefined, false).searchAtoms("LUCID-100 parsed", 5);
  assert.ok(!kHasO.some((h) => h.id === "o1"), "kukla self search cannot find ollie private");
});

test("2. sharing is opt-in: undeclared pool errors", async () => {
  await throwsCode(() => pm.resolve("kukla", "ghost", true), "no_such_pool");
  await throwsCode(() => pm.resolve("kukla", "ghost", false), "no_such_pool");
  assert.throws(
    () => pm.declarePool("self", {}),
    (e: any) => e.code === "reserved",
    "reserved name 'self' cannot be declared",
  );
});

test("3. declare a shared pool with explicit roster", () => {
  const decl = pm.declarePool("corpus", { kukla: "readwrite", ollie: "read" }, "shared corpus facts");
  assert.ok(decl.members.kukla === "readwrite" && decl.members.ollie === "read", "pool declared with members");
  assert.ok(pm.poolsForTenant("kukla").some((p) => p.name === "corpus"), "pool appears in kukla's reachable set");
  assert.ok(
    pm.poolsForTenant("ollie").some((p) => p.name === "corpus" && p.access === "read"),
    "pool appears in ollie's reachable set (read)",
  );
  assert.equal(pm.poolsForTenant("piago").length, 0, "non-member sees no reachable pools");
});

test("4. access enforcement", async () => {
  await throwsCode(() => pm.resolve("piago", "corpus", false), "not_a_member");
  await throwsCode(() => pm.resolve("ollie", "corpus", true), "read_only");
});

test("5. shared write visible to other member, isolated from self", async () => {
  const kPool = pm.resolve("kukla", "corpus", true);
  await kPool.upsertAtom({ id: "shared1", type: "fact", content: "shared: Genesis Mission has 21 challenge areas." });
  assert.equal(pm.resolve("kukla", "corpus", false).queryAtoms({}).total, 1, "readwrite member wrote to pool");
  const oPoolView = pm.resolve("ollie", "corpus", false);
  assert.equal(oPoolView.queryAtoms({}).total, 1, "read member sees the shared atom");
  const oFind = await oPoolView.searchAtoms("how many challenge areas Genesis", 5);
  assert.ok(oFind.some((h) => h.id === "shared1"), "read member can search the shared atom");
  // Strict-clean: the shared atom must NOT appear in anyone's private self store.
  assert.equal(pm.resolve("kukla", undefined, false).queryAtoms({}).total, 1, "shared atom absent from kukla self");
  assert.equal(pm.resolve("ollie", undefined, false).queryAtoms({}).total, 1, "shared atom absent from ollie self");
  // And private atoms must NOT appear in the pool.
  const poolIds = pm.resolve("kukla", "corpus", false).queryAtoms({}).items.map((a: any) => a.id);
  assert.ok(poolIds.length === 1 && poolIds[0] === "shared1", "pool contains only shared atom");
});

test("6. grant() flips access live", async () => {
  pm.grant("corpus", "ollie", "readwrite");
  const oPoolW = pm.resolve("ollie", "corpus", true); // must not throw now
  await oPoolW.upsertAtom({ id: "shared2", type: "fact", content: "shared: topics 18-21 are cross-cutting platforms." });
  assert.equal(pm.resolve("kukla", "corpus", false).queryAtoms({}).total, 2, "granted member can now write");
  pm.grant("corpus", "piago", "none"); // no-op removal, must not throw
  assert.equal(pm.getPool("corpus")!.members.piago, undefined, "revoking a non-member is a safe no-op");
});
