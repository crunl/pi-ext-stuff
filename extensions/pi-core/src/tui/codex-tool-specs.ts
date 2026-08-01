import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { createEditDiffBox } from "./edit-diff.ts";
import {
  type CodexToolRendererSpec,
  colorizeEditDiffSummary,
  compactBashStatusSpacing,
  summarizeEditDiff,
} from "./tool-renderer.ts";
import {
  createWritePreview,
  updateWriteHighlightCache,
  type WriteHighlightCache,
} from "./write-preview.ts";

/**
 * Line count for a file write, used as the collapsed summary of the write
 * tool (e.g. "Wrote src/a.ts · +42", green). A trailing newline does not
 * count as an extra line.
 */
export function countWrittenLines(content: string): number {
  if (content.length === 0) return 0;
  const normalized = content.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").length;
  return normalized.endsWith("\n") ? lines - 1 : lines;
}

export const codexBashToolSpec: CodexToolRendererSpec = {
  icon: "",
  runningVerb: "Running",
  completedVerb: "Ran",
  argument: (args) => (typeof args.command === "string" ? args.command : ""),
  collapsed: "preview",
  transformOutput: compactBashStatusSpacing,
};

export const codexWriteToolSpec: CodexToolRendererSpec = {
  icon: "",
  runningVerb: "Writing",
  completedVerb: "Wrote",
  argument: (args) => (typeof args.path === "string" ? args.path : ""),
  collapsed: (_result, args) => {
    const content = typeof args.content === "string" ? args.content : "";
    const lineCount = countWrittenLines(content);
    return lineCount > 0 ? `+${lineCount}` : undefined;
  },
  formatSummary: (summary, theme) => theme.fg("success", summary),
  renderCallPreview(args, theme, context) {
    const path = typeof args.path === "string" ? args.path : "";
    const content = typeof args.content === "string" ? args.content : "";
    const cache = updateWriteHighlightCache(
      context.state.rendererState as WriteHighlightCache | undefined,
      path,
      content,
    );
    context.state.rendererState = cache;
    return createWritePreview(cache, theme);
  },
  renderExpandedResult(_result, args, theme) {
    const path = typeof args.path === "string" ? args.path : "";
    const content = typeof args.content === "string" ? args.content : "";
    return createWritePreview(updateWriteHighlightCache(undefined, path, content), theme);
  },
};

export const codexEditToolSpec: CodexToolRendererSpec = {
  icon: "",
  runningVerb: "Editing",
  completedVerb: "Edited",
  argument: (args) => (typeof args.path === "string" ? args.path : ""),
  collapsed: summarizeEditDiff,
  formatSummary: colorizeEditDiffSummary,
  renderExpandedResult: (result, args, theme, outputPad) => {
    const details = result.details as { diff?: unknown } | undefined;
    return createEditDiffBox(typeof details?.diff === "string" ? details.diff : "", theme, {
      outputPad,
      lang: typeof args.path === "string" ? getLanguageFromPath(args.path) : undefined,
    });
  },
};
