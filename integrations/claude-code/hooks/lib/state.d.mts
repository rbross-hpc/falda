export interface HookState {
  recalled: boolean;
  postCompactPending: boolean;
}

export function stateDir(
  env?: Record<string, string | undefined>,
): string;

export function readState(
  sessionId: string,
  env?: Record<string, string | undefined>,
): HookState;

export function writeState(
  sessionId: string,
  next: Record<string, unknown>,
  env?: Record<string, string | undefined>,
): void;
