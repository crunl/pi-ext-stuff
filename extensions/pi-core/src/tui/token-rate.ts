import type { MessageEndEvent, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";

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
   * elapsed time, below the first-display warm-up, or inside the throttle
   * window). */
  update(event: MessageUpdateEvent, now: number): TokenRateSnapshot | undefined;
  /** Feed the final message of a stream (pi's `message_end` carries the
   * request's real usage, which `message_update` never does). Recomputes the
   * rate from the true token count and always refreshes the display. */
  finalize(message: MessageEndEvent["message"], now: number): TokenRateSnapshot | undefined;
}

const DEFAULT_THROTTLE_MS = 100;
/** Minimum elapsed decode time before the first rate is shown. The rate is a
 * small-sample estimate at stream start (large first deltas over a tiny
 * elapsed span read as a spike); waiting one second gives it statistical
 * meaning while the previous rate stays on the working line. */
const FIRST_SHOWN_MS = 1_000;

interface TrackerState {
  /** Incremental estimated token count from text/thinking/toolcall deltas. */
  accumulatedTokens: number;
  /** Time of the first sample with positive tokens - the decode baseline.
   * Anchoring at the first content token (not the request start) excludes
   * the prefill/TTFT phase from the denominator, so the rate measures pure
   * decode throughput - the same semantics as `completion_tokens /
   * (model_elapsed - ttft_ms)` in grok-build's telemetry. */
  firstTokenAt?: number;
  /** Last time a snapshot was allowed to refresh the display. */
  lastShownAt?: number;
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
const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/;

/**
 * CJK unified ideographs extension B-G (supplementary planes) count as one
 * token each; `for...of` iterates code points, so a surrogate pair is seen
 * as a single character here.
 */
const isCjkSupplementary = (ch: string): boolean => {
  const cp = ch.codePointAt(0);
  return cp !== undefined && cp >= 0x20000 && cp <= 0x3ffff;
};

export function estimateTokensFromChars(chars: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of chars) {
    if (isCjkSupplementary(ch) || CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

export function createTokenRateTracker(throttleMs = DEFAULT_THROTTLE_MS): TokenRateTracker {
  let state: TrackerState | undefined;

  const reset = (): void => {
    state = undefined;
  };

  const update = (event: MessageUpdateEvent, now: number): TokenRateSnapshot | undefined => {
    state ??= { accumulatedTokens: 0 };
    state.accumulatedTokens += estimateTokensFromChars(deltaText(event.assistantMessageEvent));
    if (state.accumulatedTokens <= 0) return undefined;

    state.firstTokenAt ??= now;
    const elapsedMs = now - state.firstTokenAt;
    if (elapsedMs <= 0) return undefined;
    // First display waits for a statistically meaningful span; later
    // refreshes are throttled.
    if (state.lastShownAt === undefined && elapsedMs < FIRST_SHOWN_MS) return undefined;
    if (state.lastShownAt !== undefined && now - state.lastShownAt < throttleMs) return undefined;

    // Whole-segment decode mean of the estimate. The measurement domain is
    // scoped per streaming segment by the lifecycle resets in
    // working-token-rate.ts, so the mean stays short-lived and fresh.
    const tokensPerSecond = Math.round((state.accumulatedTokens * 1000) / elapsedMs);
    state.lastShownAt = now;
    return {
      outputTokens: state.accumulatedTokens,
      source: "estimated",
      tokensPerSecond,
    };
  };

  const finalize = (
    message: MessageEndEvent["message"],
    now: number,
  ): TokenRateSnapshot | undefined => {
    if (state === undefined) return undefined;
    const output = message.role === "assistant" ? message.usage?.output : undefined;
    if (output === undefined || output <= 0 || state.firstTokenAt === undefined) return undefined;
    const elapsedMs = now - state.firstTokenAt;
    if (elapsedMs <= 0) return undefined;
    // Real usage replaces the estimate: the exact grok-build formula
    // (completion_tokens / decode time). Always refreshes, bypassing the
    // throttle - this is the final true value for the segment.
    const tokensPerSecond = Math.round((output * 1000) / elapsedMs);
    state.lastShownAt = now;
    return {
      outputTokens: output,
      source: "reported",
      tokensPerSecond,
    };
  };

  return { reset, update, finalize };
}
