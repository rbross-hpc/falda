/**
 * FALDA distillation prompts and type constants.
 * Single source of truth for VALID_TYPES and all LLM prompt templates.
 */

export const VALID_TYPES = ["fact", "pattern", "preference", "constraint", "instruction"] as const;
export type DistillType = typeof VALID_TYPES[number];

export const VALID_CONFIDENCE = ["high", "medium", "low"] as const;
export type DistillConfidence = typeof VALID_CONFIDENCE[number];

/**
 * Hand-maintained identifier for the current extraction/consolidation/scene/
 * core prompt set. Bump this whenever any prompt template in this file
 * changes meaning (not for pure formatting/typo fixes) — it is persisted on
 * every distillation_passes row (see src/distill/core.ts) so `falda distill
 * inspect` can attribute a decision to the prompt policy that produced it,
 * independent of the LLM model used.
 */
export const PROMPT_VERSION = "distill-prompts-v3";

/** L1 extraction: extract candidate atoms from a window of turns. */
export function extractionPrompt(turns: Array<{ role: string; content: string }>): string {
  const transcript = turns.map((t) => `${t.role}: ${t.content}`).join("\n");
  return `You are a memory distillation assistant. Extract durable, concise atomic memories from the conversation below.

For each memory, output a JSON object on its own line with exactly these fields:
  type: one of ${VALID_TYPES.join(" | ")}
  content: a single, self-contained sentence (≤120 words) stating the memory
  confidence: one of ${VALID_CONFIDENCE.join(" | ")} — how faithfully this captures the source turns

Rules:
- Extract only durable knowledge (facts, preferences, constraints, patterns, instructions).
- Skip transient, conversational, or low-value content.
- Each line must be valid JSON. Output ONLY the JSON lines, no other text.
- Use "fact" for stable truths, "pattern" for recurring behaviors, "preference" for likes/dislikes,
  "constraint" for hard rules, "instruction" for standing directives.
- If there is nothing durable to extract, output exactly: []

Conversation:
${transcript}`;
}

/** L1 consolidation: decide what to do with a candidate atom given existing atoms. */
export function consolidationPrompt(
  candidate: { type: string; content: string; confidence: string },
  existing: Array<{ id: string; type: string; content: string; confidence: string }>,
): string {
  const existingList = existing.map((a, i) =>
    `  ${i + 1}. [${a.id}] (${a.type}, ${a.confidence}) ${a.content}`
  ).join("\n");
  return `You are a memory consolidation assistant. Decide what to do with a candidate memory given existing memories.

Candidate memory:
  type: ${candidate.type}
  confidence: ${candidate.confidence}
  content: ${candidate.content}

Existing active memories (up to 8):
${existingList || "  (none)"}

Output exactly one JSON object with:
  action: "store" | "update" | "merge" | "skip"
  target_ids: array of existing memory ids affected
  rationale: one sentence explaining the decision

Rules:
- "store": candidate is new knowledge not covered by any existing memory. target_ids must be exactly [].
- "update": candidate refreshes or corrects exactly one existing memory. target_ids must contain exactly that one id.
- "merge": candidate unifies 2 or more existing memories into one. target_ids must contain at least 2 distinct ids.
- "skip": candidate is redundant, transient, or low-value. target_ids must be exactly [].
- Only use ids from the provided existing memories above. Do not invent ids.

Output ONLY the JSON object, no other text.`;
}

/** L2 scene title: generate an LLM title for a scene given its member atoms. */
export function sceneTitlePrompt(
  scene_kind: "episode" | "topic",
  atoms: Array<{ type: string; content: string }>,
): string {
  const atomList = atoms.map((a, i) => `  ${i + 1}. (${a.type}) ${a.content}`).join("\n");
  return `Generate a concise title (≤8 words) for a ${scene_kind} scene containing these memories:
${atomList}

Output ONLY the title text, no quotes, no explanation.`;
}

/** L2 scene summary: generate a narrative summary for a scene. */
export function sceneSummaryPrompt(
  scene_kind: "episode" | "topic",
  title: string,
  atoms: Array<{ type: string; content: string }>,
): string {
  const atomList = atoms.map((a, i) => `  ${i + 1}. (${a.type}) ${a.content}`).join("\n");
  return `Write a concise narrative summary (2–4 sentences) for this ${scene_kind} titled "${title}".

Memories in this ${scene_kind}:
${atomList}

Output ONLY the summary prose, no headings, no bullet points.`;
}

/** L3 core synthesis: synthesize a persona/project core document from scene structure. */
export function coreSynthesisPrompt(
  scenes: Array<{
    scene_kind: string; title: string;
    atoms: Array<{ type: string; content: string }>;
  }>,
): string {
  const sceneList = scenes.map((sc) => {
    const atoms = sc.atoms.map((a) => `    - (${a.type}) ${a.content}`).join("\n");
    return `  ${sc.scene_kind.toUpperCase()}: ${sc.title}\n${atoms}`;
  }).join("\n\n");
  return `You are synthesizing a durable, compressed profile of an agent or project from its organized memory structure.

Memory structure (organized by kind and title):
${sceneList || "  (no scenes yet)"}

Write a markdown core document that:
1. Captures the agent/project's durable identity, goals, and key knowledge.
2. Is genuinely compressed — not a flat list of memories, but a coherent profile.
3. Is grounded only in the provided memories, not invented.
4. Starts with a # heading naming the agent/project.

Output ONLY the markdown document.`;
}

/** Batched form of consolidationPrompt: the same instructions, sent once, over
 *  N candidates. Each candidate keeps its own retrieved neighbour set — those
 *  genuinely differ per candidate and cannot be shared — so only the
 *  instruction block is deduplicated. Decisions come back keyed by the
 *  candidate index printed here. */
export function consolidationBatchPrompt(
  items: Array<{
    candidate: { type: string; content: string; confidence: string };
    existing: Array<{ id: string; type: string; content: string; confidence: string }>;
  }>,
): string {
  const blocks = items.map((item, i) => {
    const existingList = item.existing.map((a, j) =>
      `    ${j + 1}. [${a.id}] (${a.type}, ${a.confidence}) ${a.content}`
    ).join("\n");
    return `Candidate ${i}:
  type: ${item.candidate.type}
  confidence: ${item.candidate.confidence}
  content: ${item.candidate.content}
  Existing active memories for this candidate:
${existingList || "    (none)"}`;
  }).join("\n\n");

  return `You are a memory consolidation assistant. Decide what to do with each candidate memory below, given the existing memories listed for that candidate.

${blocks}

Output a JSON array with exactly one object per candidate, each with:
  candidate: the candidate's number as given above
  action: "store" | "update" | "merge" | "skip"
  target_ids: array of existing memory ids affected
  rationale: one sentence explaining the decision

Rules:
- "store": candidate is new knowledge not covered by any existing memory. target_ids must be exactly [].
- "update": candidate refreshes or corrects exactly one existing memory. target_ids must contain exactly that one id.
- "merge": candidate unifies 2 or more existing memories into one. target_ids must contain at least 2 distinct ids.
- "skip": candidate is redundant, transient, or low-value. target_ids must be exactly [].
- Only use ids from that candidate's own existing memories listed above. Do not invent ids.
- Decide each candidate independently. Include every candidate exactly once.

Output ONLY the JSON array, no other text.`;
}
