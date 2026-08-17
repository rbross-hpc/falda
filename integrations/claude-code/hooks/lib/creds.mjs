/**
 * Credential + feature-flag resolution.
 *
 * Reads exactly the same environment variables the plugin's .mcp.json
 * interpolates, so the hooks and the model's MCP tools cannot address
 * different tenants. This is opencode's core discipline, reproduced by
 * construction rather than by a config lookup.
 */

/** Resolve MCP credentials, or null if this project has no FALDA tenant. */
export function resolveCreds(env = process.env) {
  const mcpUrl = env.FALDA_MCP_URL ?? "http://localhost:8079/mcp";
  const token = env.FALDA_TOKEN;
  const tenant = env.FALDA_TENANT;
  if (!token || !tenant) return null;
  return { mcpUrl, token, tenant };
}

/** Feature gating. Every feature is on unless its var is exactly "0". */
export function features(env = process.env) {
  const on = (v) => v !== "0";
  const capture = on(env.FALDA_CAPTURE);
  return {
    capture,
    autoRecall: on(env.FALDA_AUTO_RECALL),
    distillOnCompact: on(env.FALDA_DISTILL_ON_COMPACT),
    // Post-compaction recall re-surfaces detail the compaction summary
    // dropped, which only exists in T0 if capture is writing there.
    recallOnCompact: capture && on(env.FALDA_RECALL_ON_COMPACT),
  };
}
