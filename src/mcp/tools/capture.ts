import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ctxFromExtra, errorResult, poolArg, storeFor, textResult, type ToolDeps } from "../context.js";

/**
 * falda_stream_add is machine/harness ingestion infrastructure, not an
 * interactive memory operation — it is normally called by a capture
 * plugin/harness integration (e.g. integrations/opencode/plugin) after each
 * turn, not chosen by the model. It stays registered on the default MCP
 * surface (rather than moved to the advanced/full toolset) because MCP has
 * no way to expose a tool to one caller and hide it from another on the
 * same endpoint, and existing capture integrations already call it here.
 * Agents should prefer falda_remember for anything they want to recall
 * later; raw stream capture is not something the model should decide to do.
 */
export function registerStreamAdd(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "falda_stream_add",
    {
      description:
        "Machine/harness ingestion: append raw conversation turns to the stream (T0) for later " +
        "distillation into memories. This is normally invoked automatically by a capture " +
        "plugin/harness integration after each turn — not something the model should call directly. " +
        "Use falda_remember instead to save something you want to recall later.",
      inputSchema: {
        session_id: z.string(),
        messages: z.array(z.object({
          role: z.string(), content: z.string(),
          id: z.string().optional(), timestamp: z.string().optional(),
          turn_index: z.number().int().optional(), turn_id: z.string().optional(),
        })),
        pool: poolArg,
      },
    },
    async ({ session_id, messages, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(deps.tokenStore, extra);
        const addStartedAt = Date.now();
        const accepted_ids = await storeFor(deps, ctx, pool, true).addStream(session_id, messages);
        if (deps.metrics) deps.metrics.stream_add_ms.observe(Date.now() - addStartedAt, deps.metrics.distillActive());
        return textResult({ accepted_ids, total_count: messages.length });
      } catch (e) { return errorResult(e); }
    },
  );
}
