import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { OutputPad } from "./output-padding.ts";
import { toolResultText } from "./tool-output.ts";

/** Cap expanded read evidence so global ctrl+o cannot stall the TUI. */
export const READ_EVIDENCE_MAX_LINES = 2_000;
export const READ_EVIDENCE_MAX_CHARS = 200_000;

function replaceTabs(text: string): string {
  return text.replace(/\t/gu, "   ");
}

function splitLogicalLines(text: string): string[] {
  return replaceTabs(text).replace(/\r?\n/gu, "\n").split("\n");
}

/**
 * Header summary for settled read calls: `248 lines` / `1 line`.
 * Failed calls omit the count (error rail carries the message instead).
 */
export function summarizeReadLines(
  result: { content: unknown[] },
  _args: Record<string, unknown>,
  meta: { isError: boolean },
): string | undefined {
  if (meta.isError) return undefined;
  const text = toolResultText(result as never);
  if (text.length === 0) return undefined;
  const lines = splitLogicalLines(text);
  const count =
    lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  if (count <= 0) return undefined;
  return `${count} ${count === 1 ? "line" : "lines"}`;
}

interface PaintedReadRow {
  readonly painted: string;
  readonly lineNumber: number;
}

class ReadEvidenceComponent implements Component {
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  /** Highlighted rows independent of terminal width — reuse on resize. */
  private paintedCache: PaintedReadRow[] | undefined;
  private omittedCount = 0;

  constructor(
    private readonly path: string,
    private readonly text: string,
    private readonly theme: Theme,
    private readonly outputPad: OutputPad,
    private readonly startLine: number,
  ) {}

  private highlightLine(line: string): string {
    const lang = this.path ? getLanguageFromPath(this.path) : undefined;
    if (!lang) return this.theme.fg("toolOutput", line);
    try {
      const highlighted = highlightCode(line, lang);
      return highlighted[0] ?? this.theme.fg("toolOutput", line);
    } catch {
      return this.theme.fg("toolOutput", line);
    }
  }

  private paintedRows(): PaintedReadRow[] {
    if (this.paintedCache) return this.paintedCache;

    let logical = splitLogicalLines(this.text);
    if (logical.length > 0 && logical[logical.length - 1] === "") {
      logical = logical.slice(0, -1);
    }
    const cappedByLines = logical.slice(0, READ_EVIDENCE_MAX_LINES);

    let charBudget = READ_EVIDENCE_MAX_CHARS;
    const selected: string[] = [];
    for (const line of cappedByLines) {
      if (charBudget <= 0) break;
      selected.push(line);
      charBudget -= line.length + 1;
    }
    this.omittedCount = logical.length - selected.length;
    this.paintedCache = selected.map((line, index) => ({
      painted: this.highlightLine(line),
      lineNumber: this.startLine + index,
    }));
    return this.paintedCache;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const pad = " ".repeat(this.outputPad);
    if (this.text.length === 0 || width <= 0) {
      this.cachedWidth = width;
      this.cachedLines = [];
      return this.cachedLines;
    }

    const painted = this.paintedRows();
    const numberWidth = String(this.startLine + Math.max(0, painted.length - 1)).length;
    const rows = painted.map(({ painted: content, lineNumber }) => {
      const gutter = `${pad}${this.theme.fg("dim", String(lineNumber).padStart(numberWidth, " "))} ${this.theme.fg("dim", "│")} `;
      return truncateToWidth(`${gutter}${content}`, width, "…");
    });
    if (this.omittedCount > 0) {
      rows.push(
        truncateToWidth(
          `${pad}${this.theme.fg("dim", `… +${this.omittedCount} lines`)}`,
          width,
          "…",
        ),
      );
    }

    this.cachedWidth = width;
    this.cachedLines = rows;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export function createReadEvidence(options: {
  path: string;
  text: string;
  theme: Theme;
  outputPad: OutputPad;
  startLine?: number;
}): Component {
  return new ReadEvidenceComponent(
    options.path,
    options.text,
    options.theme,
    options.outputPad,
    options.startLine ?? 1,
  );
}
