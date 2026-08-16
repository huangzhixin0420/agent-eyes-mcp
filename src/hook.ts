import process from "node:process";

/**
 * Claude Code UserPromptSubmit hook, shipped as `agent-eyes-mcp hook` so it
 * works from an npx install (no repo checkout needed).
 *
 * When the user's message references an image file by name/path, a text-only
 * model would try to read the file directly and fail. The hook emits
 * `additionalContext` telling the agent to use the `describe_image` MCP tool
 * instead. It never blocks the prompt and prints nothing when no image
 * reference matches.
 */

const IMAGE_RE = /[\w./~-]+\.(?:png|jpe?g|webp|gif)\b/gi;

/** Returns the hint JSON line for a prompt, or null when no image is referenced. */
export function buildHintOutput(prompt: string): string | null {
  const matches = [...new Set(prompt.match(IMAGE_RE) ?? [])];
  if (matches.length === 0) return null;
  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `The user's message references image file(s): ${matches.join(", ")}. The text-only model cannot read image files directly. Use the agent-eyes describe_image tool instead: pass each file path as the "image" argument (a string or array of strings) and continue based on its description.`,
      },
    }) + "\n"
  );
}

/** Reads the hook payload from stdin; exits 0 silently on any unusable input. */
export async function runHook(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const input = JSON.parse(raw) as { prompt?: unknown };
    const out = buildHintOutput(typeof input?.prompt === "string" ? input.prompt : "");
    if (out) process.stdout.write(out);
  } catch {
    /* not a hook payload: stay silent */
  }
}
