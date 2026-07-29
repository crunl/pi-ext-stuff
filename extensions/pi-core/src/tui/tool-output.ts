import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { OutputPad } from "./output-padding.ts";

const FIRST_PREFIX = "  └ ";
const NEXT_PREFIX = "    ";

export function countNonEmptyLines(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function wrappedRows(
  text: string,
  width: number,
  outputPad: OutputPad,
): string[] {
  const contentWidth = Math.max(
    1,
    width - outputPad - NEXT_PREFIX.length,
  );
  const rows: string[] = [];
  for (const logicalLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const wrapped = wrapTextWithAnsi(logicalLine, contentWidth);
    rows.push(...(wrapped.length > 0 ? wrapped : [""]));
  }
  return rows;
}

function withPrefixes(
  rows: readonly string[],
  outputPad: OutputPad,
): string[] {
  const padding = " ".repeat(outputPad);
  return rows.map(
    (row, index) =>
      `${padding}${index === 0 ? FIRST_PREFIX : NEXT_PREFIX}${row}`,
  );
}

export function buildOutputPreview(
  text: string,
  width: number,
  maxRows = 5,
  outputPad: OutputPad = 0,
): string[] {
  if (text.length === 0 || maxRows <= 0) return [];
  const rows = wrappedRows(text, width, outputPad);
  if (rows.length <= maxRows) return withPrefixes(rows, outputPad);
  if (maxRows === 1) {
    return withPrefixes([`… +${rows.length} lines`], outputPad);
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
  return withPrefixes(visible, outputPad);
}

export function buildExpandedOutput(
  text: string,
  width: number,
  outputPad: OutputPad = 0,
): string[] {
  if (text.length === 0) return [];
  return withPrefixes(
    wrappedRows(text, width, outputPad),
    outputPad,
  );
}
