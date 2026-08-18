import { afterEach, describe, expect, it } from "vitest";
import { envTimeoutMs } from "../src/env.js";

const NAME = "AGENT_EYES_TEST_TIMEOUT_MS";

afterEach(() => {
  delete process.env[NAME];
});

describe("envTimeoutMs", () => {
  it("falls back when unset or empty", () => {
    expect(envTimeoutMs(NAME, 1234)).toBe(1234);
    process.env[NAME] = "";
    expect(envTimeoutMs(NAME, 1234)).toBe(1234);
    process.env[NAME] = "   ";
    expect(envTimeoutMs(NAME, 1234)).toBe(1234);
  });

  it("falls back on non-numeric, zero, negative, and non-finite values", () => {
    for (const bad of ["abc", "0", "-5", "NaN", "Infinity", "1e999"]) {
      process.env[NAME] = bad;
      expect(envTimeoutMs(NAME, 1234), `value ${bad}`).toBe(1234);
    }
  });

  it("parses positive numbers and floors fractions", () => {
    process.env[NAME] = "5000";
    expect(envTimeoutMs(NAME, 1234)).toBe(5000);
    process.env[NAME] = "1500.9";
    expect(envTimeoutMs(NAME, 1234)).toBe(1500);
    process.env[NAME] = " 250 ";
    expect(envTimeoutMs(NAME, 1234)).toBe(250);
  });
});
