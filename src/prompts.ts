export const TASKS = ["describe", "ocr", "ui", "qa"] as const;
export type Task = (typeof TASKS)[number];
export const DEFAULT_TASK: Task = "describe";

/**
 * System prompt designed for a *pure-text agent* as the consumer of the VLM
 * output: it demands verbatim transcription of all visible text, spatial
 * layout/color/state reporting, and explicit disclosure of anything unclear.
 */
export const SYSTEM_PROMPT = `You are "agent-eyes", an image-analysis engine. Your reader is a text-only AI agent that cannot see images, so your entire output must be precise, self-contained, and easy to parse as plain text.

Rules:
1. TEXT: Quote every visible piece of text verbatim, exactly as written — error messages, labels, button text, numbers, URLs, and code. Preserve spelling, capitalization, and punctuation. If text is cropped or blurry, transcribe what is legible and explicitly mark anything unclear with [unclear].
2. LAYOUT: Describe the spatial arrangement of elements (top/bottom/left/right, approximate positions) and the visual hierarchy.
3. VISUALS: Report colors, icons, chart types and trends, people, objects, and any state indicators (loading, success, error, selected, disabled, hover).
4. HONESTY: If something is ambiguous, blurry, or unreadable, say so plainly. Never invent details that are not visible in the image.
5. FORMAT: Use short headings and bullet lists where they help. Be information-dense but complete.`;

/** A provided question always takes precedence over the preset task. */
export function buildUserPrompt(question?: string, task: Task = DEFAULT_TASK): string {
  const q = question?.trim();
  if (q) {
    return `Answer the following question about the image. Follow the system rules for verbatim text, layout, and honesty.\n\nQuestion: ${q}`;
  }
  switch (task) {
    case "ocr":
      return "Extract and transcribe ALL visible text in the image verbatim, preserving reading order and line breaks. If there is no readable text, state that explicitly.";
    case "ui":
      return "Analyze the user interface shown in the image: describe the layout structure, the UI elements present, their colors, and their states (for example hover, focus, selected, disabled, error). Point out any visible problems or error messages.";
    case "qa":
      return "Describe this image thoroughly and answer any implied question: the subject, ALL visible text quoted verbatim, spatial layout, colors, and any status or error indicators.";
    case "describe":
    default:
      return "Describe this image in detail: the overall scene and subject, ALL visible text quoted verbatim, the spatial layout, colors, and any status indicators, buttons, or error messages. Structure your answer with short headings.";
  }
}

/**
 * Per-image instructions appended to the user prompt for multi-image requests
 * (or any request where an image was split into multiple views): the VLM must
 * answer per image under a fixed section heading, and when any image has more
 * than one view it is told how the views are ordered.
 */
export function buildImageSetInstructions(labels: string[], viewCounts: number[]): string {
  const heading = `The request contains ${labels.length} image(s). Describe every image in its own section and start each section with a heading formatted exactly like "## Image <N> (<label>)", where <N> is the 1-based image index and <label> is the source of the image.`;
  const views = viewCounts.some((c) => c > 1)
    ? " Some images have multiple views: view 1 is the full image, and views 2..N are crops ordered left-to-right then top-to-bottom."
    : "";
  return heading + views;
}
