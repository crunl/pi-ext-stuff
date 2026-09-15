import { homedir } from "node:os";
import { sep } from "node:path";
import {
  type AgentToolResult,
  getLanguageFromPath,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { createEditDiffBox } from "./edit-diff.ts";
import { countNonEmptyLines, toolResultText } from "./tool-output.ts";
import type { CodexToolRendererSpec } from "./tool-renderer.ts";
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

/** Collapse the blank line Pi prints before the final bash status line. */
export function compactBashStatusSpacing(text: string): string {
  return text.replace(
    /\n{2,}(?=Command (?:exited with code \d+|timed out after [^\n]+ seconds|aborted)\s*$)/,
    "\n",
  );
}

export function summarizeEditDiff(result: AgentToolResult<unknown>): string | undefined {
  const details = result.details as { diff?: unknown } | undefined;
  if (typeof details?.diff !== "string") return undefined;

  let additions = 0;
  let deletions = 0;
  for (const line of details.diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return additions > 0 || deletions > 0 ? `+${additions} -${deletions}` : undefined;
}

export function colorizeEditDiffSummary(summary: string, theme: Theme): string {
  const match = summary.match(/^(\+\d+)\s+(-\d+)$/);
  if (!match) return theme.fg("dim", summary);
  return `${theme.fg("success", match[1])} ${theme.fg("error", match[2])}`;
}

/** Colorize a collapsed summary that is a single positive count (e.g. write's +N lines). */
export function colorizeWriteSummary(summary: string, theme: Theme): string {
  return theme.fg("success", summary);
}

function countSummary(noun: string, plural = `${noun}s`) {
  return (result: AgentToolResult<unknown>): string | undefined => {
    const count = countNonEmptyLines(toolResultText(result));
    return count > 0 ? `${count} ${count === 1 ? noun : plural}` : undefined;
  };
}

/**
 * Display-only path shortening for tool headers. Replaces the home directory
 * prefix with `~` so long absolute paths stay readable; never mutates args.
 */
export function displayPath(path: string, home: string = homedir()): string {
  if (!path) return path;
  const normalizedHome = home.replace(/[/\\]+$/u, "");
  if (!normalizedHome || normalizedHome === "/") return path;
  if (path === normalizedHome) return "~";
  if (path.startsWith(`${normalizedHome}/`) || path.startsWith(`${normalizedHome}${sep}`)) {
    return `~${path.slice(normalizedHome.length)}`;
  }
  return path;
}

function toolPath(args: Record<string, unknown>): string {
  return typeof args.path === "string" ? displayPath(args.path) : "";
}

function readArgument(args: Record<string, unknown>): string {
  const path = toolPath(args);
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  if (offset === undefined && limit === undefined) return path;
  const start = offset ?? 1;
  const end = limit === undefined ? "" : `-${start + limit - 1}`;
  return `${path}:${start}${end}`;
}

export const codexReadToolSpec: CodexToolRendererSpec = {
  icon: "\uF15C", // nf-fa-file_lines
  runningVerb: "Reading",
  completedVerb: "Read",
  argument: readArgument,
  collapsed: "hidden",
};

export const codexGrepToolSpec: CodexToolRendererSpec = {
  icon: "\uF0B0", // nf-fa-filter
  runningVerb: "Searching",
  completedVerb: "Searched",
  argument: (args) => {
    const pattern = typeof args.pattern === "string" ? `"${args.pattern}"` : "";
    const path = typeof args.path === "string" ? ` in ${displayPath(args.path)}` : "";
    return `${pattern}${path}`;
  },
  collapsed: countSummary("match", "matches"),
};

export const codexFindToolSpec: CodexToolRendererSpec = {
  icon: "\uF002", // nf-fa-search
  runningVerb: "Finding",
  completedVerb: "Found",
  argument: (args) => {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    const path = typeof args.path === "string" ? ` in ${displayPath(args.path)}` : "";
    return `${pattern}${path}`;
  },
  collapsed: countSummary("file"),
};

export const codexLsToolSpec: CodexToolRendererSpec = {
  icon: "\uF07B", // nf-fa-folder
  runningVerb: "Listing",
  completedVerb: "Listed",
  argument: (args) => (typeof args.path === "string" ? displayPath(args.path) : "."),
  collapsed: countSummary("entry", "entries"),
};

export const codexBashToolSpec: CodexToolRendererSpec = {
  icon: "\uF120", // nf-fa-terminal
  runningVerb: "Running",
  completedVerb: "Ran",
  argument: (args) => (typeof args.command === "string" ? args.command : ""),
  headerLayout: "wrap-command",
  collapsed: "preview",
  maxOutputRows: 5,
  transformOutput: compactBashStatusSpacing,
};

export const codexWriteToolSpec: CodexToolRendererSpec<WritePreviewComponent> = {
  icon: "\uEE38", // nf-fa-file_import
  runningVerb: "Writing",
  completedVerb: "Wrote",
  argument: toolPath,
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
  icon: "\uEE3C", // nf-fa-file_signature
  runningVerb: "Editing",
  completedVerb: "Edited",
  argument: toolPath,
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
