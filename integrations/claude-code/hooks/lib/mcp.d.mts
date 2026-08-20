import type { McpCredentials } from "./creds.mjs";

export interface JsonRpcEnvelope {
  error?: unknown;
  result?: {
    isError?: boolean;
    content?: Array<{ text?: string }>;
  };
}

export function parseEnvelope(
  raw: string,
  contentType: string,
): JsonRpcEnvelope | null;

export function callTool(
  creds: McpCredentials,
  name: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<Record<string, unknown> | null>;
