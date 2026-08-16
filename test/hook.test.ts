import { describe, expect, it } from "vitest";
import { buildHintOutput } from "../src/hook.js";

describe("hook hint", () => {
  it("returns null when the prompt references no image", () => {
    expect(buildHintOutput("fix the failing test")).toBeNull();
    expect(buildHintOutput("")).toBeNull();
  });

  it("emits additionalContext when an image path is referenced", () => {
    const out = buildHintOutput("看一下 error.png 里的报错");
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out as string);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("error.png");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("describe_image");
    // never blocks the prompt
    expect(parsed.decision).toBeUndefined();
  });

  it("dedupes repeated references and lists multiple images", () => {
    const out = buildHintOutput("compare a.png with a.png and b.JPG");
    const parsed = JSON.parse(out as string);
    const ctx = parsed.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("a.png");
    expect(ctx).toContain("b.JPG");
    expect(ctx.indexOf("a.png")).toBe(ctx.lastIndexOf("a.png"));
  });

  it("does not match non-image extensions or bare words", () => {
    expect(buildHintOutput("update config.json and notes.txt")).toBeNull();
  });
});
