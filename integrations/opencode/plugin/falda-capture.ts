/**
 * FALDA auto-capture plugin for opencode.
 *
 * Writes each user/assistant turn to the FALDA Stream (T0) as it happens, so
 * conversation history is captured for later distillation into atoms/scenes/
 * core — without requiring the model to call a tool for every turn (models
 * are unreliable at remembering to do that; this hook is not).
 *
 * opencode's Message objects carry no text/content themselves — text lives in
 * separate Part objects (message.part.updated events), linked back to their
 * parent message by `messageID`. So this plugin accumulates text parts per
 * message id as they stream in, then flushes the assembled text to FALDA
 * once the message settles (`message.updated` with an assistant message's
 * `time.completed` set, or immediately for a user message, which doesn't
 * stream).
 *
 * Tenant resolution — FALDA is meant to be scoped **per project**, not per
 * agent/container (see ../README.md "Per-project opencode config"): each
 * project sets its own tenant in its `opencode.json`'s `mcp.falda.headers`.
 * This plugin must capture to that *same* tenant, or recall (via the
 * `falda_*` MCP tools) and capture would silently diverge. So at plugin init
 * it asks opencode for the resolved config for this project's directory
 * (`client.config.get({ query: { directory } })`, which returns the merged
 * global + project config — the same merge opencode itself uses to wire up
 * `mcp.falda`) and reuses its `mcp.falda.headers` (`Authorization`,
 * `X-Falda-Tenant`) and `url` directly. No separate credential, and no way
 * for capture to use a different tenant than recall for this project.
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
 *   FALDA_CAPTURE  "0" to disable capture entirely (default: enabled)
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

export const FaldaCapturePlugin: Plugin = async ({ client, directory }) => {
  if (process.env.FALDA_CAPTURE === "0") return {};

  // Resolved lazily on the first captured event (see "Lazy resolution"
  // above), not here — must never await server calls during plugin init.
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
    event: async ({ event }) => {
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
    },
  };
};
