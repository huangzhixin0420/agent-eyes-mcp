import { AgentEyesError } from "./errors.js";
import { SYSTEM_PROMPT } from "./prompts.js";

/**
 * Provider layer. A VisionProvider sends one or more images plus a prompt to
 * a vision-language model and returns plain text. `detail` is only honored by
 * the OpenAI-compatible adapter (auto/low/high are all legal OpenAI values);
 * the other providers ignore it.
 */
export const DETAILS = ["low", "high", "auto"] as const;
export type Detail = (typeof DETAILS)[number];

export interface VisionImage {
  bytes: Buffer;
  mime: string;
}

export interface VisionProvider {
  /** Stable adapter name (openai | anthropic | gemini | ollama), surfaced in result meta. */
  readonly name: string;
  /** Model identifier, used as part of the cache key. */
  readonly model: string;
  describe(images: VisionImage[], prompt: string, detail: Detail): Promise<string>;
}

const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Reasoning models (MiniMax-M3, Qwen3, ...) inline their chain-of-thought in
 * <think> blocks; callers only want the answer. A response that is *only*
 * thinking is treated as missing content. Handles both closed and unclosed
 * blocks, so a truncated <think> that never closes is still stripped.
 */
export function cleanResponseText(raw: string): string {
  const stripped = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim();
  if (!stripped) {
    throw new AgentEyesError(
      "provider_error",
      "Vision API returned only a reasoning block with no answer.",
      "Retry, or switch to a non-reasoning model.",
    );
  }
  return stripped;
}

/**
 * Shared HTTP helper: network failures, non-2xx responses, and non-JSON
 * bodies are all converted into structured provider errors.
 */
export async function requestJson(fetchImpl: typeof fetch, url: string, init: RequestInit, description: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new AgentEyesError(
      "provider_error",
      `Failed to reach the vision API (${description}): ${reason}`,
      timedOut
        ? `The request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s; try again or use smaller images.`
        : "Check the base URL and your network connection.",
    );
  }

  if (!res.ok) {
    let detailText = "";
    try {
      detailText = (await res.text()).slice(0, 600);
    } catch {
      /* ignore body read errors */
    }
    throw new AgentEyesError(
      "provider_error",
      `Vision API returned HTTP ${res.status}${res.statusText ? " " + res.statusText : ""} (${description}).`,
      detailText ? `Response: ${detailText}` : "Check the API key, model, and base URL.",
    );
  }

  try {
    return await res.json();
  } catch {
    throw new AgentEyesError(
      "provider_error",
      `Vision API returned a non-JSON response (${description}).`,
      "Check the base URL — it must point to the provider's chat completions endpoint.",
    );
  }
}

/** Per-image token budget used to size max_tokens (capped at 8192). */
function maxTokens(images: VisionImage[]): number {
  return Math.min(8192, 2048 * Math.max(1, images.length));
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible /chat/completions (default)                       */
/* ------------------------------------------------------------------ */

export interface OpenAICompatOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

const OPENAI_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const OPENAI_DEFAULT_MODEL = "qwen-vl-max";

export class OpenAICompatProvider implements VisionProvider {
  readonly name = "openai";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAICompatOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.VISION_API_KEY ?? "";
    this.baseUrl = (opts.baseUrl ?? process.env.VISION_BASE_URL ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model ?? process.env.VISION_MODEL ?? OPENAI_DEFAULT_MODEL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async describe(images: VisionImage[], prompt: string, detail: Detail): Promise<string> {
    if (!this.apiKey) {
      throw new AgentEyesError(
        "config_missing",
        "VISION_API_KEY is not set.",
        "Set the VISION_API_KEY environment variable (e.g. a DashScope or MiniMax API key) and restart the server.",
      );
    }

    const body = {
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...images.map((img) => ({
              type: "image_url",
              image_url: { url: `data:${img.mime};base64,${img.bytes.toString("base64")}`, detail },
            })),
          ],
        },
      ],
      max_tokens: maxTokens(images),
    };

    const data = await requestJson(
      this.fetchImpl,
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      this.name,
    );

    const obj = data as { error?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
    if (obj.error) {
      const msg = typeof obj.error === "string" ? obj.error : ((obj.error as { message?: string }).message ?? "unknown error");
      throw new AgentEyesError("provider_error", `Vision API error: ${msg}`, "Check the API key, model name, and image format.");
    }

    const content = obj.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim()) return cleanResponseText(content);
    if (Array.isArray(content)) {
      const joined = content
        .filter((p): p is { text?: string } => typeof p === "object" && p !== null && typeof (p as { text?: unknown }).text === "string")
        .map((p) => p.text ?? "")
        .join("");
      if (joined.trim()) return cleanResponseText(joined);
    }
    throw new AgentEyesError(
      "provider_error",
      "Vision API returned a response without a description.",
      "The response had no choices[0].message.content.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Anthropic Messages API                                              */
/* ------------------------------------------------------------------ */

export interface AnthropicOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5";

export class AnthropicProvider implements VisionProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AnthropicOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.VISION_API_KEY ?? "";
    this.baseUrl = (opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model ?? process.env.ANTHROPIC_MODEL ?? ANTHROPIC_DEFAULT_MODEL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async describe(images: VisionImage[], prompt: string, _detail: Detail): Promise<string> {
    if (!this.apiKey) {
      throw new AgentEyesError(
        "config_missing",
        "ANTHROPIC_API_KEY is not set.",
        "Set ANTHROPIC_API_KEY (or VISION_API_KEY when using the openai provider) and restart the server.",
      );
    }

    const body = {
      model: this.model,
      max_tokens: maxTokens(images),
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            ...images.map((img) => ({
              type: "image",
              source: { type: "base64", media_type: img.mime, data: img.bytes.toString("base64") },
            })),
            { type: "text", text: prompt },
          ],
        },
      ],
    };

    const data = await requestJson(
      this.fetchImpl,
      `${this.baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      },
      this.name,
    );

    const obj = data as { content?: Array<{ type: string; text?: string }> };
    const joined = (obj.content ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
    if (joined.trim()) return cleanResponseText(joined);
    throw new AgentEyesError(
      "provider_error",
      "Anthropic API returned a response without a description.",
      "The response had no text content blocks.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Google Gemini generateContent API                                   */
/* ------------------------------------------------------------------ */

export interface GeminiOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

export class GeminiProvider implements VisionProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GeminiOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.VISION_API_KEY ?? "";
    this.baseUrl = (opts.baseUrl ?? process.env.GEMINI_BASE_URL ?? GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model ?? process.env.GEMINI_MODEL ?? GEMINI_DEFAULT_MODEL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async describe(images: VisionImage[], prompt: string, _detail: Detail): Promise<string> {
    if (!this.apiKey) {
      throw new AgentEyesError(
        "config_missing",
        "GEMINI_API_KEY is not set.",
        "Set GEMINI_API_KEY (or VISION_API_KEY when using the openai provider) and restart the server.",
      );
    }

    const body = {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          role: "user",
          parts: [
            ...images.map((img) => ({ inline_data: { mime_type: img.mime, data: img.bytes.toString("base64") } })),
            { text: prompt },
          ],
        },
      ],
      // Bound the output so a runaway generation cannot balloon past the tool budget.
      generationConfig: { maxOutputTokens: maxTokens(images) },
    };

    const url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent`;
    const data = await requestJson(
      this.fetchImpl,
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
      },
      this.name,
    );

    const obj = data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const joined = (obj.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    if (joined.trim()) return cleanResponseText(joined);
    throw new AgentEyesError(
      "provider_error",
      "Gemini API returned a response without a description.",
      "The response had no candidates[0].content.parts text.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Ollama (local, keyless)                                              */
/* ------------------------------------------------------------------ */

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";
const OLLAMA_DEFAULT_MODEL = "qwen2.5vl";

export class OllamaProvider implements VisionProvider {
  readonly name = "ollama";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model ?? process.env.OLLAMA_MODEL ?? OLLAMA_DEFAULT_MODEL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async describe(images: VisionImage[], prompt: string, _detail: Detail): Promise<string> {
    const body = {
      model: this.model,
      stream: false,
      options: { num_predict: maxTokens(images) }, // bound the output length
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt, images: images.map((img) => img.bytes.toString("base64")) },
      ],
    };

    const data = await requestJson(
      this.fetchImpl,
      `${this.baseUrl}/api/chat`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      this.name,
    );

    const obj = data as { message?: { content?: string }; error?: string };
    if (obj.error) {
      throw new AgentEyesError(
        "provider_error",
        `Ollama API error: ${obj.error}`,
        "Check that the vision model is pulled (`ollama pull ...`) and the server is running.",
      );
    }
    if (typeof obj.message?.content === "string" && obj.message.content.trim()) return cleanResponseText(obj.message.content);
    throw new AgentEyesError(
      "provider_error",
      "Ollama API returned a response without a description.",
      "The response had no message.content.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

export type ProviderName = "openai" | "anthropic" | "gemini" | "ollama";

/** Pick a provider from VISION_PROVIDER (default openai). Unknown values fail fast. */
export function createDefaultProvider(fetchImpl?: typeof fetch): VisionProvider {
  const name = (process.env.VISION_PROVIDER ?? "openai").trim().toLowerCase();
  switch (name) {
    case "openai":
      return new OpenAICompatProvider({ fetchImpl });
    case "anthropic":
      return new AnthropicProvider({ fetchImpl });
    case "gemini":
      return new GeminiProvider({ fetchImpl });
    case "ollama":
      return new OllamaProvider({ fetchImpl });
    default:
      throw new AgentEyesError(
        "config_missing",
        `Unknown VISION_PROVIDER "${process.env.VISION_PROVIDER}".`,
        "Valid values: openai, anthropic, gemini, ollama.",
      );
  }
}
