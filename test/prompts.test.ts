import { describe, expect, it } from "vitest";
import { DEFAULT_TASK, SYSTEM_PROMPT, buildImageSetInstructions, buildUserPrompt } from "../src/prompts.js";

describe("buildUserPrompt", () => {
  it("uses the describe prompt by default", () => {
    expect(buildUserPrompt()).toContain("Describe");
    expect(buildUserPrompt(undefined, undefined)).toContain("Describe");
  });

  it("uses the ocr prompt when task=ocr", () => {
    const p = buildUserPrompt(undefined, "ocr");
    expect(p.toLowerCase()).toContain("extract");
    expect(p.toLowerCase()).toContain("verbatim");
  });

  it("question overrides the task", () => {
    const p = buildUserPrompt("What is the error message?", "ocr");
    expect(p).toContain("What is the error message?");
    expect(p.toLowerCase()).not.toContain("extract");
  });

  it("question overrides ui and qa tasks as well", () => {
    expect(buildUserPrompt("Any buttons?", "ui")).toContain("Any buttons?");
    expect(buildUserPrompt("Is it red?", "qa")).toContain("Is it red?");
  });

  it("defaults to the describe task", () => {
    expect(DEFAULT_TASK).toBe("describe");
  });
});

describe("buildImageSetInstructions", () => {
  it("demands one section per image with the fixed heading format", () => {
    const p = buildImageSetInstructions(["a.png", "https://x.io/b.png"], [1, 1]);
    expect(p).toContain("## Image <N> (<label>)");
    expect(p).toContain("2 image(s)");
    expect(p).not.toContain("multiple views");
  });

  it("explains view ordering when any image has multiple views", () => {
    const p = buildImageSetInstructions(["big.png"], [5]);
    expect(p).toContain("view 1 is the full image");
    expect(p).toContain("left-to-right then top-to-bottom");
  });
});

describe("SYSTEM_PROMPT", () => {
  it("demands verbatim text and uncertainty disclosure", () => {
    const p = SYSTEM_PROMPT.toLowerCase();
    expect(p).toContain("verbatim");
    expect(p).toContain("unclear");
    expect(p).toContain("never invent");
  });
});
