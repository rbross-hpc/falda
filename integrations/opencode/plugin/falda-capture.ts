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
 * This plugin talks to the FALDA MCP server (src/mcp.ts) using the same
 * bearer token + X-Falda-Tenant header your project's `mcp.falda` config
 * already uses (see ../opencode.json.example), so it's authorized for
 * exactly the same tenant your recall tools use — no separate credential.
 *
 * Config (env, or hardcode per project):
 *   FALDA_MCP_URL      e.g. http://falda-host:8079/mcp
 *   FALDA_MCP_TOKEN    same bearer token as opencode.json's mcp.falda.headers
 *   FALDA_TENANT       same tenant as opencode.json's mcp.falda.headers (X-Falda-Tenant)
 *   FALDA_CAPTURE      "0" to disable capture entirely (default: enabled)
 *
 * Install: copy this file to .opencode/plugins/falda-capture.ts (project) or
 * ~/.config/opencode/plugins/falda-capture.ts (global), and add a
 * package.json alongside it with `@modelcontextprotocol/sdk` as a dependency
 * (see ../package.json.example) — opencode runs `bun install` for you.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.FALDA_MCP_URL;
const MCP_TOKEN = process.env.FALDA_MCP_TOKEN;
const TENANT = process.env.FALDA_TENANT;
const ENABLED = process.env.FALDA_CAPTURE !== "0" && !!MCP_URL && !!MCP_TOKEN && !!TENANT;

interface PendingText { sessionID: string; text: string[]; }

async function callFaldaStreamAdd(sessionId: string, role: string, content: string, id: string) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL!), {
    requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}`, "X-Falda-Tenant": TENANT! } },
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

export const FaldaCapturePlugin: Plugin = async ({ client }) => {
  if (!ENABLED) return {};

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
    pending.delete(messageId);
    settledRole.delete(messageId);
    flushedIds.add(messageId);
    try {
      await callFaldaStreamAdd(entry.sessionID, role, text, messageId);
    } catch (e) {
      flushedIds.delete(messageId);
      await client.app.log({
        body: { service: "falda-capture", level: "warn", message: "capture failed", extra: { error: String(e) } },
      }).catch(() => {});
    }
  }

  return {
    event: async ({ event }) => {
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
