/**
 * Reconstruct a past recall trace's rendered context from CURRENT memory
 * state (src/gateway.ts's /recalls/reconstruct route, backing
 * `falda show recall`).
 *
 * A recall trace (src/recall/traces.ts) never stored the rendered text an
 * agent actually saw — only the query, budget, and each admitted item's
 * {tier, id, source, score, chars}. This is NOT a byte-faithful replay:
 * it re-fetches each item's CURRENT content and re-renders it with today's
 * tier-item caps (src/distill/context.ts), so an atom superseded/archived,
 * a scene retired, or core regenerated/deleted since the recall will show
 * up in `stale_items` rather than silently vanishing or showing stale
 * text. Callers must surface `stale_items` — it is the whole point of
 * being honest that this is a reconstruction, not a recording.
 */
import type { Falda } from "../falda.js";
import type { RecallTraceView } from "./types.js";
import { renderContext } from "./render.js";
import { ATOM_ITEM_CAP, SCENE_ITEM_CAP, truncate, type AssembledContext } from "../distill/context.js";

export type StaleReason = "not_found" | "superseded" | "merged" | "archived" | "retired" | "deleted";

export interface StaleItem {
  tier: "T1" | "T2" | "T3";
  id: string;
  reason: StaleReason;
}

export interface ReconstructedRecall {
  trace: RecallTraceView;
  context: string;
  stale_items: StaleItem[];
}

function sceneText(kind: string, title: string, summary: string | null): string {
  return summary ? `[${kind}] ${title}\n${summary}` : `[${kind}] ${title}`;
}

/**
 * Rebuild the sectioned text (Pinned / Relevant facts / Related
 * episodes-topics / Core) a trace's items would render to today, plus the
 * list of items that no longer resolve to the same live content they did
 * at recall time.
 */
export function reconstructRecallTrace(store: Falda, trace: RecallTraceView): ReconstructedRecall {
  const pinned_atoms: string[] = [];
  const ranked_atoms: string[] = [];
  const scenes: string[] = [];
  let core: string | null = null;
  const stale_items: StaleItem[] = [];

  // Items are already stored/returned in rank order (ordinal) — preserve it.
  for (const item of trace.items) {
    if (item.tier === "T1") {
      const atom = store.getAtom(item.id);
      if (!atom) { stale_items.push({ tier: "T1", id: item.id, reason: "not_found" }); continue; }
      if (atom.status !== "active") {
        const reason: StaleReason = atom.status === "superseded" ? "superseded"
          : atom.status === "merged" ? "merged" : "archived";
        stale_items.push({ tier: "T1", id: item.id, reason });
        continue;
      }
      const text = truncate(atom.content, ATOM_ITEM_CAP);
      if (item.source === "pinned") pinned_atoms.push(text);
      else ranked_atoms.push(text);
    } else if (item.tier === "T2") {
      const scene = store.getScene(item.id);
      if (!scene) { stale_items.push({ tier: "T2", id: item.id, reason: "not_found" }); continue; }
      if (scene.status !== "active") {
        stale_items.push({ tier: "T2", id: item.id, reason: "retired" });
        continue;
      }
      scenes.push(truncate(sceneText(scene.scene_kind, scene.title, scene.summary), SCENE_ITEM_CAP));
    } else {
      // T3 core has no per-item id beyond the single conceptual "core"
      // document — check it still exists at all.
      const current = store.readCore();
      if (!current) { stale_items.push({ tier: "T3", id: item.id, reason: "deleted" }); continue; }
      core = current;
    }
  }

  const asContext: AssembledContext = {
    pinned_atoms, ranked_atoms, scenes, core,
    total_chars: 0, budget_chars: trace.requested_budget,
    per_tier_chars: { pinned: 0, atoms: 0, scenes: 0, core: 0 },
    items: [], truncated: false,
  };

  return { trace, context: renderContext(asContext), stale_items };
}
