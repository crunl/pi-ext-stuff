import { homedir } from "node:os";
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
 * Leading same-line `cd <target>` followed by `&&` or `;`, with the target
 * captured unquoted (groups 1-3) and the separator plus its surrounding blanks
 * captured whole (group 4), so the fold never re-spaces a `;` the author wrote
 * tight against the path.
 */
const WORKSPACE_CD_PREFIX =
  /^[ \t]*cd[ \t]+(?:"([^"]*)"|'([^']*)'|([^\s;&|"'()<>]+))([ \t]*(?:&&|;)[ \t]+)/u;

function expandHome(path: string): string {
  const home = homedir();
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}

function trimTrailingSlashes(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/u, "") : path;
}

/**
 * Display-only fold of a leading same-line `cd <workspace>` prefix. Two
 * different edits, because the two cases differ in what they delete:
 *
 * - target === workspace: drop the prefix entirely. The `cd` is pure
 *   redundancy — the header already sits in that directory.
 * - target below workspace: rewrite the absolute path as a cwd-relative one
 *   and KEEP `cd`. The directory change is real; only the path gets shorter.
 *   Dropping the keyword would render `packages/foo && npx vitest`, which reads
 *   as executing `packages/foo`, and the shell highlighter paints the word
 *   after `&&` as a command-position token.
 *
 * Lexical comparison only (no fs, no realpath), absolute targets only, and a
 * newline-separated `cd <workspace>` + command stays untouched. A missing
 * `cwd` leaves the command unchanged — there is no `process.cwd()` fallback,
 * because the rendered row must not depend on the renderer's own directory.
 */
function stripWorkspaceCdPrefix(command: string, cwd?: string): string {
  if (!cwd) return command;
  const match = WORKSPACE_CD_PREFIX.exec(command);
  if (!match) return command;
  const target = trimTrailingSlashes(expandHome(match[1] ?? match[2] ?? match[3] ?? ""));
  const workspace = trimTrailingSlashes(expandHome(cwd));
  if (!target.startsWith("/") || !workspace.startsWith("/")) return command;
  const rest = command.slice(match[0].length);
  if (target === workspace) return rest;
  const prefix = workspace === "/" ? "/" : `${workspace}/`;
  if (!target.startsWith(prefix)) return command;
  // A doubled slash (`/repo//foo`) resolves to the same directory as `/repo/foo`,
  // but slicing the prefix off leaves a leading `/` that would read as an
  // absolute path. Strip it so the relative form stays relative.
  const relativePath = target.slice(prefix.length).replace(/^\/+/u, "");
  return `cd ${relativePath}${match[4] ?? " && "}${rest}`;
}

/**
 * Glance subject for bash headers: first logical line capped at `budget`
 * characters; `…` when truncated or more command lines exist. A leading
 * `cd <cwd>` is folded before the budget applies, so the visible command start
 * is the part that actually runs.
 */
export function commandGlance(
  command: string,
  budget: number = BASH_GLANCE_BUDGET,
  cwd?: string,
): string {
  if (!command) return "";
  const lines = stripWorkspaceCdPrefix(command, cwd).replace(/\r?\n/gu, "\n").split("\n");
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
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  /** Width-independent shell highlight — survives resizes like read-evidence paintedCache. */
  private highlightedCache: string[] | undefined;

  constructor(
    private readonly command: string,
    private readonly outputText: string,
    private readonly theme: Theme,
    private readonly outputPad: OutputPad,
    private readonly isError: boolean,
  ) {}

  private highlightedCommand(): string[] {
    if (this.highlightedCache) return this.highlightedCache;
    if (this.command.length === 0) {
      this.highlightedCache = [];
      return this.highlightedCache;
    }
    const source =
      this.command.length > MAX_COMMAND_CHARS
        ? this.command.slice(0, MAX_COMMAND_CHARS)
        : this.command;
    this.highlightedCache = highlightShellCommandLines(source);
    return this.highlightedCache;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const pad = " ".repeat(this.outputPad);
    const lines: string[] = [];
    if (this.command.length > 0) {
      const rail = `${pad}  │ `;
      this.highlightedCommand().forEach((line, index) => {
        lines.push(...wrapEvidenceCommandLine(line, width, rail, index === 0));
      });
    }
    if (this.outputText.length > 0) {
      const rows = buildExpandedOutput(this.outputText, width, this.outputPad);
      for (const row of rows) {
        lines.push(this.isError ? this.theme.fg("error", row) : this.theme.fg("toolOutput", row));
      }
    }
    this.cachedWidth = width;
    this.cachedLines = lines;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.highlightedCache = undefined;
  }
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
