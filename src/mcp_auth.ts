/**
 * FALDA MCP auth — bearer-token principals with an allowed-tenant set.
 *
 * Unlike the FALDA gateway (which trusts a `tenant` field straight from the
 * request body — fine on a trusted loopback/tailnet, see docs/POOLS.md), the
 * MCP server is meant to be reachable from many containerized agents over a
 * shared network. Design, matching proxy/falda_access_proxy.py's clamp
 * pattern but extended for one container spanning multiple projects:
 *
 *   - A bearer token identifies a PRINCIPAL (e.g. one opencode container/host).
 *   - Each principal has an explicit `tenants` allow-list (or ["*"] for a
 *     fully-trusted principal that may address any tenant).
 *   - The caller SELECTS which tenant it wants per request via the
 *     X-Falda-Tenant header (opencode sets this per-project in its MCP
 *     `headers` config) — the token AUTHORIZES the selection, it does not by
 *     itself fix a single tenant. This lets one container/token work across
 *     several projects (each project = a different tenant) while still
 *     making cross-tenant reads/writes impossible outside the token's set.
 *   - A `pool` argument (per tool call) is checked against the principal's
 *     `pools` allow-list, "self" always implicitly allowed.
 *
 * Token file is hot-read per request (like the proxy) so rotating/adding a
 * token doesn't require a restart. Never committed — see .gitignore.
 */
import { readFileSync } from "node:fs";

export interface Principal {
  /** Tenants this token may address. ["*"] = any tenant. */
  tenants: string[];
  /** Named shared pools this token may address (besides the always-allowed "self"). */
  pools: string[];
  /** Free-text label for audit/logging. */
  label?: string;
}

interface TokenFile { tokens: Record<string, Principal>; }

export class AuthError extends Error {
  constructor(public status: 401 | 403, msg: string) {
    super(msg);
    this.name = "AuthError";
  }
}

export class TokenStore {
  constructor(private path: string) {}

  private load(): TokenFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      return { tokens: parsed.tokens ?? {} };
    } catch {
      return { tokens: {} };
    }
  }

  /** Look up the principal for a bearer token. Throws 401 if unknown. */
  authenticate(bearerToken: string | undefined): Principal {
    if (!bearerToken) throw new AuthError(401, "missing bearer token");
    const { tokens } = this.load();
    const principal = tokens[bearerToken];
    if (!principal) throw new AuthError(401, "unauthorized");
    return principal;
  }

  /** Validate a principal may address the requested tenant. Throws 403 if not. */
  static requireTenant(principal: Principal, tenant: string | undefined): string {
    if (!tenant) throw new AuthError(403, "missing X-Falda-Tenant header");
    if (principal.tenants.includes("*") || principal.tenants.includes(tenant)) return tenant;
    throw new AuthError(403, `token is not authorized for tenant ${JSON.stringify(tenant)}`);
  }

  /** Validate a principal may address the requested pool ("self" always allowed). */
  static requirePool(principal: Principal, pool: string | undefined): string | undefined {
    if (!pool || pool === "self") return pool;
    if (principal.pools.includes(pool)) return pool;
    throw new AuthError(403, `token is not authorized for pool ${JSON.stringify(pool)}`);
  }
}

/** Extract "Bearer <token>" from an Authorization header value. */
export function parseBearer(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.toLowerCase().startsWith("bearer ")) return undefined;
  const token = value.slice(7).trim();
  return token || undefined;
}
