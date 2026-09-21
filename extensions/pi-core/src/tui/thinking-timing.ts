/**
 * thinking-timing - per-run thinking duration side-channel.
 *
 * Pi ThinkingContent has no duration. Derive glance meta from
 * `thinking_start` / `thinking_delta` / stream boundaries. Memory-only:
 * resume/compact lookups miss → unknown duration (`Thought`).
 */

export interface ThinkingTimingSnapshot {
  durationMs?: number;
  status: "settled" | "failed" | "interrupted";
}

export interface ThinkingTimingTracker {
  bindMessageKey(messageKey: string): void;
  onMessageStart(): void;
  onMessageUpdate(assistantMessageEvent: unknown, now: number): void;
  onMessageEnd(stopReason: string | undefined, now: number): void;
  lookup(messageKey: string, runIndex: number): ThinkingTimingSnapshot | undefined;
}

interface AssistantEventLike {
  type?: string;
  contentIndex?: number;
}

export function createThinkingTimingTracker(): ThinkingTimingTracker {
  let messageKey = "";
  /** Next thinking-run index in the current assistant message. */
  let nextRunIndex = 0;
  const openRuns = new Map<number, number>();
  const stored = new Map<string, ThinkingTimingSnapshot>();

  const closeRun = (index: number, status: ThinkingTimingSnapshot["status"], now: number): void => {
    const startedAt = openRuns.get(index);
    if (startedAt === undefined) return;
    openRuns.delete(index);
    if (!messageKey) return;
    stored.set(`${messageKey}#${index}`, {
      durationMs: Math.max(0, now - startedAt),
      status,
    });
  };

  return {
    bindMessageKey(key: string): void {
      messageKey = key;
    },
    onMessageStart(): void {
      nextRunIndex = 0;
      openRuns.clear();
    },
    onMessageUpdate(assistantMessageEvent: unknown, now: number): void {
      const event = assistantMessageEvent as AssistantEventLike | undefined;
      const type = event?.type;
      if (type === "thinking_start") {
        const index = nextRunIndex++;
        openRuns.set(index, now);
        return;
      }
      if (type === "thinking_delta") {
        if (openRuns.size === 0) openRuns.set(nextRunIndex++, now);
        return;
      }
      if (
        type === "text_delta" ||
        type === "text_start" ||
        type === "tool_call" ||
        type === "toolCall" ||
        type === "tool_start"
      ) {
        for (const index of [...openRuns.keys()]) closeRun(index, "settled", now);
      }
    },
    onMessageEnd(stopReason: string | undefined, now: number): void {
      const status: ThinkingTimingSnapshot["status"] =
        stopReason === "aborted" ? "interrupted" : stopReason === "error" ? "failed" : "settled";
      for (const index of [...openRuns.keys()]) closeRun(index, status, now);
    },
    lookup(messageKeyArg: string, run: number): ThinkingTimingSnapshot | undefined {
      return stored.get(`${messageKeyArg}#${run}`);
    },
  };
}
