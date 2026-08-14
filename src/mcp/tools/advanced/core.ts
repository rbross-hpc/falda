import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ctxFromExtra, errorResult, poolArg, storeFor, textResult, type ToolDeps } from "../../context.js";

export function registerCoreAdvanced(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "falda_core_read",
    {
      description: "Read the long-lived persona/project core document (T3) — who/what this agent is and the project it serves. Read-only: T3 is maintained by the distillation pipeline.",
      inputSchema: { pool: poolArg },
    },
    async ({ pool }, extra) => {
      try {
        const ctx = ctxFromExtra(deps.tokenStore, extra);
        return textResult({ content: storeFor(deps, ctx, pool, false).readCore() });
      } catch (e) { return errorResult(e); }
    },
  );
}
