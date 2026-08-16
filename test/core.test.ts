import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import { createLruCache } from "../src/cache.js";
import { buildStructuredContent, describeImage, labelOf } from "../src/core.js";
import { createDiskCache } from "../src/disk-cache.js";
import type { Detail, VisionImage, VisionProvider } from "../src/provider.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const DATA_URI = `data:image/png;base64,${PNG_BASE64}`;
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class FakeProvider implements VisionProvider {
  readonly name = "fake";
  readonly model: string;
  calls = 0;
  lastDetail: Detail | undefined;
  lastImages: VisionImage[] = [];
  lastPrompt = "";
  constructor(model = "fake-model", private readonly output = "fake description") {
    this.model = model;
  }
  async describe(images: VisionImage[], prompt: string, detail: Detail): Promise<string> {
    this.calls++;
    this.lastImages = images;
    this.lastPrompt = prompt;
    this.lastDetail = detail;
    return `${this.output} (detail=${detail})`;
  }
}

/** A valid, incompressible PNG whose byte size exceeds 10 MB. */
async function makeNoisePng(width = 1900, height = 1900): Promise<Buffer> {
  const raw = randomBytes(width * height * 3);
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe("describeImage pipeline", () => {
  it("caches identical image + question and skips the API on the second call", async () => {
    const provider = new FakeProvider();
    const r1 = await describeImage(DATA_URI, { question: "What color?" }, { provider });
    const r2 = await describeImage(DATA_URI, { question: "What color?" }, { provider });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(provider.calls).toBe(1);
    expect(r2.text).toBe(r1.text);
    expect(r1.meta?.cached).toBe(false);
    expect(r2.meta?.cached).toBe(true);
    expect(r1.meta?.provider).toBe("fake");
    expect(r1.meta?.imageCount).toBe(1);
  });

  it("misses the cache when the question differs", async () => {
    const provider = new FakeProvider();
    await describeImage(DATA_URI, { question: "q1" }, { provider });
    await describeImage(DATA_URI, { question: "q2" }, { provider });
    expect(provider.calls).toBe(2);
  });

  it("passes detail through to the provider", async () => {
    const provider = new FakeProvider();
    const r = await describeImage(DATA_URI, { detail: "low" }, { provider });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("detail=low");
    expect(provider.lastDetail).toBe("low");
  });

  it("returns actionable error text instead of throwing for out-of-bounds paths", async () => {
    const provider = new FakeProvider();
    const r = await describeImage("/etc/hosts", {}, { provider, cwd: process.cwd() });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("sandbox_denied");
    expect(provider.calls).toBe(0);
  });

  it("describes multiple images in one call, with per-image prompt instructions", async () => {
    const provider = new FakeProvider();
    const r = await describeImage([DATA_URI, DATA_URI], { question: "Which is redder?" }, { provider });
    expect(r.ok).toBe(true);
    expect(provider.calls).toBe(1);
    expect(provider.lastImages).toHaveLength(2);
    expect(r.meta?.imageCount).toBe(2);
    expect(provider.lastPrompt).toContain("## Image");
    expect(provider.lastPrompt).toContain("image(s)");
  });

  it("rejects multiple images whose combined raw size exceeds 20 MB", async () => {
    const big = Buffer.concat([PNG_HEADER, Buffer.alloc(11 * 1024 * 1024, 1)]);
    const uri = `data:image/png;base64,${big.toString("base64")}`;
    const provider = new FakeProvider();
    const r = await describeImage([uri, uri], {}, { provider });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("too_large");
    expect(r.error).toContain("20.0 MB");
    expect(provider.calls).toBe(0);
  });

  it("preprocesses (rather than rejects) a single image over 10 MB", async () => {
    const big = await makeNoisePng();
    expect(big.length).toBeGreaterThan(10 * 1024 * 1024);
    const provider = new FakeProvider();
    const r = await describeImage(`data:image/png;base64,${big.toString("base64")}`, {}, { provider });
    expect(r.ok).toBe(true);
    expect(provider.calls).toBe(1);
    expect(provider.lastImages.length).toBeGreaterThan(1); // full view + tiles
    expect(r.meta?.imageCount).toBe(1);
  });

  it("reads a disk-cache hit and backfills the memory cache", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-eyes-disk-"));
    try {
      const disk = createDiskCache(true, tmp);
      const provider = new FakeProvider();
      const r1 = await describeImage(DATA_URI, { question: "q" }, { provider, cache: createLruCache(128), diskCache: disk });
      expect(r1.ok).toBe(true);
      expect(provider.calls).toBe(1);

      const mem = createLruCache<string, string>(128);
      const provider2 = new FakeProvider();
      const r2 = await describeImage(DATA_URI, { question: "q" }, { provider: provider2, cache: mem, diskCache: disk });
      expect(r2.ok).toBe(true);
      expect(provider2.calls).toBe(0);
      expect(r2.text).toBe(r1.text);
      expect(r2.meta?.cached).toBe(true);
      expect(mem.size()).toBe(1); // backfilled
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("reports a missing VISION_API_KEY as an error, not a crash", async () => {
    const prevKey = process.env.VISION_API_KEY;
    const prevProvider = process.env.VISION_PROVIDER;
    delete process.env.VISION_API_KEY;
    delete process.env.VISION_PROVIDER;
    try {
      const r = await describeImage(DATA_URI, {}, { cwd: process.cwd() });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("VISION_API_KEY");
    } finally {
      if (prevKey !== undefined) process.env.VISION_API_KEY = prevKey;
      if (prevProvider !== undefined) process.env.VISION_PROVIDER = prevProvider;
    }
  });
});

describe("buildStructuredContent", () => {
  it("returns undefined on failure", () => {
    expect(buildStructuredContent({ ok: false, error: "nope" }, "")).toBeUndefined();
  });

  it("exposes meta plus the full text, and records truncation", async () => {
    const provider = new FakeProvider("m1");
    const result = await describeImage(DATA_URI, {}, { provider });
    expect(result.ok).toBe(true);
    const sc = buildStructuredContent(result, result.text ?? "", 2000);
    expect(sc).toMatchObject({ model: "m1", provider: "fake", imageCount: 1, cached: false, truncatedTo: 2000 });
    expect(sc?.text).toBe(result.text);
    const sc2 = buildStructuredContent(result, result.text ?? "");
    expect(sc2).not.toHaveProperty("truncatedTo");
  });
});

describe("concurrent dedup", () => {
  it("coalesces simultaneous identical requests into a single API call", async () => {
    class DelayedProvider extends FakeProvider {
      async describe(images: VisionImage[], prompt: string, detail: Detail): Promise<string> {
        await new Promise((r) => setTimeout(r, 80));
        return super.describe(images, prompt, detail);
      }
    }
    const provider = new DelayedProvider();
    const cache = createLruCache<string, string>(128);
    const [r1, r2] = await Promise.all([
      describeImage(DATA_URI, { question: "dedup me" }, { provider, cache }),
      describeImage(DATA_URI, { question: "dedup me" }, { provider, cache }),
    ]);
    expect(provider.calls).toBe(1);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.text).toBe(r1.text);
    // The follower awaited the shared in-flight promise, so it reads as cached.
    expect(r2.meta?.cached).toBe(true);
  });
});

describe("multi-image error context", () => {
  it("prefixes a failing per-image resolve with its 1-based index", async () => {
    const provider = new FakeProvider();
    const r = await describeImage([DATA_URI, "/nonexistent/x.png"], {}, { provider, cwd: process.cwd() });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Image 2");
    expect(provider.calls).toBe(0);
  });
});

describe("labelOf", () => {
  it("strips query and fragment from URL labels", () => {
    expect(labelOf("https://example.com/a.png?v=1#frag")).toBe("https://example.com/a.png");
  });

  it("labels data URIs and base64 payloads generically", () => {
    expect(labelOf(DATA_URI)).toBe("data URI");
    expect(labelOf(PNG_BASE64)).toBe("base64 data");
  });
});
