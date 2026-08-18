/**
 * FALDA auto-capture + auto-recall + auto-distill + post-compaction recall
 * plugin for opencode.
 *
 * Four independent features, sharing one credential-resolution path:
 *
 * 1. Auto-capture: writes each user/assistant turn to the FALDA Stream (T0)
 *    as it happens, so conversation history is captured for later
 *    distillation into atoms/scenes/core — without requiring the model to
 *    call a tool for every turn (models are unreliable at remembering to
 *    do that; this hook is not).
 *
 *    opencode's Message objects carry no text/content themselves — text
 *    lives in separate Part objects (message.part.updated events), linked
 *    back to their parent message by `messageID`. So this plugin
 *    accumulates text parts per message id as they stream in, then flushes
 *    the assembled text to FALDA once the message settles (`message.updated`
 *    with an assistant message's `time.completed` set, or immediately for a
 *    user message, which doesn't stream).
 *
 * 2. Auto-recall: fires one `falda_recall` (mode: "auto", a smaller default
 *    budget than an explicit call — see src/recall/budgets.ts) at the start
 *    of each session and injects the result into that first user turn, so
 *    the model has relevant memory *before* it decides whether to call
 *    `falda_recall` itself. This uses the `chat.message` hook — documented,
 *    non-experimental (see opencode's plugin Hooks type) — which fires with
 *    the outgoing user message and lets a plugin push extra text parts onto
 *    it before it reaches the LLM. Session-scoped, once only (first user
 *    message), not per-turn — this is meant to prime a task, not replace
 *    the model's own judgment about when to search memory further. Never
 *    blocks the turn: wrapped in a short timeout, and any failure is
 *    logged and swallowed rather than surfaced to the user.
 *
 * 3. Auto-distill: fires one `falda_distill` (fire-and-forget, no args) on
 *    the `experimental.session.compacting` hook — which runs *before*
 *    opencode generates the compaction's continuation summary. Distillation
 *    reads from the FALDA Stream (T0), which auto-capture has already
 *    persisted server-side turn-by-turn — it does not depend on opencode's
 *    in-context window at all. So triggering it here, rather than after
 *    compaction finishes, lets the async distill job run *concurrently*
 *    with the LLM's summary generation instead of strictly after it: by the
 *    time compaction completes, distillation may already be done. This is a
 *    deliberate (if slightly unconventional) use of an experimental hook
 *    purely as a timing trigger — it does not read or write `output.context`
 *    / `output.prompt`, so it can't affect what compaction produces. Because
 *    `experimental.*` hooks may change across opencode versions, this
 *    degrades gracefully if the hook ever silently stops firing: the
 *    periodic background distillation worker (FALDA_WORKER_INTERVAL_MS)
 *    remains the safety net, and this is purely a latency optimization on
 *    top of it, not a load-bearing dependency.
 *
 * 4. Post-compaction recall: fires one additional `falda_recall` (mode:
 *    "auto") on the user's next REAL message after a session compacts,
 *    since compaction's summary may have dropped detail that FALDA's
 *    Stream (T0) still has durably. Uses the stable (non-experimental)
 *    `session.compacted` event to mark the session as "awaiting its next
 *    real message", then fires on the next `chat.message` for that session
 *    — reusing the same injection mechanism and `<falda-auto-recall>`
 *    marker as feature 2, so the model doesn't need a separate concept.
 *    Deliberately does NOT key off opencode's synthetic auto-continue turn
 *    (the "Continue if you have next steps..." message opencode injects
 *    after compaction): that turn is written directly by opencode's
 *    compaction internals and does not go through `chat.message` at all
 *    (confirmed against opencode's session/compaction.ts), so the next
 *    `chat.message` this plugin actually observes after a compaction is
 *    already the user's real next message — no synthetic-turn filtering
 *    needed, though the query text is still built only from non-synthetic
 *    text parts as a defensive fallback. One-shot per compaction (like
 *    auto-recall is one-shot per session); does not double up with feature
 *    2 since that one has already fired earlier in the same session.
 *    Independent of FALDA_AUTO_RECALL — can be enabled even if the
 *    first-turn auto-recall is disabled, and vice versa. NOT independent
 *    of capture, though: it only makes sense if auto-capture is writing
 *    this session's turns to FALDA's Stream, since that's the only source
 *    of "detail the compaction summary dropped" it can re-surface. Forced
 *    off whenever FALDA_CAPTURE=0, regardless of FALDA_RECALL_ON_COMPACT.
 *
 * Tenant resolution — FALDA is meant to be scoped **per project**, not per
 * agent/container (see ../README.md "Per-project opencode config"): each
 * project sets its own tenant in its `opencode.json`'s `mcp.falda.headers`.
 * This plugin must capture/recall against that *same* tenant, or the two
 * would silently diverge. So at plugin init it asks opencode for the
 * resolved config for this project's directory
 * (`client.config.get({ query: { directory } })`, which returns the merged
 * global + project config — the same merge opencode itself uses to wire up
 * `mcp.falda`) and reuses its `mcp.falda.headers` (`Authorization`,
 * `X-Falda-Tenant`) and `url` directly. No separate credential, and no way
 * for capture/recall to use a different tenant than the rest of this project.
 *
 * Falls back to the FALDA_MCP_URL/FALDA_MCP_TOKEN/FALDA_TENANT env vars only
 * if the resolved config has no `mcp.falda` entry (e.g. no opencode.json in
 * this project and no global default either) — this keeps the plugin usable
 * standalone (env-only, no opencode.json) for non-container setups.
 *
 * Lazy resolution — opencode awaits every plugin's factory function during
 * startup, before the server has finished coming up. Calling back into that
 * same server (`client.config.get(...)`) from inside the factory deadlocks
 * startup: the server can't answer while it's still blocked loading plugins.
 * So the factory returns its hooks immediately, and credential resolution is
 * deferred to the first captured event, then memoized (a project's tenant
 * doesn't change mid-session, so resolving once is enough).
 *
 * Config:
 *   opencode.json  mcp.falda.{url,headers.Authorization,headers.X-Falda-Tenant}
 *                  (per-project or global — see ../opencode.json.example)
 *   FALDA_MCP_URL / FALDA_MCP_TOKEN / FALDA_TENANT   fallback if no mcp.falda config resolves
 *   FALDA_CAPTURE             "0" to disable capture entirely (default: enabled)
 *   FALDA_AUTO_RECALL         "0" to disable auto-recall entirely (default: enabled)
 *   FALDA_DISTILL_ON_COMPACT  "0" to disable auto-distill-on-compaction (default: enabled)
 *   FALDA_RECALL_ON_COMPACT   "0" to disable post-compaction recall (default: enabled;
 *                             also requires FALDA_CAPTURE to be on — see feature 4 above)
 *
 * Install: copy this file to .opencode/plugins/falda-capture.ts (project) or
 * ~/.config/opencode/plugins/falda-capture.ts (global), and add a
 * package.json alongside it with `@modelcontextprotocol/sdk` as a dependency
 * (see ../package.json.example) — opencode runs `bun install` for you.
 */
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CaptureFlushQueue } from "./capture-flush.js";

interface FaldaCreds { url: string; token: string; tenant: string; }

/**
 * Resolve this project's FALDA MCP url/token/tenant from opencode's merged
 * (global + project) config, falling back to env vars. Re-resolved once at
 * plugin init (not per-message) — a project's tenant doesn't change mid-session.
 */
async function resolveFaldaCreds(client: PluginInput["client"], directory: string): Promise<FaldaCreds | undefined> {
  try {
    const { data } = await client.config.get({ query: { directory } });
    const falda = data?.mcp?.["falda"];
    if (falda && falda.type === "remote" && falda.enabled !== false) {
      const headers = falda.headers ?? {};
      const auth = headers["Authorization"] ?? headers["authorization"];
      const tenant = headers["X-Falda-Tenant"] ?? headers["x-falda-tenant"];
      const token = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : auth;
      if (falda.url && token && tenant) return { url: falda.url, token, tenant };
    }
  } catch {
    // fall through to env vars below — e.g. running outside a real opencode server
  }

  const url = process.env.FALDA_MCP_URL;
  const token = process.env.FALDA_MCP_TOKEN;
  const tenant = process.env.FALDA_TENANT;
  if (url && token && tenant) return { url, token, tenant };
  return undefined;
}

async function callFaldaStreamAdd(creds: FaldaCreds, sessionId: string, role: string, content: string, id: string) {
  const transport = new StreamableHTTPClientTransport(new URL(creds.url), {
    requestInit: { headers: { Authorization: `Bearer ${creds.token}`, "X-Falda-Tenant": creds.tenant } },
  });
  const client = new Client({ name: "opencode-falda-capture", version: "1.0" });
  try {
    await client.connect(transport);
    await client.callTool({
      name: "falda_stream_add",
      arguments: { session_id: sessionId, messages: [{ id, role, content }] },
    });
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Fire one falda_recall(mode:"auto") for the given query and return its
 * rendered context text, or undefined on any failure/timeout. Never throws
 * — caller treats undefined as "nothing to inject", not an error.
 */
async function callFaldaAutoRecall(creds: FaldaCreds, query: string, timeoutMs: number): Promise<string | undefined> {
  const transport = new StreamableHTTPClientTransport(new URL(creds.url), {
    requestInit: { headers: { Authorization: `Bearer ${creds.token}`, "X-Falda-Tenant": creds.tenant } },
  });
  const client = new Client({ name: "opencode-falda-auto-recall", version: "1.0" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`falda_recall timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([client.connect(transport), timeout]);
    const result = await Promise.race([
      client.callTool({ name: "falda_recall", arguments: { query, mode: "auto" } }),
      timeout,
    ]) as any;
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") return undefined;
    const parsed = JSON.parse(text);
    return typeof parsed?.context === "string" && parsed.context.trim() ? parsed.context : undefined;
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

/**
 * Fire one falda_distill (no args) and return once it's been enqueued, or
 * throw on failure/timeout. Fire-and-forget from the caller's perspective —
 * this only confirms the job was accepted, not that distillation finished.
 */
async function callFaldaDistill(creds: FaldaCreds, timeoutMs: number): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(creds.url), {
    requestInit: { headers: { Authorization: `Bearer ${creds.token}`, "X-Falda-Tenant": creds.tenant } },
  });
  const client = new Client({ name: "opencode-falda-auto-distill", version: "1.0" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`falda_distill timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([client.connect(transport), timeout]);
    await Promise.race([client.callTool({ name: "falda_distill", arguments: {} }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

const AUTO_RECALL_TIMEOUT_MS = 5000;
const DISTILL_TIMEOUT_MS = 5000;

export const FaldaCapturePlugin: Plugin = async ({ client, directory }) => {
  const captureEnabled = process.env.FALDA_CAPTURE !== "0";
  const autoRecallEnabled = process.env.FALDA_AUTO_RECALL !== "0";
  const distillOnCompactEnabled = process.env.FALDA_DISTILL_ON_COMPACT !== "0";
  // Post-compaction recall only makes sense if capture is also on: its
  // whole point is to re-surface detail from THIS session's Stream (T0)
  // that the compaction summary dropped, and that Stream only has fresh
  // content if auto-capture is writing to it. Without capture, this would
  // just be a second no-op-ish recall against whatever pre-existing memory
  // auto-recall (feature 2) may have already surfaced at session start.
  const recallOnCompactEnabled = captureEnabled && process.env.FALDA_RECALL_ON_COMPACT !== "0";
  if (!captureEnabled && !autoRecallEnabled && !distillOnCompactEnabled) return {};

  // Resolved lazily on the first captured event (see "Lazy resolution"
  // above), not here — must never await server calls during plugin init.
  // Shared by capture and auto-recall — one credential resolution per
  // session for both features.
  let credsPromise: Promise<FaldaCreds | undefined> | undefined;
  let disabled = false; // set once creds resolve to undefined — stop accumulating
  function getCreds(): Promise<FaldaCreds | undefined> {
    if (!credsPromise) {
      credsPromise = resolveFaldaCreds(client, directory).then((creds) => {
        if (!creds) disabled = true;
        return creds;
      });
    }
    return credsPromise;
  }

  // sessionIDs that have already received their one auto-recall injection —
  // fires once per session (first user message), not once per turn.
  const autoRecalled = new Set<string>();

  // sessionIDs whose most recent compaction hasn't yet had its post-
  // compaction recall fired — set on session.compacted, consumed (deleted)
  // on the next chat.message for that session. One-shot per compaction, so
  // a session that compacts N times gets up to N post-compaction recalls.
  const pendingPostCompactRecall = new Set<string>();

  // Pending-text bookkeeping + flush-with-restore-on-failure — see
  // capture-flush.ts (docs/future/reliability-hardening.md finding 9).
  const flushQueue = new CaptureFlushQueue();

  async function flush(messageId: string, role: string) {
    if (!flushQueue.hasDeliverableText(messageId)) return;
    const creds = await getCreds();
    if (!creds) return; // state untouched — retried on the next part/settle event
    try {
      await flushQueue.flush(messageId, role, ({ sessionID, text }) =>
        callFaldaStreamAdd(creds, sessionID, role, text, messageId));
    } catch (e) {
      // flushQueue.flush() already restored pending/settledRole on failure
      // (the actual fix — previously the accumulated text was lost here),
      // so a later text-part update or settle event, or the next flush()
      // call for this message id, can still deliver it.
      await client.app.log({
        body: { service: "falda-capture", level: "warn", message: "capture failed", extra: { error: String(e) } },
      }).catch(() => {});
    }
  }

  return {
    event: captureEnabled ? async ({ event }) => {
      if (disabled) return;

      // Stable (non-experimental) event fired when a session finishes
      // compacting — see feature 4 above. Marks the session so the next
      // chat.message fires a post-compaction recall. (recallOnCompactEnabled
      // implies captureEnabled, so this branch is reachable whenever it's on.)
      if (recallOnCompactEnabled && event.type === "session.compacted") {
        const sessionID = (event.properties as any)?.sessionID;
        if (sessionID) pendingPostCompactRecall.add(sessionID);
        return;
      }

      if (event.type === "message.part.updated") {
        const part = (event.properties as any)?.part;
        if (part?.type !== "text" || !part.text) return;
        flushQueue.recordPart(part.messageID, part.sessionID, part.text);
        const role = flushQueue.getSettledRole(part.messageID);
        if (role) await flush(part.messageID, role);
        return;
      }

      if (event.type === "message.updated") {
        const message = (event.properties as any)?.info;
        if (!message || message.role === "system") return;
        const isSettled = message.role === "user" || message.time?.completed !== undefined;
        if (!isSettled) return;

        if (flushQueue.hasPending(message.id)) {
          await flush(message.id, message.role);
        } else {
          flushQueue.setSettledRole(message.id, message.role);
        }
      }
    } : undefined,

    // Fires on every incoming user message; internally gates to at most one
    // injection per triggering reason per message (never two blocks on one
    // message — see the "both triggers on the same message" note below).
    //
    // Reason 1 — first-turn auto-recall (see autoRecalled above): once per
    // session, on the first user message, before the LLM sees the turn.
    //
    // Reason 2 — post-compaction recall (see feature 4 above and
    // pendingPostCompactRecall): once per compaction, on the next real user
    // message after a session.compacted event. Deliberately does not fire
    // on opencode's synthetic auto-continue turn, because that turn is
    // injected directly by opencode's compaction internals and never
    // reaches this hook at all (confirmed against opencode's
    // session/compaction.ts) — the next chat.message this plugin observes
    // after a compaction is already the user's real next message. The
    // `synthetic` filter on query text below is a defensive fallback only,
    // not the primary mechanism (see feature 4's doc comment above).
    //
    // Both reasons inject via the same mechanism: an extra text part on
    // the SAME user message, wrapped in `<falda-auto-recall>`, so the
    // model doesn't need to distinguish why one showed up. Never blocks or
    // fails the turn: any error/timeout just means nothing gets injected.
    //
    // If both reasons would fire on the very same message (only possible
    // if a compaction somehow completes before this session's first real
    // user message), only one recall actually fires — the post-compaction
    // flag is still consumed either way, so it never fires stale on a
    // later message.
    "chat.message": (autoRecallEnabled || recallOnCompactEnabled) ? async (input, output) => {
      if (disabled) return;
      const sessionID = input.sessionID;
      if (!sessionID) return;

      const isFirstTurnAutoRecall = autoRecallEnabled && !autoRecalled.has(sessionID);
      const isPostCompactRecall = recallOnCompactEnabled && pendingPostCompactRecall.has(sessionID);
      if (!isFirstTurnAutoRecall && !isPostCompactRecall) return;

      // Mark both immediately — at most one attempt per reason, even on
      // failure. If both happened to fire on the same message, this still
      // only runs one actual recall below (isFirstTurnAutoRecall ||
      // isPostCompactRecall already guaranteed at least one is true above).
      if (isFirstTurnAutoRecall) autoRecalled.add(sessionID);
      pendingPostCompactRecall.delete(sessionID);

      const query = output.parts
        .filter((p: any) => p?.type === "text" && typeof p.text === "string" && !p.synthetic)
        .map((p: any) => p.text)
        .join("\n")
        .trim();
      if (!query) return;

      const creds = await getCreds();
      if (!creds) return;

      try {
        const context = await callFaldaAutoRecall(creds, query, AUTO_RECALL_TIMEOUT_MS);
        if (!context) return;
        // opencode stamps id/sessionID/messageID onto its own parts *before*
        // firing chat.message, then persists whatever's in output.parts
        // afterward without re-stamping — so a plugin-appended part needs
        // all three aggregate fields itself, or opencode's decode step
        // rejects it (logged as "invalid user part before save") and it's
        // silently dropped from persisted history (though the LLM still
        // sees it for this turn). `id` only needs the "prt" prefix opencode
        // requires; it doesn't need to match opencode's own ID format.
        output.parts.push({
          id: `prt_${crypto.randomUUID().replace(/-/g, "")}`,
          sessionID: (output.message as any)?.sessionID ?? sessionID,
          messageID: output.message.id,
          type: "text",
          text: `<falda-auto-recall>\nThe following memory context was retrieved automatically for this task ` +
            `(smaller budget than an explicit falda_recall call — call falda_recall yourself for a deeper search):\n\n` +
            `${context}\n</falda-auto-recall>`,
        } as any);
      } catch (e) {
        await client.app.log({
          body: { service: "falda-capture", level: "warn", message: "auto-recall failed", extra: { error: String(e) } },
        }).catch(() => {});
      }
    } : undefined,

    // Fires before opencode generates the compaction's continuation summary
    // (see "Auto-distill" above) — used purely as a timing trigger to
    // enqueue falda_distill early enough that it can run concurrently with
    // that summary generation. Never touches output.context/output.prompt,
    // never blocks or fails the compaction: any error/timeout here is
    // logged and swallowed, with the periodic background worker as the
    // safety net.
    "experimental.session.compacting": distillOnCompactEnabled ? async () => {
      if (disabled) return;
      const creds = await getCreds();
      if (!creds) return;

      try {
        await callFaldaDistill(creds, DISTILL_TIMEOUT_MS);
      } catch (e) {
        await client.app.log({
          body: { service: "falda-capture", level: "warn", message: "auto-distill failed", extra: { error: String(e) } },
        }).catch(() => {});
      }
    } : undefined,
  };
};
