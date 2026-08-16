export type AgentEyesErrorCode =
  | "invalid_image"
  | "unsupported_type"
  | "file_not_found"
  | "sandbox_denied"
  | "ssrf_blocked"
  | "fetch_failed"
  | "too_large"
  | "config_missing"
  | "provider_error"
  | "output_error"
  | "internal";

/**
 * Typed error used across the whole pipeline. Tool/CLI handlers catch every
 * throw and convert it to structured, actionable error text — nothing ever
 * escapes to crash the process.
 */
export class AgentEyesError extends Error {
  constructor(
    readonly code: AgentEyesErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "AgentEyesError";
  }
}

/** Convert any thrown value into the user-facing error text returned by the MCP tool / CLI. */
export function toUserText(err: unknown): string {
  if (err instanceof AgentEyesError) {
    const hint = err.hint ? ` ${err.hint}` : "";
    return `[agent-eyes-mcp] Error (${err.code}): ${err.message}${hint}`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `[agent-eyes-mcp] Error (internal): ${msg}`;
}
