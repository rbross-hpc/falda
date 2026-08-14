import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ctxFromExtra, errorResult, poolArg, storeFor, textResult, type ToolDeps } from "../context.js";

export function registerForget(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "falda_forget",
    {
      description:
        "Stop recalling a previously stored memory (by the id returned from falda_remember or a " +
        "falda_recall hit). This is logical forgetting only — it moves the memory from active to " +
        "archived so it no longer surfaces in falda_recall, but it does not erase historical or " +
        "provenance evidence. It is not privacy erasure.",
      inputSchema: {
        atom_id: z.string(),
        reason: z.string().optional().describe("Optional human-readable reason (not currently persisted)."),
        pool: poolArg,
      },
    },
    async ({ atom_id, pool }, extra) => {
      try {
        const ctx = ctxFromExtra(deps.tokenStore, extra);
        const store = storeFor(deps, ctx, pool, true);
        const archived = store.archiveAtom(atom_id);
        return textResult({ ok: true, archived });
      } catch (e) { return errorResult(e); }
    },
  );
}
