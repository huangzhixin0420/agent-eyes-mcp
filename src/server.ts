import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildStructuredContent, describeImage } from "./core.js";
import { toUserText } from "./errors.js";
import { MAX_BASE64_TEXT } from "./images.js";
import { log } from "./log.js";
import { TASKS } from "./prompts.js";
import type { Task } from "./prompts.js";
import { DETAILS } from "./provider.js";
import { MAX_FULL_OUTPUT, truncateForTool } from "./truncate.js";
import pkg from "../package.json";

export const TOOL_NAME = "describe_image";

/**
 * Tool description: must make the trigger scenarios explicit so a text-only
 * model reaches for this tool whenever an image cannot be attached directly
 * to the conversation.
 */
export const TOOL_DESCRIPTION = [
  "Analyze one or more images with a vision-language model (VLM) and return a text description. ",
  "USE THIS TOOL when an image cannot be attached directly to the conversation but the model needs to see it: ",
  "screenshots and screen recordings, error dialogs / crash screens, terminal or log output captured as images, ",
  "charts, plots and diagrams, UI mockups and designs, photos, memes, or whenever a message references an image ",
  "file path, http(s) URL, data: URI, or base64 string.",
  "Provide the image as: a local file path (relative paths resolve against the server working directory), ",
  "an http(s) URL, a data: URI, or a raw base64 string. Pass a single string, or an array of strings to describe ",
  "several images together (the reply contains one section per image).",
  "Optional parameters: question for a targeted question (overrides task), task preset ",
  "(describe | ocr | ui | qa, default describe), detail level (low | high | auto, default high; forwarded only by ",
  "the OpenAI-compatible provider).",
].join("");

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: pkg.name, version: pkg.version });

  server.registerTool(
    TOOL_NAME,
    {
      description: TOOL_DESCRIPTION,
      inputSchema: {
        image: z
          .union([
            z.string().min(1).max(MAX_BASE64_TEXT),
            z.array(z.string().min(1).max(MAX_BASE64_TEXT)).min(1).max(8),
          ])
          .describe(
            "Image location(s): a local file path (relative paths resolve against the working directory), an http(s) URL, a data: URI, or a raw base64 string. Pass one string, or an array of strings for multiple images.",
          ),
        question: z.string().optional().describe("Optional targeted question about the image(s). When provided, overrides task."),
        task: z.enum(TASKS).default("describe").describe("Preset task. Ignored when question is provided."),
        detail: z.enum(DETAILS).default("high").describe("Image detail level sent to the vision API. Only the OpenAI-compatible provider forwards it."),
      },
    },
    async (args) => {
      log(
        "describe_image called:",
        JSON.stringify({
          image: clip(Array.isArray(args.image) ? args.image.join(", ") : args.image, 120),
          question: args.question ? clip(args.question, 120) : undefined,
          task: args.task,
          detail: args.detail,
        }),
      );
      const result = await describeImage(args.image, { question: args.question, task: args.task, detail: args.detail });

      let text: string;
      let truncatedTo: number | undefined;
      if (result.ok) {
        try {
          const t = await truncateForTool(result.text ?? "");
          text = t.text;
          truncatedTo = t.truncatedTo;
        } catch (err) {
          // Truncation itself failed (e.g. tmp write): fall back to the error
          // text, hard-capped, with honest metadata (no sidecar file was written).
          text = toUserText(err);
          if (text.length > MAX_FULL_OUTPUT) text = `${text.slice(0, MAX_FULL_OUTPUT)}…`;
          truncatedTo = undefined;
        }
        log("describe_image ok, description chars:", String(result.text?.length ?? 0));
      } else {
        text = result.error ?? "[agent-eyes-mcp] Error (internal): unknown failure.";
        log("describe_image error:", text);
      }

      const structuredContent = buildStructuredContent(result, text, truncatedTo);
      return { content: [{ type: "text", text }], ...(structuredContent ? { structuredContent } : {}) };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server ready on stdio (${pkg.name} v${pkg.version}); stdout is reserved for JSON-RPC`);
}
