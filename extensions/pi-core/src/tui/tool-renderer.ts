import {
  type AgentToolResult,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  type Component,
} from "@earendil-works/pi-tui";
import {
  buildExpandedOutput,
  buildOutputPreview,
} from "./tool-output.ts";
import {
  outputPaddingController,
  type OutputPad,
  type OutputPaddingSource,
} from "./output-padding.ts";

export type CollapsedResult =
  | "hidden"
  | "preview"
  | ((
      result: AgentToolResult<unknown>,
      args: Record<string, unknown>,
    ) => string | undefined);

export type ExpandedResultRenderer = (
  result: AgentToolResult<unknown>,
  args: Record<string, unknown>,
  theme: Theme,
  outputPad: OutputPad,
) => Component;

export interface CodexToolRendererSpec {
  icon?: string;
  runningVerb: string;
  completedVerb: string;
  argument: (args: Record<string, unknown>, cwd: string) => string;
  collapsed: CollapsedResult;
  formatSummary?: (summary: string, theme: Theme) => string;
  renderExpandedResult?: ExpandedResultRenderer;
  maxOutputRows?: number;
  transformOutput?: (text: string) => string;
}

interface CodexToolRenderState {
  header?: Text;
  outputPad?: OutputPad;
  status?: "running" | "completed" | "failed";
  summary?: string;
}

interface RenderContext {
  args: Record<string, unknown>;
  toolCallId: string;
  invalidate: () => void;
  state: CodexToolRenderState;
  cwd: string;
  isError: boolean;
}

export interface CodexToolRendering {
  renderShell: "self";
  renderCall: (
    args: Record<string, unknown>,
    theme: Theme,
    context: RenderContext,
  ) => Component;
  renderResult: (
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RenderContext,
  ) => Component;
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .filter(Boolean)
    .join("\n");
}

export function compactBashStatusSpacing(text: string): string {
  return text.replace(
    /\n{2,}(?=Command (?:exited with code \d+|timed out after [^\n]+ seconds|aborted)\s*$)/,
    "\n",
  );
}

export function summarizeEditDiff(
  result: AgentToolResult<unknown>,
): string | undefined {
  const details = result.details as { diff?: unknown } | undefined;
  if (typeof details?.diff !== "string") return undefined;

  let additions = 0;
  let deletions = 0;
  for (const line of details.diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return additions > 0 || deletions > 0
    ? `+${additions} -${deletions}`
    : undefined;
}

export function colorizeEditDiffSummary(
  summary: string,
  theme: Theme,
): string {
  const match = summary.match(/^(\+\d+)\s+(-\d+)$/);
  if (!match) return theme.fg("dim", summary);
  return `${theme.fg("success", match[1])} ${theme.fg("error", match[2])}`;
}

function headerText(
  spec: CodexToolRendererSpec,
  state: CodexToolRenderState,
  args: Record<string, unknown>,
  context: RenderContext,
  theme: Theme,
): string {
  const status = state.status ?? "running";
  const bulletColor = status === "failed"
    ? "error"
    : status === "completed"
      ? "success"
      : "dim";
  const verb = status === "failed"
    ? "Failed"
    : status === "completed"
      ? spec.completedVerb
      : spec.runningVerb;
  const argument = spec.argument(args, context.cwd);
  const suffix = argument.length > 0 ? ` ${theme.fg("muted", argument)}` : "";
  const summary = state.summary
    ? spec.formatSummary
      ? `${theme.fg("dim", " · ")}${spec.formatSummary(state.summary, theme)}`
      : theme.fg("dim", ` · ${state.summary}`)
    : "";
  const icon = spec.icon ?? "•";
  return `${theme.fg(bulletColor, theme.bold(icon))} ${theme.bold(verb)}${suffix}${summary}`;
}

class ToolOutputComponent implements Component {
  constructor(
    private readonly text: string,
    private readonly expanded: boolean,
    private readonly maxRows: number,
    private readonly style: (text: string) => string,
    private readonly outputPad: OutputPad,
  ) {}

  render(width: number): string[] {
    const lines = this.expanded
      ? buildExpandedOutput(this.text, width, this.outputPad)
      : buildOutputPreview(
          this.text,
          width,
          this.maxRows,
          this.outputPad,
        );
    return lines.map(this.style);
  }

  invalidate(): void {}
}

function updateHeader(
  spec: CodexToolRendererSpec,
  state: CodexToolRenderState,
  args: Record<string, unknown>,
  context: RenderContext,
  theme: Theme,
  outputPad: OutputPad,
): void {
  if (!state.header || state.outputPad !== outputPad) {
    state.header = new Text("", outputPad, 0);
    state.outputPad = outputPad;
  }
  state.header?.setText(headerText(spec, state, args, context, theme));
}

export function createCodexToolRendering(
  spec: CodexToolRendererSpec,
  paddingSource: OutputPaddingSource = outputPaddingController,
): CodexToolRendering {
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      const state = context.state;
      paddingSource.track(context.toolCallId, context.invalidate);
      const outputPad = paddingSource.getOutputPad();
      state.status ??= "running";
      if (!state.header || state.outputPad !== outputPad) {
        state.header = new Text("", outputPad, 0);
        state.outputPad = outputPad;
      }
      const header = state.header;
      header.setText(headerText(spec, state, args, context, theme));
      return header;
    },
    renderResult(result, options, theme, context) {
      const state = context.state;
      paddingSource.track(context.toolCallId, context.invalidate);
      const outputPad = paddingSource.getOutputPad();
      state.status = options.isPartial
        ? "running"
        : context.isError
          ? "failed"
          : "completed";
      state.summary = typeof spec.collapsed === "function"
        && !options.isPartial
        && !context.isError
        ? spec.collapsed(result, context.args)
        : undefined;
      updateHeader(
        spec,
        state,
        context.args,
        context,
        theme,
        outputPad,
      );

      if (
        options.expanded
        && !options.isPartial
        && !context.isError
        && spec.renderExpandedResult
      ) {
        return spec.renderExpandedResult(
          result,
          context.args,
          theme,
          outputPad,
        );
      }

      const rawText = resultText(result);
      const text = spec.transformOutput
        ? spec.transformOutput(rawText)
        : rawText;
      if (options.expanded && text.length > 0) {
        return new ToolOutputComponent(
          text,
          true,
          spec.maxOutputRows ?? 5,
          (line) => theme.fg(context.isError ? "error" : "toolOutput", line),
          outputPad,
        );
      }
      if (context.isError && text.length > 0) {
        return new ToolOutputComponent(
          text,
          false,
          spec.maxOutputRows ?? 5,
          (line) => theme.fg("error", line),
          outputPad,
        );
      }
      if (spec.collapsed === "preview" && text.length > 0) {
        return new ToolOutputComponent(
          text,
          false,
          spec.maxOutputRows ?? 5,
          (line) => theme.fg("dim", line),
          outputPad,
        );
      }
      return new Container();
    },
  };
}
