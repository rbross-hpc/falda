#!/usr/bin/env node
/**
 * FALDA hook dispatcher for Claude Code.
 *
 * One entry point for every hook event: `falda-hook.mjs <subcommand>`, with
 * the hook's JSON payload on stdin. Credential resolution, the timeout
 * policy, and the always-exit-0 rule live here and nowhere else.
 *
 * Subcommands:
 *   capture-user        UserPromptSubmit (async) — user prose -> T0
 *   capture-assistant   Stop (async)             — assistant prose -> T0
 *   auto-recall         UserPromptSubmit (sync)  — recall + inject
 *   distill             PreCompact (async)       — enqueue distillation
 *   mark-compacted      PostCompact (async)      — arm post-compaction recall
 *
 * INVARIANT: this process always exits 0. A non-zero exit on
 * UserPromptSubmit erases the user's typed prompt.
 * INVARIANT: nothing is written to stdout except the recall injection.
 */
import { resolveCreds, features } from "./lib/creds.mjs";
import { callTool } from "./lib/mcp.mjs";
import { readState, writeState } from "./lib/state.mjs";
import { log } from "./lib/log.mjs";

const TIMEOUT_MS = 5000;

// Wrapper text matches the opencode plugin verbatim, so AGENTS.md.snippet
// and skills/falda-memory/SKILL.md describe both integrations unchanged.
const WRAPPER_OPEN =
  "<falda-auto-recall>\nThe following memory context was retrieved automatically for this task " +
  "(smaller budget than an explicit falda_recall call — call falda_recall yourself for a deeper search):\n\n";
const WRAPPER_CLOSE = "\n</falda-auto-recall>";

async function readStdin() {
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

async function capture(creds, env, sessionId, role, content, turnId) {
  // `prompt_id` is optional in the real payload (the binary builds it as
  // `Qst() ?? void 0`). If it's missing, `turnId` is undefined here — omit
  // `turn_id` entirely rather than send a colliding constant like
  // "cc-undefined-user" for the whole session. src/falda.ts's turn_id
  // dedup treats a repeated turn_id as an exact duplicate WITHOUT
  // comparing content, so a colliding turn_id silently discards every
  // turn after the first. Duplication (possible without turn_id) is far
  // cheaper than silent loss.
  const message = turnId ? { role, content, turn_id: turnId } : { role, content };
  const result = await callTool(creds, "falda_stream_add", {
    session_id: sessionId,
    messages: [message],
  }, TIMEOUT_MS);
  if (!result) log(env, "warn", "capture failed", { role, session_id: sessionId });
}

async function main() {
  const sub = process.argv[2];
  const input = await readStdin();
  const env = process.env;

  const creds = resolveCreds(env);
  if (!creds) return;

  const sessionId = input.session_id;
  if (!sessionId) return;

  const f = features(env);

  if (sub === "capture-user") {
    if (!f.capture) return;
    // `prompt` is the real UserPromptSubmit field (verified against the
    // shipped Claude Code binary — the published hook reference is wrong
    // and says `user_prompt`). `input.user_prompt` is a defensive fallback
    // only, costs nothing, and tolerates either payload shape.
    const text = String(input.prompt ?? input.user_prompt ?? "").trim();
    if (!text) return;
    await capture(creds, env, sessionId, "user", text, input.prompt_id ? `cc-${input.prompt_id}-user` : undefined);
    return;
  }

  if (sub === "capture-assistant") {
    if (!f.capture) return;
    const text = String(input.last_assistant_message ?? "").trim();
    if (!text) return;
    await capture(creds, env, sessionId, "assistant", text, input.prompt_id ? `cc-${input.prompt_id}-assistant` : undefined);
    return;
  }

  if (sub === "mark-compacted") {
    if (!f.recallOnCompact) return;
    const s = readState(sessionId, env);
    s.postCompactPending = true;
    writeState(sessionId, s, env);
    return;
  }

  if (sub === "distill") {
    if (!f.distillOnCompact) return;
    // Fire-and-forget: enqueue only. The background sweep worker
    // (FALDA_SWEEP_INTERVAL_MS) remains the safety net, so this is a latency
    // optimisation, never a dependency.
    const result = await callTool(creds, "falda_distill", {}, TIMEOUT_MS);
    if (!result) log(env, "warn", "auto-distill failed", { session_id: sessionId });
    return;
  }

  if (sub === "auto-recall") {
    const s = readState(sessionId, env);
    const firstTurn = f.autoRecall && !s.recalled;
    const postCompact = f.recallOnCompact && s.postCompactPending;
    if (!firstTurn && !postCompact) return;

    // Consume BOTH reasons before attempting, so a failure is never retried
    // on a later prompt and the two never double up on one message.
    if (firstTurn) s.recalled = true;
    s.postCompactPending = false;
    writeState(sessionId, s, env);

    // See the capture-user branch above: `prompt` is the real field name,
    // `user_prompt` is a defensive fallback only.
    const query = String(input.prompt ?? input.user_prompt ?? "").trim();
    if (!query) return;

    const result = await callTool(creds, "falda_recall", { query, mode: "auto" }, TIMEOUT_MS);
    if (!result) {
      log(env, "warn", "auto-recall failed", { session_id: sessionId });
      return;
    }
    const context = typeof result.context === "string" ? result.context.trim() : "";
    if (!context) return;

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: WRAPPER_OPEN + context + WRAPPER_CLOSE,
      },
    }));
    return;
  }
}

// Never propagate a failure into an exit code.
process.on("uncaughtException", () => { process.exitCode = 0; });
process.on("unhandledRejection", () => { process.exitCode = 0; });
main().then(
  () => { process.exitCode = 0; },
  () => { process.exitCode = 0; },
);
