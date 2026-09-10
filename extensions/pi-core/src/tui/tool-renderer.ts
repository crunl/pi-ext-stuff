import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";
import {
  type OutputPad,
  type OutputPaddingSource,
  outputPaddingController,
} from "./output-padding.ts";
import { buildExpandedOutput, buildOutputPreview, toolResultText } from "./tool-output.ts";

type CollapsedResult =
  | "hidden"
  | "preview"
  | ((result: AgentToolResult<unknown>, args: Record<string, unknown>) => string | undefined);

type ExpandedResultRenderer = (
  result: AgentToolResult<unknown>,
  args: Record<string, unknown>,
  theme: Theme,
  outputPad: OutputPad,
) => Component;

export interface CodexToolRendererSpec<TPreviewState = unknown> {
  icon?: string;
  runningVerb: string;
  completedVerb: string;
  argument: (args: Record<string, unknown>, cwd: string) => string;
  /** Truncate the header to one row and expose embedded line breaks as `↵`. */
  singleLineHeader?: boolean;
  collapsed?: CollapsedResult;
  formatSummary?: (summary: string, theme: Theme) => string;
  /**
   * Optional component rendered below the header while the call is being
   * streamed (partial args) and the result view is expanded. Lets a tool
   * show a live preview that updates as arguments grow, e.g. the write tool's
   * syntax-highlighted content preview. TPreviewState types the shared
   * rendererState slot so previews can persist state (e.g. a highlight
   * cache) across calls without casts.
   */
  renderCallPreview?: (
    args: Record<string, unknown>,
    theme: Theme,
    context: RenderContext<TPreviewState>,
  ) => Component | undefined;
  renderExpandedResult?: ExpandedResultRenderer;
  maxOutputRows?: number;
  transformOutput?: (text: string) => string;
}

interface MutableToolHeader extends Component {
  setText(text: string): void;
}

interface CodexToolRenderState<TPreviewState = unknown> {
  header?: MutableToolHeader;
  outputPad?: OutputPad;
  status?: "running" | "completed" | "failed";
  summary?: string;
  /** Renderer-specific state for previews (typed via CodexToolRendererSpec). */
  rendererState?: TPreviewState;
}

const HEADER_WHITESPACE = /\s/u;

/** Collapsed/expanded output row cap when a spec does not override it. */
const DEFAULT_MAX_OUTPUT_ROWS = 5;

/** Replace whitespace runs containing CR/LF with a visible break marker. */
function collapseHeaderBreaks(text: string): string {
  let chunks: string[] | undefined;
  let chunkStart = 0;
  let cursor = 0;

  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code !== 10 && code !== 13) {
      cursor += 1;
      continue;
    }

    chunks ??= [];
    let whitespaceStart = cursor;
    while (
      whitespaceStart > chunkStart &&
      HEADER_WHITESPACE.test(text.charAt(whitespaceStart - 1))
    ) {
      whitespaceStart -= 1;
    }
    chunks.push(text.slice(chunkStart, whitespaceStart), " ↵ ");

    cursor += 1;
    while (cursor < text.length && HEADER_WHITESPACE.test(text.charAt(cursor))) {
      cursor += 1;
    }
    chunkStart = cursor;
  }

  if (!chunks) return text;
  chunks.push(text.slice(chunkStart));
  return chunks.join("");
}

/** Mutable single-row header that delegates width-safe truncation to Pi TUI. */
class SingleLineToolHeader implements MutableToolHeader {
  private sourceText: string | undefined;
  private text: TruncatedText;

  constructor(private readonly outputPad: OutputPad) {
    this.text = new TruncatedText("", outputPad, 0);
  }

  setText(text: string): void {
    if (text === this.sourceText) return;
    this.sourceText = text;
    this.text = new TruncatedText(collapseHeaderBreaks(text), this.outputPad, 0);
  }

  render(width: number): string[] {
    return this.text.render(width);
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

interface RenderContext<TPreviewState = unknown> {
  args: Record<string, unknown>;
  toolCallId: string;
  invalidate: () => void;
  state: CodexToolRenderState<TPreviewState>;
  cwd: string;
  isError: boolean;
  /** Whether the result view is expanded (from ToolRenderContext). */
  expanded: boolean;
  /** Present when the host owns the persistent leading mark for this call. */
  toolCallMark?: {
    readonly icon: string;
    readonly color: "warning";
  };
}

interface CodexToolRendering<TPreviewState = unknown> {
  renderShell: "self";
  renderCall: (
    args: Record<string, unknown>,
    theme: Theme,
    context: RenderContext<TPreviewState>,
  ) => Component;
  renderResult: (
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RenderContext<TPreviewState>,
  ) => Component;
}

function headerText<TPreviewState = unknown>(
  spec: CodexToolRendererSpec<TPreviewState>,
  state: CodexToolRenderState,
  args: Record<string, unknown>,
  context: RenderContext,
  theme: Theme,
): string {
  const status = state.status ?? "running";
  const bulletColor = status === "failed" ? "error" : status === "completed" ? "success" : "dim";
  const verb =
    status === "failed" ? "Failed" : status === "completed" ? spec.completedVerb : spec.runningVerb;
  const argument = spec.argument(args, context.cwd);
  const suffix = argument.length > 0 ? ` ${theme.fg("muted", argument)}` : "";
  const summary = state.summary
    ? spec.formatSummary
      ? `${theme.fg("dim", " · ")}${spec.formatSummary(state.summary, theme)}`
      : theme.fg("dim", ` · ${state.summary}`)
    : "";
  const icon = context.toolCallMark
    ? ""
    : `${theme.fg(bulletColor, theme.bold(spec.icon ?? "•"))} `;
  return `${icon}${theme.bold(verb)}${suffix}${summary}`;
}

class ToolOutputComponent implements Component {
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly text: string,
    private readonly expanded: boolean,
    private readonly maxRows: number,
    private readonly style: (text: string) => string,
    private readonly outputPad: OutputPad,
  ) {}

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const lines = this.expanded
      ? buildExpandedOutput(this.text, width, this.outputPad)
      : buildOutputPreview(this.text, width, this.maxRows, this.outputPad);
    this.cachedWidth = width;
    this.cachedLines = lines.map(this.style);
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

function updateHeader<TPreviewState = unknown>(
  spec: CodexToolRendererSpec<TPreviewState>,
  state: CodexToolRenderState<TPreviewState>,
  args: Record<string, unknown>,
  context: RenderContext<TPreviewState>,
  theme: Theme,
  outputPad: OutputPad,
): MutableToolHeader {
  if (!state.header || state.outputPad !== outputPad) {
    state.header = spec.singleLineHeader
      ? new SingleLineToolHeader(outputPad)
      : new Text("", outputPad, 0);
    state.outputPad = outputPad;
  }
  state.header.setText(headerText(spec, state, args, context, theme));
  return state.header;
}

export function createCodexToolRendering<TPreviewState = unknown>(
  spec: CodexToolRendererSpec<TPreviewState>,
  paddingSource: OutputPaddingSource = outputPaddingController,
): CodexToolRendering<TPreviewState> {
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      const state = context.state;
      paddingSource.track(context.toolCallId, context.invalidate);
      state.status ??= "running";
      const header = updateHeader(spec, state, args, context, theme, paddingSource.getOutputPad());
      const preview =
        context.expanded && !context.isError
          ? spec.renderCallPreview?.(args, theme, context)
          : undefined;
      if (!preview) return header;
      const container = new Container();
      container.addChild(header);
      container.addChild(new Spacer(1));
      container.addChild(preview);
      return container;
    },
    renderResult(result, options, theme, context) {
      const state = context.state;
      paddingSource.track(context.toolCallId, context.invalidate);
      const outputPad = paddingSource.getOutputPad();
      state.status = options.isPartial ? "running" : context.isError ? "failed" : "completed";
      state.summary =
        typeof spec.collapsed === "function" && !options.isPartial && !context.isError
          ? spec.collapsed(result, context.args)
          : undefined;
      updateHeader(spec, state, context.args, context, theme, outputPad);

      if (options.expanded && !options.isPartial && !context.isError && spec.renderExpandedResult) {
        return spec.renderExpandedResult(result, context.args, theme, outputPad);
      }

      const rawText = toolResultText(result);
      const text = spec.transformOutput ? spec.transformOutput(rawText) : rawText;
      const maxRows = spec.maxOutputRows ?? DEFAULT_MAX_OUTPUT_ROWS;
      if (options.expanded && text.length > 0) {
        return new ToolOutputComponent(
          text,
          true,
          maxRows,
          (line) => theme.fg(context.isError ? "error" : "toolOutput", line),
          outputPad,
        );
      }
      if (context.isError && text.length > 0) {
        return new ToolOutputComponent(
          text,
          false,
          maxRows,
          (line) => theme.fg("error", line),
          outputPad,
        );
      }
      if (spec.collapsed === "preview" && text.length > 0) {
        return new ToolOutputComponent(
          text,
          false,
          maxRows,
          (line) => theme.fg("dim", line),
          outputPad,
        );
      }
      return new Container();
    },
  };
}
