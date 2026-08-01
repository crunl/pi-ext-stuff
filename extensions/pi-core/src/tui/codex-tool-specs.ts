import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { createEditDiffBox } from "./edit-diff.ts";
import {
  type CodexToolRendererSpec,
  colorizeEditDiffSummary,
  compactBashStatusSpacing,
  summarizeEditDiff,
} from "./tool-renderer.ts";

/**
 * Line count for a file write, used as the collapsed summary of the write
 * tool (e.g. "Wrote src/a.ts · +42"). A trailing newline does not count as
 * an extra line. Originally defined in pi-permissions; moved here so the
 * write rendering spec lives with the rest of the Codex rendering specs.
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
