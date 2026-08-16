import { describeImage } from "./core.js";
import { log } from "./log.js";
import pkg from "../package.json";
import { TASKS } from "./prompts.js";
import type { Task } from "./prompts.js";
import { DETAILS } from "./provider.js";
import type { Detail } from "./provider.js";

export interface DescribeCliArgs {
  images: string[];
  question?: string;
  task?: Task;
  detail?: Detail;
}

export type ParseResult = { kind: "ok"; args: DescribeCliArgs } | { kind: "error"; error: string } | { kind: "help" };

/** Manual argv parsing for `describe` (no extra dependency needed). */
export function parseDescribeArgs(argv: string[]): ParseResult {
  const images: string[] = [];
  let question: string | undefined;
  let task: Task | undefined;
  let detail: Detail | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-q" || arg === "--question") {
      const value = argv[++i];
      if (value === undefined) return { kind: "error", error: `Missing value for "${arg}".` };
      question = value;
    } else if (arg === "-t" || arg === "--task") {
      const value = argv[++i];
      if (value === undefined) return { kind: "error", error: `Missing value for "${arg}".` };
      if (!(TASKS as readonly string[]).includes(value)) {
        return { kind: "error", error: `Invalid task "${value}". Valid tasks: ${TASKS.join(", ")}.` };
      }
      task = value as Task;
    } else if (arg === "--detail") {
      const value = argv[++i];
      if (value === undefined) return { kind: "error", error: 'Missing value for "--detail".' };
      if (!DETAILS.includes(value as Detail)) {
        return { kind: "error", error: `Invalid detail "${value}". Valid values: ${DETAILS.join(", ")}.` };
      }
      detail = value as Detail;
    } else if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    } else if (arg.startsWith("-")) {
      return { kind: "error", error: `Unknown option "${arg}".` };
    } else {
      images.push(arg);
    }
  }

  if (images.length === 0) {
    return { kind: "error", error: "Missing required argument: <image>. Usage: agent-eyes-mcp describe <image> [<image> ...] [-q question] [-t task]" };
  }
  return { kind: "ok", args: { images, question, task, detail } };
}

/** CLI mode: parse, describe, print the full description to stdout. */
export async function runDescribe(argv: string[]): Promise<number> {
  const parsed = parseDescribeArgs(argv);
  if (parsed.kind === "help") {
    printHelp();
    return 0;
  }
  if (parsed.kind === "error") {
    process.stderr.write(`agent-eyes-mcp: ${parsed.error}\n`);
    return 1;
  }
  const result = await describeImage(parsed.args.images, {
    question: parsed.args.question,
    task: parsed.args.task,
    detail: parsed.args.detail,
  });
  if (!result.ok) {
    process.stderr.write((result.error ?? "unknown error") + "\n");
    return 1;
  }
  // stdout is allowed in CLI mode: this is the actual command output.
  process.stdout.write(result.text + "\n");
  log("meta:", JSON.stringify(result.meta));
  return 0;
}

export function printHelp(): void {
  process.stdout.write(`agent-eyes-mcp v${pkg.version} — give text-only LLM agents eyes (MCP server + CLI)

Usage:
  agent-eyes-mcp                        Start the MCP stdio server (default)
  agent-eyes-mcp serve                  Start the MCP stdio server
  agent-eyes-mcp describe <image> [<image> ...] [-q <question>] [-t <task>] [--detail <low|high|auto>]
  agent-eyes-mcp hook                   Claude Code UserPromptSubmit hook (reads hook JSON from stdin)
  agent-eyes-mcp --help                 Show this help
  agent-eyes-mcp --version              Print the version

describe arguments:
  <image>           One or more image locations: local file paths (relative
                    paths resolve against the working directory), http(s)
                    URLs, data: URIs, or raw base64 strings. Multiple images
                    are described together, one section per image.
  -q, --question    Optional targeted question about the image (overrides -t).
  -t, --task        describe | ocr | ui | qa (default: describe).
  --detail          low | high | auto (default: high). Forwarded only by the
                    OpenAI-compatible provider; others ignore it.

Environment:
  VISION_PROVIDER          openai | anthropic | gemini | ollama (default: openai).
  VISION_API_KEY           API key for the OpenAI-compatible provider.
  VISION_BASE_URL          Default: https://dashscope.aliyuncs.com/compatible-mode/v1
  VISION_MODEL             Default: qwen-vl-max
  ANTHROPIC_API_KEY        Anthropic API key (falls back to VISION_API_KEY).
  ANTHROPIC_BASE_URL       Default: https://api.anthropic.com
  ANTHROPIC_MODEL          Default: claude-haiku-4-5
  GEMINI_API_KEY           Google Gemini API key (falls back to VISION_API_KEY).
  GEMINI_BASE_URL          Default: https://generativelanguage.googleapis.com
  GEMINI_MODEL             Default: gemini-2.5-flash
  OLLAMA_BASE_URL          Default: http://localhost:11434
  OLLAMA_MODEL             Default: qwen2.5vl
  AGENT_EYES_ALLOWED_DIR   Overrides the sandbox root for local image paths
                           (default: the working directory).
  AGENT_EYES_DISK_CACHE    Set to 1 to persist the description cache to disk.
  AGENT_EYES_DISK_CACHE_DIR  Cache directory (default: os.tmpdir()/agent-eyes-mcp/cache).

Examples:
  agent-eyes-mcp describe ./screenshot.png
  agent-eyes-mcp describe a.png b.png -q "Which one shows the error?"
  agent-eyes-mcp describe https://example.com/a.png -t ocr
  agent-eyes-mcp describe data:image/png;base64,... --detail low
`);
}
