import { describe, expect, it } from "vitest";
import {
  createTokenRateTracker,
  estimateTokensFromChars,
  type TokenRateSnapshot,
  type TokenRateTracker,
} from "../src/tui/token-rate.ts";
import { assistantMessage } from "./helpers/token-rate-fixtures.ts";

function textDelta(delta: string) {
  return { type: "text_delta" as const, contentIndex: 0, delta, partial: assistantMessage("") };
}

function thinkingDelta(delta: string) {
  return {
    type: "thinking_delta" as const,
    contentIndex: 0,
    delta,
    partial: assistantMessage(""),
  };
}

function toolcallDelta(delta: string) {
  return {
    type: "toolcall_delta" as const,
    contentIndex: 0,
    delta,
    partial: assistantMessage(""),
  };
}

describe("token rate tracker", () => {
  it("uses reported usage.output when positive", () => {
    const tracker = createTokenRateTracker();
    const first = tracker.update(
      {
        type: "message_update",
        message: assistantMessage("", 0),
        assistantMessageEvent: textDelta("ab"),
      },
      1000,
    );
    expect(first).toBeUndefined(); // first sample only anchors the baseline

    const second = tracker.update(
      {
        type: "message_update",
        message: assistantMessage("", 40),
        assistantMessageEvent: textDelta("cd"),
      },
      2000,
    );
    expect(second).toEqual({ outputTokens: 40, source: "reported", tokensPerSecond: 40 });
  });

  it("falls back to incremental estimation from text deltas", () => {
    const tracker = createTokenRateTracker();
    tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("1234"),
      },
      1000,
    );
    const second = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("5678"),
      },
      2000,
    );
    // 8 chars -> ceil(8/4) = 2 tokens over 1s.
    expect(second).toEqual({ outputTokens: 2, source: "estimated", tokensPerSecond: 2 });
  });

  it("counts CJK characters as one token each, latin as 4 chars per token", () => {
    const tracker = createTokenRateTracker();
    // 4 CJK chars -> 4 tokens (not 1), plus 8 latin chars -> 2 tokens.
    tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("性能测试"),
      },
      1000,
    );
    const second = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("abcdefgh"),
      },
      2000,
    );
    // ceil(4 + 8/4) = 6 tokens over 1s.
    expect(second).toEqual({ outputTokens: 6, source: "estimated", tokensPerSecond: 6 });
  });

  it("accumulates thinking and toolcall deltas into the estimate", () => {
    const tracker = createTokenRateTracker();
    tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: thinkingDelta("abcd"),
      },
      1000,
    );
    tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: toolcallDelta("efgh"),
      },
      1000,
    );
    const third = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("ijkl"),
      },
      2000,
    );
    // 12 chars -> 3 tokens over 1s.
    expect(third).toEqual({ outputTokens: 3, source: "estimated", tokensPerSecond: 3 });
  });

  it("returns undefined for zero tokens and resets the baseline on reset", () => {
    const tracker = createTokenRateTracker();
    expect(
      tracker.update(
        {
          type: "message_update",
          message: assistantMessage(""),
          assistantMessageEvent: textDelta(""),
        },
        1000,
      ),
    ).toBeUndefined();

    tracker.reset();
    const afterReset = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("abcd"),
      },
      5000,
    );
    expect(afterReset).toBeUndefined(); // new baseline anchored at 5000
    const later = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("efgh"),
      },
      6000,
    );
    expect(later).toEqual({ outputTokens: 2, source: "estimated", tokensPerSecond: 2 });
  });

  it("throttles refreshes inside the window and allows them after it", () => {
    const tracker = createTokenRateTracker(100);
    tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("abcd"),
      },
      1000,
    );
    // First displayable sample: the baseline update had zero elapsed time, so
    // the throttle window has not started yet.
    const firstShown = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("ef"),
      },
      1050,
    );
    expect(firstShown).toEqual({ outputTokens: 2, source: "estimated", tokensPerSecond: 40 });
    // 50ms later: inside the window, no refresh.
    expect(
      tracker.update(
        {
          type: "message_update",
          message: assistantMessage(""),
          assistantMessageEvent: textDelta("gh"),
        },
        1100,
      ),
    ).toBeUndefined();
    // 100ms later (window edge): refresh is allowed again.
    const third = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("ij"),
      },
      1150,
    );
    expect(third).toBeDefined();
    expect(third?.source).toBe("estimated");
  });

  it("refreshes immediately when the source flips from estimated to reported", () => {
    const tracker = createTokenRateTracker(100);
    tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("abcd"),
      },
      1000,
    );
    // 10ms later: source flip bypasses the throttle window.
    const reported = tracker.update(
      {
        type: "message_update",
        message: assistantMessage("", 50),
        assistantMessageEvent: textDelta("ef"),
      },
      1010,
    );
    expect(reported).toEqual({ outputTokens: 50, source: "reported", tokensPerSecond: 5000 });
  });

  it("never downgrades a reported source back to estimated", () => {
    const tracker = createTokenRateTracker();
    tracker.update(
      {
        type: "message_update",
        message: assistantMessage("", 40),
        assistantMessageEvent: textDelta("ab"),
      },
      1000,
    );
    const later = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("cdef"),
      },
      2000,
    );
    expect(later).toEqual({ outputTokens: 40, source: "reported", tokensPerSecond: 40 });
  });

  it("shows the whole-segment decode mean so the rate stays stable", () => {
    const tracker = createTokenRateTracker(100);
    tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta(""),
      },
      1000,
    );
    // Slow phase: 1 token per second. The first positive sample anchors the
    // decode baseline (zero elapsed time), so the first display lands at 3000.
    tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("aaaa"),
      },
      2000,
    );
    const slow = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("aaaa"),
      },
      3000,
    );
    expect(slow).toEqual({ outputTokens: 2, source: "estimated", tokensPerSecond: 2 });
    // Fast phase: +100 tokens in one second. The mean reads the combined
    // 102/2s = 51/s (a sliding window would have spiked to 100/s).
    const fast = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("b".repeat(400)),
      },
      4000,
    );
    expect(fast).toEqual({ outputTokens: 102, source: "estimated", tokensPerSecond: 51 });
    // Two seconds later the mean converges to the same ~51/s instead of
    // oscillating with each burst - a stable glanceable number.
    const later = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("b".repeat(400)),
      },
      6000,
    );
    expect(later).toEqual({ outputTokens: 202, source: "estimated", tokensPerSecond: 51 });
  });

  it("keeps reported output monotonic against lower re-reports", () => {
    const tracker = createTokenRateTracker();
    tracker.update(
      {
        type: "message_update",
        message: assistantMessage("", 50),
        assistantMessageEvent: textDelta("ab"),
      },
      1000,
    );
    // Provider re-reports a lower cumulative value: the rate must not go
    // negative or step backwards.
    const later = tracker.update(
      {
        type: "message_update",
        message: assistantMessage("", 30),
        assistantMessageEvent: textDelta("cd"),
      },
      2000,
    );
    expect(later).toEqual({ outputTokens: 50, source: "reported", tokensPerSecond: 50 });
  });

  it("counts hangul and supplementary CJK ideographs as one token each", () => {
    // Hangul syllable block; 4 supplementary-plane ideographs (U+20000+)
    // used to fall into the latin bucket (4 chars -> 1 token).
    expect(estimateTokensFromChars("한글")).toBe(2);
    expect(estimateTokensFromChars("𠀀𠀁𠀂𠀃")).toBe(4);
  });

  it("self-corrects the mean when the source flips", () => {
    const tracker = createTokenRateTracker(100);
    tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta(""),
      },
      1000,
    );
    tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("abcd"),
      },
      2000,
    );
    tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("efgh"),
      },
      3000,
    );
    // usage arrives at +100ms and bypasses the throttle: the numerator steps
    // from the 2-token estimate to the true 50 and the mean self-corrects to
    // the whole-segment truth (50/1.1s ≈ 45/s) with no re-baselining.
    const reported = tracker.update(
      {
        type: "message_update",
        message: assistantMessage("", 50),
        assistantMessageEvent: textDelta("ij"),
      },
      3100,
    );
    expect(reported).toEqual({ outputTokens: 50, source: "reported", tokensPerSecond: 45 });
  });
});

describe("grok-build decode-throughput alignment", () => {
  // grok-build (xai-org/grok-build, xai-grok-shell turn.rs) computes, per
  // model call: tokens_per_sec = completion_tokens / (model_elapsed_ms -
  // ttft_ms), where ttft_ms is measured to the FIRST content chunk
  // (xai-grok-sampler metrics.rs: ttfb = chunk_timestamps[0] - stream_start).
  // The denominator therefore reduces to last_chunk - first_chunk: the
  // whole-call decode mean with prefill excluded. The tracker must land on
  // the same number when fed the same chunk timeline; only the rounding
  // differs (grok reports 1 decimal, the widget an integer).
  interface Chunk {
    at: number;
    text?: string;
    usage?: number;
  }
  const feed = (tracker: TokenRateTracker, chunks: Chunk[]): TokenRateSnapshot | undefined => {
    let snapshot: TokenRateSnapshot | undefined;
    for (const chunk of chunks) {
      snapshot = tracker.update(
        {
          type: "message_update",
          message: assistantMessage("", chunk.usage),
          assistantMessageEvent: textDelta(chunk.text ?? ""),
        },
        chunk.at,
      );
    }
    return snapshot;
  };

  it("equals grok's tokens/(model_elapsed - ttft) on a steady decode stream", () => {
    const tracker = createTokenRateTracker(0);
    const ttftMs = 850;
    const chunks = Array.from({ length: 40 }, (_, i) => ({
      at: ttftMs + i * 50, // one chunk every 50ms, first content chunk at TTFT
      text: "x".repeat(20), // 20 latin chars -> 5 estimated tokens per chunk
    }));
    const last = feed(tracker, chunks);
    // grok: 200 tokens / (2800 - 850)ms = 102.6/s; integer-rounded 103.
    const grokTps = Math.round((40 * 5 * 1000) / (2800 - ttftMs));
    expect(last?.outputTokens).toBe(200);
    expect(last?.source).toBe("estimated");
    expect(last?.tokensPerSecond).toBe(grokTps);
    expect(last?.tokensPerSecond).toBe(103);
  });

  it("is independent of prefill length (TTFT)", () => {
    const tracker = createTokenRateTracker(0);
    const longPrefill = 60_850; // a 60s prefill must not dilute the decode rate
    const chunks = Array.from({ length: 40 }, (_, i) => ({
      at: longPrefill + i * 50,
      text: "x".repeat(20),
    }));
    const last = feed(tracker, chunks);
    expect(last?.tokensPerSecond).toBe(103);
  });

  it("equals grok when usage is reported cumulatively on every chunk", () => {
    const tracker = createTokenRateTracker(0);
    const ttftMs = 850;
    const chunks = Array.from({ length: 40 }, (_, i) => ({
      at: ttftMs + i * 50,
      usage: (i + 1) * 5,
    }));
    const last = feed(tracker, chunks);
    expect(last?.outputTokens).toBe(200);
    expect(last?.source).toBe("reported");
    expect(last?.tokensPerSecond).toBe(103);
  });
});
