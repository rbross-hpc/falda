/**
 * End-to-end tests for the Claude Code plugin dispatcher, run against a
 * live falda serve() instance (MCP listener enabled).
 *
 * Guarantees under test:
 *   1. User and assistant prose reach T0.
 *   2. Replaying a turn is a no-op (server-side turn_id idempotency).
 *   3. Hooks exit 0 and print nothing when FALDA is unreachable/unconfigured.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serve, type ServeHandle } from "../src/server.js";
import { PRIORITY_EXPLICIT } from "../src/distill/queue.js";

const HOOK = fileURLToPath(new URL("../integrations/claude-code/hooks/falda-hook.mjs", import.meta.url));

export function runHook(
  sub: string,
  input: Record<string, unknown>,
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, sub], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

let root: string;
let handle: ServeHandle;
let env: Record<string, string>;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "falda-cc-hooks-"));
  const tokensPath = path.join(root, "tokens.json");
  fs.writeFileSync(tokensPath, JSON.stringify({ tokens: { "tok-cc": { tenants: ["ccproj"], pools: [], label: "cc" } } }));
  process.env.FALDA_EMBED = "local";
  process.env.FALDA_DIM = "32";
  // Keep distillation deterministically unreachable so no test depends on whether
  // the developer happens to be running Ollama.
  process.env.FALDA_LLM_BASE_URL = "http://127.0.0.1:1/v1";
  handle = await serve({
    httpPort: 0,
    mcpPort: 0,
    runtimeConfig: { root: path.join(root, "data"), dim: 32, tokensPath, label: "cc-hooks-test" },
  });
  const mcpPort = (handle.mcpServer!.address() as any).port;
  env = {
    FALDA_MCP_URL: `http://127.0.0.1:${mcpPort}/mcp`,
    FALDA_TOKEN: "tok-cc",
    FALDA_TENANT: "ccproj",
    FALDA_CC_STATE_DIR: path.join(root, "state"),
    // runHook spreads process.env first (see below), so without these a
    // developer running the suite with e.g. FALDA_CAPTURE=0 exported in
    // their shell would get spurious failures. Pin all four feature flags
    // to an explicit on-value here; individual tests override to "0" where
    // they specifically test the disabled path.
    FALDA_CAPTURE: "1",
    FALDA_AUTO_RECALL: "1",
    FALDA_DISTILL_ON_COMPACT: "1",
    FALDA_RECALL_ON_COMPACT: "1",
  };
});

after(() => {
  handle.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Count T0 turns for a session by asking the store directly. */
function streamCount(sessionId: string): number {
  // PoolManager.resolve(tenant, pool, write) — src/pools.ts:157.
  // queryStream returns { messages, total } — src/falda.ts:569.
  const store = handle.runtime.pools.resolve("ccproj", undefined, false);
  return store.queryStream({ session_id: sessionId }).total;
}

describe("cc plugin: stateless MCP contract", () => {
  test("a bare tools/call succeeds with no initialize and no Mcp-Session-Id", async () => {
    // This is the assumption the dependency-free client rests on. Asserted
    // directly so a server-side change to session handling fails loudly here
    // rather than silently breaking capture and recall in the field.
    const res = await fetch(env.FALDA_MCP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.FALDA_TOKEN}`,
        "X-Falda-Tenant": env.FALDA_TENANT,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "falda_whoami", arguments: {} },
      }),
    });
    assert.equal(res.status, 200);

    const mcp: any = await import("../integrations/claude-code/hooks/lib/mcp.mjs");
    const envelope = mcp.parseEnvelope(await res.text(), res.headers.get("content-type") ?? "");
    assert.ok(envelope, "response envelope parsed (bare JSON or SSE-framed)");
    assert.deepEqual(JSON.parse(envelope.result.content[0].text), { tenant: "ccproj" });
  });
});

describe("cc plugin: capture", () => {
  test("captures a user prompt into T0", async () => {
    const r = await runHook("capture-user", {
      session_id: "sess-cap-1", prompt_id: "p1", prompt: "the cryostat runs at 4.2 K",
    }, env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(streamCount("sess-cap-1"), 1);
  });

  test("captures the assistant's final message into T0", async () => {
    const r = await runHook("capture-assistant", {
      session_id: "sess-cap-2", prompt_id: "p2", last_assistant_message: "Noted, holding at 4.2 kelvin.",
    }, env);
    assert.equal(r.code, 0);
    assert.equal(streamCount("sess-cap-2"), 1);
  });

  test("replaying the same turn is a no-op (turn_id idempotency)", async () => {
    const input = { session_id: "sess-cap-3", prompt_id: "p3", prompt: "replay me" };
    await runHook("capture-user", input, env);
    await runHook("capture-user", input, env);
    assert.equal(streamCount("sess-cap-3"), 1, "second identical capture must not create a row");
  });

  test("empty prompt captures nothing", async () => {
    const r = await runHook("capture-user", { session_id: "sess-cap-4", prompt_id: "p4", prompt: "   " }, env);
    assert.equal(r.code, 0);
    assert.equal(streamCount("sess-cap-4"), 0);
  });

  test("FALDA_CAPTURE=0 disables capture", async () => {
    const r = await runHook("capture-user",
      { session_id: "sess-cap-5", prompt_id: "p5", prompt: "should not persist" },
      { ...env, FALDA_CAPTURE: "0" });
    assert.equal(r.code, 0);
    assert.equal(streamCount("sess-cap-5"), 0);
  });
});

describe("cc plugin: failure policy", () => {
  test("unreachable server still exits 0 with empty stdout", async () => {
    const r = await runHook("capture-user",
      { session_id: "sess-down", prompt_id: "pd", prompt: "x" },
      { ...env, FALDA_MCP_URL: "http://127.0.0.1:1/mcp" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  test("missing credentials is a silent no-op", async () => {
    const r = await runHook("capture-user",
      { session_id: "sess-nocreds", prompt_id: "pn", prompt: "x" },
      { ...env, FALDA_TOKEN: "", FALDA_TENANT: "" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  test("malformed stdin exits 0", async () => {
    const child = spawn(process.execPath, [HOOK, "capture-user"], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end("this is not json");
    const code = await new Promise<number>((res) => child.on("close", (c) => res(c ?? -1)));
    assert.equal(code, 0);
  });

  test("unknown subcommand exits 0", async () => {
    const r = await runHook("no-such-subcommand", { session_id: "s" }, env);
    assert.equal(r.code, 0);
  });
});

/**
 * Plant a T1 atom the recall can actually return.
 *
 * IMPORTANT: seeding via `capture-user` does NOT work here. That writes T0
 * (stream), and assembleContext (src/distill/context.ts) assembles pinned
 * atoms, ranked T1 atoms, T2 scenes and T3 core — never T0. Promoting T0 to
 * T1 requires an LLM-backed distillation pass these tests do not have.
 *
 * `pinned: true` makes the assertion independent of ranking quality: pinned
 * atoms are always admitted, budget permitting. That matters because these
 * tests run on the local deterministic embedder, whose vectors are
 * positional rather than semantic.
 */
async function seedMemory(content: string): Promise<void> {
  const mcp: any = await import("../integrations/claude-code/hooks/lib/mcp.mjs");
  const creds = { mcpUrl: env.FALDA_MCP_URL, token: env.FALDA_TOKEN, tenant: env.FALDA_TENANT };
  const saved = await mcp.callTool(creds, "falda_remember", {
    content, type: "fact", pinned: true,
  });
  assert.ok(saved?.id, "seed atom stored");
}

describe("cc plugin: auto-recall", () => {
  before(async () => {
    await seedMemory("The cryostat target temperature is 4.2 K.");
  });

  test("injects recalled context wrapped in <falda-auto-recall> on the first prompt", async () => {
    const r = await runHook("auto-recall", {
      session_id: "sess-rec-1", prompt_id: "r1", prompt: "what temperature for the cryostat?",
    }, env);

    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /^<falda-auto-recall>/);
    assert.match(ctx, /<\/falda-auto-recall>$/);
    assert.match(ctx, /falda_recall/, "tells the model it can search further itself");
  });

  test("fires only once per session", async () => {
    const first = await runHook("auto-recall",
      { session_id: "sess-rec-2", prompt_id: "a", prompt: "cryostat temperature" }, env);
    assert.notEqual(first.stdout, "", "first prompt recalls");

    const second = await runHook("auto-recall",
      { session_id: "sess-rec-2", prompt_id: "b", prompt: "cryostat temperature" }, env);
    assert.equal(second.stdout, "", "second prompt in the same session must not recall again");
  });

  test("FALDA_AUTO_RECALL=0 disables it", async () => {
    const r = await runHook("auto-recall",
      { session_id: "sess-rec-3", prompt_id: "c", prompt: "cryostat temperature" },
      { ...env, FALDA_AUTO_RECALL: "0" });
    assert.equal(r.stdout, "");
  });

  test("a failed recall does not retry on the next prompt", async () => {
    const broken = { ...env, FALDA_MCP_URL: "http://127.0.0.1:1/mcp" };
    const first = await runHook("auto-recall",
      { session_id: "sess-rec-4", prompt_id: "d", prompt: "cryostat temperature" }, broken);
    assert.equal(first.code, 0);
    assert.equal(first.stdout, "");

    // Same session, working server: the one-shot was already consumed.
    const second = await runHook("auto-recall",
      { session_id: "sess-rec-4", prompt_id: "e", prompt: "cryostat temperature" }, env);
    assert.equal(second.stdout, "", "the attempt was spent, exactly as in the opencode plugin");
  });

  test("NEVER exits 2 — a non-zero exit erases the user's prompt", async () => {
    for (const bad of [
      { ...env, FALDA_MCP_URL: "http://127.0.0.1:1/mcp" },
      { ...env, FALDA_TOKEN: "wrong-token" },
      { ...env, FALDA_MCP_URL: "not-a-url" },
    ]) {
      const r = await runHook("auto-recall",
        { session_id: `sess-never2-${Math.random()}`, prompt_id: "x", prompt: "q" }, bad);
      assert.equal(r.code, 0, `must exit 0 with env ${JSON.stringify(bad.FALDA_MCP_URL)}`);
    }
  });
});

describe("cc plugin: post-compaction recall", () => {
  before(async () => {
    // Same reason as the auto-recall suite: recall never reads T0.
    await seedMemory("The cryostat target temperature is 4.2 K.");
  });

  test("mark-compacted arms a second recall in an already-recalled session", async () => {
    // Consume the first-turn recall.
    await runHook("auto-recall",
      { session_id: "sess-pc-1", prompt_id: "f", prompt: "cryostat temperature" }, env);
    const suppressed = await runHook("auto-recall",
      { session_id: "sess-pc-1", prompt_id: "g", prompt: "cryostat temperature" }, env);
    assert.equal(suppressed.stdout, "", "still one-shot before compaction");

    await runHook("mark-compacted", { session_id: "sess-pc-1" }, env);

    const after = await runHook("auto-recall",
      { session_id: "sess-pc-1", prompt_id: "h", prompt: "cryostat temperature" }, env);
    assert.notEqual(after.stdout, "", "next real prompt after compaction recalls again");

    const later = await runHook("auto-recall",
      { session_id: "sess-pc-1", prompt_id: "i", prompt: "cryostat temperature" }, env);
    assert.equal(later.stdout, "", "one-shot per compaction, not sticky");
  });

  test("FALDA_CAPTURE=0 forces post-compaction recall off", async () => {
    // Positive control (FALDA_AUTO_RECALL stays ON throughout this test):
    // prove the session and seeding actually work before testing the gate.
    const first = await runHook("auto-recall",
      { session_id: "sess-pc-2", prompt_id: "j", prompt: "cryostat temperature" }, env);
    assert.notEqual(first.stdout, "", "first-turn recall fires with normal env");

    const second = await runHook("auto-recall",
      { session_id: "sess-pc-2", prompt_id: "k", prompt: "cryostat temperature" }, env);
    assert.equal(second.stdout, "", "one-shot consumed before we test the compact gate");

    const noCapture = { ...env, FALDA_CAPTURE: "0" };
    await runHook("mark-compacted", { session_id: "sess-pc-2" }, noCapture);

    // FALDA_AUTO_RECALL is ON here, so the only thing that can keep stdout
    // empty is recallOnCompact having been forced off by FALDA_CAPTURE=0.
    // Do not fold FALDA_AUTO_RECALL: "0" back into this env — that would
    // make the assertion pass regardless of the capture/recallOnCompact
    // coupling in lib/creds.mjs, and stop testing the thing this test is for.
    const r = await runHook("auto-recall",
      { session_id: "sess-pc-2", prompt_id: "l", prompt: "cryostat temperature" },
      noCapture);
    assert.equal(r.stdout, "", "recallOnCompact must be forced off by FALDA_CAPTURE=0");
  });
});

/**
 * Real Claude Code hook payload shapes, one per event, verified against the
 * shipped `claude` binary:
 *   strings -a ~/.local/share/claude/versions/<ver> \
 *     | grep -o 'hook_event_name:"UserPromptSubmit".\{0,120\}'
 * yields `hook_event_name:"UserPromptSubmit",prompt:r,...` — the field is
 * `prompt`, NOT `user_prompt`. The published Claude Code hook reference is
 * wrong about that (and about calling PreCompact's field `compaction_reason`
 * instead of `trigger`). A previous version of this plugin read
 * `input.user_prompt`, which is undefined on the real payload, so it
 * silently dropped every captured user prompt and killed auto-recall on
 * both the first turn and after every compaction.
 *
 * DO NOT "tidy" these back to match the docs. Driving tests through these
 * fixtures — rather than hand-written objects that quietly encode the same
 * wrong assumption as the code under test — is what catches that class of
 * bug. If you change a field name here to match a doc, you are very likely
 * reintroducing this exact regression.
 */
const REAL_PAYLOADS = {
  userPromptSubmit: (overrides: Record<string, unknown> = {}) => ({
    session_id: "sess-fixture-ups",
    prompt_id: "fx-ups-1",
    transcript_path: "/tmp/falda-fixture/transcript.jsonl",
    cwd: "/tmp/falda-fixture",
    hook_event_name: "UserPromptSubmit",
    prompt: "the cryostat runs at 4.2 K",
    ...overrides,
  }),
  stop: (overrides: Record<string, unknown> = {}) => ({
    session_id: "sess-fixture-stop",
    prompt_id: "fx-stop-1",
    transcript_path: "/tmp/falda-fixture/transcript.jsonl",
    cwd: "/tmp/falda-fixture",
    hook_event_name: "Stop",
    last_assistant_message: "Noted, holding at 4.2 kelvin.",
    stop_hook_active: false,
    ...overrides,
  }),
  preCompact: (overrides: Record<string, unknown> = {}) => ({
    session_id: "sess-fixture-precompact",
    prompt_id: "fx-pre-1",
    transcript_path: "/tmp/falda-fixture/transcript.jsonl",
    cwd: "/tmp/falda-fixture",
    hook_event_name: "PreCompact",
    trigger: "auto",
    ...overrides,
  }),
  postCompact: (overrides: Record<string, unknown> = {}) => ({
    session_id: "sess-fixture-postcompact",
    prompt_id: "fx-post-1",
    transcript_path: "/tmp/falda-fixture/transcript.jsonl",
    cwd: "/tmp/falda-fixture",
    hook_event_name: "PostCompact",
    trigger: "auto",
    compact_summary: "The session discussed cryostat temperatures.",
    ...overrides,
  }),
};

describe("cc plugin: real payload shapes (regression for the user_prompt/prompt bug)", () => {
  before(async () => {
    await seedMemory("The cryostat target temperature is 4.2 K.");
  });

  test("capture-user reads `prompt` (not `user_prompt`) from a real UserPromptSubmit payload", async () => {
    const payload = REAL_PAYLOADS.userPromptSubmit({ session_id: "sess-fixture-cap-user" });
    const r = await runHook("capture-user", payload, env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(streamCount("sess-fixture-cap-user"), 1,
      "a real UserPromptSubmit payload must reach T0 via its actual field name, `prompt`");
  });

  test("capture-assistant reads a real Stop payload (last_assistant_message, stop_hook_active present)", async () => {
    const payload = REAL_PAYLOADS.stop({ session_id: "sess-fixture-cap-asst" });
    const r = await runHook("capture-assistant", payload, env);
    assert.equal(r.code, 0);
    assert.equal(streamCount("sess-fixture-cap-asst"), 1);
  });

  test("auto-recall computes a non-empty query from `prompt` on a real UserPromptSubmit payload", async () => {
    const payload = REAL_PAYLOADS.userPromptSubmit({
      session_id: "sess-fixture-recall",
      prompt: "what temperature for the cryostat?",
    });
    const r = await runHook("auto-recall", payload, env);
    assert.equal(r.code, 0);
    assert.notEqual(r.stdout, "",
      "a real UserPromptSubmit payload must produce a non-empty query and an actual recall injection — " +
      "this is the exact path that was permanently and silently dead before the prompt/user_prompt fix");
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(out.hookSpecificOutput.additionalContext, /^<falda-auto-recall>/);
  });

  test("distill accepts a real PreCompact payload (trigger, not compaction_reason)", async () => {
    const payload = REAL_PAYLOADS.preCompact();
    const r = await runHook("distill", payload, env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  test("mark-compacted accepts a real PostCompact payload (trigger + compact_summary present)", async () => {
    const payload = REAL_PAYLOADS.postCompact();
    const r = await runHook("mark-compacted", payload, env);
    assert.equal(r.code, 0);
  });
});

describe("cc plugin: missing prompt_id (I5)", () => {
  test("capture-user omits turn_id when prompt_id is absent, so a second distinct turn is not discarded", async () => {
    // src/falda.ts's turn_id dedup (invariant 2) treats a repeated turn_id
    // as an exact duplicate WITHOUT comparing content. If turn_id were built
    // as `cc-${undefined}-user` whenever prompt_id is missing, every turn
    // after the first in a session would collide on that same literal
    // string and be silently discarded rather than stored. Omitting turn_id
    // entirely instead means duplication is possible but loss is not.
    const sessionId = "sess-no-prompt-id";
    const first = await runHook("capture-user", { session_id: sessionId, prompt: "first message, no prompt_id" }, env);
    assert.equal(first.code, 0);
    const second = await runHook("capture-user", { session_id: sessionId, prompt: "second message, no prompt_id" }, env);
    assert.equal(second.code, 0);
    assert.equal(streamCount(sessionId), 2,
      "both turns must be stored — a colliding turn_id would silently drop the second");
  });

  test("capture-assistant has the same guarantee", async () => {
    const sessionId = "sess-no-prompt-id-asst";
    await runHook("capture-assistant", { session_id: sessionId, last_assistant_message: "reply one" }, env);
    await runHook("capture-assistant", { session_id: sessionId, last_assistant_message: "reply two" }, env);
    assert.equal(streamCount(sessionId), 2);
  });
});

/**
 * Count jobs for this store at explicit priority, in any status.
 *
 * Asserting on explicit priority — rather than a raw row count — is what makes
 * these assertions both meaningful and race-free:
 *   - Race-free: enqueue/claim/complete/fail never delete the row, so the job
 *     persists at explicit priority through pending→running→done/dead. Even
 *     if the server processes the job synchronously before the MCP response
 *     returns to the client, the row stays visible here at explicit priority.
 *   - Meaningful: enqueue() coalesces onto an existing job but BUMPS its
 *     priority when the new request is higher (src/distill/queue.ts:94-101),
 *     so a successful explicit enqueue ALWAYS leaves an explicit-priority row
 *     behind, whether it inserted or coalesced.
 *   - Non-flaky: the worker's passive sweep timer may enqueue its own job for
 *     this store at PRIORITY_PASSIVE at any moment. That never satisfies this
 *     predicate, so it cannot make the test pass or fail spuriously.
 *
 * Do NOT filter on status: the point is that the row exists at the right
 * priority, immune to the server's execution timing. Do NOT weaken to a raw
 * count: job rows are never deleted here, so that comparison would be
 * vacuously true and pass even if `distill` were never implemented at all.
 */
function explicitJobs(): number {
  return (handle.runtime.queueDb.prepare(
    "SELECT COUNT(*) n FROM distill_jobs WHERE store_key=? AND priority>=?",
  ).get("ccproj:self", PRIORITY_EXPLICIT) as any).n;
}

describe("cc plugin: distill on compaction", () => {
  test("enqueues an explicit-priority job and prints nothing", async () => {
    await runHook("capture-user", {
      session_id: "sess-dis-1", prompt_id: "d1", prompt: "something worth distilling",
    }, env);

    // Deletes any existing job for this store (possibly left running by the
    // worker even after we delete, since the worker may be holding the row
    // as 'running' right now; the completeJob/failJob that follows is harmless
    // against zero rows).
    handle.runtime.queueDb.prepare("DELETE FROM distill_jobs WHERE store_key=?").run("ccproj:self");
    assert.equal(explicitJobs(), 0, "no explicit job before the hook runs");

    const r = await runHook("distill", { session_id: "sess-dis-1", trigger: "auto" }, env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "", "PreCompact must not inject anything");

    assert.equal(explicitJobs(), 1, "PreCompact enqueued exactly one explicit-priority job");
  });

  test("FALDA_DISTILL_ON_COMPACT=0 disables it", async () => {
    // See comment above on why we DELETE here: it is safe even if the worker
    // holds the row as 'running'.
    handle.runtime.queueDb.prepare("DELETE FROM distill_jobs WHERE store_key=?").run("ccproj:self");
    assert.equal(explicitJobs(), 0);

    const r = await runHook("distill", { session_id: "sess-dis-2" }, { ...env, FALDA_DISTILL_ON_COMPACT: "0" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");

    assert.equal(explicitJobs(), 0, "disabled: nothing may be enqueued");
  });

  test("an unreachable server does not break compaction", async () => {
    // This test verifies the SHARED exit-0 safety net in main(), not the
    // distill branch specifically — it would still pass with the whole
    // `if (sub === "distill")` block deleted. The real distill-specific
    // coverage is the first test above (enqueues a job).
    const r = await runHook("distill", { session_id: "sess-dis-3" }, { ...env, FALDA_MCP_URL: "http://127.0.0.1:1/mcp" });
    assert.equal(r.code, 0, "exit 2 would block compaction");
  });
});
