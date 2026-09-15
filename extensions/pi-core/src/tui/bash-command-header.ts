import { highlightCode } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { OutputPad } from "./output-padding.ts";

/** Codex ExecCell `command_continuation_max_lines`. */
export const COMMAND_CONTINUATION_MAX_LINES = 2;
/** Codex `  │ ` continuation prefix (two leading spaces + bar). */
export const COMMAND_CONTINUATION_PREFIX = "  │ ";

/** Cap before highlight so pathological commands cannot stall the renderer. */
const MAX_COMMAND_CHARS = 4_000;

export interface HeaderLeading {
  /** Already colored icon including trailing space, or empty when the host owns the mark. */
  icon: string;
  /** Already bold verb. */
  verb: string;
  /** Already formatted ` · summary` suffix, or empty. */
  summary: string;
}

function highlightCommand(command: string): string[] {
  const source = command.length > MAX_COMMAND_CHARS ? command.slice(0, MAX_COMMAND_CHARS) : command;
  return highlightCode(source, "bash");
}

function wrapHighlightedLines(
  lines: readonly string[],
  firstBudget: number,
  continuationBudget: number,
): string[] {
  const rows: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const budget = i === 0 ? firstBudget : continuationBudget;
    if (budget <= 0) {
      rows.push(lines[i] ?? "");
      continue;
    }
    const wrapped = wrapTextWithAnsi(lines[i] ?? "", budget);
    rows.push(...(wrapped.length > 0 ? wrapped : [""]));
  }
  return rows;
}

/**
 * Codex-style bash header: status verb on the first row with the start of the
 * command, continuation rows under a `  │ ` rail, bash syntax highlighting.
 * Display-only; never mutates tool args.
 */
export class WrappedCommandHeader {
  private leading = "";
  private command = "";
  private highlighted: string[] | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly outputPad: OutputPad,
    private readonly maxContinuationLines: number = COMMAND_CONTINUATION_MAX_LINES,
  ) {}

  setHeader(parts: HeaderLeading, command: string): void {
    const leading = `${parts.icon}${parts.verb}${parts.summary}`;
    if (leading === this.leading && command === this.command) return;
    this.leading = leading;
    this.command = command;
    this.highlighted = undefined;
    this.invalidate();
  }

  private highlightedLines(): string[] {
    if (!this.highlighted) {
      this.highlighted = this.command.length > 0 ? highlightCommand(this.command) : [];
    }
    return this.highlighted;
  }

  private buildLines(width: number): string[] {
    const pad = " ".repeat(this.outputPad);
    const hasCommand = this.command.length > 0;
    const firstSeparator = hasCommand ? " " : "";
    const firstPrefix = `${pad}${this.leading}${firstSeparator}`;
    const firstPrefixWidth = visibleWidth(firstPrefix);
    const firstBudget = Math.max(0, width - firstPrefixWidth);
    const continuationPrefix = `${pad}${COMMAND_CONTINUATION_PREFIX}`;
    const continuationPrefixWidth = visibleWidth(continuationPrefix);
    const showContinuationPrefix = width > continuationPrefixWidth;
    const continuationBudget = Math.max(
      0,
      showContinuationPrefix ? width - continuationPrefixWidth : width,
    );

    const rows = wrapHighlightedLines(this.highlightedLines(), firstBudget, continuationBudget);
    if (rows.length === 0) return [`${pad}${this.leading}`];

    const maxRows = 1 + this.maxContinuationLines;
    const overflow = rows.length > maxRows;
    const visible = overflow ? rows.slice(0, maxRows) : rows;

    const lines = visible.map((row, index) => {
      if (index === 0) return `${firstPrefix}${row}`;
      const prefix = showContinuationPrefix ? continuationPrefix : pad;
      const body =
        overflow && index === maxRows - 1 ? truncateToWidth(row, continuationBudget, "…") : row;
      return `${prefix}${body}`;
    });
    return lines;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    this.cachedWidth = width;
    this.cachedLines = this.buildLines(width);
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
