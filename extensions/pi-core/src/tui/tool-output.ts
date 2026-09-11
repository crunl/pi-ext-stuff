import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { OutputPad } from "./output-padding.ts";

const FIRST_PREFIX = "  └ ";
const NEXT_PREFIX = "    ";

interface OutputLayout {
  width: number;
  contentWidth: number;
  firstPrefix: string;
  nextPrefix: string;
}

/** Concatenate the text parts of a tool result (empty parts dropped). */
export function toolResultText(result: AgentToolResult<unknown>): string {
  return result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .filter(Boolean)
    .join("\n");
}

export function countNonEmptyLines(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function createOutputLayout(width: number, outputPad: OutputPad): OutputLayout {
  const padding = " ".repeat(outputPad);
  const firstPrefix = `${padding}${FIRST_PREFIX}`;
  const nextPrefix = `${padding}${NEXT_PREFIX}`;
  const prefixWidth = Math.max(visibleWidth(firstPrefix), visibleWidth(nextPrefix));
  // Decoration must leave room for content; otherwise give content the full width.
  const showPrefixes = width > prefixWidth;
  return {
    width,
    contentWidth: showPrefixes ? width - prefixWidth : width,
    firstPrefix: showPrefixes ? firstPrefix : "",
    nextPrefix: showPrefixes ? nextPrefix : "",
  };
}

function wrappedRows(text: string, contentWidth: number): string[] {
  const rows: string[] = [];
  for (const logicalLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const wrapped = wrapTextWithAnsi(logicalLine, contentWidth);
    rows.push(...(wrapped.length > 0 ? wrapped : [""]));
  }
  return rows;
}

function withPrefixes(rows: readonly string[], layout: OutputLayout): string[] {
  // Enforce the total column budget after decoration, including inserted omission hints.
  return rows.map((row, index) =>
    truncateToWidth(
      `${index === 0 ? layout.firstPrefix : layout.nextPrefix}${row}`,
      layout.width,
      "…",
    ),
  );
}

export function buildOutputPreview(
  text: string,
  width: number,
  maxRows = 5,
  outputPad: OutputPad = 0,
): string[] {
  if (text.length === 0 || width <= 0 || maxRows <= 0) return [];
  const layout = createOutputLayout(width, outputPad);
  const rows = wrappedRows(text, layout.contentWidth);
  if (rows.length <= maxRows) return withPrefixes(rows, layout);
  if (maxRows === 1) {
    return withPrefixes([`… +${rows.length} lines`], layout);
  }

  const contentRows = maxRows - 1;
  const headCount = Math.ceil(contentRows / 2);
  const tailCount = Math.floor(contentRows / 2);
  const omitted = rows.length - headCount - tailCount;
  const visible = [
    ...rows.slice(0, headCount),
    `… +${omitted} lines`,
    ...(tailCount > 0 ? rows.slice(-tailCount) : []),
  ];
  return withPrefixes(visible, layout);
}

export function buildExpandedOutput(
  text: string,
  width: number,
  outputPad: OutputPad = 0,
): string[] {
  if (text.length === 0 || width <= 0) return [];
  const layout = createOutputLayout(width, outputPad);
  return withPrefixes(wrappedRows(text, layout.contentWidth), layout);
}
