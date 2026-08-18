import * as fs from "node:fs/promises";
import * as path from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import ipaddr from "ipaddr.js"; // CJS module (`module.exports = ...`); default import is required under ESM interop
import { AgentEyesError } from "./errors.js";
import { envTimeoutMs } from "./env.js";

/** Total input budget across all images in one request (checked before preprocessing). */
export const MAX_TOTAL_INPUT_BYTES = 20 * 1024 * 1024; // 20 MB
/** Hard cap when streaming image bytes from a URL. */
export const MAX_FETCH_BYTES = MAX_TOTAL_INPUT_BYTES;
/**
 * Largest raw base64 / data-URI text worth decoding: 20 MB of payload needs
 * ceil(20 MB * 4 / 3) characters of base64, plus slack for the data: header.
 * Anything longer is rejected before a giant Buffer is allocated.
 */
export const MAX_BASE64_TEXT = Math.ceil((MAX_TOTAL_INPUT_BYTES * 4) / 3) + 1024;
/** Default URL image-fetch timeout; override with AGENT_EYES_FETCH_TIMEOUT_MS. */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
/** Default DNS lookup timeout; override with AGENT_EYES_DNS_TIMEOUT_MS. */
const DEFAULT_DNS_TIMEOUT_MS = 2_000;

export interface ResolvedImage {
  bytes: Buffer;
  mime: string;
  source: "file" | "url" | "data" | "base64";
}

export interface ResolveOptions {
  cwd?: string;
  allowedDir?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Parse one of the four supported image forms into {bytes, mime}:
 *   1. data: URI        -> validates the declared MIME against magic bytes
 *   2. http(s) URL      -> SSRF-guarded, streamed with a 20 MB cap
 *   3. raw base64       -> MIME sniffed from magic bytes
 *   4. local file path  -> sandboxed to the working directory (AGENT_EYES_ALLOWED_DIR overrides)
 * Detection order matters: `data:` prefix, then URL scheme, then base64 look,
 * then path. The base64 branch is heuristic: a long extension-less file name
 * made purely of base64 alphabet characters (e.g. `deadbeefcafebabe...`) is
 * indistinguishable from a raw base64 payload and is treated as base64. Real
 * file names almost always contain a `.` or characters outside the base64
 * alphabet, in which case the path branch wins.
 */
export async function resolveImage(input: string, opts: ResolveOptions = {}): Promise<ResolvedImage> {
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    throw new AgentEyesError("invalid_image", "Image input is empty.", "Pass a file path, http(s) URL, data: URI, or base64 string.");
  }
  switch (inputKind(trimmed)) {
    case "data":
      return parseDataUri(trimmed);
    case "url": {
      if (!/^https?:\/\//i.test(trimmed)) {
        const scheme = trimmed.slice(0, trimmed.indexOf(":"));
        throw new AgentEyesError("ssrf_blocked", `URL scheme "${scheme}" is not supported.`, "Only http(s) URLs are allowed.");
      }
      // URL fetches default to undici's own fetch (not the global one): the
      // SSRF dispatcher pins DNS to validated addresses, and Node's built-in
      // fetch rejects dispatchers from the npm undici package.
      return fetchImage(trimmed, opts.fetchImpl ?? (undiciFetch as unknown as typeof fetch));
    }
    case "base64":
      return parseBase64(trimmed);
    default:
      return readLocalFile(trimmed, opts);
  }
}

/* ------------------------------------------------------------------ */
/* Local file paths (sandboxed)                                        */
/* ------------------------------------------------------------------ */

/** realpath that tolerates non-existent paths (existence is checked later by stat). */
async function realpathSafe(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

async function readLocalFile(input: string, opts: ResolveOptions): Promise<ResolvedImage> {
  const cwd = opts.cwd ?? process.cwd();
  // Resolve symlinks on both sides: on macOS /tmp -> /private/tmp, so a lexical
  // comparison would falsely reject an AGENT_EYES_ALLOWED_DIR given via a symlink.
  const allowedDir = await realpathSafe(path.resolve(opts.allowedDir ?? process.env.AGENT_EYES_ALLOWED_DIR ?? cwd));
  const resolved = await realpathSafe(path.resolve(cwd, input));

  if (!isInside(resolved, allowedDir)) {
    throw new AgentEyesError(
      "sandbox_denied",
      `Path "${input}" resolves to ${resolved}, which is outside the allowed directory ${allowedDir}.`,
      "Only files inside the working directory can be read. Use AGENT_EYES_ALLOWED_DIR to widen the sandbox.",
    );
  }

  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new AgentEyesError(
        "file_not_found",
        `No file found at "${input}" (resolved to ${resolved}).`,
        "Check the path, or pass an http(s) URL, data: URI, or base64 string instead.",
      );
    }
    throw new AgentEyesError("file_not_found", `Cannot access "${input}": ${errorMessage(err)}`, "Check file permissions.");
  }

  if (!stat.isFile()) {
    throw new AgentEyesError("invalid_image", `"${input}" is not a regular file.`, "Pass the path to an image file.");
  }
  if (stat.size > MAX_TOTAL_INPUT_BYTES) {
    throw new AgentEyesError(
      "too_large",
      `Image "${input}" is ${formatBytes(stat.size)}, which exceeds the ${formatBytes(MAX_TOTAL_INPUT_BYTES)} input limit.`,
      "Compress or downscale the image first, then try again.",
    );
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(resolved);
  } catch (err) {
    throw new AgentEyesError("file_not_found", `Failed to read "${input}": ${errorMessage(err)}`, "Check file permissions.");
  }
  return { bytes, mime: detectMime(bytes), source: "file" };
}

export function isInside(p: string, root: string): boolean {
  const sep = path.sep;
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/* ------------------------------------------------------------------ */
/* http(s) URLs (SSRF-guarded)                                         */
/* ------------------------------------------------------------------ */

const MAX_REDIRECTS = 5;

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

async function fetchImage(urlStr: string, fetchImpl: typeof fetch): Promise<ResolvedImage> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new AgentEyesError("invalid_image", `"${urlStr}" is not a valid URL.`, "Pass an http(s) URL.");
  }

  // Follow redirects manually so every hop is re-checked against the SSRF guard
  // before a request is made. `redirect: "manual"` never follows automatically,
  // so the guard cannot be bypassed by a public URL redirecting to a private one.
  for (let hop = 0; ; hop++) {
    // Resolve + validate once per hop, then pin the connection to the validated
    // addresses so fetch performs no second DNS resolution (anti-rebinding).
    const pinned = await assertPublicUrl(url);
    const dispatcher = new Agent({ connect: { lookup: createPinnedLookup(url.hostname, pinned) as never } });
    try {
      let res: Response;
      try {
        // Double assertion: the `dispatcher` extension is undici's, and the
        // undici package types differ from the undici-types bundled in @types/node.
        const init = { redirect: "manual", signal: AbortSignal.timeout(envTimeoutMs("AGENT_EYES_FETCH_TIMEOUT_MS", DEFAULT_FETCH_TIMEOUT_MS)), dispatcher } as unknown as RequestInit;
        res = await fetchImpl(url.toString(), init);
      } catch (err) {
        const reason = errorMessage(err);
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        throw new AgentEyesError(
          "fetch_failed",
          `Failed to fetch image from ${urlStr}: ${reason}`,
          timedOut ? "The request timed out; retry or download the image first." : "Check the URL and network connectivity.",
        );
      }

      if (isRedirect(res.status)) {
        const location = res.headers.get("location");
        if (!location) {
          throw new AgentEyesError(
            "fetch_failed",
            `Image URL returned HTTP ${res.status} without a Location header.`,
            "Check that the URL points to an accessible image.",
          );
        }
        if (hop >= MAX_REDIRECTS) {
          throw new AgentEyesError(
            "fetch_failed",
            `Image URL redirected more than ${MAX_REDIRECTS} times.`,
            "Follow the redirect chain manually and pass the final URL.",
          );
        }
        try {
          url = new URL(location, url);
        } catch {
          throw new AgentEyesError(
            "fetch_failed",
            `Image URL redirected to an invalid location "${location}".`,
            "Check that the URL points to an accessible image.",
          );
        }
        // Consume/cancel the redirect body so the socket is released immediately
        // instead of lingering until the fetch timeout reaps it.
        await res.body?.cancel().catch(() => {});
        continue; // the next hop re-validates and re-pins before any request is sent
      }

      if (!res.ok) {
        throw new AgentEyesError(
          "fetch_failed",
          `Image URL returned HTTP ${res.status}${res.statusText ? " " + res.statusText : ""}.`,
          "Check that the URL points to an accessible image.",
        );
      }

      const declaredLength = Number(res.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_FETCH_BYTES) {
        throw new AgentEyesError(
          "too_large",
          `Image from ${urlStr} is larger than the ${formatBytes(MAX_FETCH_BYTES)} fetch limit.`,
          "Download and compress it first, then pass the local path.",
        );
      }

      const contentType = res.headers.get("content-type") ?? "";
      const bytes = await readBodyCapped(res, urlStr);
      const detected = detectMime(bytes);
      const mime =
        detected !== "application/octet-stream"
          ? detected
          : contentType.startsWith("image/")
            ? contentType.split(";")[0].trim().toLowerCase()
            : detected;
      return { bytes, mime, source: "url" };
    } finally {
      await dispatcher.close().catch(() => {});
    }
  }
}

async function readBodyCapped(res: Response, urlStr: string): Promise<Buffer> {
  if (!res.body) {
    throw new AgentEyesError("fetch_failed", `Image from ${urlStr} has no body.`, "The URL did not return data.");
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > MAX_FETCH_BYTES) {
          await reader.cancel();
          throw new AgentEyesError(
            "too_large",
            `Image from ${urlStr} exceeds the ${formatBytes(MAX_FETCH_BYTES)} fetch limit.`,
            "Download and compress it first, then pass the local path.",
          );
        }
        chunks.push(Buffer.from(value));
      }
    }
  } catch (err) {
    if (err instanceof AgentEyesError) throw err;
    throw new AgentEyesError("fetch_failed", `Failed to read image body from ${urlStr}: ${errorMessage(err)}`, "Check the URL and network connectivity.");
  }
  if (total === 0) {
    throw new AgentEyesError("fetch_failed", `Image from ${urlStr} is empty.`, "Check that the URL points to an image.");
  }
  return Buffer.concat(chunks);
}

async function assertPublicUrl(url: URL): Promise<PinnedAddress[]> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AgentEyesError("ssrf_blocked", `URL protocol "${url.protocol}" is not allowed.`, "Only http(s) URLs are supported.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLocalName(host)) {
    throw new AgentEyesError(
      "ssrf_blocked",
      `URL host "${url.host}" is not allowed.`,
      "Blocked for security: local and private network addresses cannot be fetched.",
    );
  }
  const literalFamily = isIP(host);
  if (literalFamily === 4 || literalFamily === 6) {
    // IP literal: isLocalName already rejected private ranges; pin the literal itself.
    return [{ address: host, family: literalFamily }];
  }
  // Resolve once, validate every answer, and return the validated set so the
  // connection can be pinned to it (no second, unvalidated DNS resolution).
  const ips = await resolveHost(host);
  const addrs: PinnedAddress[] = [];
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      throw new AgentEyesError(
        "ssrf_blocked",
        `URL host "${url.host}" resolves to private address ${ip}.`,
        "Blocked for security: local and private network addresses cannot be fetched.",
      );
    }
    const family = isIP(ip);
    if (family === 4 || family === 6) addrs.push({ address: ip, family });
  }
  if (addrs.length === 0) {
    throw new AgentEyesError(
      "fetch_failed",
      `DNS lookup for "${host}" returned no usable addresses.`,
      "Check that the hostname resolves publicly, or pass the image as a file or data URI instead.",
    );
  }
  return addrs;
}

interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | { address: string; family: number }[], family?: number) => void;

/**
 * dns.lookup-compatible function that only ever returns the pre-validated
 * addresses for the expected host. Feeding this to the connection layer means
 * the fetch performs no DNS resolution of its own, so a resolver that changes
 * answers between the check and the connect (DNS rebinding) cannot redirect
 * the connection to a private address.
 */
export function createPinnedLookup(host: string, addrs: PinnedAddress[]) {
  const expected = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (hostname: string, options: { all?: boolean } | undefined, cb: LookupCallback): void => {
    const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (normalized !== expected || addrs.length === 0) {
      const err = new Error(`DNS pinning: refused to resolve "${hostname}"`) as NodeJS.ErrnoException;
      err.code = "ENOTFOUND";
      if (options?.all) cb(err);
      else cb(err, "", 0);
      return;
    }
    if (options?.all) cb(null, addrs.map((a) => ({ address: a.address, family: a.family })));
    else cb(null, addrs[0].address, addrs[0].family);
  };
}

export function isLocalName(host: string): boolean {
  const h = host.toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const family = isIP(h);
  if (family === 4 || family === 6) return isPrivateIp(h);
  return false;
}

async function resolveHost(hostname: string): Promise<string[]> {
  try {
    const result = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error("DNS lookup timed out")), envTimeoutMs("AGENT_EYES_DNS_TIMEOUT_MS", DEFAULT_DNS_TIMEOUT_MS));
        t.unref();
      }),
    ]);
    return result.map((entry) => entry.address);
  } catch (err) {
    // Fail closed: if DNS cannot be resolved we refuse the fetch instead of
    // letting it proceed on a hostname whose addresses we could not verify.
    throw new AgentEyesError(
      "fetch_failed",
      `DNS lookup failed for "${hostname}": ${errorMessage(err)}`,
      "Check that the hostname resolves publicly, or pass the image as a file or data URI instead.",
    );
  }
}

/**
 * IPv4 ranges that must never be fetched (private, local, or non-routable).
 * Named after ipaddr.js `range()` values; ipaddr.js does not export its range
 * type, so the set is typed loosely.
 */
const BLOCKED_IPV4_RANGES = new Set<string>([
  "unspecified", // 0.0.0.0/8 "this network"
  "broadcast", // 255.255.255.255/32
  "multicast", // 224.0.0.0/4
  "linkLocal", // 169.254.0.0/16
  "loopback", // 127.0.0.0/8
  "carrierGradeNat", // 100.64.0.0/10 (RFC 6598)
  "private", // 10/8, 172.16/12, 192.168/16 (RFC 1918)
  "reserved", // incl. 192.0.0.0/24, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 240.0.0.0/4
]);

/**
 * True when the address must not be fetched. IPv4-mapped IPv6 (::ffff:a.b.c.d)
 * is evaluated as its embedded IPv4 address, so e.g. ::ffff:127.0.0.1 and
 * ::ffff:7f00:1 are both blocked. Any IPv6 address that is not plain public
 * unicast is rejected wholesale: that covers link-local, ULA, multicast,
 * loopback, documentation ranges, and the transition mechanisms that embed
 * IPv4 addresses (NAT64 64:ff9b::/96 + 64:ff9b:1::/48, 6to4, teredo) — even
 * when the embedded address is public, reachability through a translator
 * cannot be trusted.
 */
export function isPrivateIp(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return false; // Not a parseable IP address.
  }
  if (addr instanceof ipaddr.IPv6) {
    if (addr.range() === "ipv4Mapped") {
      return BLOCKED_IPV4_RANGES.has(addr.toIPv4Address().range());
    }
    return addr.range() !== "unicast";
  }
  return BLOCKED_IPV4_RANGES.has(addr.range());
}

/* ------------------------------------------------------------------ */
/* base64 / data: URI                                                  */
/* ------------------------------------------------------------------ */

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** One of the four supported image input forms, in detection order. */
export type InputKind = "data" | "url" | "base64" | "path";

/** Classify a trimmed image input by its form (see resolveImage for the order). */
export function inputKind(input: string): InputKind {
  const t = input.trim();
  if (t.startsWith("data:")) return "data";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return "url";
  if (isLikelyBase64(t)) return "base64";
  return "path";
}

/** A raw base64 string must be long enough to be an image payload. */
export function isLikelyBase64(s: string): boolean {
  const compact = s.replace(/\s+/g, "");
  return compact.length >= 32 && BASE64_RE.test(compact);
}

function parseBase64(input: string): ResolvedImage {
  const compact = input.replace(/\s+/g, "");
  if (compact.length > MAX_BASE64_TEXT) {
    throw new AgentEyesError(
      "too_large",
      `The base64 string is ${formatBytes(Math.floor((compact.length * 3) / 4))}, exceeding the ${formatBytes(MAX_TOTAL_INPUT_BYTES)} input limit.`,
      "Compress or downscale the image first, then try again.",
    );
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(compact, "base64");
  } catch {
    throw new AgentEyesError("invalid_image", "The base64 string could not be decoded.", "Ensure the string is valid base64-encoded image data.");
  }
  if (bytes.length === 0) {
    throw new AgentEyesError("invalid_image", "The base64 string decoded to an empty image.", "Ensure the string is valid base64-encoded image data.");
  }
  return { bytes, mime: detectMime(bytes), source: "base64" };
}

function parseDataUri(input: string): ResolvedImage {
  const comma = input.indexOf(",");
  if (comma < 0) {
    throw new AgentEyesError("invalid_image", "Malformed data URI: missing comma.", "Expected data:[<mediatype>][;base64],<data>");
  }
  const header = input.slice("data:".length, comma);
  const payload = input.slice(comma + 1);
  const parts = header.split(";").map((p) => p.trim());
  const mediatype = (parts[0] ?? "").toLowerCase();
  const isBase64 = parts.slice(1).some((p) => p.toLowerCase() === "base64");

  if (mediatype && !mediatype.startsWith("image/")) {
    throw new AgentEyesError(
      "unsupported_type",
      `The data URI declares "${mediatype}", but only image/* types are supported.`,
      "Re-encode the image as PNG, JPEG, WebP, GIF, BMP, TIFF, or SVG.",
    );
  }

  if (payload.length > MAX_BASE64_TEXT) {
    const approx = isBase64 ? Math.floor((payload.length * 3) / 4) : payload.length;
    throw new AgentEyesError(
      "too_large",
      `The data URI payload is about ${formatBytes(approx)}, exceeding the ${formatBytes(MAX_TOTAL_INPUT_BYTES)} input limit.`,
      "Compress or downscale the image first, then try again.",
    );
  }

  let bytes: Buffer;
  try {
    bytes = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  } catch {
    throw new AgentEyesError(
      "invalid_image",
      "The data URI payload could not be decoded.",
      "Ensure the payload is valid base64 (with ;base64) or percent-encoded text.",
    );
  }
  if (bytes.length === 0) {
    throw new AgentEyesError("invalid_image", "The data URI decoded to an empty image.", "Ensure the payload contains image data.");
  }

  // Validate the declared MIME against the actual magic bytes.
  const detected = detectMime(bytes);
  if (mediatype && detected !== "application/octet-stream" && detected !== mediatype) {
    throw new AgentEyesError(
      "invalid_image",
      `Data URI declares "${mediatype}" but the bytes are actually "${detected}".`,
      "Fix the declared MIME type or re-encode the image.",
    );
  }
  return { bytes, mime: mediatype || detected, source: "data" };
}

/* ------------------------------------------------------------------ */
/* MIME sniffing from magic bytes                                      */
/* ------------------------------------------------------------------ */

export function detectMime(bytes: Buffer): string {
  if (!bytes || bytes.length < 4) return "application/octet-stream";
  const b = (off: number): number => bytes[off] ?? 0;
  // PNG
  if (bytes.length >= 8 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 && b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a) {
    return "image/png";
  }
  // JPEG
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  // GIF87a / GIF89a
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38 && (b(4) === 0x37 || b(4) === 0x39) && b(5) === 0x61) {
    return "image/gif";
  }
  // WebP (RIFF....WEBP)
  if (bytes.length >= 12 && b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) {
    return "image/webp";
  }
  // BMP
  if (b(0) === 0x42 && b(1) === 0x4d) return "image/bmp";
  // TIFF (little/big endian)
  if ((b(0) === 0x49 && b(1) === 0x49 && b(2) === 0x2a && b(3) === 0x00) || (b(0) === 0x4d && b(1) === 0x4d && b(2) === 0x00 && b(3) === 0x2a)) {
    return "image/tiff";
  }
  // ICO
  if (b(0) === 0x00 && b(1) === 0x00 && b(2) === 0x01 && b(3) === 0x00) return "image/x-icon";
  // SVG / XML (text)
  const head = bytes
    .subarray(0, Math.min(bytes.length, 512))
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (head.startsWith("<svg") || head.startsWith("<SVG") || head.startsWith("<?xml")) return "image/svg+xml";
  return "application/octet-stream";
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
