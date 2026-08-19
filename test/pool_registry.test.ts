/**
 * FALDA pool-registry durability test (docs/future/reliability-hardening.md
 * finding 12): pools.json corruption must fail loud, not silently degrade
 * to an empty registry, and writes must be atomic (temp + rename).
 *
 * Guarantees under test:
 *   1. Writes go through writeFileAtomic — no stray .tmp file survives a
 *      successful mutation.
 *   2. A corrupt (unreadable/invalid-JSON/structurally-wrong) pools.json
 *      throws PoolError("corrupt_registry") from every read path
 *      (getPool/listPools/poolsForTenant/resolve), instead of silently
 *      returning an empty registry.
 *   3. The corrupt file is NEVER overwritten as a side effect of a failed
 *      read — a subsequent mutating call also throws, and the on-disk
 *      bytes are unchanged (the actual regression this finding closes:
 *      the old code would silently clobber a corrupt-but-recoverable file
 *      with {pools:{}} on the very next write).
 *   4. Syntactically valid JSON that isn't a registry shape is rejected
 *      too (missing "pools", wrong types, a pool entry missing required
 *      fields, an invalid access value).
 *   5. A missing pools.json is a legitimate first-run state, not an error.
 *   6. A stale interrupted-write temp file left in the directory doesn't
 *      break a subsequent normal write.
 *   7. requirePoolRegistry (boot.ts) exits(1) on a corrupt registry, is a
 *      silent no-op on a missing one, and does not exit on a valid one.
 *   8. Roundtrip integrity: declare/update/grant survive a fresh
 *      PoolManager instance reading the same root back.
 *   9. falda stats' layout section warns (not silently reports zero
 *      pools) when pools.json is present but corrupt.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PoolManager, PoolError, validateRegistry, writeFileAtomic } from "../src/pools.js";
import { requirePoolRegistry } from "../src/boot.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { inspectLayout, type Warning } from "../src/stats.js";

function throwsCorrupt(fn: () => any) {
  assert.throws(fn, (e: any) => e instanceof PoolError && e.code === "corrupt_registry");
}

describe("pool registry: atomic writes", () => {
  let root: string;
  let pm: PoolManager;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-poolreg-atomic-"));
    pm = new PoolManager({ root, embed: makeLocalEmbedder(32), dim: 32 });
  });
  after(() => { pm.closeAll(); fs.rmSync(root, { recursive: true, force: true }); });

  test("no temp file survives a successful declarePool/grant", () => {
    pm.declarePool("corpus", { alice: "readwrite" }, "test pool");
    pm.grant("corpus", "bob", "read");
    const entries = fs.readdirSync(root);
    assert.deepEqual(entries.filter((e) => e.includes(".tmp")), [], "no leftover temp files");
    assert.ok(entries.includes("pools.json"), "pools.json was written");
  });

  test("writeFileAtomic writes valid content and leaves no temp", () => {
    const target = path.join(root, "standalone.json");
    writeFileAtomic(target, JSON.stringify({ a: 1 }));
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { a: 1 });
    const entries = fs.readdirSync(root);
    assert.deepEqual(entries.filter((e) => e.includes(".tmp") && e.includes("standalone")), []);
  });

  test("a stale interrupted-write temp file doesn't break a subsequent normal write", () => {
    const staleTmp = path.join(root, ".pools.json.99999.stale.tmp");
    fs.writeFileSync(staleTmp, "{ garbage, not json");
    pm.grant("corpus", "carol", "read");
    const reg = JSON.parse(fs.readFileSync(path.join(root, "pools.json"), "utf8"));
    assert.equal(reg.pools.corpus.members.carol, "read", "write succeeded despite stale temp present");
    fs.rmSync(staleTmp, { force: true });
  });
});

describe("pool registry: corrupt registry fails loud, never silently empties", () => {
  let root: string;

  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-poolreg-corrupt-")); });
  after(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function freshPm() { return new PoolManager({ root, embed: makeLocalEmbedder(32), dim: 32 }); }

  test("unreadable/invalid JSON throws corrupt_registry from every read path", () => {
    fs.writeFileSync(path.join(root, "pools.json"), "{ not valid json");
    const pm = freshPm();
    try {
      throwsCorrupt(() => pm.getPool("anything"));
      throwsCorrupt(() => pm.listPools());
      throwsCorrupt(() => pm.poolsForTenant("alice"));
      throwsCorrupt(() => pm.resolve("alice", "corpus", false));
    } finally { pm.closeAll(); }
  });

  test("the corrupt file is never overwritten by a failed read or a subsequent mutation attempt", () => {
    const regPath = path.join(root, "pools.json");
    const before = fs.readFileSync(regPath, "utf8");
    const pm = freshPm();
    try {
      throwsCorrupt(() => pm.listPools());
      // A mutating call must ALSO throw (never reach saveReg with an
      // empty/partial registry) — this is the actual regression: the old
      // code would happily write {pools:{}} here, destroying the
      // recoverable file.
      throwsCorrupt(() => pm.declarePool("newpool", { alice: "read" }));
      throwsCorrupt(() => pm.grant("corpus", "alice", "read"));
    } finally { pm.closeAll(); }
    const after = fs.readFileSync(regPath, "utf8");
    assert.equal(after, before, "corrupt pools.json bytes are untouched after failed read/mutation attempts");
  });

  test("structurally-invalid-but-valid-JSON is also rejected", () => {
    const cases: Array<[string, unknown]> = [
      ["missing pools key", {}],
      ["array instead of object", []],
      ["pools is an array", { pools: [] }],
      ["pool entry missing members", { pools: { corpus: { name: "corpus", created_at: "x", updated_at: "x" } } }],
      ["pool entry name mismatch", { pools: { corpus: { name: "other", members: {}, created_at: "x", updated_at: "x" } } }],
      ["invalid access value", { pools: { corpus: { name: "corpus", members: { alice: "superadmin" }, created_at: "x", updated_at: "x" } } }],
    ];
    for (const [label, body] of cases) {
      assert.throws(() => validateRegistry(body, "test.json"), (e: any) => e instanceof PoolError && e.code === "corrupt_registry", label);
    }
  });

  test("a well-formed empty registry and a well-formed populated registry both validate", () => {
    assert.deepEqual(validateRegistry({ pools: {} }, "x"), { pools: {} });
    const good = { pools: { corpus: { name: "corpus", description: "d", members: { alice: "read" }, created_at: "a", updated_at: "b" } } };
    assert.deepEqual(validateRegistry(good, "x"), good);
  });
});

describe("pool registry: missing file is a legitimate first-run state", () => {
  test("no pools.json -> empty registry, first declarePool creates a valid file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-poolreg-firstrun-"));
    const pm = new PoolManager({ root, embed: makeLocalEmbedder(32), dim: 32 });
    try {
      assert.deepEqual(pm.listPools(), []);
      assert.equal(fs.existsSync(path.join(root, "pools.json")), false);
      pm.declarePool("corpus", { alice: "readwrite" });
      assert.equal(fs.existsSync(path.join(root, "pools.json")), true);
      const reg = JSON.parse(fs.readFileSync(path.join(root, "pools.json"), "utf8"));
      validateRegistry(reg, path.join(root, "pools.json")); // does not throw
    } finally { pm.closeAll(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe("pool registry: roundtrip integrity across PoolManager instances", () => {
  test("declare/update/grant survive a fresh PoolManager reading the same root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-poolreg-roundtrip-"));
    try {
      const pm1 = new PoolManager({ root, embed: makeLocalEmbedder(32), dim: 32 });
      pm1.declarePool("corpus", { alice: "readwrite", bob: "read" }, "shared corpus");
      pm1.updatePool("corpus", { description: "updated desc" });
      pm1.grant("corpus", "carol", "read");
      pm1.closeAll();

      const pm2 = new PoolManager({ root, embed: makeLocalEmbedder(32), dim: 32 });
      try {
        const decl = pm2.getPool("corpus");
        assert.ok(decl);
        assert.equal(decl!.description, "updated desc");
        assert.deepEqual(decl!.members, { alice: "readwrite", bob: "read", carol: "read" });
      } finally { pm2.closeAll(); }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe("requirePoolRegistry (boot fail-fast)", () => {
  let root: string;
  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-poolreg-boot-")); });
  after(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function call(r: string): { exited: boolean; code: number | undefined } {
    const realExit = process.exit;
    let exited = false;
    let code: number | undefined;
    (process as any).exit = ((c?: number) => { exited = true; code = c; throw new Error("__exit__"); }) as any;
    try {
      requirePoolRegistry(r, "test");
    } catch (e: any) {
      if (e?.message !== "__exit__") throw e;
    } finally {
      process.exit = realExit;
    }
    return { exited, code };
  }

  test("missing pools.json does not exit", () => {
    const r = call(path.join(root, "nope-dir"));
    assert.equal(r.exited, false);
  });

  test("valid pools.json does not exit", () => {
    const goodRoot = path.join(root, "good");
    fs.mkdirSync(goodRoot, { recursive: true });
    fs.writeFileSync(path.join(goodRoot, "pools.json"), JSON.stringify({ pools: {} }));
    const r = call(goodRoot);
    assert.equal(r.exited, false);
  });

  test("corrupt (invalid JSON) pools.json exits(1)", () => {
    const badRoot = path.join(root, "bad-json");
    fs.mkdirSync(badRoot, { recursive: true });
    fs.writeFileSync(path.join(badRoot, "pools.json"), "{ not valid json");
    const r = call(badRoot);
    assert.ok(r.exited && r.code === 1);
  });

  test("structurally-invalid pools.json exits(1)", () => {
    const badRoot = path.join(root, "bad-shape");
    fs.mkdirSync(badRoot, { recursive: true });
    fs.writeFileSync(path.join(badRoot, "pools.json"), JSON.stringify({ notPools: {} }));
    const r = call(badRoot);
    assert.ok(r.exited && r.code === 1);
  });
});

describe("falda stats: layout section warns on a corrupt (not just absent) registry", () => {
  test("corrupt pools.json produces a warning, not a silent zero-pool report", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-poolreg-stats-"));
    try {
      fs.writeFileSync(path.join(root, "pools.json"), "{ not valid json");
      const warnings: Warning[] = [];
      const layout = inspectLayout(root, warnings);
      assert.equal(layout.pools_json.pool_count, 0);
      assert.ok(warnings.some((w) => w.message.includes("pools.json exists but is corrupt")), "warning surfaced for corrupt registry");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test("missing pools.json produces no such warning", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-poolreg-stats-missing-"));
    try {
      const warnings: Warning[] = [];
      const layout = inspectLayout(root, warnings);
      assert.equal(layout.pools_json.pool_count, 0);
      assert.ok(!warnings.some((w) => w.message.includes("pools.json exists but is corrupt")));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
