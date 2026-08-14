/**
 * Tool registry: each ToolDef registers one or more tools on a McpServer.
 * Splitting registration into small per-concern modules (tools/*.ts) keeps
 * the compact agent-facing surface (DEFAULT_TOOLS) and the tier-specific
 * storage surface (ADVANCED_TOOLS) easy to reason about and select between.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./context.js";

export type ToolDef = (server: McpServer, deps: ToolDeps) => void;

export type ToolsetName = "default" | "full";

import { registerRecall } from "./tools/recall.js";
import { registerRemember } from "./tools/remember.js";
import { registerForget } from "./tools/forget.js";
import { registerDistill } from "./tools/distill.js";
import { registerIdentity } from "./tools/identity.js";
import { registerStreamAdd } from "./tools/capture.js";
import { registerStreamAdvanced } from "./tools/advanced/stream.js";
import { registerAtomsAdvanced } from "./tools/advanced/atoms.js";
import { registerScenesAdvanced } from "./tools/advanced/scenes.js";
import { registerCoreAdvanced } from "./tools/advanced/core.js";

/** Compact, intention-level surface. Recommended default for agents. */
export const DEFAULT_TOOLS: ToolDef[] = [
  registerRecall,
  registerRemember,
  registerForget,
  registerDistill,
  registerIdentity,
  registerStreamAdd,
];

/** Tier-specific storage primitives — diagnostics/admin/advanced workflows. */
export const ADVANCED_TOOLS: ToolDef[] = [
  registerStreamAdvanced,
  registerAtomsAdvanced,
  registerScenesAdvanced,
  registerCoreAdvanced,
];

export const FULL_TOOLS: ToolDef[] = [...DEFAULT_TOOLS, ...ADVANCED_TOOLS];

export function toolsFor(toolset: ToolsetName): ToolDef[] {
  return toolset === "full" ? FULL_TOOLS : DEFAULT_TOOLS;
}

export function resolveToolset(explicit?: ToolsetName): ToolsetName {
  if (explicit) return explicit;
  return process.env.FALDA_MCP_TOOLSET === "full" ? "full" : "default";
}
