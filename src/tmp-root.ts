import * as os from "node:os";
import * as path from "node:path";

/** Root of all agent-eyes-mcp runtime scratch files (truncated output, disk cache). */
export function tmpRoot(): string {
  return path.join(os.tmpdir(), "agent-eyes-mcp");
}
