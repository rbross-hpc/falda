/**
 * FALDA mcp_auth test — proves the token-file fail-fast guard.
 *
 * TokenStore.load() (used per-request, for hot-reload of rotated tokens)
 * tolerates a missing/malformed token file by treating it as `{tokens:{}}` —
 * which means every request 401s forever with no diagnostic. validateTokenFile
 * / requireTokenFile exist to catch that at boot instead, mirroring
 * boot.ts's enforceEmbeddingLock fail-fast pattern.
 *
 * Guarantees under test:
 *   1. Missing token file -> not ok.
 *   2. Malformed (non-JSON) token file -> not ok.
 *   3. Valid but empty {"tokens": {}} -> not ok (silent-lockout case).
 *   4. Valid, non-empty token file -> ok, with the correct token count.
 *   5. requireTokenFile exits(1) on any not-ok case, and does not exit on ok.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateTokenFile, requireTokenFile } from "../src/mcp_auth.js";

let root: string;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-tokfile-"));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function callRequireTokenFile(p: string): { exited: boolean; code: number | undefined } {
  const realExit = process.exit;
  let exited = false;
  let code: number | undefined;
  (process as any).exit = ((c?: number) => { exited = true; code = c; throw new Error("__exit__"); }) as any;
  try {
    requireTokenFile(p, "test");
  } catch (e: any) {
    if (e?.message !== "__exit__") throw e;
  } finally {
    process.exit = realExit;
  }
  return { exited, code };
}

test("1. missing file is not ok", () => {
  const missing = validateTokenFile(path.join(root, "nope.json"));
  assert.equal(missing.ok, false);
});

test("2. malformed JSON is not ok", () => {
  const badJsonPath = path.join(root, "bad.json");
  fs.writeFileSync(badJsonPath, "{ not valid json");
  const bad = validateTokenFile(badJsonPath);
  assert.equal(bad.ok, false);
});

test("3. valid but empty tokens map is not ok", () => {
  const emptyPath = path.join(root, "empty.json");
  fs.writeFileSync(emptyPath, JSON.stringify({ tokens: {} }));
  const empty = validateTokenFile(emptyPath);
  assert.equal(empty.ok, false, "empty tokens map is not ok");

  const noTokensKey = path.join(root, "no-tokens-key.json");
  fs.writeFileSync(noTokensKey, JSON.stringify({}));
  assert.equal(validateTokenFile(noTokensKey).ok, false, "missing 'tokens' key is not ok");
});

test("4. valid, non-empty is ok", () => {
  const goodPath = path.join(root, "good.json");
  fs.writeFileSync(goodPath, JSON.stringify({ tokens: { "tok-a": { tenants: ["proj-a"], pools: [] } } }));
  const good = validateTokenFile(goodPath);
  assert.equal(good.ok, true, "valid non-empty file is ok");
  assert.equal(good.ok === true && good.count, 1, "reports correct token count");
});

test("5. requireTokenFile exits(1) on bad, does not exit on good", () => {
  const badJsonPath = path.join(root, "bad.json");
  const emptyPath = path.join(root, "empty.json");
  const goodPath = path.join(root, "good.json");

  const r1 = callRequireTokenFile(path.join(root, "still-missing.json"));
  assert.ok(r1.exited && r1.code === 1, "requireTokenFile exits(1) on missing file");
  const r2 = callRequireTokenFile(badJsonPath);
  assert.ok(r2.exited && r2.code === 1, "requireTokenFile exits(1) on malformed JSON");
  const r3 = callRequireTokenFile(emptyPath);
  assert.ok(r3.exited && r3.code === 1, "requireTokenFile exits(1) on empty tokens map");
  const r4 = callRequireTokenFile(goodPath);
  assert.equal(r4.exited, false, "requireTokenFile does not exit on a valid file");
});
