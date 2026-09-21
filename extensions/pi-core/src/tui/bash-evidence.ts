import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { OutputPad } from "./output-padding.ts";
import { highlightShellCommandLines, MAX_COMMAND_CHARS } from "./shell-command-highlight.ts";
import { buildExpandedOutput } from "./tool-output.ts";

/** Fixed glance budget so `· N output lines` + chevron stay on the header row. */
export const BASH_GLANCE_BUDGET = 52;

/**
 * Glance subject for bash headers: first logical line capped at `budget`
 * characters; `…` when truncated or more command lines exist.
 */
export function commandGlance(command: string, budget: number = BASH_GLANCE_BUDGET): string {
  if (!command) return "";
  const lines = command.replace(/\r?\n/gu, "\n").split("\n");
  const first = lines[0]?.trim() ?? "";
  const hasMoreLines = lines.slice(1).some((line) => line.trim().length > 0);
  if (!first) return hasMoreLines ? "…" : "";
  const truncated = first.length > budget;
  const display = truncated ? first.slice(0, budget) : first;
  return hasMoreLines || truncated ? `${display}…` : display;
}

/** Wrap one highlighted command line under the evidence rail (`$ ` / `  `). */
function wrapEvidenceCommandLine(
  line: string,
  width: number,
  rail: string,
  isFirstCommandLine: boolean,
): string[] {
  const contPrefix = `${rail}  `;
  const firstPrefix = isFirstCommandLine ? `${rail}$ ` : contPrefix;
  const budget = Math.max(1, width - visibleWidth(contPrefix));
  const wrapped = wrapTextWithAnsi(line, budget);
  return wrapped.map((row, index) => {
    const prefix = index === 0 ? firstPrefix : contPrefix;
    return truncateToWidth(`${prefix}${row}`, width, "…");
  });
}

class BashExpandedEvidence implements Component {
  constructor(
    private readonly command: string,
    private readonly outputText: string,
    private readonly theme: Theme,
    private readonly outputPad: OutputPad,
    private readonly isError: boolean,
  ) {}

  render(width: number): string[] {
    const pad = " ".repeat(this.outputPad);
    const lines: string[] = [];
    if (this.command.length > 0) {
      const source =
        this.command.length > MAX_COMMAND_CHARS
          ? this.command.slice(0, MAX_COMMAND_CHARS)
          : this.command;
      const rail = `${pad}  │ `;
      const highlighted = highlightShellCommandLines(source);
      highlighted.forEach((line, index) => {
        lines.push(...wrapEvidenceCommandLine(line, width, rail, index === 0));
      });
    }
    if (this.outputText.length > 0) {
      const rows = buildExpandedOutput(this.outputText, width, this.outputPad);
      for (const row of rows) {
        lines.push(this.isError ? this.theme.fg("error", row) : this.theme.fg("toolOutput", row));
      }
    }
    return lines;
  }

  invalidate(): void {}
}

/**
 * Expanded bash evidence: full highlighted command under a `  │ ` rail, then
 * full output. Header stays glance-only so collapsed↔expanded does not reshuffle IA.
 */
export function createBashExpandedEvidence(options: {
  command: string;
  outputText: string;
  theme: Theme;
  outputPad: OutputPad;
  isError: boolean;
}): Component {
  return new BashExpandedEvidence(
    options.command,
    options.outputText,
    options.theme,
    options.outputPad,
    options.isError,
  );
}
