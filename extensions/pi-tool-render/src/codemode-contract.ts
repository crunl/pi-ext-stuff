/**
 * Defensive mapping from Pi's `codemode` tool payload to a stable ViewModel.
 *
 * This module is the only place that knows upstream field names
 * (`CodemodeToolDetails`, `CodemodeNestedCall`, script header text). The tree
 * renderer consumes {@link TreeView} only. Keep parsing fail-soft: unknown
 * fields are ignored, missing fields default, bad JSON never throws.
 *
 * Upstream pin: `@earendil-works/pi-coding-agent` 1.0.0. `CodemodeNestedCall`
 * is not exported there — we mirror it structurally on purpose.
 * (`CodemodeToolDetails`/`CodemodeNestedCall` are unchanged from 0.99.1;
 * 1.0.0 only adds `models.generateImages()`, whose image blocks arrive as
 * `image` content parts alongside the text output.)
 */

export type CallStatus = "running" | "ok" | "error" | "cancelled" | "unknown";

export interface ChildRow {
  readonly id: string;
  readonly toolLabel: string;
  readonly target: string;
  readonly status: CallStatus;
  readonly durationMs?: number;
  readonly costUsd?: number;
  readonly errorText?: string;
  readonly argsPreview?: string;
}

export interface GlanceSummary {
  readonly total: number;
  readonly commands: number;
  readonly reads: number;
  readonly edits: number;
  readonly other: number;
  readonly failed: number;
  readonly running: number;
}

export interface TextBlock {
  readonly lineCount: number;
  readonly preview: string;
  readonly lines: string[];
}

export interface TreeView {
  readonly glance: GlanceSummary;
  readonly children: ChildRow[];
  readonly code: TextBlock | null;
  readonly output: TextBlock | null;
  readonly fullOutputPath?: string;
  /** Image blocks in the script result (1.0.0 `models.generateImages()`). Never throws. */
  readonly imageCount: number;
  readonly capabilities: {
    readonly childResultPreview: boolean;
  };
}

export interface ToTreeViewInput {
  readonly details: unknown;
  readonly args: unknown;
  readonly result?: { content?: readonly unknown[] };
  readonly isPartial?: boolean;
}

const ARGS_COLLAPSED_CHARS = 48;
const ARGS_PREVIEW_CHARS = 120;
const ERROR_PREVIEW_CHARS = 80;
const CODE_PREVIEW_CHARS = 72;
const OUTPUT_PREVIEW_CHARS = 72;

/**
 * Pi prepends `Script completed|failed / Wall time … / Output:` as its own
 * header. Prefer a line scan over one regex so wall-time wording can drift.
 */
export function stripScriptHeader(text: string): string {
  const lines = text.split("\n");
  if (lines.length === 0) return text;
  const first = lines[0] ?? "";
  if (!/^Script (completed|failed)\b/.test(first)) return text;
  const outputIndex = lines.findIndex((line, index) => index > 0 && line === "Output:");
  if (outputIndex === -1) {
    // Header without a bare `Output:` marker — drop just the Script line.
    return lines.slice(1).join("\n");
  }
  return lines.slice(outputIndex + 1).join("\n");
}

function textBlocksToPlain(result: { content?: readonly unknown[] } | undefined): string[] {
  const out: string[] = [];
  if (!Array.isArray(result?.content)) return out;
  for (const part of result.content) {
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      (part as { type?: unknown }).type === "text" &&
      "text" in part &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      out.push((part as { text: string }).text);
    }
  }
  return out;
}

export function extractScriptOutput(result: { content?: readonly unknown[] } | undefined): string {
  return stripScriptHeader(textBlocksToPlain(result).join("\n")).trim();
}

/** Count `image` content parts (1.0.0 `models.generateImages()` output). Fail-soft. */
export function countImageBlocks(result: { content?: readonly unknown[] } | undefined): number {
  let count = 0;
  if (!Array.isArray(result?.content)) return count;
  for (const part of result.content) {
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      (part as { type?: unknown }).type === "image"
    ) {
      count += 1;
    }
  }
  return count;
}

function collapseText(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 1)}…`;
}

function oneLinePreview(text: string, limit = OUTPUT_PREVIEW_CHARS): string {
  const line =
    text.split("\n").find((value) => value.trim().length > 0) ?? text.split("\n")[0] ?? "";
  return collapseText(line, limit);
}

function toTextBlock(raw: string, previewChars = OUTPUT_PREVIEW_CHARS): TextBlock | null {
  if (!raw) return null;
  const lines = raw.split("\n");
  return {
    lineCount: lines.length,
    preview: oneLinePreview(raw, previewChars),
    lines,
  };
}

function shortToolLabel(name: string): string {
  if (name.startsWith("mcp__")) return name.slice("mcp__".length).replace("__", " / ");
  return name;
}

/** Prefer path/command/query over raw JSON when summarizing nested args. */
export function summarizeCallArgs(_toolName: string, argsJson: string): string {
  let parsed: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(argsJson || "{}");
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = undefined;
  }
  const firstString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = parsed?.[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
  };
  const hit =
    firstString("path", "file", "filePath") ??
    firstString("command", "cmd") ??
    firstString("pattern", "query", "url", "text") ??
    firstString("oldText");
  if (hit) return collapseText(hit, ARGS_COLLAPSED_CHARS);
  if (parsed && Object.keys(parsed).length > 0) {
    return collapseText(argsJson, ARGS_COLLAPSED_CHARS);
  }
  // Truncated / non-JSON args: show a short raw preview instead of dropping it.
  return argsJson.trim() ? collapseText(argsJson, ARGS_COLLAPSED_CHARS) : "";
}

function normalizeStatus(raw: unknown): CallStatus {
  if (raw === "running" || raw === "ok" || raw === "error" || raw === "cancelled") return raw;
  return "unknown";
}

function normalizeChild(index: number, raw: unknown): ChildRow {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : `call:${index}`;
  const name = typeof record.name === "string" ? record.name : "tool";
  const args = typeof record.args === "string" ? record.args : "";
  const durationMs = typeof record.durationMs === "number" ? record.durationMs : undefined;
  const costUsd = typeof record.cost === "number" ? record.cost : undefined;
  const errorText = typeof record.error === "string" ? record.error : undefined;
  return {
    id,
    toolLabel: shortToolLabel(name),
    target: summarizeCallArgs(name, args),
    status: normalizeStatus(record.status),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(errorText === undefined ? {} : { errorText: collapseText(errorText, ERROR_PREVIEW_CHARS) }),
    ...(args ? { argsPreview: collapseText(args, ARGS_PREVIEW_CHARS) } : {}),
  };
}

function readCalls(details: unknown): readonly unknown[] {
  if (typeof details !== "object" || details === null) return [];
  const calls = (details as { calls?: unknown }).calls;
  return Array.isArray(calls) ? calls : [];
}

function readFullOutputPath(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const path = (details as { fullOutputPath?: unknown }).fullOutputPath;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

function scriptCodeFromArgs(args: unknown): string {
  if (typeof args === "object" && args !== null && "code" in args) {
    const code = (args as { code?: unknown }).code;
    return typeof code === "string" ? code : "";
  }
  return "";
}

function summarizeGlance(children: readonly ChildRow[]): GlanceSummary {
  let commands = 0;
  let reads = 0;
  let edits = 0;
  let other = 0;
  let failed = 0;
  let running = 0;
  for (const child of children) {
    if (child.status === "error") failed += 1;
    else if (child.status === "running") running += 1;
    // Classify by the original-ish name when present in argsPreview-less form.
    const label = child.toolLabel;
    if (label === "bash" || label === "powershell" || label === "user_bash") commands += 1;
    else if (label === "read" || label === "grep" || label === "find" || label === "ls") reads += 1;
    else if (label === "edit" || label === "write") edits += 1;
    else other += 1;
  }
  return {
    total: children.length,
    commands,
    reads,
    edits,
    other,
    failed,
    running,
  };
}

export function toTreeView(input: ToTreeViewInput): TreeView {
  const rawCalls = readCalls(input.details);
  const children = rawCalls.map((raw, index) => normalizeChild(index, raw));
  const codeText = scriptCodeFromArgs(input.args).replace(/\r/g, "").trimEnd();
  const outputText = input.isPartial ? "" : extractScriptOutput(input.result);
  const fullOutputPath = readFullOutputPath(input.details);
  return {
    glance: summarizeGlance(children),
    children,
    code: toTextBlock(codeText, CODE_PREVIEW_CHARS),
    output: toTextBlock(outputText, OUTPUT_PREVIEW_CHARS),
    ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
    imageCount: input.isPartial ? 0 : countImageBlocks(input.result),
    capabilities: {
      childResultPreview: rawCalls.some(
        (raw) => typeof raw === "object" && raw !== null && "resultPreview" in raw,
      ),
    },
  };
}
