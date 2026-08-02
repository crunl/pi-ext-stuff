import type { MessageUpdateEvent } from "@earendil-works/pi-coding-agent";

export type TokenRateSource = "reported" | "estimated";

export interface TokenRateSnapshot {
  outputTokens: number;
  source: TokenRateSource;
  tokensPerSecond: number;
}

export interface TokenRateTracker {
  reset(): void;
  /** Feed one streaming update; returns a refresh-eligible snapshot or
   * `undefined` when nothing should be shown (no positive tokens yet, zero
   * elapsed time, or inside the throttle window). */
  update(event: MessageUpdateEvent, now: number): TokenRateSnapshot | undefined;
}

const DEFAULT_THROTTLE_MS = 100;

interface TrackerState {
  /** Incremental character count from text/thinking/toolcall deltas. */
  accumulatedChars: number;
  /** Time of the first sample with positive tokens; the rate baseline. */
  firstTokenAt?: number;
  /** Last time a snapshot was allowed to refresh the display. */
  lastShownAt?: number;
  lastSource?: TokenRateSource;
  /** Latest positive `usage.output`; once seen, the source never downgrades. */
  reportedOutput?: number;
}

function deltaChars(event: MessageUpdateEvent["assistantMessageEvent"]): number {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return event.delta.length;
    default:
      return 0;
  }
}

export function createTokenRateTracker(throttleMs = DEFAULT_THROTTLE_MS): TokenRateTracker {
  let state: TrackerState | undefined;

  const reset = (): void => {
    state = undefined;
  };

  const update = (event: MessageUpdateEvent, now: number): TokenRateSnapshot | undefined => {
    state ??= { accumulatedChars: 0 };
    state.accumulatedChars += deltaChars(event.assistantMessageEvent);

    // MessageUpdateEvent.message is the AgentMessage union; only assistant
    // messages carry usage.
    const reported = event.message.role === "assistant" ? event.message.usage?.output : undefined;
    let tokens: number;
    let source: TokenRateSource;
    if (reported !== undefined && reported > 0) {
      tokens = reported;
      source = "reported";
      state.reportedOutput = reported;
    } else if (state.reportedOutput !== undefined) {
      tokens = state.reportedOutput;
      source = "reported";
    } else {
      tokens = Math.ceil(state.accumulatedChars / 4);
      source = "estimated";
    }
    if (tokens <= 0) return undefined;

    state.firstTokenAt ??= now;
    const elapsedMs = now - state.firstTokenAt;
    if (elapsedMs <= 0) return undefined;

    const sourceChanged = state.lastSource !== undefined && state.lastSource !== source;
    if (state.lastShownAt !== undefined && !sourceChanged && now - state.lastShownAt < throttleMs) {
      return undefined;
    }
    state.lastShownAt = now;
    state.lastSource = source;
    return {
      outputTokens: tokens,
      source,
      tokensPerSecond: Math.round((tokens * 1000) / elapsedMs),
    };
  };

  return { reset, update };
}
