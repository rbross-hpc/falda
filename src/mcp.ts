/**
 * Backward-compatible re-export for the FALDA MCP server implementation.
 *
 * The implementation lives in src/mcp/ (server.ts + tools/); this file
 * re-exports the same public API so existing imports
 * (`import { makeFaldaMcpServer } from "./mcp.js"`, `src/index.ts`,
 * `src/server.ts`) keep working unchanged. The standalone `node dist/mcp.js`
 * / `falda mcp` entry point (MCP only, no distillation worker of its own)
 * has been retired — use `falda serve` (src/server.ts), which starts the
 * HTTP API, MCP endpoint, and distillation worker together against one
 * shared runtime. See src/mcp/server.ts for the MCP implementation itself.
 */
export { makeFaldaMcpServer, handleFaldaMcpRequest } from "./mcp/server.js";
