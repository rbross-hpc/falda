/**
 * FALDA pool layer — multi-tenant routing + opt-in shared pools.
 *
 * Design (see docs/POOLS.md for the full contract):
 *
 *   Every memory operation is addressed by a (tenant, pool) pair.
 *     tenant = agent identity (e.g. "kukla", "ollie"). Always required.
 *     pool   = namespace within reach. "self" (private, default) or a named
 *              shared pool ("lucid", "osti", ...).
 *
 *   Sharing is NOT the default. With no pool specified, every agent reaches
 *   only its own private store (pool="self") — exact single-store parity.
 *
 *   A shared pool exists only after it is DECLARED, with an explicit member
 *   roster and per-member access mode. Touching an undeclared pool is an error,
 *   never an autovivify.
 *
 * Strict-clean isolation is PHYSICAL, not predicate-based:
 *   - Each (tenant, "self") is its own SQLite file + blob dir.
 *   - Each named pool is ONE SQLite file + blob dir that member tenants route to.
 *   - A self query literally cannot open a pool DB and vice-versa. There is no
 *     shared table with a tenant column that a forgotten WHERE clause could leak.
 *
 * Layout under root/:
 *   root/tenants/<tenant>/self/{falda.db, blobs/}     private store
 *   root/pools/<pool>/{falda.db, blobs/}              shared store
 *   root/pools.json                                     pool registry
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Falda, type Embedder } from "./falda.js";
import { storeKeyFor } from "./distill/queue.js";

export type Access = "none" | "read" | "readwrite";

export interface PoolDecl {
  /** Pool name (namespace key). */
  name: string;
  /** Free-text description for humans/audit. */
  description?: string;
  /** Per-tenant access map. Tenants absent from the map have "none". */
  members: Record<string, Access>;
  created_at: string;
  updated_at: string;
}

interface Registry { pools: Record<string, PoolDecl>; }

/** A pool name must be a safe single path segment. "self" is reserved. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TENANT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ACCESS_VALUES = new Set(["none", "read", "readwrite"]);

export class PoolError extends Error {
  constructor(public code: "bad_name" | "bad_tenant" | "no_such_pool" | "not_a_member" | "read_only" | "reserved" | "exists" | "corrupt_registry", msg: string) {
    super(msg);
    this.name = "PoolError";
  }
}

/**
 * Structural validation of a parsed pools.json body. Deliberately stricter
 * than "is it JSON" — a truncated write can leave syntactically valid JSON
 * that isn't a registry (e.g. `{}`, `[]`, or a pool entry missing
 * `members`). Throws PoolError("corrupt_registry") naming what's wrong;
 * callers should never silently coerce a bad shape into an empty registry
 * (docs/future/reliability-hardening.md finding 12) — doing so previously
 * meant the very next admin write would overwrite a recoverable-but-corrupt
 * file with `{pools:{}}`, permanently losing every declared pool's roster
 * even though the pools' physical falda.db files were untouched.
 */
export function validateRegistry(raw: unknown, sourcePath: string): Registry {
  const fail = (why: string): never => {
    throw new PoolError("corrupt_registry", `pool registry ${JSON.stringify(sourcePath)} is corrupt: ${why}`);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("top level is not an object");
  const pools = (raw as any).pools;
  if (typeof pools !== "object" || pools === null || Array.isArray(pools)) fail(`"pools" is not an object`);
  for (const [name, decl] of Object.entries(pools as Record<string, unknown>)) {
    if (typeof decl !== "object" || decl === null || Array.isArray(decl)) fail(`pool ${JSON.stringify(name)} entry is not an object`);
    const d = decl as any;
    if (d.name !== name) fail(`pool ${JSON.stringify(name)} entry's "name" field (${JSON.stringify(d.name)}) does not match its key`);
    if (typeof d.members !== "object" || d.members === null || Array.isArray(d.members)) fail(`pool ${JSON.stringify(name)} "members" is not an object`);
    for (const [tenant, access] of Object.entries(d.members as Record<string, unknown>)) {
      if (!ACCESS_VALUES.has(access as string)) fail(`pool ${JSON.stringify(name)} member ${JSON.stringify(tenant)} has invalid access ${JSON.stringify(access)}`);
    }
    if (typeof d.created_at !== "string") fail(`pool ${JSON.stringify(name)} "created_at" is not a string`);
    if (typeof d.updated_at !== "string") fail(`pool ${JSON.stringify(name)} "updated_at" is not a string`);
  }
  return raw as Registry;
}

/**
 * Write JSON to `filePath` atomically: write to a sibling temp file in the
 * same directory (so the final rename is same-filesystem, hence atomic),
 * fsync the temp file's contents, rename over the target (POSIX rename(2)
 * is atomic — a concurrent reader or a crash mid-write sees either the
 * complete old file or the complete new one, never a truncated mix), then
 * best-effort fsync the parent directory so the rename itself is durable.
 * Cleans up the temp file on any failure. See
 * docs/future/reliability-hardening.md finding 12.
 */
export function writeFileAtomic(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, "w");
    fs.writeSync(fd, contents, 0, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, filePath);
    try {
      const dirFd = fs.openSync(dir, "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* best-effort; not all platforms support fsync on a directory fd */ }
  } catch (e) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw e;
  }
}

export class PoolManager {
  private root: string;
  private embed: Embedder;
  private dim: number;
  /** Open store cache keyed by physical store path. */
  private stores = new Map<string, Falda>();
  private regPath: string;

  constructor(opts: { root: string; embed: Embedder; dim?: number }) {
    this.root = opts.root;
    this.embed = opts.embed;
    this.dim = opts.dim ?? 768;
    fs.mkdirSync(path.join(this.root, "tenants"), { recursive: true });
    fs.mkdirSync(path.join(this.root, "pools"), { recursive: true });
    this.regPath = path.join(this.root, "pools.json");
  }

  // ─── registry persistence ──────────────────────────────────────────────────
  /**
   * Load the registry. A missing file is a legitimate first-run state
   * (returns an empty registry). A present-but-unreadable-or-malformed
   * file THROWS PoolError("corrupt_registry") rather than silently
   * returning an empty registry — see validateRegistry's doc comment and
   * docs/future/reliability-hardening.md finding 12. This matters most on
   * the mutating path: a corrupt read must never reach saveReg(), or the
   * next write permanently destroys whatever was recoverable in the
   * corrupt file.
   */
  private loadReg(): Registry {
    if (!fs.existsSync(this.regPath)) return { pools: {} };
    let raw: string;
    try { raw = fs.readFileSync(this.regPath, "utf8"); }
    catch (e: any) { throw new PoolError("corrupt_registry", `pool registry ${JSON.stringify(this.regPath)} could not be read: ${e?.message ?? e}`); }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (e: any) { throw new PoolError("corrupt_registry", `pool registry ${JSON.stringify(this.regPath)} is not valid JSON: ${e?.message ?? e}`); }
    return validateRegistry(parsed, this.regPath);
  }
  private saveReg(r: Registry) {
    writeFileAtomic(this.regPath, JSON.stringify(r, null, 2));
  }

  // ─── validation ─────────────────────────────────────────────────────────────
  private vTenant(t: string) {
    if (!TENANT_RE.test(t)) throw new PoolError("bad_tenant", `invalid tenant id: ${JSON.stringify(t)}`);
  }
  private vName(n: string) {
    if (n === "self") throw new PoolError("reserved", `"self" is the reserved private pool and cannot be declared`);
    if (!NAME_RE.test(n)) throw new PoolError("bad_name", `invalid pool name: ${JSON.stringify(n)}`);
  }

  // ─── pool declaration / admin ────────────────────────────────────────────────
  /** Declare a new shared pool. Fails if it already exists. */
  declarePool(name: string, members: Record<string, Access>, description = ""): PoolDecl {
    this.vName(name);
    for (const t of Object.keys(members)) this.vTenant(t);
    const reg = this.loadReg();
    if (reg.pools[name]) throw new PoolError("exists", `pool already exists: ${name}`);
    const now = new Date().toISOString();
    const decl: PoolDecl = { name, description, members: { ...members }, created_at: now, updated_at: now };
    reg.pools[name] = decl;
    this.saveReg(reg);
    // Materialize the store directory eagerly so membership == existence is honest.
    fs.mkdirSync(this.poolStorePath(name).dir, { recursive: true });
    return decl;
  }

  /** Update an existing pool's membership/description. Replaces the member map. */
  updatePool(name: string, patch: { members?: Record<string, Access>; description?: string }): PoolDecl {
    this.vName(name);
    const reg = this.loadReg();
    const decl = reg.pools[name];
    if (!decl) throw new PoolError("no_such_pool", `no such pool: ${name}`);
    if (patch.members) {
      for (const t of Object.keys(patch.members)) this.vTenant(t);
      decl.members = { ...patch.members };
    }
    if (patch.description !== undefined) decl.description = patch.description;
    decl.updated_at = new Date().toISOString();
    this.saveReg(reg);
    return decl;
  }

  /** Grant/change a single tenant's access without rewriting the whole roster. */
  grant(name: string, tenant: string, access: Access): PoolDecl {
    this.vName(name); this.vTenant(tenant);
    const reg = this.loadReg();
    const decl = reg.pools[name];
    if (!decl) throw new PoolError("no_such_pool", `no such pool: ${name}`);
    if (access === "none") delete decl.members[tenant];
    else decl.members[tenant] = access;
    decl.updated_at = new Date().toISOString();
    this.saveReg(reg);
    return decl;
  }

  getPool(name: string): PoolDecl | null { return this.loadReg().pools[name] ?? null; }
  listPools(): PoolDecl[] { return Object.values(this.loadReg().pools); }

  /** Pools a tenant can reach, with their effective access (read/readwrite only). */
  poolsForTenant(tenant: string): Array<{ name: string; access: Access; description: string }> {
    this.vTenant(tenant);
    return this.listPools()
      .map((p) => ({ name: p.name, access: p.members[tenant] ?? "none", description: p.description ?? "" }))
      .filter((p) => p.access !== "none");
  }

  // ─── access resolution ───────────────────────────────────────────────────────
  /**
   * Resolve a (tenant, pool) request to a physical store, enforcing access.
   * @param write true if the operation mutates the store.
   * Throws PoolError on missing pool / insufficient access.
   */
  resolve(tenant: string, pool: string | undefined, write: boolean): Falda {
    this.vTenant(tenant);
    const p = pool ?? "self";
    if (p === "self") return this.storeAt(this.selfStorePath(tenant), storeKeyFor(tenant, undefined));

    this.vName(p);
    const decl = this.getPool(p);
    if (!decl) throw new PoolError("no_such_pool", `no such pool: ${p} (declare it first)`);
    const access = decl.members[tenant] ?? "none";
    if (access === "none") throw new PoolError("not_a_member", `tenant ${tenant} has no access to pool ${p}`);
    if (write && access !== "readwrite") throw new PoolError("read_only", `tenant ${tenant} has read-only access to pool ${p}`);
    return this.storeAt(this.poolStorePath(p), storeKeyFor(tenant, p));
  }

  // ─── physical store paths ────────────────────────────────────────────────────
  private selfStorePath(tenant: string) {
    const dir = path.join(this.root, "tenants", tenant, "self");
    return { dir, db: path.join(dir, "falda.db"), blobs: path.join(dir, "blobs") };
  }
  private poolStorePath(pool: string) {
    const dir = path.join(this.root, "pools", pool);
    return { dir, db: path.join(dir, "falda.db"), blobs: path.join(dir, "blobs") };
  }

  /**
   * Enumerate tenants that have an initialised self-store on disk.
   * A tenant counts if `${root}/tenants/<tenant>/self/falda.db` exists.
   * Used by the gateway worker to auto-enqueue every known self-store.
   */
  listSelfTenants(): string[] {
    const tenantsDir = path.join(this.root, "tenants");
    let entries: string[];
    try {
      entries = fs.readdirSync(tenantsDir);
    } catch {
      return [];
    }
    return entries.filter((name) => {
      const dbPath = path.join(tenantsDir, name, "self", "falda.db");
      try { return fs.statSync(dbPath).isFile(); } catch { return false; }
    });
  }

  /** Open (or reuse) the Falda store at a physical location. `storeKey`
   *  (e.g. "<tenant>:self" or "<tenant>:<pool>") is threaded through so
   *  lifecycle-mutation methods can mark the correct store dirty for L2/L3
   *  reconciliation (docs/future/reliability-hardening.md finding 2) —
   *  matches the same key the sweep/queue use for this store. */
  private storeAt(loc: { dir: string; db: string; blobs: string }, storeKey: string): Falda {
    const key = loc.db;
    let s = this.stores.get(key);
    if (!s) {
      fs.mkdirSync(loc.dir, { recursive: true });
      s = new Falda({ dbPath: loc.db, blobDir: loc.blobs, embed: this.embed, dim: this.dim, storeKey });
      this.stores.set(key, s);
    }
    return s;
  }

  closeAll() { for (const s of this.stores.values()) s.close(); this.stores.clear(); }
}
