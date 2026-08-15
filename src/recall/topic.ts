/**
 * Resolve a `topic` request parameter (POST /recall's optional `topic`
 * field, backing `falda show recall --topic=...`) to an active topic
 * scene's title, which then becomes the recall query. Server-side so the
 * CLI stays a pure HTTP client with no store access of its own (one round
 * trip, not a scene lookup followed by a recall call).
 *
 * Matching order: exact scene_id first (unambiguous), then a
 * case-insensitive substring match against active topic scene titles. If
 * more than one active topic title matches the substring, the most
 * recently updated one wins — same recency bias listScenes() already
 * applies (ORDER BY updated_at DESC), not a new policy invented here.
 */
import type { Falda } from "../falda.js";

export class TopicNotFoundError extends Error {
  constructor(msg: string) { super(msg); this.name = "TopicNotFoundError"; }
}

export function resolveTopicQuery(store: Falda, topic: string): string {
  const byId = store.getScene(topic);
  if (byId && byId.scene_kind === "topic" && byId.status === "active") {
    return byId.title;
  }

  const { items } = store.listScenes({ scene_kind: "topic", status: "active", limit: 200 });
  const needle = topic.toLowerCase();
  const match = items.find((s) => s.title.toLowerCase().includes(needle));
  if (!match) {
    throw new TopicNotFoundError(
      `no active topic scene matches '${topic}' (tried exact scene_id, then a title substring match)`,
    );
  }
  return match.title;
}
