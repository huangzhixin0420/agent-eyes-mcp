import { createLruCache, cacheKey } from "./cache.js";
import type { LruCache } from "./cache.js";
import { createDiskCacheFromEnv } from "./disk-cache.js";
import type { DiskCache } from "./disk-cache.js";
import { AgentEyesError, toUserText } from "./errors.js";
import { MAX_TOTAL_INPUT_BYTES, formatBytes, inputKind, resolveImage } from "./images.js";
import type { ResolvedImage } from "./images.js";
import { log } from "./log.js";
import { preprocessImage } from "./preprocess.js";
import { buildImageSetInstructions, buildUserPrompt } from "./prompts.js";
import type { Task } from "./prompts.js";
import { createDefaultProvider } from "./provider.js";
import type { Detail, VisionProvider } from "./provider.js";

export type ImageInput = string | string[];

export interface DescribeOptions {
  question?: string;
  task?: Task;
  detail?: Detail;
}

export interface DescribeDeps {
  provider?: VisionProvider;
  cache?: LruCache<string, string>;
  diskCache?: DiskCache;
  cwd?: string;
  allowedDir?: string;
  fetchImpl?: typeof fetch;
}

/** Metadata attached to successful results, also surfaced as structured tool content. */
export interface DescribeMeta {
  model: string;
  provider: string;
  imageCount: number;
  cached: boolean;
}

export interface DescribeResult {
  ok: boolean;
  /** The description (on success) or the structured error text (on failure). */
  text?: string;
  error?: string;
  meta?: DescribeMeta;
}

const CACHE_SIZE = 128;
const defaultCache = createLruCache<string, string>(CACHE_SIZE);

// De-duplicates concurrent requests for the same cache key: while one is in
// flight, followers await the same promise instead of calling the API again.
const inflight = new Map<string, Promise<string>>();

/** Short, human-readable label for one input, used in per-image prompt headings. */
export function labelOf(input: string): string {
  switch (inputKind(input)) {
    case "data":
      return "data URI";
    case "url": {
      // Strip query/fragment: the heading only needs the target, not tracking params.
      try {
        const u = new URL(input.trim());
        return `${u.origin}${u.pathname}`.slice(0, 80);
      } catch {
        return input;
      }
    }
    case "base64":
      return "base64 data";
    default:
      return input;
  }
}

/**
 * Shared pipeline used by both the MCP tool and the CLI:
 * resolve (parallel) -> total-size check -> cache lookup -> preprocess ->
 * assemble prompt -> in-flight dedup -> VLM -> caches.
 * Every failure is converted into structured, actionable error text.
 */
export async function describeImage(input: ImageInput, opts: DescribeOptions = {}, deps: DescribeDeps = {}): Promise<DescribeResult> {
  try {
    const inputs = Array.isArray(input) ? input : [input];

    // Resolve all inputs in parallel. The total-size budget is enforced on the
    // raw bytes as each resolve completes (fail fast); per-image failures get
    // an "Image N" prefix so multi-image requests are debuggable.
    let totalBytes = 0;
    const resolved = await Promise.all(
      inputs.map(async (one, i) => {
        let r: ResolvedImage;
        try {
          r = await resolveImage(one, { cwd: deps.cwd, allowedDir: deps.allowedDir, fetchImpl: deps.fetchImpl });
        } catch (err) {
          if (err instanceof AgentEyesError) {
            throw new AgentEyesError(err.code, `Image ${i + 1}: ${err.message}`, err.hint);
          }
          throw err;
        }
        totalBytes += r.bytes.length;
        if (totalBytes > MAX_TOTAL_INPUT_BYTES) {
          throw new AgentEyesError(
            "too_large",
            `The image(s) total ${formatBytes(totalBytes)}, exceeding the ${formatBytes(MAX_TOTAL_INPUT_BYTES)} input limit (at image ${i + 1} of ${inputs.length}).`,
            "Compress or downscale the images first, then try again.",
          );
        }
        return r;
      }),
    );

    const provider = deps.provider ?? createDefaultProvider(deps.fetchImpl);
    const prompt = buildUserPrompt(opts.question, opts.task);
    const detail = opts.detail ?? "high";

    // Cache lookups happen before preprocessing: the key covers the raw bytes,
    // prompt, model, provider, and detail — all known without any sharp work.
    // Preprocessing only adds per-view instructions, which are prompt-level
    // and would bloat the key without changing the content the model answers.
    // Known edge: if sharp was unavailable when an answer was cached, a later
    // run with sharp working still serves the fallback (single-view) answer
    // for the same key — a deliberately accepted, self-limiting tradeoff.
    const key = cacheKey(resolved.map((r) => r.bytes), prompt, provider.model, provider.name, detail);
    const cache = deps.cache ?? defaultCache;
    const diskCache = deps.diskCache ?? createDiskCacheFromEnv();

    const cached = cache.get(key);
    if (cached !== undefined) {
      log("cache hit (model:", provider.model + ")");
      return { ok: true, text: cached, meta: { model: provider.model, provider: provider.name, imageCount: inputs.length, cached: true } };
    }

    const diskCached = await diskCache.get(key);
    if (diskCached !== undefined) {
      cache.set(key, diskCached); // backfill the in-process cache
      log("disk cache hit (model:", provider.model + ")");
      return { ok: true, text: diskCached, meta: { model: provider.model, provider: provider.name, imageCount: inputs.length, cached: true } };
    }

    // A concurrent request for the same key is already talking to the VLM:
    // await it instead of firing a second API call.
    const running = inflight.get(key);
    if (running) {
      const text = await running;
      cache.set(key, text);
      return { ok: true, text, meta: { model: provider.model, provider: provider.name, imageCount: inputs.length, cached: true } };
    }

    // Register the in-flight promise *before* any further await so a request
    // that races through preprocessing joins this one instead of double-calling
    // the VLM. Preprocessing and the API call run inside the promise.
    const pending = (async (): Promise<string> => {
      const processed = await Promise.all(resolved.map((r) => preprocessImage(r)));
      const views = processed.flatMap((p) => p.views);
      const viewCounts = processed.map((p) => p.views.length);
      const labels = inputs.map(labelOf);
      const needsInstructions = inputs.length > 1 || viewCounts.some((c) => c > 1);
      const fullPrompt = needsInstructions ? `${prompt}\n\n${buildImageSetInstructions(labels, viewCounts)}` : prompt;

      log("calling vision API (model:", provider.model + ", detail:", detail + ")");
      const text = await provider.describe(
        views.map((v) => ({ bytes: v.bytes, mime: v.mime })),
        fullPrompt,
        detail,
      );
      cache.set(key, text);
      await diskCache.set(key, text);
      return text;
    })();
    inflight.set(key, pending);
    try {
      const text = await pending;
      return { ok: true, text, meta: { model: provider.model, provider: provider.name, imageCount: inputs.length, cached: false } };
    } finally {
      inflight.delete(key);
    }
  } catch (err) {
    const error = toUserText(err);
    log("describe failed:", error);
    return { ok: false, error };
  }
}

/**
 * Structured tool output for machine consumers. Present only on success;
 * `text` is the actual text returned to the user (possibly truncated), and
 * `truncatedTo` records the character prefix it was clipped to.
 */
export function buildStructuredContent(result: DescribeResult, text: string, truncatedTo?: number): Record<string, unknown> | undefined {
  if (!result.ok || !result.meta) return undefined;
  return {
    text,
    model: result.meta.model,
    provider: result.meta.provider,
    imageCount: result.meta.imageCount,
    cached: result.meta.cached,
    ...(truncatedTo !== undefined ? { truncatedTo } : {}),
  };
}
