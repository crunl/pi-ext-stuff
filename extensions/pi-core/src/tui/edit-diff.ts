import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { OutputPad } from "./output-padding.ts";

export type EditDiffKind = "context" | "added" | "removed";

export interface EditDiffRow {
  kind: EditDiffKind;
  lineNumber?: number;
  content: string;
}

const DISPLAY_DIFF_ROW = /^([ +\-])(\s*\d*)\s(.*)$/;

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
      kind: match[1] === "+"
        ? "added"
        : match[1] === "-"
          ? "removed"
          : "context",
      lineNumber: match[2].trim()
        ? Number.parseInt(match[2], 10)
        : undefined,
      content: match[3],
    };
  });
}

export interface EditDiffBoxOptions {
  outputPad: OutputPad;
}

class EditDiffRows implements Component {
  constructor(
    private readonly rows: readonly EditDiffRow[],
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const numberWidth = Math.max(
      1,
      ...this.rows.map((row) => String(row.lineNumber ?? "").length),
    );
    const gutterWidth = numberWidth + 5;
    const contentWidth = Math.max(1, width - gutterWidth);
    const output: string[] = [];

    for (const row of this.rows) {
      const marker = row.kind === "added"
        ? "+"
        : row.kind === "removed"
          ? "-"
          : " ";
      const number = row.lineNumber === undefined
        ? " ".repeat(numberWidth)
        : String(row.lineNumber).padStart(numberWidth);
      const contentRows = wrapTextWithAnsi(row.content, contentWidth);
      const logicalRows = contentRows.length > 0 ? contentRows : [""];
      const color = row.kind === "added"
        ? "toolDiffAdded"
        : row.kind === "removed"
          ? "toolDiffRemoved"
          : "toolDiffContext";

      logicalRows.forEach((content, index) => {
        const gutter = index === 0
          ? `${marker} ${number} │ `
          : `${" ".repeat(numberWidth + 2)} │ `;
        output.push(this.theme.fg(color, `${gutter}${content}`));
      });
    }

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
    return this.child
      .render(Math.max(1, width - this.padding))
      .map((line) => `${prefix}${line}`);
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

  const box = new Box(
    1,
    0,
    (line) => theme.bg("toolSuccessBg", line),
  );
  box.addChild(new EditDiffRows(parseEditDiff(diff), theme));
  return new IndentedComponent(box, options.outputPad);
}
