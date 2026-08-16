/**
 * Shared request/auth helpers used by every MCP tool registrar.
 *
 * Kept separate from server.ts so tool modules (tools/*.ts,
 * tools/advanced/*.ts) can depend on the auth/store-resolution plumbing
 * without depending on the McpServer construction itself.
 */
import { z } from "zod";
import type { PoolManager } from "../pools.js";
import { TokenStore, parseBearer, type Principal } from "../mcp_auth.js";
import type { MetricsRegistry } from "../metrics.js";

export interface RequestCtx { tenant: string; principal: Principal; }

export interface ToolDeps {
  pools: PoolManager;
  tokenStore: TokenStore;
  queueDb?: import("better-sqlite3").Database;
  recallTraceDb?: import("better-sqlite3").Database;
  /** Since-startup timing histograms (src/metrics.ts). Undefined only in
   *  tests that don't wire a registry — instrumentation is best-effort. */
  metrics?: MetricsRegistry;
  /** Immediately drains ready explicit-priority distill jobs — see
   *  src/distill/worker.ts's wake(). Undefined for the legacy standalone
   *  `falda mcp` entry point, which has no worker of its own; falda_distill
   *  still enqueues correctly, it just falls back to whatever process (if
   *  any) owns the shared queue's timed drain. */
  wakeDistiller?: () => void;
}

export const poolArg = z.string().optional().describe(
  "Named shared pool to address instead of the tenant's private store. Must be one this token is authorized for."
);

export function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function errorResult(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function ctxFromExtra(
  tokenStore: TokenStore,
  extra: { requestInfo?: { headers: Record<string, unknown> } },
): RequestCtx {
  const headers = (extra.requestInfo?.headers ?? {}) as Record<string, string | string[] | undefined>;
  const bearer = parseBearer(headers["authorization"]);
  const principal = tokenStore.authenticate(bearer);
  const tenantHeader = headers["x-falda-tenant"];
  const tenant = TokenStore.requireTenant(principal, Array.isArray(tenantHeader) ? tenantHeader[0] : tenantHeader);
  return { tenant, principal };
}

export function storeFor(deps: ToolDeps, ctx: RequestCtx, pool: string | undefined, write: boolean) {
  const checkedPool = TokenStore.requirePool(ctx.principal, pool);
  return deps.pools.resolve(ctx.tenant, checkedPool, write);
}
