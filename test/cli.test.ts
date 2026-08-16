import { describe, expect, it } from "vitest";
import { parseDescribeArgs } from "../src/cli.js";

describe("parseDescribeArgs", () => {
  it("parses multiple images and every option", () => {
    const r = parseDescribeArgs(["a.png", "b.png", "-q", "which is redder?", "-t", "ocr", "--detail", "low"]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.args.images).toEqual(["a.png", "b.png"]);
    expect(r.args.question).toBe("which is redder?");
    expect(r.args.task).toBe("ocr");
    expect(r.args.detail).toBe("low");
  });

  it("accepts the long-form --question flag and defaults", () => {
    const r = parseDescribeArgs(["a.png", "--question", "hello"]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.args.images).toEqual(["a.png"]);
    expect(r.args.question).toBe("hello");
    expect(r.args.task).toBeUndefined();
    expect(r.args.detail).toBeUndefined();
  });

  it("rejects a missing image argument", () => {
    const r = parseDescribeArgs(["-q", "hello"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.error).toContain("Missing required argument");
  });

  it("rejects an invalid task value", () => {
    const r = parseDescribeArgs(["a.png", "-t", "summarize"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.error).toContain('Invalid task "summarize"');
  });

  it("rejects an invalid detail value", () => {
    const r = parseDescribeArgs(["a.png", "--detail", "ultra"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.error).toContain('Invalid detail "ultra"');
  });

  it("rejects unknown options", () => {
    const r = parseDescribeArgs(["a.png", "--bogus"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.error).toContain('Unknown option "--bogus"');
  });

  it("rejects a missing option value", () => {
    expect(parseDescribeArgs(["a.png", "-q"]).kind).toBe("error");
    expect(parseDescribeArgs(["a.png", "--detail"]).kind).toBe("error");
  });

  it("returns help for --help and -h", () => {
    expect(parseDescribeArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseDescribeArgs(["-h"])).toEqual({ kind: "help" });
    // Help wins even when other args are present.
    expect(parseDescribeArgs(["a.png", "--help"]).kind).toBe("help");
  });
});
