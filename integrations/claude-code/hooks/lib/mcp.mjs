/**
 * Dependency-free MCP client.
 *
 * FALDA's MCP endpoint accepts stateless single-shot JSON-RPC POSTs — no
 * `initialize` handshake, no `Mcp-Session-Id`. That is what lets this file
 * exist instead of a @modelcontextprotocol/sdk dependency. See
 * docs/future/claude-code-plugin.md, "Speaking MCP without the SDK".
 *
 * Nothing here throws. Every failure path returns null, because callers are
 * hooks that must never break a turn.
 */

const DEFAULT_TIMEOUT_MS = 5000;

/** Unwrap a JSON-RPC envelope from either a bare-JSON or SSE-framed body. */
export function parseEnvelope(raw, contentType) {
  try {
    if (String(contentType).includes("text/event-stream")) {
      const line = raw.split(/\r?\n/).find((l) => l.startsWith("data: "));
      return line ? JSON.parse(line.slice(6)) : null;
    }
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Call one MCP tool. Returns the tool's parsed JSON result, or null on any
 * failure (transport, HTTP status, JSON-RPC error, malformed payload).
 */
export async function callTool(creds, name, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const res = await fetch(creds.mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "X-Falda-Tenant": creds.tenant,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const envelope = parseEnvelope(await res.text(), res.headers.get("content-type") ?? "");
    if (!envelope || envelope.error) return null;
    // A tool-level error is a valid JSON-RPC result with isError:true, not a
    // JSON-RPC error envelope — the `envelope.error` check above never sees
    // it. Without this, callTool only "works" today because the server's
    // error path happens to return a non-JSON string that fails the parse
    // below; that is an accident, not a contract.
    if (envelope.result?.isError) return null;
    const text = envelope.result?.content?.[0]?.text;
    if (typeof text !== "string") return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}
