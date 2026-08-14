/**
 * Private cross-tier context assembly (§8.9).
 *
 * Evaluation-only — not exposed via gateway or MCP.
 * Used by the retrieval evaluation harness to test whether cross-tier
 * assembly adds value beyond atom-ranking alone.
 *
 * Assembly order (highest to lowest priority within budget):
 *   1. Pinned atoms (unconditional, reserved budget slice)
 *   2. Query-ranked active atoms (ranked recall)
 *   3. Query-ranked active scenes, across both kinds (episode + topic)
 *   4. Core excerpt
 */
import type { Falda } from "../falda.js";

const PER_ITEM_CHAR_LIMIT = 2000;
const PINNED_BUDGET_FRACTION = 0.25;

function truncate(s: string, limit = PER_ITEM_CHAR_LIMIT): string {
  return s.length <= limit ? s : s.slice(0, limit - 3) + "...";
}

export interface AssembledContext {
  pinned_atoms: string[];
  ranked_atoms: string[];
  scenes: string[];
  core: string | null;
  total_chars: number;
  budget_chars: number;
}

export async function assembleContext(
  store: Falda,
  query: string,
  budget: number,
): Promise<AssembledContext> {
  const pinnedBudget = Math.floor(budget * PINNED_BUDGET_FRACTION);
  let used = 0;
  const ctx: AssembledContext = {
    pinned_atoms: [],
    ranked_atoms: [],
    scenes: [],
    core: null,
    total_chars: 0,
    budget_chars: budget,
  };

  // 1. Pinned atoms — unconditional within reserved slice.
  const db = (store as any).db as import("better-sqlite3").Database;
  const pinned = db.prepare(
    "SELECT content FROM atoms WHERE status='active' AND pinned=1"
  ).all() as Array<{ content: string }>;
  for (const p of pinned) {
    const t = truncate(p.content);
    if (used + t.length > pinnedBudget) break;
    ctx.pinned_atoms.push(t);
    used += t.length;
  }

  // 2. Query-ranked atoms — remaining budget.
  const atomLimit = Math.ceil((budget - used) / 200);
  const rankedAtoms = await store.searchAtoms(query, Math.max(atomLimit, 10));
  const pinnedIds = new Set(
    (db.prepare("SELECT id FROM atoms WHERE pinned=1").all() as any[]).map((r: any) => r.id)
  );
  for (const atom of rankedAtoms) {
    if (pinnedIds.has(atom.id)) continue;
    const t = truncate(atom.content);
    if (used + t.length > budget) break;
    ctx.ranked_atoms.push(t);
    used += t.length;
  }

  // 3. Scenes — query-ranked, both kinds.
  const sceneLimit = Math.max(5, Math.ceil((budget - used) / 500));
  const scenes = await store.searchScenes(query, sceneLimit);
  for (const sc of scenes) {
    const text = sc.summary
      ? `[${sc.scene_kind}] ${sc.title}\n${sc.summary}`
      : `[${sc.scene_kind}] ${sc.title}`;
    const t = truncate(text);
    if (used + t.length > budget) break;
    ctx.scenes.push(t);
    used += t.length;
  }

  // 4. Core excerpt.
  const core = store.readCore();
  if (core) {
    const remaining = budget - used;
    if (remaining > 50) {
      const t = truncate(core, remaining);
      ctx.core = t;
      used += t.length;
    }
  }

  ctx.total_chars = used;
  return ctx;
}
