/**
 * Recall budget resolution — env-configurable character budgets for the
 * two recall entry points, plus the safety-ceiling clamp shared by both.
 *
 * Two-tier model:
 *   explicit budget — a model deliberately calling falda_recall (or
 *                     POST /recall) to dig into memory. Higher default:
 *                     it's a conscious choice to spend more context.
 *   auto budget     — fired automatically per task by a harness
 *                     integration (e.g. the opencode capture plugin)
 *                     before the model has asked for anything. Kept
 *                     smaller by default so it doesn't crowd out the
 *                     task prompt itself.
 * FALDA_RECALL_MAX_BUDGET is a hard ceiling applied to both — a
 * caller-supplied `budget` can request up to this much, never more,
 * regardless of mode.
 *
 * Resolved once at module load (env is fixed for the lifetime of a
 * process), matching the existing FALDA_PORT/FALDA_WORKER_INTERVAL_MS
 * style (see src/server.ts, src/gateway.ts).
 */

export const MIN_RECALL_BUDGET = 500;
export const DEFAULT_RECALL_BUDGET = 6000;
export const DEFAULT_AUTO_RECALL_BUDGET = 3500;
export const DEFAULT_MAX_RECALL_BUDGET = 20000;

/**
 * Per-item character caps applied in assembleContext() (src/distill/context.ts)
 * when admitting one T1 atom or T2 scene into the assembled context. Tier-
 * specific rather than one global cap: T1 atoms are short, discrete facts —
 * a large cap wastes budget an admitting loop could otherwise spend on more
 * atoms; T2 scenes are episode/topic summaries that need more room to be
 * useful at all. Deployment-tunable since "how verbose is a typical atom vs.
 * scene" is corpus-dependent, not a universal constant.
 */
export const DEFAULT_ATOM_ITEM_CAP = 600;
export const DEFAULT_SCENE_ITEM_CAP = 1800;

/**
 * recallAtoms()'s legacy T1-only budget (src/falda.ts) — not on the live
 * assembleContext recall path (falda_recall / POST /recall); only exercised
 * by tests today. Lowered from its old hardcoded 12000 to align with the
 * new explicit-recall default rather than carry an oversized, unreviewed
 * ceiling forward.
 */
export const DEFAULT_LEGACY_ATOM_BUDGET = 6000;

function resolveIntEnv(envValue: string | undefined, fallback: number): number {
  if (envValue === undefined || envValue === "") return fallback;
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function resolveRecallBudget(envValue: string | undefined = process.env.FALDA_RECALL_BUDGET): number {
  return resolveIntEnv(envValue, DEFAULT_RECALL_BUDGET);
}

export function resolveAutoRecallBudget(envValue: string | undefined = process.env.FALDA_AUTO_RECALL_BUDGET): number {
  return resolveIntEnv(envValue, DEFAULT_AUTO_RECALL_BUDGET);
}

export function resolveMaxRecallBudget(envValue: string | undefined = process.env.FALDA_RECALL_MAX_BUDGET): number {
  return resolveIntEnv(envValue, DEFAULT_MAX_RECALL_BUDGET);
}

export function resolveLegacyAtomBudget(envValue: string | undefined = process.env.FALDA_LEGACY_ATOM_BUDGET): number {
  return resolveIntEnv(envValue, DEFAULT_LEGACY_ATOM_BUDGET);
}

export function resolveAtomItemCap(envValue: string | undefined = process.env.FALDA_RECALL_ATOM_ITEM_CAP): number {
  return resolveIntEnv(envValue, DEFAULT_ATOM_ITEM_CAP);
}

export function resolveSceneItemCap(envValue: string | undefined = process.env.FALDA_RECALL_SCENE_ITEM_CAP): number {
  return resolveIntEnv(envValue, DEFAULT_SCENE_ITEM_CAP);
}
