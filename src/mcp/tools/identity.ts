import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ctxFromExtra, errorResult, textResult, type ToolDeps } from "../context.js";

export function registerIdentity(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "falda_whoami",
    {
      description:
        "Return the FALDA tenant this connection resolves to. Use this to confirm which tenant/project " +
        "identity your recall and remember calls address — does not disclose the bearer token or its " +
        "full tenant/pool allow-lists.",
      inputSchema: {},
    },
    async (_args, extra) => {
      try {
        const ctx = ctxFromExtra(deps.tokenStore, extra);
        return textResult({ tenant: ctx.tenant });
      } catch (e) { return errorResult(e); }
    },
  );
}
