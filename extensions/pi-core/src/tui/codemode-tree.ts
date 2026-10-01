import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import {
  type CallStatus,
  type ChildRow,
  type GlanceSummary,
  type TextBlock,
  type TreeView,
  toTreeView,
} from "./codemode-contract.ts";

/**
 * Tree presentation for Pi's `codemode` tool. UI only — payload mapping lives
 * in `codemode-contract.ts`. Nested calls never become host tool rows, so this
 * renderer is the only place they appear.
 */

export interface CodemodeTreeTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface CodemodeTreeState {
  expandedCalls?: Set<string>;
  expandedCode?: boolean;
  expandedOutput?: boolean;
  leadingIconOverride?: string;
}

const CHILD_ERROR_CHARS = 80;

function statusIcon(status: CallStatus, theme: CodemodeTreeTheme): string {
  switch (status) {
    case "running":
      return theme.fg("warning", "…");
    case "ok":
      return theme.fg("success", "✓");
    case "error":
      return theme.fg("error", "✗");
    case "cancelled":
      return theme.fg("muted", "⊘");
    default:
      return theme.fg("muted", "•");
  }
}

function formatCost(cost: number): string {
  return cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${cost.toPrecision(2)}`;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `└ Ran 1 command · Read 3 files · Edited 1 file · 1 failed` */
export function formatCodemodeGlance(
  glance: GlanceSummary,
  theme: CodemodeTreeTheme,
  options: { leadingIconOverride?: string } = {},
): string {
  const root = options.leadingIconOverride
    ? theme.fg("warning", theme.bold(options.leadingIconOverride))
    : theme.fg("dim", "└");
  const parts: string[] = [];
  if (glance.commands > 0)
    parts.push(theme.bold(`Ran ${plural(glance.commands, "command", "commands")}`));
  if (glance.reads > 0) parts.push(theme.bold(`Read ${plural(glance.reads, "file", "files")}`));
  if (glance.edits > 0) parts.push(theme.bold(`Edited ${plural(glance.edits, "file", "files")}`));
  if (glance.other > 0) parts.push(theme.bold(plural(glance.other, "call", "calls")));
  if (parts.length === 0) parts.push(theme.bold(plural(glance.total, "tool", "tools")));
  const failure =
    glance.failed > 0
      ? theme.fg(
          "error",
          glance.failed === glance.total ? " · all failed" : ` · ${glance.failed} failed`,
        )
      : "";
  const active = glance.running > 0 ? theme.fg("warning", ` · ${glance.running} running`) : "";
  return `${root} ${parts.join(theme.fg("muted", " · "))}${failure}${active}`;
}

export function formatNestedCallRow(
  child: ChildRow,
  theme: CodemodeTreeTheme,
  options: { expanded?: boolean; leadingIconOverride?: string } = {},
): string {
  const icon =
    options.leadingIconOverride && (child.status === "ok" || child.status === "error")
      ? theme.fg("warning", theme.bold(options.leadingIconOverride))
      : statusIcon(child.status, theme);
  const name = theme.fg("toolTitle", child.toolLabel);
  const body = child.target ? `  ${theme.fg("muted", child.target)}` : "";
  const duration = formatDuration(child.durationMs);
  const tailParts = [
    duration ? theme.fg("dim", duration) : "",
    child.costUsd !== undefined ? theme.fg("dim", formatCost(child.costUsd)) : "",
  ].filter(Boolean);
  const tail = tailParts.length > 0 ? `  ${tailParts.join(" ")}` : "";
  const error =
    child.status === "error" && child.errorText && options.expanded
      ? `\n    ${theme.fg("error", child.errorText.slice(0, CHILD_ERROR_CHARS))}`
      : "";
  return `${icon} ${name}${body}${tail}${error}`;
}

type TreeSectionId = "code" | `call:${string}` | "output";

interface TreeSection {
  id: TreeSectionId;
  head: string;
  body: string[];
  open: boolean;
}

function blockHead(label: string, block: TextBlock, theme: CodemodeTreeTheme): string {
  return `${theme.fg("toolTitle", label)}  ${theme.fg("muted", `${block.lineCount} lines · ${block.preview}`)}`;
}

function buildSections(
  view: TreeView,
  theme: CodemodeTreeTheme,
  state: CodemodeTreeState,
): TreeSection[] {
  const sections: TreeSection[] = [];
  if (view.code) {
    sections.push({
      id: "code",
      head: blockHead("code", view.code, theme),
      body: view.code.lines.map((line) => theme.fg("dim", line)),
      open: state.expandedCode === true,
    });
  }
  for (const child of view.children) {
    const open = state.expandedCalls?.has(child.id) ?? child.status === "error";
    const body: string[] = [];
    if (child.status === "error" && child.errorText) {
      body.push(theme.fg("error", `    ${child.errorText}`));
    }
    if (child.argsPreview) {
      body.push(theme.fg("dim", `    ${child.argsPreview}`));
    }
    sections.push({
      id: `call:${child.id}`,
      head: formatNestedCallRow(child, theme, { expanded: false }),
      body,
      open,
    });
  }
  if (view.output) {
    const body = view.output.lines.map((line) => theme.fg("toolOutput", line));
    if (view.fullOutputPath) {
      body.push(theme.fg("muted", `full output: ${view.fullOutputPath}`));
    }
    sections.push({
      id: "output",
      head: blockHead("output", view.output, theme),
      body,
      open: state.expandedOutput === true,
    });
  }
  return sections;
}

function paintTreeLines(root: string, sections: TreeSection[]): string[] {
  const lines = [root];
  sections.forEach((section, index) => {
    const isLast = index === sections.length - 1;
    const head = isLast ? "└" : "├";
    const rail = isLast ? " " : "│";
    const mark = section.open ? "▾" : "▸";
    lines.push(`  ${head} ${mark} ${section.head}`);
    if (section.open) {
      for (const line of section.body) {
        lines.push(`  ${rail}  ${line}`);
      }
    }
  });
  return lines;
}

function sectionAtY(sections: TreeSection[], y: number): number {
  if (y <= 0) return -1;
  let cursor = 1;
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    if (!section) continue;
    const span = 1 + (section.open ? section.body.length : 0);
    if (y >= cursor && y < cursor + span) return i;
    cursor += span;
  }
  return -1;
}

interface TuiMouseEventLike {
  type: string;
  button: string;
  y: number;
}

function createClickableTree(options: {
  buildLines: () => { lines: string[]; sections: TreeSection[] };
  onToggle: (sectionId: TreeSectionId) => void;
}): Component {
  let cache: { lines: string[]; sections: TreeSection[] } | undefined;
  const read = () => {
    cache = options.buildLines();
    return cache;
  };
  return {
    render(width: number) {
      void width;
      return read().lines;
    },
    invalidate() {
      cache = undefined;
    },
    handleMouse(event: TuiMouseEventLike) {
      if (event.type !== "click" || event.button !== "left") return undefined;
      const { sections } = read();
      const index = sectionAtY(sections, event.y);
      if (index < 0) return undefined;
      const section = sections[index];
      if (!section) return undefined;
      options.onToggle(section.id);
      cache = undefined;
      return { handled: true };
    },
  };
}

function toggleSection(state: CodemodeTreeState, id: TreeSectionId): void {
  if (id === "code") {
    state.expandedCode = !state.expandedCode;
    return;
  }
  if (id === "output") {
    state.expandedOutput = !state.expandedOutput;
    return;
  }
  const callId = id.slice("call:".length);
  const set = state.expandedCalls instanceof Set ? state.expandedCalls : new Set<string>();
  if (set.has(callId)) set.delete(callId);
  else set.add(callId);
  state.expandedCalls = set;
}

const emptyComponent = (): Component => ({
  render: () => [],
  invalidate: () => {},
});

function reuseText(last: unknown): Text {
  if (last && typeof (last as Text).setText === "function") return last as Text;
  return new Text("", 0, 0);
}

export interface CodemodeTreeRenderContext {
  readonly state: unknown;
  readonly expanded: boolean;
  readonly isError: boolean;
  readonly lastComponent?: unknown;
  readonly args?: unknown;
  readonly invalidate?: () => void;
}

export interface CodemodeTreeRendering {
  renderShell: "self";
  renderCall(
    args: Record<string, unknown>,
    theme: CodemodeTreeTheme,
    context: CodemodeTreeRenderContext,
  ): Component;
  renderResult(
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: CodemodeTreeTheme,
    context: CodemodeTreeRenderContext,
  ): Component;
}

export function createCodemodeTreeRendering(): CodemodeTreeRendering {
  return {
    renderShell: "self",
    renderCall() {
      return emptyComponent();
    },
    renderResult(result, options, theme, context) {
      const state = (context.state ?? {}) as CodemodeTreeState;
      const view: TreeView = toTreeView({
        details: result?.details,
        args: context.args,
        result: result as { content?: readonly unknown[] },
        isPartial: options.isPartial,
      });

      if (!options.expanded) {
        const component = reuseText(context.lastComponent);
        component.setText(
          formatCodemodeGlance(view.glance, theme, {
            leadingIconOverride: state.leadingIconOverride,
          }),
        );
        return component;
      }

      const root = formatCodemodeGlance(view.glance, theme, {
        leadingIconOverride: state.leadingIconOverride,
      });
      return createClickableTree({
        buildLines: () => {
          const sections = buildSections(view, theme, state);
          return { lines: paintTreeLines(root, sections), sections };
        },
        onToggle: (id) => {
          toggleSection(state, id);
          context.invalidate?.();
        },
      });
    },
  };
}
