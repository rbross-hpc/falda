/**
 * Per-session state. Hooks are separate processes, so opencode's in-memory
 * `autoRecalled` / `pendingPostCompactRecall` sets become one small JSON
 * file per session.
 *
 * Deliberately not under ${CLAUDE_PLUGIN_ROOT} — that is a read-only cache
 * path. FALDA_CC_STATE_DIR overrides the location (used by tests).
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
// Circular import: log.mjs imports `stateDir` from this module. Safe in
// ESM because both are hoisted function declarations used only inside
// function bodies, never at module-evaluation time.
import { log } from "./log.mjs";

const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const EMPTY = { recalled: false, postCompactPending: false };

export function stateDir(env = process.env) {
  return env.FALDA_CC_STATE_DIR ?? join(homedir(), ".falda", "claude-code");
}

export function readState(sessionId, env = process.env) {
  try {
    const raw = readFileSync(join(stateDir(env), `${sessionId}.json`), "utf8");
    const parsed = JSON.parse(raw);
    return {
      recalled: parsed.recalled === true,
      postCompactPending: parsed.postCompactPending === true,
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Atomic write (temp + rename), then opportunistic prune of stale sessions. */
export function writeState(sessionId, next, env = process.env) {
  try {
    const dir = stateDir(env);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${sessionId}.json`);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next));
    renameSync(tmp, target);
    prune(dir);
  } catch (err) {
    // State is an optimisation, never a correctness requirement — but a
    // silent failure here is dangerous: on a read-only $HOME, `recalled`
    // never persists, so EVERY prompt re-attempts a synchronous 5s recall
    // with no diagnostic. Best-effort log so that has a trail. log() itself
    // writes into the same (possibly unwritable) state dir and swallows its
    // own errors internally, so this cannot recurse or throw even when the
    // directory is genuinely unwritable.
    log(env, "warn", "writeState failed", { session_id: sessionId, error: String(err?.message ?? err) });
  }
}

function prune(dir) {
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
      } catch {}
    }
  } catch {}
}
