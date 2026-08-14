import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ctxFromExtra, errorResult, poolArg, storeFor, textResult, type ToolDeps } from "../context.js";

export function registerRemember(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "falda_remember",
    {
      description:
        "Save a durable fact, pattern, preference, constraint, or standing instruction that will be " +
        "useful in future sessions. Do not use for transient details that only matter to the current " +
        "conversation. Each call records a new memory — to change a previously remembered proposition, " +
        "call this again with the corrected content rather than expecting the old one to be edited " +
        "(content is immutable once stored).",
      inputSchema: {
        content: z.string(),
        type: z.enum(["fact", "pattern", "preference", "constraint", "instruction"]).optional(),
        background: z.string().optional(),
        priority: z.number().int().min(0).max(100).optional(),
        pinned: z.boolean().optional()
          .describe("Pin so this is always included in future recall, budget permitting."),
        tags: z.array(z.string()).optional(),
        pool: poolArg,
      },
    },
    async ({ pool, ...atom }, extra) => {
      try {
        const ctx = ctxFromExtra(deps.tokenStore, extra);
        const store = storeFor(deps, ctx, pool, true);
        const saved = await store.upsertAtom(atom);
        return textResult({ id: saved.id, type: saved.type, pinned: saved.pinned });
      } catch (e) { return errorResult(e); }
    },
  );
}
