import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentEyesError } from "./errors.js";
import { tmpRoot } from "./tmp-root.js";

export const MAX_FULL_OUTPUT = 4000;
export const MAX_RETURN_PREFIX = 2000;

export interface TruncatedText {
  text: string;
  /** Present when `text` was clipped to the first MAX_RETURN_PREFIX characters. */
  truncatedTo?: number;
}

// Memoized: the output dir is created and tightened once per process.
// A failed attempt resets the memo so a transient error is not sticky.
let dirReady: Promise<string> | undefined;

async function ensureTempDir(): Promise<string> {
  const dir = path.join(tmpRoot(), "truncated");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode applies only to newly created dirs; enforce it on existing ones too.
  await fs.chmod(dir, 0o700);
  return dir;
}

/**
 * Output protection for MCP tool replies: descriptions longer than
 * MAX_FULL_OUTPUT chars are written in full to a private temp file
 * (0700 dir / 0600 file); the tool returns the first MAX_RETURN_PREFIX chars
 * plus the file path, and records the truncation for structured output.
 */
export async function truncateForTool(text: string): Promise<TruncatedText> {
  if (text.length <= MAX_FULL_OUTPUT) return { text };
  let file: string;
  try {
    dirReady ??= ensureTempDir().catch((err) => {
      dirReady = undefined;
      throw err;
    });
    const dir = await dirReady;
    file = path.join(dir, `description-${randomUUID()}.txt`);
    await fs.writeFile(file, text, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AgentEyesError(
      "output_error",
      `Failed to write the full description to a temporary file: ${msg}`,
      "The description below is truncated and incomplete.",
    );
  }
  return {
    text: `${text.slice(0, MAX_RETURN_PREFIX)}\n\n[agent-eyes-mcp] The description is ${text.length} characters. The full description was written to: ${file}`,
    truncatedTo: MAX_RETURN_PREFIX,
  };
}
