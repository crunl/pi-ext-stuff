import {
  type Component,
  TruncatedText,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { OutputPad } from "./output-padding.ts";

export const STEP_GROUP_TOOL_NAMES = [
  "edit",
  "write",
  "bash",
  "read",
  "grep",
  "find",
  "ls",
] as const;

export type StepGroupToolName = (typeof STEP_GROUP_TOOL_NAMES)[number];

const STEP_GROUP_TOOL_SET: ReadonlySet<string> = new Set(STEP_GROUP_TOOL_NAMES);

export function isStepGroupToolName(name: string): name is StepGroupToolName {
  return STEP_GROUP_TOOL_SET.has(name);
}

export interface StepGroupTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
}

export type StepGroupItemDescriptor =
  | { readonly kind: "thought" }
  | { readonly kind: "tool"; readonly toolName: StepGroupToolName };

export interface StepGroupCounts {
  readonly edit: number;
  readonly write: number;
  readonly read: number;
  readonly search: number;
  readonly bash: number;
  readonly thought: number;
}

export function countStepGroupItems(items: readonly StepGroupItemDescriptor[]): StepGroupCounts {
  let edit = 0;
  let write = 0;
  let read = 0;
  let search = 0;
  let bash = 0;
  let thought = 0;

  for (const item of items) {
    if (item.kind === "thought") {
      thought += 1;
      continue;
    }
    switch (item.toolName) {
      case "edit":
        edit += 1;
        break;
      case "write":
        write += 1;
        break;
      case "read":
        read += 1;
        break;
      case "grep":
      case "find":
      case "ls":
        search += 1;
        break;
      case "bash":
        bash += 1;
        break;
    }
  }

  return { edit, write, read, search, bash, thought };
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatStepGroupClauses(counts: StepGroupCounts): string[] {
  const clauses: string[] = [];
  if (counts.edit > 0) clauses.push(`Edited ${pluralize(counts.edit, "file")}`);
  if (counts.write > 0) clauses.push(`Wrote ${pluralize(counts.write, "file")}`);
  if (counts.read > 0) clauses.push(`Read ${pluralize(counts.read, "file")}`);
  if (counts.search > 0) clauses.push(`Searched ${counts.search}`);
  if (counts.bash > 0) clauses.push(`Ran ${pluralize(counts.bash, "command")}`);
  if (counts.thought > 0) clauses.push(pluralize(counts.thought, "thought"));
  return clauses;
}

export function formatStepGroupSummaryText(counts: StepGroupCounts): string {
  return formatStepGroupClauses(counts).join(" · ");
}

export function formatStepGroupHeader(
  counts: StepGroupCounts,
  expanded: boolean,
  theme: StepGroupTheme,
): string {
  const marker = theme.fg("dim", expanded ? "▾" : "▸");
  const clauses = formatStepGroupClauses(counts).map((clause) => theme.fg("muted", clause));
  if (clauses.length === 0) return marker;
  return `${marker} ${clauses.join(theme.fg("dim", " · "))}`;
}

export function renderThoughtStepLines(
  text: string,
  expanded: boolean,
  width: number,
  outputPad: OutputPad,
  theme: StepGroupTheme,
): string[] {
  if (width <= 0) return [];
  const effectivePad = width > outputPad * 2 ? outputPad : 0;
  const trimmed = text.trim();
  const showBody = expanded && trimmed.length > 0;
  const labelText = showBody ? "Thinking" : "Thinking...";
  const label = theme.italic(theme.fg("thinkingText", labelText));
  const headerLines = new TruncatedText(label, effectivePad, 0).render(width);
  if (!showBody) {
    return headerLines;
  }

  const indent = " ".repeat(Math.min(width, effectivePad + 2));
  const bodyWidth = Math.max(0, width - indent.length);
  const lines = [...headerLines];
  for (const rawLine of trimmed.split(/\r?\n/u)) {
    if (rawLine.length === 0) {
      lines.push(indent);
      continue;
    }
    if (bodyWidth <= 0) {
      lines.push(truncateToWidth(indent, width, ""));
      continue;
    }
    for (const wrapped of wrapTextWithAnsi(rawLine, bodyWidth)) {
      lines.push(`${indent}${theme.italic(theme.fg("thinkingText", wrapped))}`);
    }
  }
  return lines;
}

export type RenderableStepGroupItem =
  | {
      readonly kind: "thought";
      readonly id: string;
      readonly text: string;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly toolName: StepGroupToolName;
      readonly expanded: boolean;
      renderLines(width: number, expanded: boolean): string[];
    };

export interface StepGroupSpan {
  readonly stepId: string;
  readonly startY: number;
  readonly endY: number;
}

export interface StepGroupMouseEvent {
  readonly type: string;
  readonly button: string;
  readonly y: number;
}

export function findStepSpanAtY(
  spans: readonly StepGroupSpan[],
  y: number,
): StepGroupSpan | undefined {
  for (const span of spans) {
    if (y >= span.startY && y < span.endY) return span;
  }
  return undefined;
}

export interface SettledStepGroupOptions {
  getGroupExpanded(): boolean;
  onToggleGroup(): void;
  getSteps(): readonly RenderableStepGroupItem[];
  onToggleStep(stepId: string): void;
  readonly theme: StepGroupTheme;
  getOutputPad(): OutputPad;
}

function stripLeadingPad(line: string, pad: number): string {
  if (pad <= 0) return line;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching leading ANSI SGR sequences
  const match = /^((?:\x1b\[[0-9;]*m)*)( +)/u.exec(line);
  if (!match) return line;
  const ansiPrefix = match[1] ?? "";
  const spaces = match[2] ?? "";
  const remove = Math.min(pad, spaces.length);
  return `${ansiPrefix}${spaces.slice(remove)}${line.slice(ansiPrefix.length + remove)}`;
}

export function createSettledStepGroupComponent(options: SettledStepGroupOptions): Component & {
  handleMouse(event: StepGroupMouseEvent): { handled: true } | undefined;
} {
  let lastSpans: StepGroupSpan[] = [];

  return {
    render(width: number): string[] {
      if (width <= 0) {
        lastSpans = [];
        return [];
      }
      const steps = options.getSteps();
      const groupExpanded = options.getGroupExpanded();
      const outputPad = options.getOutputPad();
      const effectivePad = width > outputPad * 2 ? outputPad : 0;
      const counts = countStepGroupItems(steps);
      const header = formatStepGroupHeader(counts, groupExpanded, options.theme);
      const headerLines = new TruncatedText(header, effectivePad, 0).render(width);

      if (!groupExpanded) {
        lastSpans = [];
        return headerLines;
      }

      const lines = [...headerLines];
      const spans: StepGroupSpan[] = [];
      const pad = " ".repeat(effectivePad);
      const railGlyph = options.theme.fg("borderMuted", "│");
      const tickGlyph = options.theme.fg("borderMuted", "├─");

      for (const step of steps) {
        const startY = lines.length;
        const prefixWidth = effectivePad + 2;
        const hasGutter = width > prefixWidth;
        const childWidth = hasGutter ? Math.max(1, width - prefixWidth) : width;
        const rawLines =
          step.kind === "thought"
            ? renderThoughtStepLines(step.text, step.expanded, childWidth, 0, options.theme)
            : step
                .renderLines(childWidth, step.expanded)
                .map((line) => stripLeadingPad(line, effectivePad));

        for (let lineIdx = 0; lineIdx < rawLines.length; lineIdx++) {
          const line = rawLines[lineIdx] ?? "";
          if (!hasGutter) {
            lines.push(line);
          } else if (step.expanded) {
            const gutter = lineIdx === 0 ? `${pad}${tickGlyph}` : `${pad}${railGlyph} `;
            lines.push(`${gutter}${line}`);
          } else {
            lines.push(`${pad}${railGlyph} ${line}`);
          }
        }
        const endY = lines.length;
        if (endY > startY) {
          spans.push({ stepId: step.id, startY, endY });
        }
      }

      lastSpans = spans;
      return lines;
    },
    handleMouse(event: StepGroupMouseEvent): { handled: true } | undefined {
      if (event.type !== "click" || event.button !== "left") return undefined;
      if (event.y === 0) {
        options.onToggleGroup();
        return { handled: true };
      }
      const hit = findStepSpanAtY(lastSpans, event.y);
      if (hit) {
        options.onToggleStep(hit.stepId);
        return { handled: true };
      }
      return undefined;
    },
    invalidate(): void {
      lastSpans = [];
    },
  };
}

export interface UnsettledThoughtItem {
  readonly id: string;
  readonly text: string;
  readonly expanded: boolean;
}

export interface UnsettledToolStepOptions {
  getLeadingThoughts(): readonly UnsettledThoughtItem[];
  getTrailingThoughts(): readonly UnsettledThoughtItem[];
  renderToolLines(width: number): string[];
  onToggleThought(thoughtId: string): void;
  readonly theme: StepGroupTheme;
  getOutputPad(): OutputPad;
}

export function createUnsettledToolStepComponent(options: UnsettledToolStepOptions): Component & {
  handleMouse(event: StepGroupMouseEvent): { handled: true } | undefined;
} {
  let lastThoughtSpans: StepGroupSpan[] = [];
  let lastSpacerYs = new Set<number>();

  return {
    render(width: number): string[] {
      if (width <= 0) {
        lastThoughtSpans = [];
        lastSpacerYs = new Set();
        return [];
      }
      const leading = options.getLeadingThoughts();
      const trailing = options.getTrailingThoughts();
      const outputPad = options.getOutputPad();

      if (leading.length === 0 && trailing.length === 0) {
        lastThoughtSpans = [];
        lastSpacerYs = new Set();
        return options.renderToolLines(width);
      }

      const lines: string[] = [];
      const thoughtSpans: StepGroupSpan[] = [];
      const spacerYs = new Set<number>();

      for (const thought of leading) {
        if (lines.length > 0) {
          spacerYs.add(lines.length);
          lines.push("");
        }
        const startY = lines.length;
        const thoughtLines = renderThoughtStepLines(
          thought.text,
          thought.expanded,
          width,
          outputPad,
          options.theme,
        );
        lines.push(...thoughtLines);
        const endY = lines.length;
        if (endY > startY) {
          thoughtSpans.push({ stepId: thought.id, startY, endY });
        }
      }

      const toolLines = options.renderToolLines(width);
      if (toolLines.length > 0) {
        if (lines.length > 0) {
          spacerYs.add(lines.length);
          lines.push("");
        }
        lines.push(...toolLines);
      }

      for (const thought of trailing) {
        if (lines.length > 0) {
          spacerYs.add(lines.length);
          lines.push("");
        }
        const startY = lines.length;
        const thoughtLines = renderThoughtStepLines(
          thought.text,
          thought.expanded,
          width,
          outputPad,
          options.theme,
        );
        lines.push(...thoughtLines);
        const endY = lines.length;
        if (endY > startY) {
          thoughtSpans.push({ stepId: thought.id, startY, endY });
        }
      }

      lastThoughtSpans = thoughtSpans;
      lastSpacerYs = spacerYs;
      return lines;
    },
    handleMouse(event: StepGroupMouseEvent): { handled: true } | undefined {
      if (event.type !== "click" || event.button !== "left") return undefined;
      const hit = findStepSpanAtY(lastThoughtSpans, event.y);
      if (hit) {
        options.onToggleThought(hit.stepId);
        return { handled: true };
      }
      if (lastSpacerYs.has(event.y)) {
        return { handled: true };
      }
      return undefined;
    },
    invalidate(): void {
      lastThoughtSpans = [];
      lastSpacerYs = new Set();
    },
  };
}

export function emptyStepGroupComponent(): Component {
  return {
    render: () => [],
    invalidate: () => {},
  };
}
