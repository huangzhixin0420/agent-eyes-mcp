import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MAX_RETURN_PREFIX, truncateForTool } from "../src/truncate.js";

describe("truncateForTool", () => {
  it("returns short text unchanged", async () => {
    expect(await truncateForTool("short")).toEqual({ text: "short" });
    expect(await truncateForTool("x".repeat(4000))).toEqual({ text: "x".repeat(4000) });
  });

  it("writes long text to a private temp file and returns the prefix plus the path", async () => {
    const long = "x".repeat(5000);
    const out = await truncateForTool(long);
    expect(out.truncatedTo).toBe(MAX_RETURN_PREFIX);
    expect(out.text.startsWith("x".repeat(MAX_RETURN_PREFIX))).toBe(true);
    expect(out.text).toContain("The full description was written to: ");
    const match = /was written to: (.+)$/.exec(out.text);
    expect(match).not.toBeNull();
    const file = match![1];
    const content = await fs.readFile(file, "utf8");
    expect(content).toBe(long);
    // the file and its directory are not world-readable
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    await fs.rm(file, { force: true });
  });
});
