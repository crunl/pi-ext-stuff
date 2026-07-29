import type { Theme } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  Container,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { OutputPad } from "./output-padding.ts";

export type EditDiffKind = "context" | "added" | "removed";

export interface EditDiffRow {
  kind: EditDiffKind;
  lineNumber?: number;
  content: string;
}

const DISPLAY_DIFF_ROW = /^([ +-])(\s*\d*)\s(.*)$/;

export function parseEditDiff(diff: string): EditDiffRow[] {
  if (diff.length === 0) return [];

  return diff.split(/\r?\n/).map((line) => {
    const match = DISPLAY_DIFF_ROW.exec(line);
    if (!match) {
      return {
        kind: "context",
        lineNumber: undefined,
        content: line,
      };
    }

    return {
      kind: match[1] === "+" ? "added" : match[1] === "-" ? "removed" : "context",
      lineNumber: match[2].trim() ? Number.parseInt(match[2], 10) : undefined,
      content: match[3],
    };
  });
}

export interface EditDiffBoxOptions {
  outputPad: OutputPad;
  /** Language for syntax highlighting diff content (e.g. from getLanguageFromPath). */
  lang?: string;
  /** Highlighter (line -> styled line). Defaults to pi's highlightCode. Test seam. */
  highlight?: (line: string, lang: string) => string;
}

function defaultHighlight(line: string, lang: string): string {
  return highlightCode(line, lang)[0] ?? line;
}

/** Parse a truecolor SGR sequence (38/48;2;r;g;b) into RGB. */
function parseTruecolor(ansi: string): [number, number, number] | null {
  const match = ansi.match(/[34]8;2;(\d+);(\d+);(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Fraction of the diff color mixed into the base background. */
const DIFF_TINT = 0.3;

type RowBg = (text: string) => string;

interface RowBackgrounds {
  context: RowBg;
  added: RowBg;
  removed: RowBg;
}

/**
 * Build per-row background painters. pi themes have no diff backgrounds
 * (toolSuccessBg and toolErrorBg are both neutral surface colors in e.g.
 * catppuccin), so added/removed tint the box background with the theme's
 * own diff foreground colors (toolDiffAdded/toolDiffRemoved). Falls back
 * to a uniform box background when the theme is not truecolor.
 */
function buildRowBackgrounds(theme: Theme): RowBackgrounds {
  const boxBg: RowBg = (text) => theme.bg("toolSuccessBg", text);
  try {
    const base = parseTruecolor(theme.getBgAnsi("toolSuccessBg"));
    const added = parseTruecolor(theme.getFgAnsi("toolDiffAdded"));
    const removed = parseTruecolor(theme.getFgAnsi("toolDiffRemoved"));
    if (!base || !added || !removed) return { context: boxBg, added: boxBg, removed: boxBg };

    const tinted = (tint: [number, number, number]): RowBg => {
      const channel = (i: number) => Math.round(base[i] * (1 - DIFF_TINT) + tint[i] * DIFF_TINT);
      const open = `\x1b[48;2;${channel(0)};${channel(1)};${channel(2)}m`;
      return (text) => `${open}${text}\x1b[49m`;
    };
    return { context: boxBg, added: tinted(added), removed: tinted(removed) };
  } catch {
    return { context: boxBg, added: boxBg, removed: boxBg };
  }
}

class EditDiffRows implements Component {
  /** Row contents after optional syntax highlighting (computed once; rows are static). */
  private readonly styledContents: string[];
  private readonly rowBg: RowBackgrounds;

  constructor(
    private readonly rows: readonly EditDiffRow[],
    private readonly theme: Theme,
    lang?: string,
    highlight: (line: string, lang: string) => string = defaultHighlight,
  ) {
    this.rowBg = buildRowBackgrounds(theme);
    this.styledContents = rows.map((row) => {
      if (!lang) return row.content;
      try {
        return highlight(row.content, lang);
      } catch {
        return row.content;
      }
    });
  }

  render(width: number): string[] {
    const numberWidth = Math.max(1, ...this.rows.map((row) => String(row.lineNumber ?? "").length));
    const gutterWidth = numberWidth + 5;
    const contentWidth = Math.max(1, width - gutterWidth);
    const output: string[] = [];

    this.rows.forEach((row, rowIndex) => {
      const marker = row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " ";
      const number =
        row.lineNumber === undefined
          ? " ".repeat(numberWidth)
          : String(row.lineNumber).padStart(numberWidth);
      const styled = this.styledContents[rowIndex];
      const highlighted = styled !== row.content;
      const contentRows = wrapTextWithAnsi(styled, contentWidth);
      const logicalRows = contentRows.length > 0 ? contentRows : [""];
      const color =
        row.kind === "added"
          ? "toolDiffAdded"
          : row.kind === "removed"
            ? "toolDiffRemoved"
            : "toolDiffContext";

      logicalRows.forEach((content, index) => {
        const gutter = index === 0 ? `${marker} ${number} │ ` : `${" ".repeat(numberWidth + 2)} │ `;
        // Highlighted content carries its own ANSI colors (with resets that
        // would truncate an outer wrap), so only the gutter gets the diff
        // color. Plain content keeps the original whole-line diff color.
        const body = highlighted
          ? `${this.theme.fg(color, gutter)}${content}`
          : this.theme.fg(color, `${gutter}${content}`);
        // The whole box keeps its neutral background; added/removed rows
        // are tinted toward the theme's diff colors. Pad first so the
        // background spans the full row width.
        const padded = `${body}${" ".repeat(Math.max(0, width - visibleWidth(body)))}`;
        output.push(this.rowBg[row.kind](padded));
      });
    });

    return output;
  }

  invalidate(): void {}
}

class IndentedComponent implements Component {
  constructor(
    private readonly child: Component,
    private readonly padding: number,
  ) {}

  render(width: number): string[] {
    const prefix = " ".repeat(this.padding);
    return this.child.render(Math.max(1, width - this.padding)).map((line) => `${prefix}${line}`);
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

export function createEditDiffBox(
  diff: string,
  theme: Theme,
  options: EditDiffBoxOptions,
): Component {
  if (diff.length === 0) return new Container();

  // No box-wide background: each row paints its own (added/removed/context).
  const box = new Box(1, 0);
  box.addChild(new EditDiffRows(parseEditDiff(diff), theme, options.lang, options.highlight));
  return new IndentedComponent(box, options.outputPad);
}
