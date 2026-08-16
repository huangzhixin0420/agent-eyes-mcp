/**
 * Logger. stdout is reserved for MCP JSON-RPC (or CLI output), so EVERY log
 * line goes to stderr. Never write to stdout from here.
 */
export function log(...args: unknown[]): void {
  const line = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  process.stderr.write(`[agent-eyes-mcp] ${line}\n`);
}
