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

type EditDiffKind = "context" | "added" | "removed";

interface EditDiffRow {
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

interface EditDiffBoxOptions {
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

/**
 * MiniMax `packages/tui` dedicated diff row backgrounds
 * (`theme/palettes.ts` `diffAddedBg` / `diffRemovedBg`) — GitHub-like
 * muted green/red, not a 30% fg tint on the tool surface.
 */
const MINIMAX_DIFF_ADDED_BG_DARK: [number, number, number] = [0x21, 0x3a, 0x2b];
const MINIMAX_DIFF_REMOVED_BG_DARK: [number, number, number] = [0x4a, 0x22, 0x1d];
const MINIMAX_DIFF_ADDED_BG_LIGHT: [number, number, number] = [0xda, 0xfb, 0xe1];
const MINIMAX_DIFF_REMOVED_BG_LIGHT: [number, number, number] = [0xff, 0xeb, 0xe9];

type RowBg = (text: string) => string;

interface RowBackgrounds {
  context: RowBg;
  added: RowBg;
  removed: RowBg;
}

function truecolorBackground(rgb: [number, number, number]): RowBg {
  const open = `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  return (text) => `${open}${text}\x1b[49m`;
}

/**
 * Row backgrounds aligned with MiniMax: solid `diffAddedBg`/`diffRemovedBg`
 * hex values (dark vs light picked from the host theme surface). Context
 * keeps the neutral tool surface — MiniMax does not tint unchanged lines.
 */
function buildRowBackgrounds(theme: Theme): RowBackgrounds {
  const boxBg: RowBg = (text) => theme.bg("toolSuccessBg", text);
  let isLightSurface = false;
  try {
    const base = parseTruecolor(theme.getBgAnsi("toolSuccessBg"));
    if (base) isLightSurface = (base[0] + base[1] + base[2]) / 3 > 140;
  } catch {
    // Fall through to dark palette (MiniMax default in the dark.json set).
  }
  return {
    context: boxBg,
    added: truecolorBackground(
      isLightSurface ? MINIMAX_DIFF_ADDED_BG_LIGHT : MINIMAX_DIFF_ADDED_BG_DARK,
    ),
    removed: truecolorBackground(
      isLightSurface ? MINIMAX_DIFF_REMOVED_BG_LIGHT : MINIMAX_DIFF_REMOVED_BG_DARK,
    ),
  };
}

class EditDiffRows implements Component {
  /** Row contents after optional syntax highlighting (computed once; rows are static). */
  private readonly styledContents: string[];
  private readonly rowBg: RowBackgrounds;
  private readonly numberWidth: number;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

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
    this.numberWidth = Math.max(1, ...rows.map((row) => String(row.lineNumber ?? "").length));
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const numberWidth = this.numberWidth;
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
        // Highlighted content carries its own ANSI colors; only the gutter gets
        // the diff color. Plain content keeps the whole-line diff color.
        const body = highlighted
          ? `${this.theme.fg(color, gutter)}${content}`
          : this.theme.fg(color, `${gutter}${content}`);
        // Long lines wrap so the full change stays visible; continuation rows
        // share the line-number gutter column.
        const padded = `${body}${" ".repeat(Math.max(0, width - visibleWidth(body)))}`;
        output.push(this.rowBg[row.kind](padded));
      });
    });

    this.cachedWidth = width;
    this.cachedLines = output;
    return output;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
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
