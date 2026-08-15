/**
 * `falda distill inspect` — operator-facing, read-only CLI for reviewing
 * what distillation actually decided (not merely whether it ran).
 *
 * Usage:
 *   falda distill inspect [--root=DIR] [--tenant=T] [--pool=P]
 *                          [--last=N] [--since=24h|7d] [--pass=ID]
 *                          [--action=store,update,merge,skip] [--status=done|failed|running]
 *                          [--random=N] [--evidence] [--verbose] [--json]
 *                          [--export-fixture=out.json]
 *
 * See docs/OPERATIONS.md "Reviewing distillation quality" for the full
 * runbook. This command never mutates a store — see src/inspect/distill.ts.
 */
import Database from "better-sqlite3";
import { buildInspectReport } from "./distill.js";
import { renderHuman, renderJson } from "./format.js";
import { buildDistillFixture, writeFixtureFile } from "./fixture.js";
import type { ActionFilter, DecisionAction, InspectSelector, PassStatus } from "./types.js";

const VALID_ACTIONS: DecisionAction[] = ["store", "update", "merge", "skip"];
const VALID_STATUSES: PassStatus[] = ["running", "done", "failed"];

interface CliOptions extends InspectSelector {
  json: boolean;
  exportFixture?: string;
  help: boolean;
}

/** Parse a duration like "24h", "7d", "30m" into milliseconds. */
function parseDuration(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(m|h|d|w)$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unitMs: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return n * unitMs[m[2]];
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { root: process.env.FALDA_ROOT ?? "./falda-data", json: false, help: false };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--evidence") opts.evidence = true;
    else if (arg === "--verbose") opts.verbose = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--root=")) opts.root = arg.slice("--root=".length);
    else if (arg.startsWith("--tenant=")) opts.tenant = arg.slice("--tenant=".length);
    else if (arg.startsWith("--pool=")) opts.pool = arg.slice("--pool=".length);
    else if (arg.startsWith("--pass=")) opts.passId = arg.slice("--pass=".length);
    else if (arg.startsWith("--export-fixture=")) opts.exportFixture = arg.slice("--export-fixture=".length);
    else if (arg.startsWith("--last=")) {
      const n = Number(arg.slice("--last=".length));
      if (!Number.isFinite(n) || n <= 0) { console.error(`falda distill inspect: --last must be a positive number`); process.exit(1); }
      opts.last = Math.floor(n);
    } else if (arg.startsWith("--random=")) {
      const n = Number(arg.slice("--random=".length));
      if (!Number.isFinite(n) || n <= 0) { console.error(`falda distill inspect: --random must be a positive number`); process.exit(1); }
      opts.random = Math.floor(n);
    } else if (arg.startsWith("--since=")) {
      const raw = arg.slice("--since=".length);
      const ms = parseDuration(raw);
      if (ms === null) { console.error(`falda distill inspect: invalid --since '${raw}' (expected e.g. 24h, 7d, 30m)`); process.exit(1); }
      opts.sinceMs = ms;
    } else if (arg.startsWith("--status=")) {
      const s = arg.slice("--status=".length);
      if (!VALID_STATUSES.includes(s as PassStatus)) {
        console.error(`falda distill inspect: unknown --status '${s}' (valid: ${VALID_STATUSES.join(", ")})`);
        process.exit(1);
      }
      opts.status = s as PassStatus;
    } else if (arg.startsWith("--action=")) {
      const requested = arg.slice("--action=".length).split(",").map((s) => s.trim());
      for (const a of requested) {
        if (!VALID_ACTIONS.includes(a as DecisionAction)) {
          console.error(`falda distill inspect: unknown --action '${a}' (valid: ${VALID_ACTIONS.join(", ")})`);
          process.exit(1);
        }
      }
      opts.actions = requested as ActionFilter;
    } else {
      console.error(`falda distill inspect: unknown argument '${arg}' (see --help)`);
      process.exit(1);
    }
  }
  return opts;
}

const HELP = `Usage: falda distill inspect [OPTIONS]

Read-only inspection of what distillation actually decided: which memories
were extracted, stored, updated, merged, or skipped, and why — plus T2
scene and T3 core effects and heuristic quality warnings. Never mutates a
store. Only passes distilled AFTER this feature was deployed are visible
(distillation_passes did not exist before).

Store scope (same conventions as falda stats / falda reembed):
  --root=DIR        Pool root dir (default: FALDA_ROOT env or ./falda-data)
  --tenant=T        Only inspect this tenant's self store
  --pool=P          Only inspect this declared pool's store

Selectors (compose freely, e.g. --since=7d --action=merge --evidence):
  --last=N          Most recent N passes (default: 10, when no other
                     selector narrows the result)
  --since=24h|7d    Passes started within this duration (m/h/d/w units)
  --pass=ID         Exact pass lookup
  --action=A[,A...] Only passes/decisions with at least one of these
                     actions: store, update, merge, skip
  --status=S        Only passes with this job status: running, done, failed
  --random=N        Sample N decisions at random (not cryptographic),
                     grouped by their owning pass. Composes with --action.

Detail:
  --evidence        Include T0 evidence turns per decision (see
                     docs/OPERATIONS.md for truncation defaults)
  --verbose         Expand evidence truncation limits, show unchanged
                     scenes, include decided_at timestamps

Output:
  --json            Structured JSON (same DTOs as human output)
  --export-fixture=PATH
                     Write a replayable evaluation fixture for the matched
                     decision(s) to PATH (requires --pass; narrows to one
                     decision if the pass has --action/--random applied)
`;

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }

  const warnThresholds = undefined; // resolved from env inside computeInspectionWarnings by default
  const report = buildInspectReport(opts, warnThresholds);

  if (opts.exportFixture) {
    if (!opts.passId) {
      console.error("falda distill inspect: --export-fixture requires --pass=ID");
      process.exit(1);
    }
    const pass = report.passes[0];
    if (!pass) {
      console.error(`falda distill inspect: no pass found matching the given selector`);
      process.exit(1);
    }
    const db = new Database(pass.store.dbPath, { readonly: true, fileMustExist: true });
    try {
      const fixture = buildDistillFixture(db, pass, { verbose: opts.verbose });
      writeFixtureFile(opts.exportFixture, fixture);
      console.log(`Wrote fixture (${fixture.cases.length} case(s)) to ${opts.exportFixture}`);
    } finally {
      db.close();
    }
    return;
  }

  if (opts.json) {
    console.log(renderJson(report));
  } else {
    console.log(renderHuman(report, opts.verbose ?? false));
  }
}

const IS_MAIN = process.argv[1]?.endsWith("inspect/cli.js") || process.argv[1]?.endsWith("inspect/cli.ts")
  || process.argv[1]?.endsWith("inspect\\cli.js") || process.argv[1]?.endsWith("inspect\\cli.ts");
if (IS_MAIN) {
  try {
    main();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
