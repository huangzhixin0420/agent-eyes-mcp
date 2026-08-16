# agent-eyes-mcp

> Give text-only LLM agents eyes: describe images through a vision-language model (VLM) via MCP or CLI.

Text models cannot see screenshots, error dialogs, or charts. `agent-eyes-mcp` is a single npm package that runs as an **MCP server** (stdio) exposing one tool, `describe_image`, which sends one or more images to a VLM API and returns a text description. The image is never attached to the model's context — the VLM does the seeing, the text model reads the answer.

Install in one line: `npx -y agent-eyes-mcp`.

## Features

- **One MCP tool, `describe_image`** — accepts a local file path, an `http(s)` URL, a `data:` URI, or a raw base64 string; pass one image or an array of several.
- **Four preset tasks** — `describe` (default), `ocr`, `ui`, `qa`, plus an optional free-form `question` that overrides the task.
- **Model-friendly tool description** — tells the agent exactly when to use it (screenshots, error screens, charts, UI, image paths in messages) and that it exists precisely for the case where an image cannot be attached directly to the conversation.
- **Automatic preprocessing** — images over 10 MB or wider than 2048 px are downscaled; large high-resolution images are split into a full view plus tiled crops (multi-crop) so small VLMs can read them. EXIF orientation is normalized and metadata stripped; re-encoding retries at lower JPEG quality to stay within the byte budget. Falls back to the original bytes on any failure. Images whose header claims more than 100 megapixels (a pixel bomb) are rejected as too large rather than processed.
- **Multi-image descriptions** — pass several images at once; the reply contains one `## Image N (<source>)` section per image.
- **Four provider backends** — OpenAI-compatible (default, e.g. DashScope / MiniMax), Anthropic, Google Gemini, and local Ollama, selected with `VISION_PROVIDER`.
- **Safe by default** — local files are sandboxed to the working directory (`AGENT_EYES_ALLOWED_DIR` to widen), URLs are SSRF-guarded (DNS failures fail closed; private, NAT64, IPv4-mapped, and non-unicast addresses are rejected; every redirect hop is re-checked — see [URL safety](#url-safety-model)), and total input across all images is capped at 20 MB.
- **Two-layer cache** — in-process LRU (128 entries) plus an optional persistent disk cache (`AGENT_EYES_DISK_CACHE=1`). The key is `sha256(raw bytes + prompt + model + provider + detail)` computed *before* preprocessing, so identical image + question + model pairs never call the API twice — even across restarts.
- **Structured output** — successful tool calls also return `structuredContent` with the full text, model, provider, image count, and cache status.
- **Output protection** — descriptions longer than 4000 characters are written in full to a temp file; the tool returns the first 2000 characters plus the file path.
- **Never crashes on bad input** — every failure (missing API key, network error, missing file, out-of-bounds path) returns structured, actionable error text.
- **Pure stdio MCP** — no logs on stdout (they would corrupt JSON-RPC); all logging goes to stderr.

## Quick start

```bash
export VISION_API_KEY=sk-...          # required (default provider)
npx -y agent-eyes-mcp                 # starts the MCP stdio server
```

### Claude Code

`.mcp.json` at the project root (or use `claude mcp add`):

```json
{
  "mcpServers": {
    "agent-eyes": {
      "command": "npx",
      "args": ["-y", "agent-eyes-mcp"],
      "env": {
        "VISION_API_KEY": "sk-...",
        "VISION_MODEL": "qwen-vl-max"
      }
    }
  }
}
```

or with the CLI:

```bash
claude mcp add agent-eyes --env VISION_API_KEY=sk-... -- npx -y agent-eyes-mcp
```

#### Claude Code hook: point image references at `describe_image`

Text-only Claude Code sessions cannot attach images. The built-in `hook` subcommand injects a hint (via `additionalContext`) whenever the user's message references an image file, telling the agent to use `describe_image` instead of trying to read the file. Add it to `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx -y agent-eyes-mcp hook",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

The hook never blocks the prompt — on no image match it exits silently with code 0.

### Cursor

`Settings → MCP` → Add server, or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agent-eyes": {
      "command": "npx",
      "args": ["-y", "agent-eyes-mcp"],
      "env": {
        "VISION_API_KEY": "sk-..."
      }
    }
  }
}
```

Then ask the agent to "read this screenshot", "what does this error say", etc.

### Kimi Code

`~/.kimi-code/mcp.json` (user level) or `.kimi-code/mcp.json` (project level), or run `/mcp-config` in the TUI:

```json
{
  "mcpServers": {
    "agent-eyes": {
      "command": "npx",
      "args": ["-y", "agent-eyes-mcp"],
      "env": {
        "VISION_API_KEY": "sk-..."
      }
    }
  }
}
```

### Other MCP clients

Any client that supports stdio MCP servers works the same way: run `npx -y agent-eyes-mcp` and pass `VISION_API_KEY` (plus `VISION_PROVIDER` / `VISION_BASE_URL` / `VISION_MODEL` as needed) in the server's environment. The tool is named `describe_image` (clients usually show it as `agent-eyes_describe_image` or `mcp__agent-eyes__describe_image`).

## CLI usage

```bash
agent-eyes-mcp                                # start the MCP stdio server (default)
agent-eyes-mcp serve                          # same
agent-eyes-mcp describe ./screenshot.png      # describe an image
agent-eyes-mcp describe a.png b.png -q "Which one shows the error?"   # multiple images
agent-eyes-mcp describe https://example.com/a.png -t ocr
agent-eyes-mcp describe data:image/png;base64,... --detail low
agent-eyes-mcp --help
```

In CLI mode the description is printed in full to stdout.

## Providers

`VISION_PROVIDER` selects the backend; unknown values fail fast with an actionable error.

| `VISION_PROVIDER` | Default base URL                                   | Default model          | Auth / notes                                   |
| ----------------- | -------------------------------------------------- | ---------------------- | ---------------------------------------------- |
| `openai` (default)| `https://dashscope.aliyuncs.com/compatible-mode/v1`| `qwen-vl-max`          | `VISION_API_KEY` (Bearer). `detail` forwarded (`low`/`high`/`auto`). |
| `anthropic`       | `https://api.anthropic.com`                        | `claude-haiku-4-5`     | `ANTHROPIC_API_KEY` (falls back to `VISION_API_KEY`). `detail` ignored. |
| `gemini`          | `https://generativelanguage.googleapis.com`        | `gemini-2.5-flash`     | `GEMINI_API_KEY` (falls back to `VISION_API_KEY`). `detail` ignored. |
| `ollama`          | `http://localhost:11434`                           | `qwen2.5vl`            | No API key. `detail` ignored.                   |

Reasoning models (MiniMax-M3, Qwen3, …) that emit `<think>...</think>` blocks have the reasoning stripped automatically — including truncated blocks that never close; a response that is *only* reasoning is treated as an error.

Example — MiniMax as the backend (verified end to end):

```bash
export VISION_PROVIDER=openai   # default
export VISION_BASE_URL=https://api.minimaxi.com/v1
export VISION_MODEL=MiniMax-M3
export VISION_API_KEY=sk-...    # MiniMax API key
```

## Environment variables

| Variable                  | Required | Default                                                        | Description                                                                 |
| ------------------------- | -------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `VISION_PROVIDER`         | no       | `openai`                                                       | Backend: `openai` \| `anthropic` \| `gemini` \| `ollama`. Unknown → actionable error. |
| `VISION_API_KEY`          | openai*  | —                                                              | API key for the OpenAI-compatible provider (also a fallback for anthropic/gemini). |
| `VISION_BASE_URL`         | no       | `https://dashscope.aliyuncs.com/compatible-mode/v1`             | Base URL of an OpenAI-compatible `/chat/completions` endpoint.               |
| `VISION_MODEL`            | no       | `qwen-vl-max`                                                  | OpenAI-compatible model name.                                                |
| `ANTHROPIC_API_KEY`       | anthropic*| —                                                              | Anthropic API key (falls back to `VISION_API_KEY`).                          |
| `ANTHROPIC_BASE_URL`      | no       | `https://api.anthropic.com`                                    | Anthropic Messages API base URL.                                             |
| `ANTHROPIC_MODEL`         | no       | `claude-haiku-4-5`                                             | Anthropic model name.                                                        |
| `GEMINI_API_KEY`          | gemini*  | —                                                              | Google Gemini API key (falls back to `VISION_API_KEY`).                      |
| `GEMINI_BASE_URL`         | no       | `https://generativelanguage.googleapis.com`                    | Gemini `generateContent` base URL.                                           |
| `GEMINI_MODEL`            | no       | `gemini-2.5-flash`                                             | Gemini model name.                                                           |
| `OLLAMA_BASE_URL`         | no       | `http://localhost:11434`                                       | Local Ollama base URL.                                                       |
| `OLLAMA_MODEL`            | no       | `qwen2.5vl`                                                    | Ollama vision model name (must be pulled first).                             |
| `AGENT_EYES_ALLOWED_DIR`  | no       | working directory                                              | Root directory the file sandbox permits (relative paths still resolve against `process.cwd()`). |
| `AGENT_EYES_DISK_CACHE`   | no       | (off)                                                          | Set to `1` to persist the description cache to disk.                         |
| `AGENT_EYES_DISK_CACHE_DIR`| no      | `os.tmpdir()/agent-eyes-mcp/cache`                             | Disk cache directory (created lazily).                                       |

`*` required for that provider only.

## Image inputs, preprocessing & limits

| Form        | Example                                | Notes                                                                                     |
| ----------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| File path   | `screenshots/error.png`                | Relative paths resolve against `process.cwd()`; must stay inside the sandbox (working directory, or `AGENT_EYES_ALLOWED_DIR`). |
| URL         | `https://host/a.png`                   | `http(s)` only; the fetched body is capped at 20 MB. The *resolved address* is checked before connecting: private/local ranges (loopback, 10/8, 172.16/12, 192.168/16, link-local 169.254/16, CGNAT 100.64/10, multicast, broadcast, reserved), IPv4-mapped IPv6, NAT64 (`64:ff9b::/96`, incl. the RFC 8215 /48 form), and any other non-unicast IPv6 are blocked. DNS resolution failures fail closed; every redirect hop is re-checked (max 5). |
| data: URI   | `data:image/png;base64,...`            | The declared MIME is validated against the image magic bytes.                              |
| base64      | `iVBORw0KGgo...`                       | MIME is sniffed from magic bytes.                                                          |

**Preprocessing** (before calling the VLM):

- Images whose long edge exceeds **2048 px** or whose size exceeds **10 MB** are downscaled to fit inside 2048 px and re-encoded as JPEG; quality is stepped down (85 → 35) until the view fits 10 MB. EXIF orientation is applied and metadata stripped.
- Images at or above **1800 px** on the long edge **and** 3.5 MP are split into a full (downscaled) view plus up to 4 tiles (5 views total). The reply's prompt tells the model that view 1 is the full image and views 2..N are crops ordered left-to-right then top-to-bottom.
- If `sharp` cannot decode the image, or any preprocessing step fails, the **original bytes are passed through untouched** — preprocessing never turns a valid image into an error.
- Images whose decoded pixel count exceeds **100 megapixels** are rejected with an actionable `too_large` error (pixel bomb). The metadata read bypasses sharp's own default pixel limit so the oversized file is detected up front, before any decode work.
- **Total input across all images is capped at 20 MB** (checked on the raw bytes before preprocessing). Exceeding it returns an actionable error; a single large image is preprocessed instead of rejected.

## URL safety model

Fetching an `http(s)` URL is the riskiest input path, so it is handled defensively:

- **DNS failures fail closed.** If the host cannot be resolved, the request is a hard `fetch_failed` error — there is no "try anyway" fallback.
- **The resolved address is checked, not the hostname.** Loopback, private (RFC 1918), link-local, CGNAT (RFC 6598), multicast, broadcast, and reserved addresses are rejected. IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are unwrapped and re-checked as IPv4, and the NAT64 prefix `64:ff9b::/96` (which also covers the RFC 8215 /48 form) is rejected outright. Any other non-unicast IPv6 address is rejected.
- **Redirects are followed manually, one hop at a time** (max 5). Every hop must be an `http(s)` URL that passes the same address checks; a redirect to `file:`, a private host, or a local address is rejected. This keeps a public image host from bouncing the fetch into the local network.
- **Connections are pinned to the validated addresses.** DNS is resolved once per hop, every answer is validated, and the connection's `lookup` is replaced with a function that only ever returns those validated addresses — the fetch performs no second DNS resolution, so a resolver that changes its answers between check and connect (DNS rebinding / TOCTOU) cannot redirect the connection to a private address. URL fetching uses undici's own `fetch` because Node's built-in `fetch` rejects dispatchers from the npm undici package.
- **Body cap:** at most 20 MB is read (streamed), and the connection is never used for anything else.

## Known tradeoffs (accepted for now)

These came out of a security/robustness review but are deliberately out of scope for this round:

- **Provider construction boilerplate** — the four providers in `src/provider.ts` each repeat the same constructor plumbing (`apiKey`/`baseUrl`/`model`/`fetchImpl`). A shared base class or factory would dedupe it; left explicit so each adapter stays self-contained.
- **Duplicate limit constants** — `MAX_TILE_EDGE` and `MAX_DOWNSCALE_EDGE` are both 2048 and could be merged. Likewise the documented limits (10 MB, 2048 px, 20 MB, 100 MP) are repeated in prose here and in the CLI help instead of being derived from the shared constants.
- **Hand-rolled response parsing** — provider responses are parsed with defensive type casts rather than schemas; a small zod schema per provider would yield exact error messages for malformed payloads.

## Caching, structured output & output protection

- **Memory cache:** in-process LRU, 128 entries. The key is `sha256(raw resolved bytes + prompt + model + provider + detail)`, computed before preprocessing so a hit skips all sharp work.
- **Disk cache:** with `AGENT_EYES_DISK_CACHE=1`, successful descriptions are written under `AGENT_EYES_DISK_CACHE_DIR` (default `os.tmpdir()/agent-eyes-mcp/cache`) as `<key>.txt` (0700 dir / 0600 files, atomic temp-file+rename writes, capped at 500 entries by mtime) and reused across restarts; a disk hit backfills the memory cache. Read/write failures are logged and ignored.
- **Structured output:** successful `describe_image` tool calls return `structuredContent` = `{ text, model, provider, imageCount, cached, truncatedTo? }` alongside the plain-text content.
- **Output:** MCP tool replies longer than 4000 characters are stored in full in a private temp file (`os.tmpdir()/agent-eyes-mcp/truncated/description-<uuid>.txt`, 0700 dir / 0600 file); the tool returns the first 2000 characters plus the file path. CLI mode always prints the full description.

## Error handling

All failures return structured text like `[agent-eyes-mcp] Error (sandbox_denied): ... Hint ...` as the tool's content — the process never crashes. Logs go to **stderr only**; stdout is reserved for MCP JSON-RPC (or CLI output).

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsup -> single ESM bundle at dist/index.js (sharp stays external)
npm test            # vitest
npm run smoke       # spawns the built server and drives initialize/tools/list/tools/call over stdio
```

## Roadmap

- [ ] MCP Registry listing / `mcp.json` installation
- [ ] Remote (HTTP/SSE) transport

## License

MIT
