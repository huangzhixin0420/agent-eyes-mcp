import { describe, expect, it } from "vitest";
import { cacheKey, createLruCache } from "../src/cache.js";

describe("LRU cache", () => {
  it("returns undefined on miss and the value on hit", () => {
    const c = createLruCache<string, string>(128);
    expect(c.get("a")).toBeUndefined();
    c.set("a", "1");
    expect(c.get("a")).toBe("1");
  });

  it("evicts the least recently used entry", () => {
    const c = createLruCache<string, string>(2);
    c.set("a", "1");
    c.set("b", "2");
    c.get("a"); // refresh a
    c.set("c", "3"); // evicts b
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe("1");
    expect(c.get("c")).toBe("3");
  });

  it("respects the 128-entry capacity", () => {
    const c = createLruCache<number, number>(128);
    for (let i = 0; i < 200; i++) c.set(i, i);
    expect(c.size()).toBe(128);
    expect(c.get(0)).toBeUndefined();
    expect(c.get(199)).toBe(199);
  });

  it("re-setting a key refreshes its recency", () => {
    const c = createLruCache<string, string>(2);
    c.set("a", "1");
    c.set("b", "2");
    c.set("a", "1b");
    c.set("c", "3"); // evicts b (a was touched last)
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe("1b");
  });
});

describe("cacheKey", () => {
  it("produces distinct keys for different bytes / prompts / models", () => {
    const keys = [
      cacheKey(Buffer.from([1]), "p", "m"),
      cacheKey(Buffer.from([1]), "p", "m2"),
      cacheKey(Buffer.from([1]), "q", "m"),
      cacheKey(Buffer.from([2]), "p", "m"),
    ];
    expect(new Set(keys).size).toBe(4);
  });

  it("produces the same key for identical bytes + prompt + model", () => {
    expect(cacheKey(Buffer.from([1, 2, 3]), "hello", "qwen")).toBe(cacheKey(Buffer.from([1, 2, 3]), "hello", "qwen"));
  });

  it("accepts multiple view buffers in order (multi-view / multi-image)", () => {
    const a = Buffer.from([1]);
    const b = Buffer.from([2]);
    expect(cacheKey([a, b], "p", "m")).toBe(cacheKey([a, b], "p", "m"));
    expect(cacheKey([b, a], "p", "m")).not.toBe(cacheKey([a, b], "p", "m")); // order matters
    expect(cacheKey([a, b], "p", "m")).not.toBe(cacheKey([Buffer.from([1, 2])], "p", "m")); // not just concatenation
    expect(cacheKey(a, "p", "m")).toBe(cacheKey([a], "p", "m")); // single buffer equals one-element array
  });

  it("scopes the key by provider name and detail when given", () => {
    const base = cacheKey(Buffer.from([1]), "p", "m");
    expect(cacheKey(Buffer.from([1]), "p", "m", "openai")).not.toBe(base);
    expect(cacheKey(Buffer.from([1]), "p", "m", "openai", "low")).not.toBe(cacheKey(Buffer.from([1]), "p", "m", "openai", "high"));
    expect(cacheKey(Buffer.from([1]), "p", "m", "openai", "high")).toBe(cacheKey(Buffer.from([1]), "p", "m", "openai", "high"));
  });
});
