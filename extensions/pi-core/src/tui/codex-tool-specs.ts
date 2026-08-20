import { type AgentToolResult, getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { createEditDiffBox } from "./edit-diff.ts";
import { countNonEmptyLines } from "./tool-output.ts";
import {
  type CodexToolRendererSpec,
  colorizeEditDiffSummary,
  colorizeWriteSummary,
  compactBashStatusSpacing,
  summarizeEditDiff,
} from "./tool-renderer.ts";
import { createWritePreviewFromArgs, type WritePreviewComponent } from "./write-preview.ts";

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

function textOutput(result: AgentToolResult<unknown>): string {
  return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function countSummary(noun: string, plural = `${noun}s`) {
  return (result: AgentToolResult<unknown>): string | undefined => {
    const count = countNonEmptyLines(textOutput(result));
    return count > 0 ? `${count} ${count === 1 ? noun : plural}` : undefined;
  };
}

function readArgument(args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : "";
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  if (offset === undefined && limit === undefined) return path;
  const start = offset ?? 1;
  const end = limit === undefined ? "" : `-${start + limit - 1}`;
  return `${path}:${start}${end}`;
}

export const codexReadToolSpec: CodexToolRendererSpec = {
  icon: "󰈙",
  runningVerb: "Reading",
  completedVerb: "Read",
  argument: readArgument,
  collapsed: "hidden",
};

export const codexGrepToolSpec: CodexToolRendererSpec = {
  icon: "󰱽",
  runningVerb: "Searching",
  completedVerb: "Searched",
  argument: (args) => {
    const pattern = typeof args.pattern === "string" ? `"${args.pattern}"` : "";
    const path = typeof args.path === "string" ? ` in ${args.path}` : "";
    return `${pattern}${path}`;
  },
  collapsed: countSummary("match", "matches"),
};

export const codexFindToolSpec: CodexToolRendererSpec = {
  icon: "󰈞",
  runningVerb: "Finding",
  completedVerb: "Found",
  argument: (args) => {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    const path = typeof args.path === "string" ? ` in ${args.path}` : "";
    return `${pattern}${path}`;
  },
  collapsed: countSummary("file"),
};

export const codexLsToolSpec: CodexToolRendererSpec = {
  icon: "󰉋",
  runningVerb: "Listing",
  completedVerb: "Listed",
  argument: (args) => (typeof args.path === "string" ? args.path : "."),
  collapsed: countSummary("entry", "entries"),
};

export const codexBashToolSpec: CodexToolRendererSpec = {
  icon: "",
  runningVerb: "Running",
  completedVerb: "Ran",
  argument: (args) => (typeof args.command === "string" ? args.command : ""),
  singleLineHeader: true,
  collapsed: "preview",
  maxOutputRows: 4,
  transformOutput: compactBashStatusSpacing,
};

export const codexWriteToolSpec: CodexToolRendererSpec<WritePreviewComponent> = {
  icon: "󰝒",
  runningVerb: "Writing",
  completedVerb: "Wrote",
  argument: (args) => (typeof args.path === "string" ? args.path : ""),
  collapsed: (_result, args) => {
    const content = typeof args.content === "string" ? args.content : "";
    const lineCount = countWrittenLines(content);
    return lineCount > 0 ? `+${lineCount}` : undefined;
  },
  formatSummary: colorizeWriteSummary,
  renderCallPreview(args, theme, context) {
    const preview = createWritePreviewFromArgs(args, context.state.rendererState?.cache, theme);
    context.state.rendererState = preview;
    return preview;
  },
  renderExpandedResult(_result, args, theme) {
    return createWritePreviewFromArgs(args, undefined, theme);
  },
};

export const codexEditToolSpec: CodexToolRendererSpec = {
  icon: "󰏫",
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
