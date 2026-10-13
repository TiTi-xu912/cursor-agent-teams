export class AgentTeamsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentTeamsError";
  }
}

export function invariant(
  condition: unknown,
  message: string,
  code = "INVALID_STATE",
  details?: Record<string, unknown>,
): asserts condition {
  if (!condition) {
    throw new AgentTeamsError(message, code, details);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
