import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolRenderers,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  createSettledStepGroupComponent,
  createUnsettledToolStepComponent,
  emptyStepGroupComponent,
  isInteractiveTui,
  isStepGroupToolName,
  type OutputPaddingSource,
  outputPaddingController,
  type RenderableStepGroupItem,
  type StepGroupToolName,
  type UnsettledThoughtItem,
} from "../../../packages/shared-tool-presentation/src/index.ts";

export interface StepGroupToolRenderContext {
  args: unknown;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: Component | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: state is renderer-defined per tool
  state: any;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isError: boolean;
  expanded: boolean;
  showImages: boolean;
}

export interface StepGroupBaseRenderer {
  renderShell?: "default" | "self";
  renderCall?: (
    // biome-ignore lint/suspicious/noExplicitAny: bivariant tool args across ToolRenderers and CodexToolRendering
    args: any,
    theme: Theme,
    // biome-ignore lint/suspicious/noExplicitAny: bivariant state across ToolRenderers and CodexToolRendering
    context: any,
  ) => Component;
  renderResult?: (
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    // biome-ignore lint/suspicious/noExplicitAny: bivariant state across ToolRenderers and CodexToolRendering
    context: any,
  ) => Component;
}

interface RecordedAssistantMessage {
  readonly kind: "assistant";
  readonly id: string;
  content: readonly unknown[];
  stopReason?: string | undefined;
}

interface RecordedUserBoundary {
  readonly kind: "user";
}

interface RecordedSettlementBoundary {
  readonly kind: "settle";
}

type RecordedEntry = RecordedAssistantMessage | RecordedUserBoundary | RecordedSettlementBoundary;

interface DerivedThoughtStep {
  readonly kind: "thought";
  readonly id: string;
  readonly text: string;
}

interface DerivedToolStep {
  readonly kind: "tool";
  readonly id: string;
  readonly toolName: StepGroupToolName;
  readonly args: Record<string, unknown>;
}

type DerivedStep = DerivedThoughtStep | DerivedToolStep;

interface DerivedSegment {
  readonly steps: DerivedStep[];
  readonly toolIds: string[];
  settled: boolean;
}

interface ToolResultSnapshot {
  readonly result: AgentToolResult<unknown>;
  readonly isPartial: boolean;
  readonly isError: boolean;
}

interface ToolRecord {
  readonly toolCallId: string;
  toolName: StepGroupToolName;
  baseRenderer: StepGroupBaseRenderer;
  args: Record<string, unknown>;
  theme: Theme | undefined;
  callContext: StepGroupToolRenderContext | undefined;
  resultContext: StepGroupToolRenderContext | undefined;
  resultSnapshot: ToolResultSnapshot | undefined;
  baseCallComponent: Component | undefined;
  baseResultComponent: Component | undefined;
  stepCallComponent: Component | undefined;
  stepResultComponent: Component | undefined;
  stepState: Record<string, unknown>;
}

interface ToolPlacement {
  readonly segment: DerivedSegment;
  readonly isFolded: boolean;
  readonly isAnchor: boolean;
  readonly anchorToolCallId: string;
  readonly leadingThoughts: readonly DerivedThoughtStep[];
  readonly trailingThoughts: readonly DerivedThoughtStep[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isThinkingContent(block: unknown): block is { type: "thinking"; thinking: string } {
  return isRecord(block) && block.type === "thinking" && typeof block.thinking === "string";
}

function isTextContent(block: unknown): block is { type: "text"; text: string } {
  return isRecord(block) && block.type === "text" && typeof block.text === "string";
}

function isToolCallContent(
  block: unknown,
): block is { type: "toolCall"; id: string; name: string; arguments?: unknown } {
  return (
    isRecord(block) &&
    block.type === "toolCall" &&
    typeof block.id === "string" &&
    typeof block.name === "string"
  );
}

function toArgsRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function hasImageContent(result: AgentToolResult<unknown> | undefined): boolean {
  if (!result || !Array.isArray(result.content)) return false;
  return result.content.some((block) => isRecord(block) && block.type === "image");
}

function safeRenderCall(
  base: StepGroupBaseRenderer,
  args: Record<string, unknown>,
  theme: Theme,
  context: StepGroupToolRenderContext,
): Component | undefined {
  if (!base.renderCall) return undefined;
  try {
    return base.renderCall(args, theme, context);
  } catch {
    return undefined;
  }
}

function safeRenderResult(
  base: StepGroupBaseRenderer,
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: StepGroupToolRenderContext,
): Component | undefined {
  if (!base.renderResult) return undefined;
  try {
    return base.renderResult(result, options, theme, context);
  } catch {
    return undefined;
  }
}

function isFoldedSegment(segment: DerivedSegment): boolean {
  return segment.settled && segment.steps.length >= 2 && segment.toolIds.length >= 1;
}

function deriveSegments(
  entries: readonly RecordedEntry[],
  streamingAssistant: RecordedAssistantMessage | undefined,
  canIncludeToolInGroup: (toolCallId: string, toolName: StepGroupToolName) => boolean,
): DerivedSegment[] {
  const allEntries = streamingAssistant ? [...entries, streamingAssistant] : entries;
  const segments: DerivedSegment[] = [];
  let openSegment: DerivedSegment | undefined;
  let unsettledInTurn: DerivedSegment[] = [];

  const ensureOpenSegment = (): DerivedSegment => {
    if (!openSegment) {
      openSegment = { steps: [], toolIds: [], settled: false };
      segments.push(openSegment);
      unsettledInTurn.push(openSegment);
    }
    return openSegment;
  };

  const settleTurn = (): void => {
    for (const pending of unsettledInTurn) {
      pending.settled = true;
    }
    unsettledInTurn = [];
    openSegment = undefined;
  };

  for (const entry of allEntries) {
    if (entry.kind === "user" || entry.kind === "settle") {
      settleTurn();
      continue;
    }

    const content = entry.content;
    let thinkingRunIndex = 0;

    for (let i = 0; i < content.length; i++) {
      const block = content[i];

      if (isThinkingContent(block)) {
        const thinkingBlocks: string[] = [];
        for (; i < content.length; i++) {
          const candidate = content[i];
          if (!isThinkingContent(candidate)) break;
          const trimmed = candidate.thinking.trim();
          if (trimmed.length > 0) {
            thinkingBlocks.push(trimmed);
          }
        }
        i--;
        if (thinkingBlocks.length === 0) continue;

        const runIndex = thinkingRunIndex++;
        const segment = ensureOpenSegment();
        segment.steps.push({
          kind: "thought",
          id: `${entry.id}:thought:${runIndex}`,
          text: thinkingBlocks.join("\n\n"),
        });
        continue;
      }

      if (isToolCallContent(block)) {
        if (isStepGroupToolName(block.name) && canIncludeToolInGroup(block.id, block.name)) {
          const segment = ensureOpenSegment();
          segment.steps.push({
            kind: "tool",
            id: block.id,
            toolName: block.name,
            args: toArgsRecord(block.arguments),
          });
          segment.toolIds.push(block.id);
        } else {
          openSegment = undefined;
        }
        continue;
      }

      if (isTextContent(block) && block.text.trim().length > 0) {
        settleTurn();
      }
    }

    if (entry.stopReason === "aborted" || entry.stopReason === "error") {
      settleTurn();
    }
  }

  return segments;
}

function buildPlacements(segments: readonly DerivedSegment[]): Map<string, ToolPlacement> {
  const placements = new Map<string, ToolPlacement>();

  for (const segment of segments) {
    const anchorToolCallId = segment.toolIds[0];
    if (!anchorToolCallId) continue;
    const isFolded = isFoldedSegment(segment);

    for (let stepIdx = 0; stepIdx < segment.steps.length; stepIdx++) {
      const step = segment.steps[stepIdx];
      if (step?.kind !== "tool") continue;

      const isAnchor = step.id === anchorToolCallId;
      const leadingThoughts: DerivedThoughtStep[] = [];
      if (isAnchor) {
        for (let k = 0; k < stepIdx; k++) {
          const prior = segment.steps[k];
          if (prior?.kind === "thought") {
            leadingThoughts.push(prior);
          }
        }
      }

      const trailingThoughts: DerivedThoughtStep[] = [];
      for (let k = stepIdx + 1; k < segment.steps.length; k++) {
        const next = segment.steps[k];
        if (!next || next.kind === "tool") break;
        trailingThoughts.push(next);
      }

      placements.set(step.id, {
        segment,
        isFolded,
        isAnchor,
        anchorToolCallId,
        leadingThoughts,
        trailingThoughts,
      });
    }
  }

  return placements;
}

export class StepGroupFoldController {
  private entries: RecordedEntry[] = [];
  private streamingAssistant: RecordedAssistantMessage | undefined;
  private nextMessageSeq = 1;
  private placementsByToolId = new Map<string, ToolPlacement>();
  private previousSignaturesByToolId = new Map<string, string>();
  private readonly toolsById = new Map<string, ToolRecord>();
  private readonly resultsByToolId = new Map<string, ToolResultSnapshot>();
  private readonly baseRenderersByTool = new Map<StepGroupToolName, StepGroupBaseRenderer>();
  private readonly unwrappedTools = new Set<StepGroupToolName>();
  private readonly groupExpandedByAnchorId = new Map<string, boolean>();
  private readonly lastHostExpandedByAnchorId = new Map<string, boolean>();
  private readonly expandedStepIds = new Set<string>();

  constructor(private readonly paddingSource: OutputPaddingSource = outputPaddingController) {}

  markToolUnwrapped(toolName: StepGroupToolName): void {
    this.unwrappedTools.add(toolName);
    this.baseRenderersByTool.delete(toolName);
  }

  clear(): void {
    this.entries = [];
    this.streamingAssistant = undefined;
    this.nextMessageSeq = 1;
    this.placementsByToolId.clear();
    this.previousSignaturesByToolId.clear();
    this.toolsById.clear();
    this.resultsByToolId.clear();
    this.groupExpandedByAnchorId.clear();
    this.lastHostExpandedByAnchorId.clear();
    this.expandedStepIds.clear();
  }

  resetFromBranch(branchEntries: readonly unknown[]): void {
    this.entries = [];
    this.streamingAssistant = undefined;
    this.resultsByToolId.clear();
    this.groupExpandedByAnchorId.clear();
    this.lastHostExpandedByAnchorId.clear();
    this.expandedStepIds.clear();

    const activeBranchToolIds = new Set<string>();

    for (const rawEntry of branchEntries) {
      if (!isRecord(rawEntry) || rawEntry.type !== "message" || !isRecord(rawEntry.message)) {
        continue;
      }
      const message = rawEntry.message;
      const entryId =
        typeof rawEntry.id === "string" ? rawEntry.id : `branch-${this.nextMessageSeq++}`;
      if (message.role === "user") {
        this.entries.push({ kind: "user" });
        continue;
      }
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (isToolCallContent(block)) {
            activeBranchToolIds.add(block.id);
          }
        }
        this.entries.push({
          kind: "assistant",
          id: entryId,
          content: message.content,
          stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
        });
        continue;
      }
      if (message.role === "toolResult" && typeof message.toolCallId === "string") {
        activeBranchToolIds.add(message.toolCallId);
        const content = Array.isArray(message.content) ? message.content : [];
        const isError = message.isError === true;
        const snapshot: ToolResultSnapshot = {
          result: {
            content: content as AgentToolResult<unknown>["content"],
            details: message.details,
          },
          isPartial: false,
          isError,
        };
        this.resultsByToolId.set(message.toolCallId, snapshot);
        const record = this.toolsById.get(message.toolCallId);
        if (record) {
          record.resultSnapshot = snapshot;
        }
      }
    }

    if (this.entries.length > 0 && this.entries.at(-1)?.kind !== "settle") {
      this.entries.push({ kind: "settle" });
    }

    this.reconcileAndInvalidate();

    if (branchEntries.length === 0) {
      this.toolsById.clear();
      this.previousSignaturesByToolId.clear();
    } else {
      for (const toolCallId of this.toolsById.keys()) {
        if (!activeBranchToolIds.has(toolCallId)) {
          this.toolsById.delete(toolCallId);
          this.previousSignaturesByToolId.delete(toolCallId);
        }
      }
    }
  }

  handleMessageStart(message: unknown): void {
    if (!isRecord(message)) return;
    if (message.role === "user") {
      if (this.streamingAssistant) {
        this.entries.push(this.streamingAssistant);
        this.streamingAssistant = undefined;
      }
      this.entries.push({ kind: "user" });
      this.reconcileAndInvalidate();
      return;
    }
    if (message.role === "assistant") {
      if (this.streamingAssistant) {
        this.entries.push(this.streamingAssistant);
      }
      this.streamingAssistant = {
        kind: "assistant",
        id: `live-${this.nextMessageSeq++}`,
        content: Array.isArray(message.content) ? message.content : [],
        stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
      };
      this.reconcileAndInvalidate();
    }
  }

  handleMessageUpdate(message: unknown): void {
    if (!isRecord(message) || message.role !== "assistant") return;
    const content = Array.isArray(message.content) ? message.content : [];
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    if (!this.streamingAssistant) {
      this.streamingAssistant = {
        kind: "assistant",
        id: `live-${this.nextMessageSeq++}`,
        content,
        stopReason,
      };
    } else {
      this.streamingAssistant.content = content;
      this.streamingAssistant.stopReason = stopReason;
    }
    this.reconcileAndInvalidate();
  }

  handleMessageEnd(message: unknown): void {
    if (!isRecord(message)) return;
    if (message.role === "user") {
      return;
    }
    if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
      if (this.streamingAssistant) {
        this.streamingAssistant.content = content;
        this.streamingAssistant.stopReason = stopReason;
        this.entries.push(this.streamingAssistant);
        this.streamingAssistant = undefined;
      } else {
        this.entries.push({
          kind: "assistant",
          id: `live-${this.nextMessageSeq++}`,
          content,
          stopReason,
        });
      }
      this.reconcileAndInvalidate();
    }
  }

  handleAgentEnd(): void {
    if (this.streamingAssistant) {
      this.entries.push(this.streamingAssistant);
      this.streamingAssistant = undefined;
    }
    if (this.entries.length > 0 && this.entries.at(-1)?.kind !== "settle") {
      this.entries.push({ kind: "settle" });
    }
    this.reconcileAndInvalidate();
  }

  recordToolResult(
    toolCallId: string,
    result: AgentToolResult<unknown>,
    isPartial: boolean,
    isError: boolean,
  ): void {
    const prevHadImage = hasImageContent(this.resultsByToolId.get(toolCallId)?.result);
    const nextHasImage = hasImageContent(result);
    const snapshot: ToolResultSnapshot = { result, isPartial, isError };
    this.resultsByToolId.set(toolCallId, snapshot);
    const record = this.toolsById.get(toolCallId);
    if (record) {
      record.resultSnapshot = snapshot;
    }

    if (prevHadImage !== nextHasImage) {
      this.reconcileAndInvalidate();
      return;
    }

    const placement = this.placementsByToolId.get(toolCallId);
    if (
      placement?.isFolded &&
      this.groupExpandedByAnchorId.get(placement.anchorToolCallId) === true
    ) {
      this.toolsById.get(placement.anchorToolCallId)?.callContext?.invalidate();
    }
  }

  wrapRenderer(toolName: StepGroupToolName, base: StepGroupBaseRenderer): ToolRenderers {
    this.unwrappedTools.delete(toolName);
    this.baseRenderersByTool.set(toolName, base);

    return {
      renderShell: "self",
      renderCall: (args, theme, context) =>
        this.renderToolCall(toolName, base, toArgsRecord(args), theme, context),
      renderResult: (result, options, theme, context) =>
        this.renderToolResult(toolName, base, result, options, theme, context),
    };
  }

  private canIncludeToolInGroup(toolCallId: string, toolName: StepGroupToolName): boolean {
    if (this.unwrappedTools.has(toolName)) return false;
    if (this.baseRenderersByTool.size > 0 && !this.baseRenderersByTool.has(toolName)) {
      const record = this.toolsById.get(toolCallId);
      if (!record) return false;
    }
    const snapshot =
      this.resultsByToolId.get(toolCallId) ?? this.toolsById.get(toolCallId)?.resultSnapshot;
    if (hasImageContent(snapshot?.result)) return false;
    return true;
  }

  private ensureToolRecord(
    toolCallId: string,
    toolName: StepGroupToolName,
    base: StepGroupBaseRenderer,
  ): ToolRecord {
    let record = this.toolsById.get(toolCallId);
    if (!record) {
      record = {
        toolCallId,
        toolName,
        baseRenderer: base,
        args: {},
        theme: undefined,
        callContext: undefined,
        resultContext: undefined,
        resultSnapshot: this.resultsByToolId.get(toolCallId),
        baseCallComponent: undefined,
        baseResultComponent: undefined,
        stepCallComponent: undefined,
        stepResultComponent: undefined,
        stepState: {},
      };
      this.toolsById.set(toolCallId, record);
    } else {
      record.toolName = toolName;
      record.baseRenderer = base;
    }
    return record;
  }

  private renderToolCall(
    toolName: StepGroupToolName,
    base: StepGroupBaseRenderer,
    args: Record<string, unknown>,
    theme: Theme,
    context: StepGroupToolRenderContext,
  ): Component {
    const record = this.ensureToolRecord(context.toolCallId, toolName, base);
    record.args = args;
    record.theme = theme;
    record.callContext = context;
    this.paddingSource.track(context.toolCallId, context.invalidate);

    const placement = this.placementsByToolId.get(context.toolCallId);
    if (placement?.isFolded) {
      if (!placement.isAnchor) {
        return emptyStepGroupComponent();
      }
      this.syncHostExpansion(placement.anchorToolCallId, placement.segment, context.expanded);
      return this.createAnchorGroupComponent(placement.anchorToolCallId, record, theme);
    }

    record.baseCallComponent = safeRenderCall(base, args, theme, {
      ...context,
      lastComponent: record.baseCallComponent,
    });
    if (record.resultSnapshot && !record.baseResultComponent) {
      record.baseResultComponent = safeRenderResult(
        base,
        record.resultSnapshot.result,
        { expanded: context.expanded, isPartial: record.resultSnapshot.isPartial },
        theme,
        {
          ...(record.resultContext ?? context),
          args,
          isError: record.resultSnapshot.isError,
          expanded: context.expanded,
          lastComponent: record.baseResultComponent,
        },
      );
    }

    return createUnsettledToolStepComponent({
      getLeadingThoughts: () => this.getUnsettledThoughts(context.toolCallId, "leading"),
      getTrailingThoughts: () => this.getUnsettledThoughts(context.toolCallId, "trailing"),
      renderToolLines: (width) => {
        const lines: string[] = [];
        if (record.baseCallComponent) {
          lines.push(...record.baseCallComponent.render(width));
        }
        if (record.baseResultComponent) {
          lines.push(...record.baseResultComponent.render(width));
        }
        return lines;
      },
      onToggleThought: (thoughtId) => {
        this.toggleStepExpanded(thoughtId);
        record.callContext?.invalidate();
      },
      theme,
      getOutputPad: () => this.paddingSource.getOutputPad(),
    });
  }

  private renderToolResult(
    toolName: StepGroupToolName,
    base: StepGroupBaseRenderer,
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: StepGroupToolRenderContext,
  ): Component {
    const record = this.ensureToolRecord(context.toolCallId, toolName, base);
    record.args = toArgsRecord(context.args);
    record.theme = theme;
    record.resultContext = context;
    const prevHadImage = hasImageContent(record.resultSnapshot?.result);
    const nextHasImage = hasImageContent(result);
    const snapshot: ToolResultSnapshot = {
      result,
      isPartial: options.isPartial,
      isError: context.isError,
    };
    record.resultSnapshot = snapshot;
    this.resultsByToolId.set(context.toolCallId, snapshot);

    if (prevHadImage !== nextHasImage) {
      this.reconcileAndInvalidate();
    }

    const placement = this.placementsByToolId.get(context.toolCallId);
    if (placement?.isFolded) {
      if (
        !placement.isAnchor &&
        this.groupExpandedByAnchorId.get(placement.anchorToolCallId) === true
      ) {
        this.toolsById.get(placement.anchorToolCallId)?.callContext?.invalidate();
      }
      return emptyStepGroupComponent();
    }

    record.baseResultComponent = safeRenderResult(base, result, options, theme, {
      ...context,
      lastComponent: record.baseResultComponent,
    });

    return emptyStepGroupComponent();
  }

  private syncHostExpansion(
    anchorId: string,
    segment: DerivedSegment,
    hostExpanded: boolean,
  ): void {
    const previous = this.lastHostExpandedByAnchorId.get(anchorId);
    if (previous === undefined) {
      this.lastHostExpandedByAnchorId.set(anchorId, hostExpanded);
      if (hostExpanded && !this.groupExpandedByAnchorId.has(anchorId)) {
        this.groupExpandedByAnchorId.set(anchorId, true);
      }
      return;
    }
    if (previous !== hostExpanded) {
      this.lastHostExpandedByAnchorId.set(anchorId, hostExpanded);
      this.groupExpandedByAnchorId.set(anchorId, hostExpanded);
      if (!hostExpanded) {
        for (const step of segment.steps) {
          this.expandedStepIds.delete(step.id);
        }
      }
    }
  }

  private createAnchorGroupComponent(
    anchorId: string,
    anchorRecord: ToolRecord,
    theme: Theme,
  ): Component {
    return createSettledStepGroupComponent({
      getGroupExpanded: () => this.groupExpandedByAnchorId.get(anchorId) ?? false,
      onToggleGroup: () => {
        const next = !(this.groupExpandedByAnchorId.get(anchorId) ?? false);
        this.groupExpandedByAnchorId.set(anchorId, next);
        if (!next) {
          const placement = this.placementsByToolId.get(anchorId);
          if (placement) {
            for (const step of placement.segment.steps) {
              this.expandedStepIds.delete(step.id);
            }
          }
        }
        anchorRecord.callContext?.invalidate();
      },
      getSteps: () => {
        const placement = this.placementsByToolId.get(anchorId);
        if (!placement) return [];
        return this.buildRenderableSteps(placement.segment, anchorRecord, theme);
      },
      onToggleStep: (stepId) => {
        this.toggleStepExpanded(stepId);
        anchorRecord.callContext?.invalidate();
      },
      theme,
      getOutputPad: () => this.paddingSource.getOutputPad(),
    });
  }

  private buildRenderableSteps(
    segment: DerivedSegment,
    anchorRecord: ToolRecord,
    fallbackTheme: Theme,
  ): RenderableStepGroupItem[] {
    const fallbackCwd = anchorRecord.callContext?.cwd ?? process.cwd();

    return segment.steps.map((step): RenderableStepGroupItem => {
      const expanded = this.expandedStepIds.has(step.id);
      if (step.kind === "thought") {
        return {
          kind: "thought",
          id: step.id,
          text: step.text,
          expanded,
        };
      }
      return {
        kind: "tool",
        id: step.id,
        toolName: step.toolName,
        expanded,
        renderLines: (width, stepExpanded) =>
          this.renderChildToolLines(
            step,
            anchorRecord,
            width,
            stepExpanded,
            fallbackTheme,
            fallbackCwd,
          ),
      };
    });
  }

  private renderChildToolLines(
    step: DerivedToolStep,
    anchorRecord: ToolRecord,
    width: number,
    stepExpanded: boolean,
    fallbackTheme: Theme,
    fallbackCwd: string,
  ): string[] {
    const existingRecord = this.toolsById.get(step.id);
    const baseRenderer =
      existingRecord?.baseRenderer ?? this.baseRenderersByTool.get(step.toolName);
    if (!baseRenderer) return [];

    const record = this.ensureToolRecord(step.id, step.toolName, baseRenderer);
    const args = Object.keys(record.args).length > 0 ? record.args : toArgsRecord(step.args);
    const theme = record.theme ?? fallbackTheme;
    const snapshot = record.resultSnapshot ?? this.resultsByToolId.get(step.id);
    const isError = record.callContext?.isError ?? snapshot?.isError ?? false;
    const invalidate = () => {
      anchorRecord.callContext?.invalidate();
    };

    const callContext: StepGroupToolRenderContext = {
      ...(record.callContext ?? {}),
      args,
      toolCallId: step.id,
      invalidate,
      lastComponent: record.stepCallComponent,
      state: record.stepState,
      cwd: record.callContext?.cwd ?? fallbackCwd,
      executionStarted: record.callContext?.executionStarted ?? snapshot !== undefined,
      argsComplete: record.callContext?.argsComplete ?? true,
      isError,
      expanded: stepExpanded,
      showImages: record.callContext?.showImages ?? false,
    };

    const callComp = safeRenderCall(baseRenderer, args, theme, callContext);
    record.stepCallComponent = callComp;

    let resultComp: Component | undefined;
    if (snapshot && baseRenderer.renderResult) {
      const resultContext: StepGroupToolRenderContext = {
        ...(record.resultContext ?? callContext),
        args,
        toolCallId: step.id,
        invalidate,
        state: record.stepState,
        cwd: record.callContext?.cwd ?? fallbackCwd,
        executionStarted: true,
        argsComplete: true,
        isError,
        expanded: stepExpanded,
        showImages: record.callContext?.showImages ?? false,
        lastComponent: record.stepResultComponent,
      };
      resultComp = safeRenderResult(
        baseRenderer,
        snapshot.result,
        { expanded: stepExpanded, isPartial: snapshot.isPartial },
        theme,
        resultContext,
      );
      record.stepResultComponent = resultComp;
    }

    const lines: string[] = [];
    if (callComp) {
      lines.push(...callComp.render(width));
    }
    if (resultComp) {
      lines.push(...resultComp.render(width));
    }
    return lines;
  }

  private getUnsettledThoughts(
    toolCallId: string,
    position: "leading" | "trailing",
  ): UnsettledThoughtItem[] {
    const placement = this.placementsByToolId.get(toolCallId);
    if (!placement || placement.isFolded) return [];
    const thoughts =
      position === "leading" ? placement.leadingThoughts : placement.trailingThoughts;
    return thoughts.map((thought) => ({
      id: thought.id,
      text: thought.text,
      expanded: this.expandedStepIds.has(thought.id),
    }));
  }

  private toggleStepExpanded(stepId: string): void {
    if (this.expandedStepIds.has(stepId)) {
      this.expandedStepIds.delete(stepId);
    } else {
      this.expandedStepIds.add(stepId);
    }
  }

  private computeSignature(toolCallId: string): string {
    const placement = this.placementsByToolId.get(toolCallId);
    if (!placement) return "unplaced";
    if (placement.isFolded) {
      if (!placement.isAnchor) {
        return `absorbed:${placement.anchorToolCallId}`;
      }
      const stepParts = placement.segment.steps.map((step) => {
        const expanded = this.expandedStepIds.has(step.id);
        if (step.kind === "thought") {
          return expanded ? `T:${step.id}:1:${step.text}` : `T:${step.id}:0`;
        }
        return `C:${step.id}:${step.toolName}:${expanded ? 1 : 0}`;
      });
      return `anchor:${placement.anchorToolCallId}:${stepParts.join("|")}`;
    }

    const leadingParts = placement.leadingThoughts.map((t) =>
      this.expandedStepIds.has(t.id) ? `${t.id}:${t.text}` : t.id,
    );
    const trailingParts = placement.trailingThoughts.map((t) =>
      this.expandedStepIds.has(t.id) ? `${t.id}:${t.text}` : t.id,
    );
    return `unsettled:L(${leadingParts.join(",")})T(${trailingParts.join(",")})`;
  }

  private reconcileAndInvalidate(): void {
    const segments = deriveSegments(this.entries, this.streamingAssistant, (toolCallId, toolName) =>
      this.canIncludeToolInGroup(toolCallId, toolName),
    );
    this.placementsByToolId = buildPlacements(segments);

    const candidateIds = new Set<string>([
      ...this.previousSignaturesByToolId.keys(),
      ...this.placementsByToolId.keys(),
      ...this.toolsById.keys(),
    ]);

    const nextSignatures = new Map<string, string>();
    const toInvalidate: ToolRecord[] = [];

    for (const toolCallId of candidateIds) {
      const nextSig = this.computeSignature(toolCallId);
      nextSignatures.set(toolCallId, nextSig);
      const prevSig = this.previousSignaturesByToolId.get(toolCallId);
      if (prevSig !== nextSig) {
        const record = this.toolsById.get(toolCallId);
        if (record) {
          toInvalidate.push(record);
        }
      }
    }

    this.previousSignaturesByToolId = nextSignatures;
    for (const record of toInvalidate) {
      record.callContext?.invalidate();
    }
  }
}

function syncControllerFromSession(
  controller: StepGroupFoldController,
  ctx: ExtensionContext,
): void {
  if (!isInteractiveTui(ctx)) return;
  ctx.ui.setHiddenThinkingLabel?.("");
  const branchEntries = ctx.sessionManager?.getBranch?.() ?? [];
  controller.resetFromBranch(branchEntries);
}

export function registerStepGroupFold(
  pi: ExtensionAPI,
  controller: StepGroupFoldController = new StepGroupFoldController(),
): StepGroupFoldController {
  pi.registerToolRenderer?.((toolName, next) => {
    const base = next();
    if (!isStepGroupToolName(toolName)) return base;
    if (base?.renderShell !== "self" || !base.renderCall) {
      controller.markToolUnwrapped(toolName);
      return base;
    }
    return controller.wrapRenderer(toolName, base);
  });

  pi.on("session_start", (_event, ctx) => {
    syncControllerFromSession(controller, ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    syncControllerFromSession(controller, ctx);
  });

  pi.on("session_shutdown", () => {
    controller.clear();
  });

  pi.on("agent_end", () => {
    controller.handleAgentEnd();
  });

  pi.on("message_start", (event) => {
    if (isRecord(event)) {
      controller.handleMessageStart(event.message);
    }
  });

  pi.on("message_update", (event) => {
    if (isRecord(event)) {
      controller.handleMessageUpdate(event.message);
    }
  });

  pi.on("message_end", (event) => {
    if (isRecord(event)) {
      controller.handleMessageEnd(event.message);
    }
  });

  pi.on("tool_execution_update", (event) => {
    if (
      isRecord(event) &&
      typeof event.toolCallId === "string" &&
      isRecord(event.partialResult) &&
      Array.isArray(event.partialResult.content)
    ) {
      controller.recordToolResult(
        event.toolCallId,
        {
          content: event.partialResult.content as AgentToolResult<unknown>["content"],
          details: event.partialResult.details,
        },
        true,
        false,
      );
    }
  });

  pi.on("tool_execution_end", (event) => {
    if (
      isRecord(event) &&
      typeof event.toolCallId === "string" &&
      isRecord(event.result) &&
      Array.isArray(event.result.content)
    ) {
      controller.recordToolResult(
        event.toolCallId,
        {
          content: event.result.content as AgentToolResult<unknown>["content"],
          details: event.result.details,
        },
        false,
        event.isError === true,
      );
    }
  });

  return controller;
}
