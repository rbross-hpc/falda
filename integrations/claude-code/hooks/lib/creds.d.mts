export interface McpCredentials {
  mcpUrl: string;
  token: string;
  tenant: string;
}

export interface HookFeatures {
  capture: boolean;
  autoRecall: boolean;
  distillOnCompact: boolean;
  recallOnCompact: boolean;
}

export function resolveCreds(
  env?: Record<string, string | undefined>,
): McpCredentials | null;

export function features(
  env?: Record<string, string | undefined>,
): HookFeatures;
