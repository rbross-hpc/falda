/**
 * FALDA distillation CLI — --once backfill or interval daemon.
 * Invoked as: tsx src/distill/cli.ts [--once] [--interval-ms=N]
 *
 * Env:
 *   FALDA_ROOT            Pool root dir
 *   FALDA_TENANT          Tenant to distill (required)
 *   FALDA_POOL            Pool to distill (default: self)
 *   FALDA_LLM_BASE_URL    OpenAI-compatible chat endpoint
 *   FALDA_LLM_API_KEY     API key (default: x)
 *   FALDA_LLM_MODEL       Model name (default: gpt-4o-mini)
 *   FALDA_DIM             Embedding dimensionality (default: 768)
 */
import { PoolManager } from "../pools.js";
import { selectEmbedder } from "../boot.js";
import { distillOnce } from "./core.js";
import { makeLLM } from "./llm.js";

async function run(once: boolean, intervalMs: number): Promise<void> {
  const ROOT = process.env.FALDA_ROOT ?? "./falda-data";
  const DIM = Number(process.env.FALDA_DIM ?? 768);
  const TENANT = process.env.FALDA_TENANT;
  const POOL = process.env.FALDA_POOL;

  if (!TENANT) {
    console.error("FALDA_TENANT must be set");
    process.exit(1);
  }

  const pools = new PoolManager({ root: ROOT, embed: selectEmbedder(DIM, "distill-cli"), dim: DIM });
  const llm = makeLLM();

  const doPass = async () => {
    const store = pools.resolve(TENANT!, POOL, true);
    const storeKey = `${TENANT}:${POOL ?? "self"}`;
    try {
      const result = await distillOnce(store, llm, { storeKey, verbose: true });
      console.log(`[distill-cli] pass ${result.pass_id}: ${result.turns_processed} turns, ` +
        `${result.atoms_stored} stored, ${result.atoms_updated} updated, ${result.atoms_merged} merged`);
    } catch (e) {
      console.error("[distill-cli] pass failed:", e);
    }
  };

  if (once) {
    await doPass();
    pools.closeAll();
  } else {
    console.log(`[distill-cli] daemon mode, interval=${intervalMs}ms`);
    await doPass();
    setInterval(doPass, intervalMs);
  }
}

const args = process.argv.slice(2);
const once = args.includes("--once");
const intervalArg = args.find((a) => a.startsWith("--interval-ms="));
const intervalMs = intervalArg ? Number(intervalArg.split("=")[1]) : 60_000;

run(once, intervalMs).catch((e) => { console.error(e); process.exit(1); });
