/**
 * thinking-glance - MiniMax-style thinking rows in the assistant transcript.
 *
 * Host `AssistantMessageComponent` hides thinking as a single global
 * `hiddenThinkingLabel` ("Thinking..."). pi-core patches `updateContent` so
 * each hidden thinking run renders its own glance (no `▶` — expand chevron
 * is bash-header only):
 *
 *   └ Thinking…
 *   └ Thought for 1.4s
 *
 * Tree rail is intentional product chrome. Duration comes from
 * thinking-timing (memory-only; unknown → `Thought`). Expand stays
 * host-owned: click / `app.thinking.toggle` (ctrl+t).
 */
import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import { createThinkingTimingTracker, type ThinkingTimingTracker } from "./thinking-timing.ts";

export const THINKING_GLANCE_TREE = "└ ";
/** Bash header keeps host-driven expand chevron; thinking glance does not. */
export const THINKING_GLANCE_CHEVRON = "";

interface AssistantMessageLike {
  role?: string;
  content?: Array<{ type: string; text?: string; thinking?: string }>;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: string | number;
  responseId?: string;
}

type ThemeLike = {
  italic: (text: string) => string;
  fg: (color: string, text: string) => string;
};

type MarkdownThemeLike = ConstructorParameters<typeof Markdown>[3];

interface ThinkingRunState {
  durationMs?: number;
  status: "open" | "settled" | "failed" | "interrupted" | "unknown";
}

function resolvePiTheme(): ThemeLike | undefined {
  const key = Symbol.for("@earendil-works/pi-coding-agent:theme");
  const t = (globalThis as Record<symbol, unknown>)[key] as ThemeLike | undefined;
  if (t && typeof t.fg === "function" && typeof t.italic === "function") return t;
  return undefined;
}

export function formatThinkingGlance(state: ThinkingRunState): string {
  const chevron = THINKING_GLANCE_CHEVRON;
  if (state.status === "open") return `${THINKING_GLANCE_TREE}Thinking…${chevron}`;
  const duration =
    typeof state.durationMs === "number" ? ` for ${(state.durationMs / 1000).toFixed(1)}s` : "";
  if (state.status === "failed") {
    return `${THINKING_GLANCE_TREE}Thought${duration} · failed${chevron}`;
  }
  if (state.status === "interrupted") {
    return `${THINKING_GLANCE_TREE}Thought${duration} · interrupted${chevron}`;
  }
  return `${THINKING_GLANCE_TREE}Thought${duration}${chevron}`;
}

/** Stable per-message key for the timing side-channel (not display text). */
export function thinkingMessageKey(message: AssistantMessageLike): string {
  return `${message.timestamp ?? ""}|${message.responseId ?? ""}`;
}

interface ComponentInternals {
  hideThinkingBlock: boolean;
  markdownTheme: MarkdownThemeLike;
  hiddenThinkingLabel: string;
  outputPad: number;
  markdownTransformers: unknown;
  lastMessage?: AssistantMessageLike;
  isStreaming: boolean;
  thinkingVisibilityOverrides: Map<number, boolean>;
  contentContainer: { clear(): void; addChild(c: unknown): void };
  hasToolCalls?: boolean;
}

type UpdateContent = (message: AssistantMessageLike, isStreaming?: boolean) => void;

interface PatchCarrier {
  updateContent: UpdateContent;
  __thinkingGlanceOriginal?: UpdateContent;
  __thinkingGlanceTracker?: ThinkingTimingTracker;
}

let glanceTracker: ThinkingTimingTracker | undefined;

export function getThinkingTimingTracker(): ThinkingTimingTracker | undefined {
  return glanceTracker;
}

export function setThinkingTimingTracker(tracker: ThinkingTimingTracker | undefined): void {
  glanceTracker = tracker;
}

function glanceForRun(
  message: AssistantMessageLike,
  runIndex: number,
  isStreaming: boolean,
): string {
  const snap = glanceTracker?.lookup(thinkingMessageKey(message), runIndex);
  if (snap) return formatThinkingGlance({ durationMs: snap.durationMs, status: snap.status });
  if (isStreaming) return formatThinkingGlance({ status: "open" });
  if (message.stopReason === "aborted") return formatThinkingGlance({ status: "interrupted" });
  if (message.stopReason === "error") return formatThinkingGlance({ status: "failed" });
  return formatThinkingGlance({ status: "unknown" });
}

export function applyThinkingGlance(tracker: ThinkingTimingTracker): void {
  setThinkingTimingTracker(tracker);
  const proto = AssistantMessageComponent.prototype as unknown as PatchCarrier;
  if (typeof proto.updateContent !== "function") return;

  const original = proto.__thinkingGlanceOriginal ?? proto.updateContent;
  proto.__thinkingGlanceOriginal = original;
  proto.__thinkingGlanceTracker = tracker;

  proto.updateContent = function (
    this: AssistantMessageComponent,
    message: AssistantMessageLike,
    isStreaming?: boolean,
  ): void {
    try {
      const self = this as unknown as ComponentInternals;
      const streaming = isStreaming ?? self.isStreaming ?? false;
      const hostTheme = resolvePiTheme();
      const paintError = (text: string) => (hostTheme ? hostTheme.fg("error", text) : text);

      self.lastMessage = message;
      self.isStreaming = streaming;
      self.contentContainer.clear();

      const contents = message.content ?? [];
      const hasVisibleContent = contents.some(
        (c) =>
          (c.type === "text" && typeof c.text === "string" && c.text.trim()) ||
          (c.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim()),
      );
      if (hasVisibleContent) self.contentContainer.addChild(new Spacer(1));

      let thinkingRunIndex = 0;
      for (let i = 0; i < contents.length; i++) {
        const content = contents[i];
        if (!content) continue;
        if (content.type === "text" && typeof content.text === "string" && content.text.trim()) {
          self.contentContainer.addChild(
            new Markdown(
              content.text.trim(),
              self.outputPad,
              0,
              self.markdownTheme,
              undefined,
              undefined,
            ),
          );
          continue;
        }
        if (content.type !== "thinking") continue;

        const thinkingBlocks: string[] = [];
        for (; i < contents.length; i++) {
          const block = contents[i];
          if (block?.type !== "thinking") break;
          const text = typeof block.thinking === "string" ? block.thinking.trim() : "";
          if (text) thinkingBlocks.push(text);
        }
        i--;
        if (thinkingBlocks.length === 0) continue;

        const hasVisibleContentAfter = contents
          .slice(i + 1)
          .some(
            (c) =>
              (c.type === "text" && typeof c.text === "string" && c.text.trim()) ||
              (c.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim()),
          );
        const runIndex = thinkingRunIndex++;
        const hidden = self.thinkingVisibilityOverrides.get(runIndex) ?? self.hideThinkingBlock;
        const label = glanceForRun(message, runIndex, streaming);
        const thinkingComponent = hidden
          ? new Text(
              hostTheme ? hostTheme.italic(hostTheme.fg("thinkingText", label)) : label,
              self.outputPad,
              0,
            )
          : new Markdown(
              thinkingBlocks.join("\n\n"),
              self.outputPad,
              0,
              self.markdownTheme,
              {
                color: (text: string) => (hostTheme ? hostTheme.fg("thinkingText", text) : text),
                italic: true,
              } as never,
              undefined,
            );
        self.contentContainer.addChild(
          new MouseRegion(thinkingComponent, (event) => {
            if (event.type !== "click" || event.button !== "left") return undefined;
            self.thinkingVisibilityOverrides.set(runIndex, !hidden);
            if (self.lastMessage) original.call(this, self.lastMessage);
            return { handled: true };
          }),
        );
        if (hasVisibleContentAfter) self.contentContainer.addChild(new Spacer(1));
      }

      const hasToolCalls = contents.some((c) => c.type === "toolCall");
      self.hasToolCalls = hasToolCalls;
      if (message.stopReason === "length") {
        self.contentContainer.addChild(new Spacer(1));
        self.contentContainer.addChild(
          new Text(paintError("Response was truncated before completion."), self.outputPad, 0),
        );
      } else if (!hasToolCalls) {
        if (message.stopReason === "aborted") {
          const abortMessage =
            message.errorMessage && message.errorMessage !== "Request was aborted"
              ? message.errorMessage
              : "Operation aborted";
          self.contentContainer.addChild(new Spacer(1));
          self.contentContainer.addChild(new Text(paintError(abortMessage), self.outputPad, 0));
        } else if (message.stopReason === "error") {
          const errorMsg = message.errorMessage || "Unknown error";
          self.contentContainer.addChild(new Spacer(1));
          self.contentContainer.addChild(
            new Text(paintError(`Error: ${errorMsg}`), self.outputPad, 0),
          );
        }
      }
    } catch {
      original.call(this, message, isStreaming);
    }
  };
}

export function resetThinkingGlance(): void {
  const proto = AssistantMessageComponent.prototype as unknown as PatchCarrier;
  if (proto.__thinkingGlanceOriginal) {
    proto.updateContent = proto.__thinkingGlanceOriginal;
    proto.__thinkingGlanceOriginal = undefined;
  }
  proto.__thinkingGlanceTracker = undefined;
  setThinkingTimingTracker(undefined);
}

export function registerThinkingGlance(pi: ExtensionAPI, now: () => number = Date.now): void {
  const tracker = createThinkingTimingTracker();
  applyThinkingGlance(tracker);

  pi.on("message_start", (event) => {
    const raw = event.message as AssistantMessageLike | undefined;
    if (raw?.role !== "assistant") return;
    tracker.onMessageStart();
  });

  pi.on("message_update", (event) => {
    const raw = event.message as AssistantMessageLike | undefined;
    if (raw?.role !== "assistant") return;
    tracker.bindMessageKey(thinkingMessageKey(raw));
    tracker.onMessageUpdate(
      (event as { assistantMessageEvent?: unknown }).assistantMessageEvent,
      now(),
    );
  });

  pi.on("message_end", (event) => {
    const raw = event.message as AssistantMessageLike | undefined;
    if (raw?.role !== "assistant") return;
    tracker.bindMessageKey(thinkingMessageKey(raw));
    tracker.onMessageEnd(raw.stopReason, now());
  });
}
