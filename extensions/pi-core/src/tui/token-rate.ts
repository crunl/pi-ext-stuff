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
/** Sliding window for the rate: recent output over the last N ms. */
const DEFAULT_WINDOW_MS = 10_000;

interface RateSample {
  at: number;
  tokens: number;
}

interface TrackerState {
  /** Incremental estimated token count from text/thinking/toolcall deltas. */
  accumulatedTokens: number;
  /** Time of the first sample with positive tokens; the rate baseline. */
  firstTokenAt?: number;
  /** Last time a snapshot was allowed to refresh the display. */
  lastShownAt?: number;
  lastSource?: TokenRateSource;
  /** Latest positive `usage.output`; once seen, the source never downgrades. */
  reportedOutput?: number;
  /** Refresh points (throttled), used as the sliding-window rate baseline. */
  samples: RateSample[];
}

function deltaText(event: MessageUpdateEvent["assistantMessageEvent"]): string {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return event.delta;
    default:
      return "";
  }
}

/**
 * Approximate token count from characters. Latin text averages ~4 chars per
 * token, but CJK characters are roughly one token each; counting code units
 * blindly would under-estimate Chinese output by ~4x. The approximation is
 * only used until the provider reports real usage.
 */
const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

export function estimateTokensFromChars(chars: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of chars) {
    if (CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

export function createTokenRateTracker(
  throttleMs = DEFAULT_THROTTLE_MS,
  windowMs = DEFAULT_WINDOW_MS,
): TokenRateTracker {
  let state: TrackerState | undefined;

  const reset = (): void => {
    state = undefined;
  };

  const update = (event: MessageUpdateEvent, now: number): TokenRateSnapshot | undefined => {
    state ??= { accumulatedTokens: 0, samples: [] };
    state.accumulatedTokens += estimateTokensFromChars(deltaText(event.assistantMessageEvent));

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
      tokens = state.accumulatedTokens;
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
    // A source flip (estimated -> reported) can jump the token count by a
    // correction, which a window rate would read as a burst: re-baseline so
    // the next rate is the warm-up average again.
    if (sourceChanged) {
      state.samples.length = 0;
    }
    // Drop refresh points that fell out of the window, keeping the oldest as
    // the rate baseline. Samples are pushed only on displayed refreshes, so
    // the ring is sparse by design and bounded by windowMs / throttleMs.
    while (state.samples.length > 1) {
      const second = state.samples[1];
      if (second === undefined || now - second.at <= windowMs) break;
      state.samples.shift();
    }
    let tokensPerSecond: number;
    const base = state.samples[0];
    if (base === undefined) {
      // Warm-up: no prior refresh point yet, average since the first token.
      tokensPerSecond = Math.round((tokens * 1000) / elapsedMs);
    } else {
      // Sliding window: tokens produced since the oldest in-window refresh
      // point, over that span — reflects recent speed instead of the whole
      // run's average (which drifts down on long turns).
      const dtMs = now - base.at;
      tokensPerSecond =
        dtMs > 0
          ? Math.round(((tokens - base.tokens) * 1000) / dtMs)
          : Math.round((tokens * 1000) / elapsedMs);
    }
    state.samples.push({ at: now, tokens });
    state.lastShownAt = now;
    state.lastSource = source;
    return {
      outputTokens: tokens,
      source,
      tokensPerSecond,
    };
  };

  return { reset, update };
}
