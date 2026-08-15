/**
 * FALDA auto-capture + auto-recall + auto-distill plugin for opencode.
 *
 * Three independent features, sharing one credential-resolution path:
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
 *
 * Install: copy this file to .opencode/plugins/falda-capture.ts (project) or
 * ~/.config/opencode/plugins/falda-capture.ts (global), and add a
 * package.json alongside it with `@modelcontextprotocol/sdk` as a dependency
 * (see ../package.json.example) — opencode runs `bun install` for you.
 */
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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

interface PendingText { sessionID: string; text: string[]; }

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

  // messageID -> accumulated text parts, until the message settles.
  const pending = new Map<string, PendingText>();
  // messageID -> role, for messages whose message.updated (settled) event
  // arrived before their text part(s) did — flush as soon as the text
  // part shows up.
  const settledRole = new Map<string, string>();
  // messageID already flushed to FALDA, to avoid double-capture.
  const flushedIds = new Set<string>();

  async function flush(messageId: string, role: string) {
    const entry = pending.get(messageId);
    if (!entry || flushedIds.has(messageId)) return;
    const text = entry.text.join("\n").trim();
    if (!text) return;
    const creds = await getCreds();
    if (!creds) return;
    pending.delete(messageId);
    settledRole.delete(messageId);
    flushedIds.add(messageId);
    try {
      await callFaldaStreamAdd(creds, entry.sessionID, role, text, messageId);
    } catch (e) {
      flushedIds.delete(messageId);
      await client.app.log({
        body: { service: "falda-capture", level: "warn", message: "capture failed", extra: { error: String(e) } },
      }).catch(() => {});
    }
  }

  return {
    event: captureEnabled ? async ({ event }) => {
      if (disabled) return;

      if (event.type === "message.part.updated") {
        const part = (event.properties as any)?.part;
        if (part?.type !== "text" || !part.text) return;
        const entry = pending.get(part.messageID) ?? { sessionID: part.sessionID, text: [] };
        entry.text = [part.text]; // TextPart carries the full accumulated text, not a delta
        pending.set(part.messageID, entry);
        const role = settledRole.get(part.messageID);
        if (role) await flush(part.messageID, role);
        return;
      }

      if (event.type === "message.updated") {
        const message = (event.properties as any)?.info;
        if (!message || message.role === "system") return;
        const isSettled = message.role === "user" || message.time?.completed !== undefined;
        if (!isSettled) return;

        if (pending.has(message.id)) {
          await flush(message.id, message.role);
        } else {
          settledRole.set(message.id, message.role);
        }
      }
    } : undefined,

    // Fires once per session (first user message only — see autoRecalled
    // above), before the LLM sees the turn. Injects a small falda_recall
    // (mode:"auto") result as an extra text part on the SAME user message,
    // so it's part of what the model reads for this turn without being a
    // separate assistant-visible tool call. Never blocks or fails the turn:
    // any error/timeout just means nothing gets injected.
    "chat.message": autoRecallEnabled ? async (input, output) => {
      if (disabled) return;
      const sessionID = input.sessionID;
      if (!sessionID || autoRecalled.has(sessionID)) return;
      autoRecalled.add(sessionID); // mark immediately — at most one attempt per session, even on failure

      const query = output.parts
        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("\n")
        .trim();
      if (!query) return;

      const creds = await getCreds();
      if (!creds) return;

      try {
        const context = await callFaldaAutoRecall(creds, query, AUTO_RECALL_TIMEOUT_MS);
        if (!context) return;
        output.parts.push({
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
