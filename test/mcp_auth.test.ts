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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateTokenFile, requireTokenFile } from "../src/mcp_auth.js";

let pass = 0, fail = 0;
function check(name: string, ok: boolean) {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else    { fail++; console.log(`  FAIL ${name}`); }
}

function callRequireTokenFile(path: string): { exited: boolean; code: number | undefined } {
  const realExit = process.exit;
  let exited = false;
  let code: number | undefined;
  (process as any).exit = ((c?: number) => { exited = true; code = c; throw new Error("__exit__"); }) as any;
  try {
    requireTokenFile(path, "test");
  } catch (e: any) {
    if (e?.message !== "__exit__") throw e;
  } finally {
    process.exit = realExit;
  }
  return { exited, code };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-tokfile-"));

  // ── 1. missing file ──────────────────────────────────────────────────────
  const missing = validateTokenFile(path.join(root, "nope.json"));
  check("1a missing file is not ok", missing.ok === false);

  // ── 2. malformed JSON ────────────────────────────────────────────────────
  const badJsonPath = path.join(root, "bad.json");
  fs.writeFileSync(badJsonPath, "{ not valid json");
  const bad = validateTokenFile(badJsonPath);
  check("2a malformed JSON is not ok", bad.ok === false);

  // ── 3. valid but empty tokens map ────────────────────────────────────────
  const emptyPath = path.join(root, "empty.json");
  fs.writeFileSync(emptyPath, JSON.stringify({ tokens: {} }));
  const empty = validateTokenFile(emptyPath);
  check("3a empty tokens map is not ok", empty.ok === false);
  const noTokensKey = path.join(root, "no-tokens-key.json");
  fs.writeFileSync(noTokensKey, JSON.stringify({}));
  check("3b missing 'tokens' key is not ok", validateTokenFile(noTokensKey).ok === false);

  // ── 4. valid, non-empty ──────────────────────────────────────────────────
  const goodPath = path.join(root, "good.json");
  fs.writeFileSync(goodPath, JSON.stringify({ tokens: { "tok-a": { tenants: ["proj-a"], pools: [] } } }));
  const good = validateTokenFile(goodPath);
  check("4a valid non-empty file is ok", good.ok === true);
  check("4b reports correct token count", good.ok === true && good.count === 1);

  // ── 5. requireTokenFile exits(1) on bad, does not exit on good ──────────
  const r1 = callRequireTokenFile(missingPathFor(root));
  check("5a requireTokenFile exits(1) on missing file", r1.exited && r1.code === 1);
  const r2 = callRequireTokenFile(badJsonPath);
  check("5b requireTokenFile exits(1) on malformed JSON", r2.exited && r2.code === 1);
  const r3 = callRequireTokenFile(emptyPath);
  check("5c requireTokenFile exits(1) on empty tokens map", r3.exited && r3.code === 1);
  const r4 = callRequireTokenFile(goodPath);
  check("5d requireTokenFile does not exit on a valid file", r4.exited === false);

  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\nFALDA mcp_auth: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  console.log("TOKEN FILE GUARD GREEN");
}

function missingPathFor(root: string) {
  return path.join(root, "still-missing.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
