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
  lastSource?: TokenRateSource;
  /** Latest positive `usage.output`; once seen, the source never downgrades. */
  reportedOutput?: number;
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

    // MessageUpdateEvent.message is the AgentMessage union; only assistant
    // messages carry usage.
    const reported = event.message.role === "assistant" ? event.message.usage?.output : undefined;
    // Estimation is only a fallback. Once real cumulative usage is available,
    // walking every subsequent text delta provides no value.
    if (state.reportedOutput === undefined && !(reported !== undefined && reported > 0)) {
      state.accumulatedTokens += estimateTokensFromChars(deltaText(event.assistantMessageEvent));
    }
    let tokens: number;
    let source: TokenRateSource;
    if (reported !== undefined && reported > 0) {
      // usage.output is cumulative and should be monotonic, but guard against
      // providers that report a re-computed lower value (it would otherwise
      // break the token monotonicity the window rate relies on).
      state.reportedOutput = Math.max(state.reportedOutput ?? 0, reported);
      tokens = state.reportedOutput;
      source = "reported";
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
    // Whole-segment decode mean: cumulative tokens over the time since the
    // first content token (prefill excluded). The measurement domain is
    // scoped per streaming segment by the lifecycle resets in
    // working-token-rate.ts, so the mean stays short-lived and fresh. A
    // source flip (estimated -> reported) merely steps the numerator to the
    // corrected count - the mean self-corrects, no re-baselining needed.
    const tokensPerSecond = Math.round((tokens * 1000) / elapsedMs);
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
