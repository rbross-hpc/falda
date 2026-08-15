/**
 * `falda show recall` — view a recall via the running falda HTTP server.
 *
 * Three selectors, mutually exclusive:
 *   1. Show the most recent PRIOR recall (the default — no selector given,
 *      or explicitly `--last`): fetches the most recent recall trace for
 *      the addressed tenant/pool (`recall_id: "latest"`) and re-renders it
 *      against CURRENT memory via POST /recalls/reconstruct. This is NOT a
 *      byte-faithful replay — the trace never stored rendered text, only
 *      item ids/scores (src/recall/reconstruct.ts) — so items that changed
 *      since the recall are listed as `stale_items` rather than silently
 *      shown wrong or omitted. `--last` takes no value; it only exists so
 *      "show me the last one" can be spelled explicitly instead of relying
 *      on the absence of every other flag.
 *   2. Show a SPECIFIC PAST recall: --recall-id=ID, same reconstruction as above.
 *   3. Synthesize a NEW recall: --query="..." or --topic=<scene_id|title
 *      substring> fires a real POST /recall and shows today's result.
 *      This writes a new recall trace, like any other recall.
 *
 * Unlike `falda stats`/`falda distill inspect`, this command requires a
 * running server (a real recall needs the configured embedder, which only
 * the server has wired) and a bearer token — it is a normal authenticated
 * HTTP client, not an offline filesystem inspector.
 *
 * Usage:
 *   falda show recall --tenant=T [--pool=P] [--token=TOK] [--url=BASE] [--json]
 *   falda show recall --tenant=T --last
 *   falda show recall --tenant=T --recall-id=ID
 *   falda show recall --tenant=T --query="..." [--budget=N]
 *   falda show recall --tenant=T --topic=<scene_id|substring> [--budget=N]
 *
 * Env:
 *   FALDA_URL    Base URL of the running falda HTTP server (default http://localhost:8077)
 *   FALDA_TOKEN  Bearer token (falls back to --token)
 */

export interface CliOptions {
  url: string;
  token?: string;
  tenant?: string;
  pool?: string;
  last?: boolean;
  recallId?: string;
  query?: string;
  topic?: string;
  budget?: number;
  json: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    url: process.env.FALDA_URL ?? "http://localhost:8077",
    token: process.env.FALDA_TOKEN,
    json: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--last") opts.last = true;
    else if (arg.startsWith("--last=")) {
      console.error("falda show recall: --last takes no value; it shows the single most recent recall (see --help)");
      process.exit(1);
    }
    else if (arg.startsWith("--url=")) opts.url = arg.slice("--url=".length);
    else if (arg.startsWith("--token=")) opts.token = arg.slice("--token=".length);
    else if (arg.startsWith("--tenant=")) opts.tenant = arg.slice("--tenant=".length);
    else if (arg.startsWith("--pool=")) opts.pool = arg.slice("--pool=".length);
    else if (arg.startsWith("--recall-id=")) opts.recallId = arg.slice("--recall-id=".length);
    else if (arg.startsWith("--query=")) opts.query = arg.slice("--query=".length);
    else if (arg.startsWith("--topic=")) opts.topic = arg.slice("--topic=".length);
    else if (arg.startsWith("--budget=")) {
      const n = Number(arg.slice("--budget=".length));
      if (!Number.isFinite(n) || n <= 0) { console.error("falda show recall: --budget must be a positive number"); process.exit(1); }
      opts.budget = Math.floor(n);
    } else {
      console.error(`falda show recall: unknown argument '${arg}' (see --help)`);
      process.exit(1);
    }
  }
  return opts;
}

const HELP = `Usage: falda show recall [OPTIONS]

Views a recall through the running falda HTTP server. Requires the server
to be up and a bearer token — unlike \`falda stats\`/\`falda distill
inspect\`, this is a live authenticated client, not an offline inspector.

Default (no selector, or explicit --last): shows the MOST RECENT recall
for the addressed tenant/pool, reconstructed against current memory. This
is the "what did the last prompt's recall return" use case. Reconstruction
is NOT a byte-faithful replay (the trace never stored rendered text) —
items that changed since (superseded, merged, archived, retired, deleted)
are listed under "Stale items" rather than silently shown wrong.

  --last               Show the most recent recall (the default — this flag
                       exists so you can say so explicitly). Takes no value.
  --recall-id=ID       Show a specific PAST recall instead of the latest one
  --query="..."        Fire a NEW recall with this query and show it (writes a trace)
  --topic=ID|SUBSTR    Fire a NEW recall using an active topic scene's title as
                       the query (matches an exact scene_id, else a
                       case-insensitive title substring)

Connection:
  --tenant=T           X-Falda-Tenant header (required)
  --pool=P             Shared pool to address instead of the tenant's self store
  --token=TOK          Bearer token (default: FALDA_TOKEN env)
  --url=BASE           Server base URL (default: FALDA_URL env or http://localhost:8077)

Other:
  --budget=N           Character budget for a NEW recall (--query/--topic only)
  --json               Print the raw server response instead of formatted text
`;

interface RecallItem {
  tier: "T1" | "T2" | "T3";
  id: string;
  source?: string;
  score?: number | null;
  chars?: number | null;
}

interface ReconstructResponse {
  trace: {
    recall_id: string;
    query: string;
    created_at: string;
    requested_budget: number;
    used_budget: number;
    mode: string;
    items: Array<RecallItem & { rank: number; usage: string }>;
  };
  context: string;
  stale_items: Array<{ tier: string; id: string; reason: string }>;
}

interface RecallResponse {
  recall_id?: string;
  context: string;
  items: RecallItem[];
  truncated: boolean;
  total_chars: number;
}

async function post(opts: CliOptions, route: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.tenant) headers["x-falda-tenant"] = opts.tenant;
  let res: Response;
  try {
    res = await fetch(new URL(route, opts.url), { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e: any) {
    console.error(`falda show recall: could not reach ${opts.url} (${e?.message ?? e}) — is the falda server running?`);
    process.exit(1);
  }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

function renderReconstruct(r: ReconstructResponse): string {
  const lines: string[] = [];
  lines.push(`Recall ${r.trace.recall_id}`);
  lines.push(`${r.trace.created_at}  mode=${r.trace.mode}  query="${r.trace.query}"`);
  lines.push(`budget: ${r.trace.used_budget} / ${r.trace.requested_budget} chars`);
  lines.push("", "(reconstructed from current memory — not a byte-faithful replay of what was originally returned)");
  lines.push("", r.context || "(nothing admitted into the recalled context)");
  if (r.stale_items.length) {
    lines.push("", "Stale items (changed since this recall):");
    for (const s of r.stale_items) lines.push(`  ${s.tier} ${s.id}: ${s.reason}`);
  }
  return lines.join("\n");
}

function renderRecall(r: RecallResponse): string {
  const lines: string[] = [];
  if (r.recall_id) lines.push(`Recall ${r.recall_id}`);
  lines.push(`total_chars: ${r.total_chars}${r.truncated ? "  (truncated)" : ""}`);
  lines.push("", r.context || "(nothing admitted into the recalled context)");
  return lines.join("\n");
}

/**
 * Cross-flag validation, separated from parseArgs (which only parses one
 * flag at a time) so mutual-exclusion rules can be unit-tested without
 * driving process.argv/network I/O through main(). Returns an error
 * message, or null if opts are internally consistent.
 */
export function validateOptions(opts: CliOptions): string | null {
  if (!opts.tenant) return "--tenant is required";
  if (opts.query && opts.topic) return "--query and --topic are mutually exclusive";
  if (opts.recallId && (opts.query || opts.topic)) {
    return "--recall-id shows a prior recall; it cannot be combined with --query/--topic (which fire a new one)";
  }
  if (opts.last && (opts.query || opts.topic || opts.recallId)) {
    return "--last already means 'show the most recent recall'; it cannot be combined with --query/--topic/--recall-id";
  }
  return null;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }
  const validationError = validateOptions(opts);
  if (validationError) { console.error(`falda show recall: ${validationError}`); process.exit(1); }

  if (opts.query || opts.topic) {
    const { status, body } = await post(opts, "/recall", {
      query: opts.query, topic: opts.topic, budget: opts.budget, pool: opts.pool,
    });
    if (status !== 200) { console.error(`falda show recall: ${status} ${body.error ?? JSON.stringify(body)}`); process.exit(1); }
    console.log(opts.json ? JSON.stringify(body, null, 2) : renderRecall(body as RecallResponse));
    return;
  }

  const { status, body } = await post(opts, "/recalls/reconstruct", {
    recall_id: opts.recallId ?? "latest", pool: opts.pool,
  });
  if (status === 404) {
    console.log(opts.recallId
      ? `No recall trace found for id '${opts.recallId}' in this tenant/pool.`
      : `No recall traces recorded yet for this tenant/pool. Run falda show recall --query="..." to make one.`);
    return;
  }
  if (status !== 200) { console.error(`falda show recall: ${status} ${body.error ?? JSON.stringify(body)}`); process.exit(1); }
  console.log(opts.json ? JSON.stringify(body, null, 2) : renderReconstruct(body as ReconstructResponse));
}

const IS_MAIN = process.argv[1]?.endsWith("show/recall.js") || process.argv[1]?.endsWith("show/recall.ts")
  || process.argv[1]?.endsWith("show\\recall.js") || process.argv[1]?.endsWith("show\\recall.ts");
if (IS_MAIN) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
