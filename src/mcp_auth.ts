/**
 * FALDA auth — bearer-token principals with an allowed-tenant set.
 *
 * Shared by both the MCP server (src/mcp.ts) and the JSON gateway
 * (src/gateway.ts) — one auth story for both front doors onto the pool
 * layer. Design, matching proxy/falda_access_proxy.py's clamp pattern but
 * extended for one container spanning multiple projects:
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

/**
 * Pure check for whether a token file at `path` is usable: exists, parses as
 * JSON, and declares at least one token. A missing/malformed/empty token file
 * is a silent lockout trap — the server boots fine but TokenStore.load()'s
 * tolerant per-request fallback (`{ tokens: {} }`) means every request 401s
 * forever with no indication why. This makes that condition explicit and
 * testable without touching process.exit.
 */
export function validateTokenFile(path: string): { ok: true; count: number } | { ok: false; reason: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e: any) {
    return { ok: false, reason: `cannot read ${JSON.stringify(path)}: ${e?.code ?? e?.message ?? e}` };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    return { ok: false, reason: `${JSON.stringify(path)} is not valid JSON: ${e?.message ?? e}` };
  }
  const count = Object.keys(parsed?.tokens ?? {}).length;
  if (count === 0) return { ok: false, reason: `${JSON.stringify(path)} declares no tokens (empty "tokens" map)` };
  return { ok: true, count };
}

/**
 * Boot-time assertion: FATAL + exit(1) if the token file is missing,
 * malformed, or empty. Mirrors boot.ts's enforceEmbeddingLock — fail loud and
 * immediately rather than silently serving a server that can never
 * authenticate anyone. Does not replace TokenStore's tolerant per-request
 * hot-read (rotating tokens still needs no restart); this only catches the
 * "nobody can ever get in" case at startup.
 */
export function requireTokenFile(path: string, label = "FALDA"): void {
  const result = validateTokenFile(path);
  if (!result.ok) {
    console.error(
      `FATAL: ${label} token file problem — ${result.reason}. ` +
        `Every request would be rejected with 401. Create the file with at least one ` +
        `{"tokens": {"<bearer-token>": {"tenants": [...], "pools": [...]}}} entry, or point ` +
        `FALDA_MCP_TOKENS/FALDA_TOKENS at a valid file.`,
    );
    process.exit(1);
  }
  console.log(`${label} token file OK: ${result.count} token(s) loaded from ${path}`);
}

/** Extract "Bearer <token>" from an Authorization header value. */
export function parseBearer(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.toLowerCase().startsWith("bearer ")) return undefined;
  const token = value.slice(7).trim();
  return token || undefined;
}
