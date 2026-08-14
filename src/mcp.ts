/**
 * Backward-compatible entry point for the FALDA MCP server.
 *
 * The implementation lives in src/mcp/ (server.ts + tools/); this file
 * re-exports the same public API so existing imports
 * (`import { makeFaldaMcpServer } from "./mcp.js"`, `src/index.ts`,
 * `src/gateway.ts` IS_MAIN, `src/server.ts`) keep working unchanged, and
 * keeps the standalone `node dist/mcp.js` entry point (MCP only, no
 * distillation worker of its own — see src/mcp/server.ts doc header).
 */
import { createServer } from "node:http";
import { PoolManager, PoolError } from "./pools.js";
import { buildRuntime } from "./runtime.js";
import { makeFaldaMcpServer, handleFaldaMcpRequest } from "./mcp/server.js";

export { makeFaldaMcpServer, handleFaldaMcpRequest };

const IS_MAIN = process.argv[1]?.endsWith("mcp.js") || process.argv[1]?.endsWith("mcp.ts");
if (IS_MAIN) {
  const PORT = Number(process.env.FALDA_MCP_PORT ?? 8079);
  const runtime = buildRuntime({ label: "FALDA MCP" });

  createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, mcp: true }));
      return;
    }
    if (req.url !== "/mcp" && req.url !== "/") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    handleFaldaMcpRequest(runtime.pools, runtime.tokenStore, req, res, runtime.queueDb, {
      recallTraceDb: runtime.recallTraceDb,
    }).catch((e) => {
      console.error("[falda-mcp] fatal:", e);
      if (!res.headersSent) {
        res.writeHead(e instanceof PoolError ? 400 : 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      }
    });
  }).listen(PORT, () => console.log(`FALDA MCP server listening on :${PORT} (root=${runtime.root})`));
}
