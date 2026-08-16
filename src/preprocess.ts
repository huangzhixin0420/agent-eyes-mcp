import type { Sharp } from "sharp";
import { AgentEyesError } from "./errors.js";
import { log } from "./log.js";

/**
 * Image preprocessing: automatic downscaling for very large images and
 * multi-crop tiling for wide/tall images, so VLM providers receive payloads
 * they can actually digest. Everything here is best-effort — any failure
 * (including a missing / native-loading `sharp`) falls back to the original
 * bytes untouched, so the pipeline never turns a valid image into an error.
 * The one exception is the pixel-bomb check: an image whose header claims more
 * than MAX_INPUT_PIXELS is rejected with a too_large error instead of being
 * silently passed through to the provider.
 */

/** Total decoded pixels (all pages) above which an image is rejected before any decode. */
export const MAX_INPUT_PIXELS = 100_000_000; // 100 MP

/** Long edge cap for a single (downscaled) view. */
export const MAX_DOWNSCALE_EDGE = 2048;
/** Long edge cap for a multi-crop tile. */
export const MAX_TILE_EDGE = 2048;
/** Re-encode budget: a single view is re-encoded at lower JPEG quality until it fits. */
export const MAX_PREPROCESS_BYTES = 10 * 1024 * 1024; // 10 MB
/** Images at/above these dimensions are candidates for multi-crop tiling. */
export const MULTICROP_MIN_EDGE = 1800;
export const MULTICROP_MIN_PIXELS = 3_500_000;
/** Full view + up to this many tiles. */
export const MAX_MULTICROP_IMAGES = 5;
/** JPEG quality ladder tried (best first) until a view fits MAX_PREPROCESS_BYTES. */
export const JPEG_QUALITIES = [85, 75, 65, 55, 45, 35];

export interface PreparedView {
  bytes: Buffer;
  mime: string;
  /** Human-readable view description, used in the per-image prompt instructions. */
  label: string;
}

export interface PreprocessedImage {
  views: PreparedView[];
  /** false when the image was returned untouched (or preprocessing failed). */
  processed: boolean;
}

export interface PreprocessInput {
  bytes: Buffer;
  mime: string;
}

/** Callable sharp entry point (dynamic import of sharp's default export). */
type SharpFactory = (input?: Buffer | string, options?: { limitInputPixels?: number | false }) => Sharp;

let sharpLoader: Promise<SharpFactory> | undefined;

function loadSharp(): Promise<SharpFactory> {
  sharpLoader ??= import("sharp").then((m) => (m.default ?? m) as unknown as SharpFactory);
  return sharpLoader;
}

/** Decode entry point: rejects images whose header claims more than MAX_INPUT_PIXELS. */
function decode(sharp: SharpFactory, src: Buffer): Sharp {
  return sharp(src, { limitInputPixels: MAX_INPUT_PIXELS });
}

/** A single view must be downscaled when it is over the byte budget or the long-edge budget. */
export function shouldDownscale(longEdge: number, byteLength: number): boolean {
  return longEdge > MAX_DOWNSCALE_EDGE || byteLength > MAX_PREPROCESS_BYTES;
}

/** Multi-crop triggers on large, high-resolution images. */
export function shouldMultiCrop(longEdge: number, pixels: number): boolean {
  return longEdge >= MULTICROP_MIN_EDGE && pixels >= MULTICROP_MIN_PIXELS;
}

/**
 * Analyze and prepare one image for the VLM. Returns the original bytes
 * untouched when no processing is needed, and always degrades gracefully.
 */
export async function preprocessImage(image: PreprocessInput): Promise<PreprocessedImage> {
  const fallback: PreparedView[] = [{ bytes: image.bytes, mime: image.mime, label: "1 of 1 (full view)" }];
  try {
    const sharp = await loadSharp();
    // Metadata reads only the file header, so the default pixel limit would
    // reject >268 MP headers before we can produce our own actionable error.
    const meta = await sharp(image.bytes, { limitInputPixels: false }).metadata();
    if (!meta.width || !meta.height) return { views: fallback, processed: false };
    const { width, height } = orientedSize(meta);
    const longEdge = Math.max(width, height);
    // Count every page (animated GIF/AVIF, multi-page TIFF): decoding allocates
    // all of them, so the bomb check covers the total decoded pixel count.
    // Pixel count is rotation-invariant, so use the raw (unrotated) metadata.
    const totalPixels = (meta.width ?? 0) * (meta.pageHeight ?? meta.height ?? 0) * (meta.pages ?? 1);
    if (totalPixels > MAX_INPUT_PIXELS) {
      throw new AgentEyesError(
        "too_large",
        `Image is ${width}x${height} (${Math.round(totalPixels / 1_000_000)} MP), exceeding the 100 MP pixel limit.`,
        "Crop or downscale the image first, then try again.",
      );
    }
    const pixels = width * height;

    if (shouldMultiCrop(longEdge, pixels)) {
      return { views: await buildMultiCrop(sharp, image.bytes, width, height), processed: true };
    }
    if (shouldDownscale(longEdge, image.bytes.length)) {
      const bytes = await renderJpeg(sharp, image.bytes, MAX_DOWNSCALE_EDGE);
      return { views: [{ bytes, mime: "image/jpeg", label: "1 of 1 (full view)" }], processed: true };
    }
    return { views: fallback, processed: false };
  } catch (err) {
    if (err instanceof AgentEyesError) throw err; // actionable errors are surfaced, not swallowed
    log("preprocess skipped:", err instanceof Error ? err.message : String(err));
    return { views: fallback, processed: false };
  }
}

/** EXIF orientations 5-8 rotate the image 90°/270°, so the grid math must swap dimensions. */
function orientedSize(meta: { width?: number; height?: number; orientation?: number }): { width: number; height: number } {
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const o = meta.orientation ?? 1;
  return o >= 5 && o <= 8 ? { width: h, height: w } : { width: w, height: h };
}

/**
 * Auto-rotate (EXIF-aware), strip metadata, fit inside `maxEdge`, and encode
 * as JPEG, retrying at lower qualities until the result fits the byte budget.
 */
async function renderJpeg(sharp: SharpFactory, src: Buffer, maxEdge: number): Promise<Buffer> {
  // No .withMetadata(): EXIF (including orientation) is dropped.
  const pipeline = decode(sharp, src)
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });
  let smallest: Buffer | undefined;
  for (const quality of JPEG_QUALITIES) {
    const out = await pipeline.clone().jpeg({ quality }).toBuffer();
    if (smallest === undefined || out.length < smallest.length) smallest = out;
    if (out.length <= MAX_PREPROCESS_BYTES) return out;
  }
  return smallest ?? Buffer.alloc(0);
}

/**
 * Split a large image into a full (downscaled) view plus a grid of tiles:
 * cols = round(sqrt(4 * w / h)), rows = ceil(4 / cols) — roughly a 4:3-ish
 * area split. The tile count is capped so the full set never exceeds
 * MAX_MULTICROP_IMAGES views. Tiles are extracted from the auto-rotated
 * image so coordinates line up with the oriented dimensions.
 */
async function buildMultiCrop(sharp: SharpFactory, src: Buffer, width: number, height: number): Promise<PreparedView[]> {
  const oriented = await decode(sharp, src).rotate().toBuffer();

  // The grid shares the tile budget with the full view: at most maxTiles tiles.
  const maxTiles = MAX_MULTICROP_IMAGES - 1;
  let cols = Math.max(1, Math.round(Math.sqrt((maxTiles * width) / height)));
  let rows = Math.max(1, Math.ceil(maxTiles / cols));
  while (cols * rows > maxTiles) {
    if (cols === 1) {
      // cols cannot shrink further; clamp rows to guarantee termination.
      rows = Math.min(rows, maxTiles);
      break;
    }
    cols = Math.ceil(cols / 2);
    rows = Math.max(1, Math.ceil(maxTiles / cols));
  }

  const tileW = Math.ceil(width / cols);
  const tileH = Math.ceil(height / rows);
  const total = 1 + cols * rows;

  const full = await renderJpeg(sharp, oriented, MAX_DOWNSCALE_EDGE);
  const views: PreparedView[] = [{ bytes: full, mime: "image/jpeg", label: `1 of ${total} (full view)` }];

  let n = 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const left = c * tileW;
      const top = r * tileH;
      const w = Math.min(tileW, width - left);
      const h = Math.min(tileH, height - top);
      const tile = await decode(sharp, oriented).extract({ left, top, width: w, height: h }).toBuffer();
      const tileJpeg = await renderJpeg(sharp, tile, MAX_TILE_EDGE);
      const position = tilePosition(r, rows, c, cols);
      views.push({ bytes: tileJpeg, mime: "image/jpeg", label: `${n} of ${total} (tile${position ? ", " + position : ""})` });
      n++;
    }
  }
  return views;
}

function tilePosition(r: number, rows: number, c: number, cols: number): string {
  const vertical = rows === 1 ? "" : r === 0 ? "top" : r === rows - 1 ? "bottom" : "middle";
  const horizontal = cols === 1 ? "" : c === 0 ? "left" : c === cols - 1 ? "right" : "center";
  return [horizontal, vertical].filter(Boolean).join("-");
}
