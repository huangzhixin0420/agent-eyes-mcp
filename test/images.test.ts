import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_BASE64_TEXT, MAX_FETCH_BYTES, createPinnedLookup, detectMime, isLikelyBase64, isPrivateIp, resolveImage } from "../src/images.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PROJECT_ROOT = process.cwd();

type MockFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const mockFetch = (impl: MockFetch) => vi.fn(impl) as unknown as typeof fetch;

describe("image resolution — local file paths (sandbox)", () => {
  it("resolves a relative path inside the working directory", async () => {
    const img = await resolveImage("test/fixtures/pixel.png", { cwd: PROJECT_ROOT });
    expect(img.source).toBe("file");
    expect(img.mime).toBe("image/png");
    expect(img.bytes.equals(PNG_BYTES)).toBe(true);
  });

  it("resolves an absolute path inside the sandbox", async () => {
    const abs = path.join(PROJECT_ROOT, "test", "fixtures", "pixel.png");
    const img = await resolveImage(abs, { cwd: PROJECT_ROOT });
    expect(img.mime).toBe("image/png");
  });

  it("rejects absolute paths outside the sandbox", async () => {
    await expect(resolveImage("/etc/hosts", { cwd: PROJECT_ROOT })).rejects.toMatchObject({ code: "sandbox_denied" });
  });

  it("rejects traversal outside the sandbox", async () => {
    await expect(resolveImage("..", { cwd: PROJECT_ROOT })).rejects.toMatchObject({ code: "sandbox_denied" });
    await expect(resolveImage("../../etc/passwd", { cwd: PROJECT_ROOT })).rejects.toMatchObject({ code: "sandbox_denied" });
  });

  it("returns file_not_found for a missing path inside the sandbox", async () => {
    await expect(resolveImage("no-such-file.png", { cwd: PROJECT_ROOT })).rejects.toMatchObject({ code: "file_not_found" });
  });

  it("honors the AGENT_EYES_ALLOWED_DIR override (option and env)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-eyes-test-"));
    const file = path.join(tmp, "img.png");
    await fs.writeFile(file, PNG_BYTES);
    const prev = process.env.AGENT_EYES_ALLOWED_DIR;
    try {
      // option
      const viaOption = await resolveImage(file, { allowedDir: tmp });
      expect(viaOption.mime).toBe("image/png");
      // env
      process.env.AGENT_EYES_ALLOWED_DIR = tmp;
      const viaEnv = await resolveImage(file);
      expect(viaEnv.mime).toBe("image/png");
      // paths outside the override root are still denied
      await expect(resolveImage("/etc/hosts", { allowedDir: tmp })).rejects.toMatchObject({ code: "sandbox_denied" });
    } finally {
      if (prev === undefined) delete process.env.AGENT_EYES_ALLOWED_DIR;
      else process.env.AGENT_EYES_ALLOWED_DIR = prev;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("accepts an allowed dir given via a symlink (e.g. macOS /tmp -> /private/tmp)", async () => {
    const real = await fs.mkdtemp(path.join(os.tmpdir(), "agent-eyes-real-"));
    const link = path.join(os.tmpdir(), `agent-eyes-link-${process.pid}`);
    await fs.writeFile(path.join(real, "img.png"), PNG_BYTES);
    await fs.symlink(real, link);
    try {
      const img = await resolveImage(path.join(link, "img.png"), { allowedDir: link });
      expect(img.mime).toBe("image/png");
    } finally {
      await fs.rm(link, { force: true });
      await fs.rm(real, { recursive: true, force: true });
    }
  });
});

describe("image resolution — data URIs", () => {
  it("parses a base64 data URI and validates the declared MIME", async () => {
    const img = await resolveImage(`data:image/png;base64,${PNG_BASE64}`);
    expect(img.source).toBe("data");
    expect(img.mime).toBe("image/png");
    expect(img.bytes.equals(PNG_BYTES)).toBe(true);
  });

  it("rejects a data URI whose declared MIME does not match the bytes", async () => {
    await expect(resolveImage(`data:image/jpeg;base64,${PNG_BASE64}`)).rejects.toMatchObject({ code: "invalid_image" });
  });

  it("rejects a data URI declaring a non-image type", async () => {
    await expect(resolveImage(`data:application/pdf;base64,${PNG_BASE64}`)).rejects.toMatchObject({ code: "unsupported_type" });
  });

  it("parses a percent-encoded SVG data URI", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><text>hi</text></svg>`;
    const uri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    const img = await resolveImage(uri);
    expect(img.mime).toBe("image/svg+xml");
    expect(img.bytes.toString("utf8")).toContain("<svg");
  });
});

describe("image resolution — raw base64", () => {
  it("parses a raw base64 string and sniffs the MIME from magic bytes", async () => {
    const img = await resolveImage(PNG_BASE64);
    expect(img.source).toBe("base64");
    expect(img.mime).toBe("image/png");
    expect(img.bytes.equals(PNG_BYTES)).toBe(true);
  });

  it("treats short strings that are not base64 as paths, not base64", () => {
    expect(isLikelyBase64("logo")).toBe(false);
    expect(isLikelyBase64("screenshot.png")).toBe(false);
    expect(isLikelyBase64(PNG_BASE64)).toBe(true);
  });
});

describe("image resolution — URLs (SSRF guard)", () => {
  it("blocks localhost and private-network hosts", async () => {
    const blocked = [
      "http://localhost:8080/a.png",
      "http://localhost/a.png",
      "http://127.0.0.1/a.png",
      "http://10.0.0.1/a.png",
      "http://172.16.0.1/a.png",
      "http://172.31.255.255/a.png",
      "http://192.168.1.1/a.png",
      "http://169.254.169.254/latest/meta-data/",
      "http://0.0.0.0/a.png",
      "http://100.64.0.1/a.png",
      "http://[::1]/a.png",
      "http://[fc00::1]/a.png",
    ];
    for (const u of blocked) {
      await expect(resolveImage(u, { fetchImpl: mockFetch(async () => new Response("")) })).rejects.toMatchObject({
        code: "ssrf_blocked",
      });
    }
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(resolveImage("ftp://example.com/a.png")).rejects.toMatchObject({ code: "ssrf_blocked" });
    await expect(resolveImage("file:///etc/passwd")).rejects.toMatchObject({ code: "ssrf_blocked" });
    await expect(resolveImage("gopher://example.com/x")).rejects.toMatchObject({ code: "ssrf_blocked" });
  });

  it("fetches a public URL and returns the sniffed MIME", async () => {
    const fetchImpl = mockFetch(async () => new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }));
    const img = await resolveImage("https://8.8.8.8/pixel.png", { fetchImpl });
    expect(img.source).toBe("url");
    expect(img.mime).toBe("image/png");
    expect(img.bytes.equals(PNG_BYTES)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("pins the connection to validated addresses via a custom dispatcher", async () => {
    const fetchImpl = mockFetch(async () => new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }));
    await resolveImage("https://8.8.8.8/pixel.png", { fetchImpl });
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit & { dispatcher?: unknown };
    // The dispatcher is an undici Agent whose lookup only serves the validated IPs.
    expect(typeof (init.dispatcher as { close?: unknown })?.close).toBe("function");
  });

  it("pinned lookup serves only the validated addresses, only for the expected host", () => {
    const pinned = createPinnedLookup("Example.COM", [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    // single-address form
    pinned("example.com", undefined, (err, address, family) => {
      expect(err).toBeNull();
      expect(address).toBe("93.184.216.34");
      expect(family).toBe(4);
    });
    // all-addresses form
    pinned("EXAMPLE.COM", { all: true }, (err, addresses) => {
      expect(err).toBeNull();
      expect(addresses).toHaveLength(2);
    });
    // different host is refused, both forms
    pinned("evil.com", undefined, (err) => expect((err as NodeJS.ErrnoException).code).toBe("ENOTFOUND"));
    pinned("evil.com", { all: true }, (err) => expect((err as NodeJS.ErrnoException).code).toBe("ENOTFOUND"));
  });

  it("rejects non-2xx URL responses", async () => {
    const fetchImpl = mockFetch(async () => new Response("nope", { status: 404 }));
    await expect(resolveImage("https://8.8.8.8/missing.png", { fetchImpl })).rejects.toMatchObject({ code: "fetch_failed" });
  });

  it("rejects URL responses over the 20 MB fetch cap", async () => {
    const big = Buffer.alloc(MAX_FETCH_BYTES + 1, 1);
    const fetchImpl = mockFetch(async () => new Response(big, { status: 200, headers: { "content-type": "image/png" } }));
    await expect(resolveImage("https://8.8.8.8/big.png", { fetchImpl })).rejects.toMatchObject({ code: "too_large" });
  });

  it("rejects a redirect to a private address without ever fetching the target", async () => {
    const fetchImpl = mockFetch(async () => new Response("", { status: 302, headers: { location: "http://127.0.0.1:9/x.png" } }));
    await expect(resolveImage("https://8.8.8.8/start.png", { fetchImpl })).rejects.toMatchObject({ code: "ssrf_blocked" });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // only the first hop was fetched
  });

  it("rejects a redirect to a non-http(s) scheme", async () => {
    const fetchImpl = mockFetch(async () => new Response("", { status: 301, headers: { location: "file:///etc/passwd" } }));
    await expect(resolveImage("https://8.8.8.8/start.png", { fetchImpl })).rejects.toMatchObject({ code: "ssrf_blocked" });
  });

  it("follows a chain of public redirects", async () => {
    const fetchImpl = mockFetch(async (url) => {
      const s = String(url);
      if (s.includes("/a.png")) return new Response("", { status: 302, headers: { location: "/b.png" } });
      if (s.includes("/b.png")) return new Response("", { status: 301, headers: { location: "https://8.8.8.8/final.png" } });
      return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
    });
    const img = await resolveImage("https://8.8.8.8/a.png", { fetchImpl });
    expect(img.mime).toBe("image/png");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects a redirect loop after 5 hops", async () => {
    const fetchImpl = mockFetch(async () => new Response("", { status: 302, headers: { location: "https://8.8.8.8/loop.png" } }));
    await expect(resolveImage("https://8.8.8.8/loop.png", { fetchImpl })).rejects.toMatchObject({ code: "fetch_failed" });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("rejects a 3xx response without a Location header", async () => {
    const fetchImpl = mockFetch(async () => new Response("", { status: 301 }));
    await expect(resolveImage("https://8.8.8.8/start.png", { fetchImpl })).rejects.toMatchObject({ code: "fetch_failed" });
  });
});

describe("mime sniffing & IP classification helpers", () => {
  it("detects MIME types from magic bytes", () => {
    expect(detectMime(PNG_BYTES)).toBe("image/png");
    expect(detectMime(JPEG_BYTES)).toBe("image/jpeg");
    expect(detectMime(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toBe("image/gif");
    expect(detectMime(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
    expect(detectMime(Buffer.from([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00]))).toBe("image/bmp");
    expect(detectMime(Buffer.from("random text not an image"))).toBe("application/octet-stream");
  });

  it("classifies private IPs", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("172.20.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    expect(isPrivateIp("192.168.0.1")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("100.64.1.1")).toBe(true);
    expect(isPrivateIp("0.0.0.0")).toBe(true);
    expect(isPrivateIp("255.255.255.255")).toBe(true);
    expect(isPrivateIp("198.18.1.1")).toBe(true); // RFC 2544 benchmarking
    expect(isPrivateIp("224.0.0.1")).toBe(true); // multicast
    expect(isPrivateIp("240.0.0.1")).toBe(true); // reserved
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("::")).toBe(true);
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true); // IPv4-mapped (dotted-quad form)
    expect(isPrivateIp("::ffff:7f00:1")).toBe(true); // IPv4-mapped (hex form)
    expect(isPrivateIp("::ffff:a9fe:a9fe")).toBe(true); // maps to 169.254.169.254
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false); // mapped public address stays public
    expect(isPrivateIp("64:ff9b::a9fe:a9fe")).toBe(true); // NAT64 (RFC 6052)
    expect(isPrivateIp("64:ff9b:1::1")).toBe(true); // NAT64 (RFC 8215)
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("ff02::1")).toBe(true); // multicast
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateIp("not-an-ip")).toBe(false);
  });
});

describe("image resolution — oversized base64 / data URIs", () => {
  it("rejects a raw base64 string beyond the decode budget", async () => {
    const huge = "a".repeat(MAX_BASE64_TEXT + 1);
    await expect(resolveImage(huge)).rejects.toMatchObject({ code: "too_large" });
  });

  it("rejects a data URI whose payload is beyond the decode budget", async () => {
    const huge = `data:image/png;base64,${"a".repeat(MAX_BASE64_TEXT + 1)}`;
    await expect(resolveImage(huge)).rejects.toMatchObject({ code: "too_large" });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
