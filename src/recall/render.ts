/**
 * Shared rendering for an assembled recall context — one function, used by
 * both the MCP `falda_recall` tool (src/mcp/tools/recall.ts) and the HTTP
 * `/recall` route (src/gateway.ts), so the two surfaces never drift on what
 * "the recall result" looks like as text. Previously this lived only in
 * mcp/tools/recall.ts; the HTTP gateway's /recall response did not include
 * rendered text at all (only structured `items` metadata) — a real gap for
 * anything that wants to *show* a recall rather than just log its
 * provenance (see src/show/recall.ts).
 */
import type { AssembledContext } from "../distill/context.js";

export function renderContext(ctx: AssembledContext): string {
  const sections: string[] = [];
  if (ctx.pinned_atoms.length) sections.push(["## Pinned", ...ctx.pinned_atoms].join("\n"));
  if (ctx.ranked_atoms.length) sections.push(["## Relevant facts/preferences/rules", ...ctx.ranked_atoms].join("\n"));
  if (ctx.scenes.length) sections.push(["## Related episodes/topics", ...ctx.scenes].join("\n"));
  if (ctx.core) sections.push(["## Project/persona core", ctx.core].join("\n"));
  return sections.join("\n\n");
}
