import type {
  MessageEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";

export type TokenRateSource = "reported" | "estimated";

export interface TokenRateSnapshot {
  outputTokens: number;
  source: TokenRateSource;
  /** Decode throughput. Absent on the first-token snapshot, shown before the
   * warm-up window has given the rate enough samples to be honest. */
  tokensPerSecond?: number;
  /** Milliseconds from the request start (pi's `message.timestamp`) to the
   * first content token - Time To First Token. `undefined` when it cannot be
   * measured honestly: no `message_start` anchor for this segment (tool phase,
   * mid-turn model switch), a message without a usable timestamp, or an
   * implausible wait (anchor after the first token, or past
   * `MAX_PLAUSIBLE_TTFT_MS`). */
  timeToFirstTokenMs?: number;
}

export interface TokenRateTracker {
  reset(): void;
  /** Open a new measurement segment for a streaming assistant message.
   * `message` is pi's `message_start` payload: its `timestamp` is the moment
   * the request was issued, which is what TTFT is measured from. It must share
   * a clock domain with the `now` passed to `update`/`finalize` (both default
   * to `Date.now`). */
  begin(message: MessageStartEvent["message"]): void;
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
  /** Wall-clock ms when the request was issued (`AssistantMessage.timestamp`,
   * set by pi when the provider stream is created). Only present for segments
   * that began at a request boundary, i.e. a `message_start`. */
  requestStartAt?: number;
  /** `firstTokenAt - requestStartAt`, captured once when the decode baseline
   * is anchored. TTFT is a per-request quantity: it never changes during a
   * stream, so the display stays stable instead of drifting with a timer. */
  timeToFirstTokenMs?: number;
  /** When the TTFT-only snapshot was shown for this segment. Separate from
   * `lastShownAt` so a latency display can never satisfy the rate's warm-up. */
  latencyShownAt?: number;
}

/** pi's `AssistantMessage.timestamp` is the request start (`Date.now()` when
 * the provider stream is created). The type marks it required, but the host
 * itself re-checks it at runtime (`session-manager.getMessageActivityTime` does
 * `typeof === "number"`), because messages restored from older session files
 * can lack it. Read it the same way: only a positive, finite number counts as
 * an anchor, anything else means "unknown". */
function requestStartOf(message: MessageStartEvent["message"]): number | undefined {
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
    ? timestamp
    : undefined;
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

export type StreamHealth = "healthy" | "slow" | "stalled";

/**
 * Classify the in-flight turn's health from silence AND throughput. A sustained
 * CRAWL (a trickle of tokens) is as bad as silence — the idle stall-timeout misses
 * it because bytes keep arriving, so a turn can run ~30 min at 0.2 tok/s looking
 * "busy". `tps` is null before any tokens have streamed (still "connecting").
 *   idleMs  — ms since the last stream event of any kind
 *   burstMs — ms the current generation burst has been running
 *   tps     — live tokens/sec for this burst (null if not generating yet)
 *
 * Ported from Plicerin/freecode `src/tui/speed.ts` — thresholds proven in
 * production for the same speedometer use-case.
 */
const STALL_AFTER_IDLE_MS = 20_000;
const STALL_AFTER_BURST_MS = 30_000;
const STALL_BELOW_TPS = 2;
const SLOW_AFTER_IDLE_MS = 5_000;
const SLOW_AFTER_BURST_MS = 15_000;
const SLOW_BELOW_TPS = 5;

export function streamHealth(idleMs: number, burstMs: number, tps: number | null): StreamHealth {
  if (
    idleMs >= STALL_AFTER_IDLE_MS ||
    (tps !== null && burstMs > STALL_AFTER_BURST_MS && tps < STALL_BELOW_TPS)
  ) {
    return "stalled";
  }
  if (
    idleMs >= SLOW_AFTER_IDLE_MS ||
    (tps !== null && burstMs > SLOW_AFTER_BURST_MS && tps < SLOW_BELOW_TPS)
  ) {
    return "slow";
  }
  return "healthy";
}

/** Upper bound for a credible TTFT. `message.timestamp` is the provider
 * stream's creation time, so a value far past this means a stale anchor (a
 * reused message object, a clock jump) rather than a real wait; hiding it is
 * better than putting a wrong number on the line. */
const MAX_PLAUSIBLE_TTFT_MS = 5 * 60 * 1000;

/** TTFT is only reported once per segment - anchored when the first content
 * token arrives - and dropped when the request-start anchor is missing or
 * implausible. */
const measureTimeToFirstToken = (state: TrackerState): number | undefined => {
  if (state.requestStartAt === undefined || state.firstTokenAt === undefined) return undefined;
  const elapsedMs = state.firstTokenAt - state.requestStartAt;
  if (elapsedMs < 0 || elapsedMs > MAX_PLAUSIBLE_TTFT_MS) return undefined;
  return elapsedMs;
};

/** Snapshot fields for TTFT; omitted entirely when unmeasured so consumers can
 * tell "not available" from "0 ms" without a sentinel value. */
const timeToFirstTokenFields = (
  state: TrackerState,
): Pick<TokenRateSnapshot, "timeToFirstTokenMs"> =>
  state.timeToFirstTokenMs === undefined ? {} : { timeToFirstTokenMs: state.timeToFirstTokenMs };

export function createTokenRateTracker(throttleMs = DEFAULT_THROTTLE_MS): TokenRateTracker {
  let state: TrackerState | undefined;

  const reset = (): void => {
    state = undefined;
  };

  const begin = (message: MessageStartEvent["message"]): void => {
    // A request boundary: TTFT can be measured from this message's start. Any
    // other reset (tool phase, model switch) has no request start, so the
    // following segment is measured without a TTFT rather than misattributing
    // the time since the last request.
    state = { accumulatedTokens: 0, requestStartAt: requestStartOf(message) };
  };

  const update = (event: MessageUpdateEvent, now: number): TokenRateSnapshot | undefined => {
    state ??= { accumulatedTokens: 0 };
    state.accumulatedTokens += estimateTokensFromChars(deltaText(event.assistantMessageEvent));
    if (state.accumulatedTokens <= 0) return undefined;

    // The first sample with positive tokens anchors the decode baseline and
    // freezes this request's TTFT.
    if (state.firstTokenAt === undefined) {
      state.firstTokenAt = now;
      state.timeToFirstTokenMs = measureTimeToFirstToken(state);
    }
    const elapsedMs = now - state.firstTokenAt;
    // A rate needs a real decode span: the first display waits for the warm-up
    // (a burst over a tiny span reads as a spike), later ones are throttled.
    const rateReady =
      elapsedMs > 0 &&
      (state.lastShownAt === undefined
        ? elapsedMs >= FIRST_SHOWN_MS
        : now - state.lastShownAt >= throttleMs);

    if (!rateReady) {
      // The wait, unlike the rate, is complete the moment the first token
      // lands. A short tool-call burst that never reaches the warm-up still
      // gets its one honest number on the line - exactly once per segment, and
      // without touching the rate's warm-up gate.
      if (state.timeToFirstTokenMs !== undefined && state.latencyShownAt === undefined) {
        state.latencyShownAt = now;
        return {
          outputTokens: state.accumulatedTokens,
          source: "estimated",
          ...timeToFirstTokenFields(state),
        };
      }
      return undefined;
    }

    // Whole-segment decode mean of the estimate. The measurement domain is
    // scoped per streaming segment by the lifecycle resets in
    // working-token-rate.ts, so the mean stays short-lived and fresh.
    const tokensPerSecond = Math.round((state.accumulatedTokens * 1000) / elapsedMs);
    state.lastShownAt = now;
    return {
      outputTokens: state.accumulatedTokens,
      source: "estimated",
      tokensPerSecond,
      ...timeToFirstTokenFields(state),
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
      ...timeToFirstTokenFields(state),
    };
  };

  return { reset, begin, update, finalize };
}
