/**
 * Private cross-tier context assembly (§8.9).
 *
 * Evaluation-only — not exposed via gateway or MCP.
 * Used by the retrieval evaluation harness to test whether cross-tier
 * assembly adds value beyond atom-ranking alone.
 *
 * Budget model: each tier gets a reserved fraction of the total budget.
 * Unused budget from one tier spills forward to the next, so nothing is
 * wasted when a tier is empty — but a greedy tier can never consume more
 * than (its own allowance + inherited spillover), so T1 atoms cannot
 * pre-empt T2 scenes or T3 core. Pinned atoms are satisfied first,
 * unconditionally within their reserved slice.
 *
 * Default fractions (configurable per call via TierBudgets):
 *   pinned  0.20   — standing instructions, always injected first
 *   atoms   0.40   — query-ranked T1 atoms
 *   scenes  0.25   — query-ranked T2 scenes (episodes + topics)
 *   core    0.15   — T3 core excerpt
 */
import type { Falda } from "../falda.js";

const PER_ITEM_CHAR_LIMIT = 2000;

function truncate(s: string, limit = PER_ITEM_CHAR_LIMIT): string {
  return s.length <= limit ? s : s.slice(0, limit - 3) + "...";
}

export interface TierBudgets {
  pinned: number;
  atoms: number;
  scenes: number;
  core: number;
}

const DEFAULT_TIER_BUDGETS: TierBudgets = {
  pinned: 0.20,
  atoms:  0.40,
  scenes: 0.25,
  core:   0.15,
};

export interface AssembledContext {
  pinned_atoms: string[];
  ranked_atoms: string[];
  scenes: string[];
  core: string | null;
  total_chars: number;
  budget_chars: number;
  /** Chars actually used per tier (for eval assertions). */
  per_tier_chars: { pinned: number; atoms: number; scenes: number; core: number };
}

export async function assembleContext(
  store: Falda,
  query: string,
  budget: number,
  tierBudgets: Partial<TierBudgets> = {},
): Promise<AssembledContext> {
  const fractions: TierBudgets = { ...DEFAULT_TIER_BUDGETS, ...tierBudgets };

  // Normalize so fractions always sum to 1 (defensive against partial overrides).
  const total = fractions.pinned + fractions.atoms + fractions.scenes + fractions.core;
  if (total <= 0) throw new Error("TierBudgets fractions must sum to > 0");
  const norm = (f: number) => Math.floor(budget * (f / total));

  // Per-tier char allowances.
  let pinnedAllowance = norm(fractions.pinned);
  let atomsAllowance  = norm(fractions.atoms);
  let scenesAllowance = norm(fractions.scenes);
  let coreAllowance   = budget - pinnedAllowance - atomsAllowance - scenesAllowance; // remainder

  let spillover = 0;
  const ctx: AssembledContext = {
    pinned_atoms: [],
    ranked_atoms: [],
    scenes: [],
    core: null,
    total_chars: 0,
    budget_chars: budget,
    per_tier_chars: { pinned: 0, atoms: 0, scenes: 0, core: 0 },
  };

  // ── 1. Pinned atoms ────────────────────────────────────────────────────────
  const pinnedCap = pinnedAllowance; // no spillover into pinned from prior tiers
  for (const a of store.getPinnedAtoms()) {
    const t = truncate(a.content);
    if (ctx.per_tier_chars.pinned + t.length > pinnedCap) break;
    ctx.pinned_atoms.push(t);
    ctx.per_tier_chars.pinned += t.length;
  }
  spillover = pinnedAllowance - ctx.per_tier_chars.pinned;

  // ── 2. Query-ranked atoms ──────────────────────────────────────────────────
  const atomsCap = atomsAllowance + spillover;
  spillover = 0;
  const pinnedIds = new Set(store.getPinnedAtoms().map((a) => a.id));
  const atomLimit = Math.max(10, Math.ceil(atomsCap / 200));
  const rankedAtoms = await store.searchAtoms(query, atomLimit);
  for (const atom of rankedAtoms) {
    if (pinnedIds.has(atom.id)) continue;
    const t = truncate(atom.content);
    if (ctx.per_tier_chars.atoms + t.length > atomsCap) break;
    ctx.ranked_atoms.push(t);
    ctx.per_tier_chars.atoms += t.length;
  }
  spillover = atomsCap - ctx.per_tier_chars.atoms;

  // ── 3. Scenes ──────────────────────────────────────────────────────────────
  const scenesCap = scenesAllowance + spillover;
  spillover = 0;
  const sceneLimit = Math.max(5, Math.ceil(scenesCap / 400));
  const scenes = await store.searchScenes(query, sceneLimit);
  for (const sc of scenes) {
    const text = sc.summary
      ? `[${sc.scene_kind}] ${sc.title}\n${sc.summary}`
      : `[${sc.scene_kind}] ${sc.title}`;
    const t = truncate(text);
    if (ctx.per_tier_chars.scenes + t.length > scenesCap) break;
    ctx.scenes.push(t);
    ctx.per_tier_chars.scenes += t.length;
  }
  spillover = scenesCap - ctx.per_tier_chars.scenes;

  // ── 4. Core excerpt ────────────────────────────────────────────────────────
  const coreCap = coreAllowance + spillover;
  const core = store.readCore();
  if (core && coreCap > 50) {
    const t = truncate(core, coreCap);
    ctx.core = t;
    ctx.per_tier_chars.core = t.length;
  }

  ctx.total_chars =
    ctx.per_tier_chars.pinned +
    ctx.per_tier_chars.atoms +
    ctx.per_tier_chars.scenes +
    ctx.per_tier_chars.core;

  return ctx;
}
