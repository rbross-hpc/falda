/**
 * File logging. NEVER stdout: on UserPromptSubmit, stdout is the injection
 * channel, so anything written there lands in the model's context.
 */
import { appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./state.mjs";

const MAX_BYTES = 1024 * 1024;

export function log(env, level, message, extra = {}) {
  try {
    const dir = stateDir(env);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "hook.log");
    try {
      if (statSync(p).size > MAX_BYTES) renameSync(p, `${p}.1`);
    } catch {}
    appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), level, message, ...extra }) + "\n");
  } catch {}
}
