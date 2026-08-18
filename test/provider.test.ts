import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicProvider,
  GeminiProvider,
  OllamaProvider,
  OpenAICompatProvider,
  cleanResponseText,
  createDefaultProvider,
} from "../src/provider.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
const ONE_IMAGE = [{ bytes: PNG_BYTES, mime: "image/png" }];
const TWO_IMAGES = [ONE_IMAGE[0], ONE_IMAGE[0]];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type MockFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const mockFetch = (impl: MockFetch) => vi.fn(impl) as unknown as typeof fetch;

describe("OpenAICompatProvider", () => {
  it("posts system + text + one image_url per image (data URI) and returns the description", async () => {
    const mock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "A red button labeled OK." } }] }));
    const provider = new OpenAICompatProvider({
      apiKey: "sk-test",
      baseUrl: "https://api.test/v1",
      model: "vision-test",
      fetchImpl: mock as unknown as typeof fetch,
    });

    const out = await provider.describe(TWO_IMAGES, "What is this?", "high");
    expect(out).toBe("A red button labeled OK.");

    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(headers["content-type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("vision-test");
    expect(body.messages[0]).toMatchObject({ role: "system" });
    const blocks = body.messages[1].content as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({ type: "text", text: "What is this?" });
    expect(blocks).toHaveLength(3); // text + 2 images
    for (const b of blocks.slice(1)) {
      expect(b).toMatchObject({ type: "image_url", image_url: { detail: "high" } });
      expect((b.image_url as { url: string }).url.startsWith("data:image/png;base64,")).toBe(true);
    }
    expect(body.max_tokens).toBe(Math.min(8192, 2048 * 2));
  });

  it("forwards detail=auto as-is", async () => {
    const mock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    const provider = new OpenAICompatProvider({ apiKey: "k", baseUrl: "https://api.test/v1", fetchImpl: mock as unknown as typeof fetch });
    await provider.describe(ONE_IMAGE, "p", "auto");
    const body = JSON.parse((mock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[1].content[1].image_url.detail).toBe("auto");
  });

  it("throws a config error when the API key is missing", async () => {
    const provider = new OpenAICompatProvider({ apiKey: "" });
    await expect(provider.describe(ONE_IMAGE, "p", "high")).rejects.toMatchObject({ code: "config_missing" });
  });

  it("surfaces API error responses as provider errors", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ error: { message: "invalid model" } }, 400));
    const provider = new OpenAICompatProvider({ apiKey: "k", baseUrl: "https://api.test/v1", fetchImpl });
    await expect(provider.describe(ONE_IMAGE, "p", "high")).rejects.toMatchObject({ code: "provider_error" });
  });

  it("converts network failures into provider errors", async () => {
    const fetchImpl = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const provider = new OpenAICompatProvider({ apiKey: "k", baseUrl: "https://api.test/v1", fetchImpl });
    await expect(provider.describe(ONE_IMAGE, "p", "high")).rejects.toMatchObject({ code: "provider_error" });
  });

  it("aborts the request after AGENT_EYES_API_TIMEOUT_MS", async () => {
    process.env.AGENT_EYES_API_TIMEOUT_MS = "50";
    try {
      const fetchImpl = mockFetch(
        (_url, init) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("The operation timed out.");
              err.name = "TimeoutError";
              reject(err);
            });
          }),
      );
      const provider = new OpenAICompatProvider({ apiKey: "k", baseUrl: "https://api.test/v1", fetchImpl });
      await expect(provider.describe(ONE_IMAGE, "p", "high")).rejects.toMatchObject({
        code: "provider_error",
        hint: expect.stringContaining("timed out"),
      });
    } finally {
      delete process.env.AGENT_EYES_API_TIMEOUT_MS;
    }
  });

  it("reads defaults from the environment", async () => {
    const prevKey = process.env.VISION_API_KEY;
    const prevUrl = process.env.VISION_BASE_URL;
    const prevModel = process.env.VISION_MODEL;
    process.env.VISION_API_KEY = "env-key";
    delete process.env.VISION_BASE_URL;
    delete process.env.VISION_MODEL;
    try {
      const mock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
      const provider = new OpenAICompatProvider({ fetchImpl: mock as unknown as typeof fetch });
      expect(provider.model).toBe("qwen-vl-max");
      const out = await provider.describe(ONE_IMAGE, "p", "low");
      expect(out).toBe("ok");
      const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
      const body = JSON.parse(init.body as string);
      expect(body.messages[1].content[1].image_url.detail).toBe("low");
    } finally {
      if (prevKey === undefined) delete process.env.VISION_API_KEY;
      else process.env.VISION_API_KEY = prevKey;
      if (prevUrl === undefined) delete process.env.VISION_BASE_URL;
      else process.env.VISION_BASE_URL = prevUrl;
      if (prevModel === undefined) delete process.env.VISION_MODEL;
      else process.env.VISION_MODEL = prevModel;
    }
  });
});

describe("cleanResponseText (shared)", () => {
  it("strips reasoning-model <think> blocks from the answer", () => {
    expect(cleanResponseText("<think>Let me look...</think>\n\nA cat.")).toBe("A cat.");
  });

  it("treats a response that is only a <think> block as missing content", () => {
    expect(() => cleanResponseText("<think>only thinking</think>")).toThrow(expect.objectContaining({ code: "provider_error" }));
  });

  it("strips an unclosed <think> block from a truncated response", () => {
    expect(() => cleanResponseText("<think>truncated mid-thought, never closed")).toThrow(expect.objectContaining({ code: "provider_error" }));
  });
});

describe("AnthropicProvider", () => {
  it("posts to /v1/messages with x-api-key, system at top level, and base64 image blocks", async () => {
    const mock = vi.fn(async () => jsonResponse({ content: [{ type: "text", text: "<think>hmm</think>\n\nA chart." }] }));
    const provider = new AnthropicProvider({ apiKey: "sk-ant", baseUrl: "https://api.test", model: "claude-test", fetchImpl: mock as unknown as typeof fetch });
    const out = await provider.describe(TWO_IMAGES, "Analyze", "high");
    expect(out).toBe("A chart.");

    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-test");
    expect(body.system).toContain("agent-eyes");
    const blocks = body.messages[0].content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
    expect(blocks[2]).toMatchObject({ type: "text", text: "Analyze" });
  });

  it("falls back to VISION_API_KEY and env overrides for base URL and model", async () => {
    const prevKey = process.env.VISION_API_KEY;
    const prevUrl = process.env.ANTHROPIC_BASE_URL;
    const prevModel = process.env.ANTHROPIC_MODEL;
    process.env.VISION_API_KEY = "shared-key";
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_MODEL;
    try {
      const mock = vi.fn(async () => jsonResponse({ content: [{ type: "text", text: "ok" }] }));
      const provider = new AnthropicProvider({ fetchImpl: mock as unknown as typeof fetch });
      expect(provider.model).toBe("claude-haiku-4-5");
      await provider.describe(ONE_IMAGE, "p", "auto"); // detail is ignored
      const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect((init.headers as Record<string, string>)["x-api-key"]).toBe("shared-key");
    } finally {
      if (prevKey === undefined) delete process.env.VISION_API_KEY;
      else process.env.VISION_API_KEY = prevKey;
      if (prevUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = prevUrl;
      if (prevModel === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = prevModel;
    }
  });

  it("throws a config error when no key is available", async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevVision = process.env.VISION_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.VISION_API_KEY;
    try {
      const provider = new AnthropicProvider({ apiKey: "" });
      await expect(provider.describe(ONE_IMAGE, "p", "high")).rejects.toMatchObject({ code: "config_missing" });
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
      if (prevVision === undefined) delete process.env.VISION_API_KEY;
      else process.env.VISION_API_KEY = prevVision;
    }
  });
});

describe("GeminiProvider", () => {
  it("posts to :generateContent with x-goog-api-key, system_instruction and inline_data parts", async () => {
    const mock = vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: "A photo." }] } }] }));
    const provider = new GeminiProvider({ apiKey: "g-key", baseUrl: "https://gen.test", model: "gemini-x", fetchImpl: mock as unknown as typeof fetch });
    const out = await provider.describe(TWO_IMAGES, "Look", "high");
    expect(out).toBe("A photo.");

    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gen.test/v1beta/models/gemini-x:generateContent");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("g-key");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.system_instruction).toMatchObject({ parts: [{ text: expect.stringContaining("agent-eyes") }] });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 4096 }); // 2 images * 2048
    const parts = body.contents[0].parts as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({ inline_data: { mime_type: "image/png" } });
    expect(parts[2]).toMatchObject({ text: "Look" });
  });

  it("falls back to VISION_API_KEY and env overrides", async () => {
    const prevKey = process.env.VISION_API_KEY;
    const prevUrl = process.env.GEMINI_BASE_URL;
    const prevModel = process.env.GEMINI_MODEL;
    process.env.VISION_API_KEY = "shared-key";
    delete process.env.GEMINI_BASE_URL;
    delete process.env.GEMINI_MODEL;
    try {
      const mock = vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
      const provider = new GeminiProvider({ fetchImpl: mock as unknown as typeof fetch });
      expect(provider.model).toBe("gemini-2.5-flash");
      await provider.describe(ONE_IMAGE, "p", "auto");
      const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
      expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("shared-key");
    } finally {
      if (prevKey === undefined) delete process.env.VISION_API_KEY;
      else process.env.VISION_API_KEY = prevKey;
      if (prevUrl === undefined) delete process.env.GEMINI_BASE_URL;
      else process.env.GEMINI_BASE_URL = prevUrl;
      if (prevModel === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = prevModel;
    }
  });

  it("throws a provider error when the response has no candidates text", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ candidates: [] }));
    const provider = new GeminiProvider({ apiKey: "k", baseUrl: "https://gen.test", fetchImpl });
    await expect(provider.describe(ONE_IMAGE, "p", "high")).rejects.toMatchObject({ code: "provider_error" });
  });
});

describe("OllamaProvider", () => {
  it("posts to /api/chat with system + user images (no API key needed)", async () => {
    const mock = vi.fn(async () => jsonResponse({ message: { content: "Local model reply." } }));
    const provider = new OllamaProvider({ baseUrl: "http://127.0.0.1:11434", model: "qwen2.5vl", fetchImpl: mock as unknown as typeof fetch });
    const out = await provider.describe(TWO_IMAGES, "Hi", "high");
    expect(out).toBe("Local model reply.");

    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("qwen2.5vl");
    expect(body.stream).toBe(false);
    expect(body.options).toEqual({ num_predict: 4096 }); // 2 images * 2048
    expect(body.messages[0]).toMatchObject({ role: "system" });
    expect(body.messages[1].content).toBe("Hi");
    expect(body.messages[1].images).toEqual([PNG_BASE64, PNG_BASE64]);
  });

  it("reads defaults from the environment", async () => {
    const prevUrl = process.env.OLLAMA_BASE_URL;
    const prevModel = process.env.OLLAMA_MODEL;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_MODEL;
    try {
      const mock = vi.fn(async () => jsonResponse({ message: { content: "ok" } }));
      const provider = new OllamaProvider({ fetchImpl: mock as unknown as typeof fetch });
      expect(provider.model).toBe("qwen2.5vl");
      await provider.describe(ONE_IMAGE, "p", "auto");
      const [url] = mock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://localhost:11434/api/chat");
    } finally {
      if (prevUrl === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = prevUrl;
      if (prevModel === undefined) delete process.env.OLLAMA_MODEL;
      else process.env.OLLAMA_MODEL = prevModel;
    }
  });

  it("surfaces Ollama API errors as provider errors", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ error: "model not found" }, 404));
    const provider = new OllamaProvider({ baseUrl: "http://127.0.0.1:11434", fetchImpl });
    await expect(provider.describe(ONE_IMAGE, "p", "high")).rejects.toMatchObject({ code: "provider_error" });
  });
});

describe("createDefaultProvider", () => {
  const prev = process.env.VISION_PROVIDER;
  afterEach(() => {
    if (prev === undefined) delete process.env.VISION_PROVIDER;
    else process.env.VISION_PROVIDER = prev;
  });

  it("selects the provider by VISION_PROVIDER (default openai)", () => {
    expect(createDefaultProvider().name).toBe("openai");
    process.env.VISION_PROVIDER = "anthropic";
    expect(createDefaultProvider().name).toBe("anthropic");
    process.env.VISION_PROVIDER = "gemini";
    expect(createDefaultProvider().name).toBe("gemini");
    process.env.VISION_PROVIDER = "ollama";
    expect(createDefaultProvider().name).toBe("ollama");
  });

  it("fails fast on an unknown provider value", () => {
    process.env.VISION_PROVIDER = "azure";
    expect(() => createDefaultProvider()).toThrow(expect.objectContaining({ code: "config_missing" }));
  });
});
