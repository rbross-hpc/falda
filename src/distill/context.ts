/**
 * Cross-tier context assembly (§8.9).
 *
 * Backs the compact `falda_recall` MCP tool (src/mcp/tools/recall.ts) as well
 * as the retrieval evaluation harness, which uses it to test whether
 * cross-tier assembly adds value beyond atom-ranking alone.
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
import { resolveAtomItemCap, resolveSceneItemCap } from "../recall/budgets.js";

/**
 * Per-item char caps, tier-specific rather than one global limit: T1 atoms
 * are short discrete facts (a large cap just wastes budget the admission
 * loop below could spend on more atoms instead); T2 scenes are
 * episode/topic summaries that need more room to carry a title+summary
 * usefully. Resolved once at module load — see src/recall/budgets.ts for
 * the FALDA_RECALL_ATOM_ITEM_CAP / FALDA_RECALL_SCENE_ITEM_CAP env vars.
 */
/** Exported for src/recall/reconstruct.ts, which re-renders a past trace's
 *  items against CURRENT content using the same per-item caps a live
 *  assembleContext() call would apply — a reconstruction should look like
 *  a real recall would today, not use different truncation rules. */
export const ATOM_ITEM_CAP = resolveAtomItemCap();
export const SCENE_ITEM_CAP = resolveSceneItemCap();

export function truncate(s: string, limit: number): string {
  return s.length <= limit ? s : s.slice(0, limit - 3) + "...";
}

export interface TierBudgets {
  pinned: number;
  atoms: number;
  scenes: number;
  core: number;
}

export const DEFAULT_TIER_BUDGETS: TierBudgets = {
  pinned: 0.20,
  atoms:  0.40,
  scenes: 0.25,
  core:   0.15,
};

/** Where an admitted item came from within the assembly pipeline. */
export type RecallItemSource = "pinned" | "ranked" | "scene" | "core";
/** What kind of underlying object an admitted item is. */
export type RecallItemKind = "atom" | "scene" | "core";

/**
 * Structured provenance for one item actually admitted into the assembled
 * context — survives rendering to text, and is what recall traces
 * (src/recall/) persist for later usage-reporting and evaluation.
 */
export interface RecallItem {
  tier: "T1" | "T2" | "T3";
  id: string;
  kind: RecallItemKind;
  source: RecallItemSource;
  /** Characters this item contributed to the rendered context. */
  chars: number;
  score?: number;
}

/** @deprecated renamed to RecallItem (kept as an alias during migration). */
export type ContextHit = RecallItem;

export interface AssembledContext {
  pinned_atoms: string[];
  ranked_atoms: string[];
  scenes: string[];
  core: string | null;
  total_chars: number;
  budget_chars: number;
  /** Chars actually used per tier (for eval assertions). */
  per_tier_chars: { pinned: number; atoms: number; scenes: number; core: number };
  /** Structured provenance for each item actually admitted into the context, in admission/rank order. */
  items: RecallItem[];
  /** True if any tier had a candidate that didn't fit its budget. */
  truncated: boolean;
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
  let truncated = false;
  const ctx: AssembledContext = {
    pinned_atoms: [],
    ranked_atoms: [],
    scenes: [],
    core: null,
    total_chars: 0,
    budget_chars: budget,
    per_tier_chars: { pinned: 0, atoms: 0, scenes: 0, core: 0 },
    items: [],
    truncated: false,
  };

  // ── 1. Pinned atoms ────────────────────────────────────────────────────────
  const pinnedCap = pinnedAllowance; // no spillover into pinned from prior tiers
  const pinnedAtoms = store.getPinnedAtoms();
  for (const a of pinnedAtoms) {
    const t = truncate(a.content, ATOM_ITEM_CAP);
    if (ctx.per_tier_chars.pinned + t.length > pinnedCap) { truncated = true; break; }
    ctx.pinned_atoms.push(t);
    ctx.per_tier_chars.pinned += t.length;
    ctx.items.push({ tier: "T1", id: a.id, kind: "atom", source: "pinned", chars: t.length });
  }
  spillover = pinnedAllowance - ctx.per_tier_chars.pinned;

  // ── 2. Query-ranked atoms ──────────────────────────────────────────────────
  const atomsCap = atomsAllowance + spillover;
  spillover = 0;
  const pinnedIds = new Set(pinnedAtoms.map((a) => a.id));
  // Fetch more candidates than the cap alone would suggest: with a per-item
  // cap smaller than a candidate's actual content, more candidates can fit
  // than a naive "cap / typical size" estimate assumes, and skip-and-continue
  // below (rather than stopping at the first non-fitting item) needs extra
  // candidates in the pool to skip past a large one and keep filling the tier.
  const atomLimit = Math.max(15, Math.ceil((atomsCap / 100) * 1.5));
  const rankedAtoms = await store.searchAtoms(query, atomLimit);
  for (const atom of rankedAtoms) {
    if (pinnedIds.has(atom.id)) continue;
    const t = truncate(atom.content, ATOM_ITEM_CAP);
    // Skip (not break): a low-ranked atom that happens to fit should still
    // get a chance to fill the tier even if a higher-ranked one didn't fit —
    // stopping at the first miss left the remaining budget unused whenever a
    // large item was ranked ahead of several small ones.
    if (ctx.per_tier_chars.atoms + t.length > atomsCap) { truncated = true; continue; }
    ctx.ranked_atoms.push(t);
    ctx.per_tier_chars.atoms += t.length;
    ctx.items.push({ tier: "T1", id: atom.id, kind: "atom", source: "ranked", chars: t.length, score: atom.score });
  }
  spillover = atomsCap - ctx.per_tier_chars.atoms;

  // ── 3. Scenes ──────────────────────────────────────────────────────────────
  const scenesCap = scenesAllowance + spillover;
  spillover = 0;
  // Same over-fetch rationale as atomLimit above, scaled to scenes' larger
  // per-item cap and typically-longer rendered text.
  const sceneLimit = Math.max(8, Math.ceil((scenesCap / 300) * 1.5));
  const scenes = await store.searchScenes(query, sceneLimit);
  for (const sc of scenes) {
    const text = sc.summary
      ? `[${sc.scene_kind}] ${sc.title}\n${sc.summary}`
      : `[${sc.scene_kind}] ${sc.title}`;
    const t = truncate(text, SCENE_ITEM_CAP);
    if (ctx.per_tier_chars.scenes + t.length > scenesCap) { truncated = true; continue; }
    ctx.scenes.push(t);
    ctx.per_tier_chars.scenes += t.length;
    ctx.items.push({ tier: "T2", id: sc.scene_id, kind: "scene", source: "scene", chars: t.length, score: sc.score });
  }
  spillover = scenesCap - ctx.per_tier_chars.scenes;

  // ── 4. Core excerpt ────────────────────────────────────────────────────────
  const coreCap = coreAllowance + spillover;
  const core = store.readCore();
  if (core && coreCap > 50) {
    const t = truncate(core, coreCap);
    ctx.core = t;
    ctx.per_tier_chars.core = t.length;
    ctx.items.push({ tier: "T3", id: "core", kind: "core", source: "core", chars: t.length });
    if (t.length < core.length) truncated = true;
  } else if (core) {
    truncated = true;
  }

  ctx.total_chars =
    ctx.per_tier_chars.pinned +
    ctx.per_tier_chars.atoms +
    ctx.per_tier_chars.scenes +
    ctx.per_tier_chars.core;
  ctx.truncated = truncated;

  return ctx;
}
