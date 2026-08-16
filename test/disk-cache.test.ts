import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDiskCache, createDiskCacheFromEnv } from "../src/disk-cache.js";

let tmp: string | undefined;

afterEach(async () => {
  if (tmp) {
    await fs.rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe("disk cache", () => {
  it("round-trips a value and persists it to disk", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-eyes-disk-"));
    const cache = createDiskCache(true, tmp);
    expect(cache.enabled).toBe(true);
    expect(await cache.get("abc")).toBeUndefined();
    await cache.set("abc", "hello");
    expect(await cache.get("abc")).toBe("hello");
    // the file really exists on disk
    const files = await fs.readdir(tmp);
    expect(files).toContain("abc.txt");
  });

  it("is a no-op when disabled", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-eyes-disk-"));
    const cache = createDiskCache(false, tmp);
    expect(cache.enabled).toBe(false);
    await cache.set("abc", "hello");
    expect(await cache.get("abc")).toBeUndefined();
    expect(await fs.readdir(tmp)).toHaveLength(0);
  });

  it("creates the directory lazily", async () => {
    tmp = path.join(os.tmpdir(), "agent-eyes-disk-nested-" + Date.now(), "sub");
    const cache = createDiskCache(true, tmp);
    await cache.set("k", "v");
    expect(await cache.get("k")).toBe("v");
  });

  it("evicts the oldest entries when the cache exceeds maxEntries", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-eyes-disk-"));
    const cache = createDiskCache(true, tmp, 3);
    for (let i = 0; i < 5; i++) await cache.set(`k${i}`, `v${i}`);
    const files = (await fs.readdir(tmp)).filter((n) => n.endsWith(".txt")).sort();
    expect(files).toEqual(["k2.txt", "k3.txt", "k4.txt"]);
    expect(await cache.get("k0")).toBeUndefined();
    expect(await cache.get("k1")).toBeUndefined();
    expect(await cache.get("k4")).toBe("v4");
  });

  it("reads AGENT_EYES_DISK_CACHE from the environment", async () => {
    const prev = process.env.AGENT_EYES_DISK_CACHE;
    const prevDir = process.env.AGENT_EYES_DISK_CACHE_DIR;
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-eyes-disk-"));
    try {
      process.env.AGENT_EYES_DISK_CACHE = "1";
      process.env.AGENT_EYES_DISK_CACHE_DIR = tmp;
      const cache = createDiskCacheFromEnv();
      expect(cache.enabled).toBe(true);
      await cache.set("k", "v");
      expect(await cache.get("k")).toBe("v");
    } finally {
      if (prev === undefined) delete process.env.AGENT_EYES_DISK_CACHE;
      else process.env.AGENT_EYES_DISK_CACHE = prev;
      if (prevDir === undefined) delete process.env.AGENT_EYES_DISK_CACHE_DIR;
      else process.env.AGENT_EYES_DISK_CACHE_DIR = prevDir;
    }
  });
});
