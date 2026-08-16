import { describe, expect, it } from "vitest";
import sharp from "sharp";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  MAX_PREPROCESS_BYTES,
  MULTICROP_MIN_EDGE,
  MULTICROP_MIN_PIXELS,
  shouldDownscale,
  shouldMultiCrop,
  preprocessImage,
} from "../src/preprocess.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pixel.png");

async function makePng(width: number, height: number, background = "#336699"): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
}

/** Minimal structurally-valid PNG whose IHDR claims the given dimensions (no real pixel data). */
function pngWithClaimedDims(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const t = Buffer.from(type, "ascii");
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    t.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type: truecolor
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(0))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("preprocessing thresholds (pure functions)", () => {
  it("downscales when the long edge exceeds 2048", () => {
    expect(shouldDownscale(2048, 1024)).toBe(false);
    expect(shouldDownscale(2049, 1024)).toBe(true);
    expect(shouldDownscale(100, 5 * 1024 * 1024)).toBe(false);
  });

  it("downscales when the byte size exceeds 10 MB even with small dimensions", () => {
    expect(shouldDownscale(1000, MAX_PREPROCESS_BYTES + 1)).toBe(true);
  });

  it("multi-crops only for large, high-resolution images", () => {
    expect(shouldMultiCrop(MULTICROP_MIN_EDGE, MULTICROP_MIN_PIXELS)).toBe(true);
    expect(shouldMultiCrop(MULTICROP_MIN_EDGE - 1, MULTICROP_MIN_PIXELS)).toBe(false);
    expect(shouldMultiCrop(MULTICROP_MIN_EDGE, MULTICROP_MIN_PIXELS - 1)).toBe(false);
  });
});

describe("preprocessImage", () => {
  it("returns a small image untouched (processed: false)", async () => {
    const bytes = await fs.readFile(FIXTURE);
    const out = await preprocessImage({ bytes, mime: "image/png" });
    expect(out.processed).toBe(false);
    expect(out.views).toHaveLength(1);
    expect(out.views[0].mime).toBe("image/png");
    expect(out.views[0].bytes.equals(bytes)).toBe(true);
    expect(out.views[0].label).toBe("1 of 1 (full view)");
  });

  it("downscales a wide image to a JPEG with a <=2048 long edge", async () => {
    const png = await makePng(2600, 60);
    const out = await preprocessImage({ bytes: png, mime: "image/png" });
    expect(out.processed).toBe(true);
    expect(out.views).toHaveLength(1);
    expect(out.views[0].mime).toBe("image/jpeg");
    const meta = await sharp(out.views[0].bytes).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(2048);
  });

  it("multi-crops a 2200x1600 image into a full view plus 4 tiles (5 views), all JPEG", async () => {
    const png = await makePng(2200, 1600, "#882244");
    const out = await preprocessImage({ bytes: png, mime: "image/png" });
    expect(out.processed).toBe(true);
    expect(out.views).toHaveLength(5);
    expect(out.views[0].label).toBe("1 of 5 (full view)");
    expect(out.views[1].label).toContain("tile");
    expect(out.views[4].label).toBe("5 of 5 (tile, right-bottom)");
    for (const v of out.views) {
      expect(v.mime).toBe("image/jpeg");
      const meta = await sharp(v.bytes).metadata();
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(2048);
    }
  });

  it("returns original bytes untouched when sharp cannot decode the image", async () => {
    const junk = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not a real png payload")]);
    const out = await preprocessImage({ bytes: junk, mime: "image/png" });
    expect(out.processed).toBe(false);
    expect(out.views).toHaveLength(1);
    expect(out.views[0].bytes.equals(junk)).toBe(true);
  });

  it("rejects a pixel bomb whose header claims more than 100 MP (moderate dims)", async () => {
    const bomb = pngWithClaimedDims(200_000, 600); // 120 MP
    await expect(preprocessImage({ bytes: bomb, mime: "image/png" })).rejects.toMatchObject({
      code: "too_large",
      message: expect.stringContaining("100 MP"),
    });
  });

  it("rejects a pixel bomb whose header alone exceeds sharp's default limit", async () => {
    const bomb = pngWithClaimedDims(30_000, 30_000); // 900 MP
    await expect(preprocessImage({ bytes: bomb, mime: "image/png" })).rejects.toMatchObject({ code: "too_large" });
  });

  it("passes a claimed size under the pixel limit through the normal pipeline", async () => {
    const fake = pngWithClaimedDims(64, 64);
    // No real pixel data, so decoding fails and the pipeline degrades gracefully
    // instead of surfacing the pixel-bomb error.
    const out = await preprocessImage({ bytes: fake, mime: "image/png" });
    expect(out.processed).toBe(false);
    expect(out.views[0].bytes.equals(fake)).toBe(true);
  });
});
