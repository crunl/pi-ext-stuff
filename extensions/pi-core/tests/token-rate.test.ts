import { describe, expect, it } from "vitest";
import {
  createTokenRateTracker,
  estimateTokensFromChars,
  streamHealth,
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
  it("finalizes to the reported usage.output at message end", () => {
    const tracker = createTokenRateTracker();
    const first = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("ab"),
      },
      1000,
    );
    expect(first).toBeUndefined(); // first sample only anchors the baseline

    const second = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("cd"),
      },
      2000,
    );
    expect(second).toEqual({ outputTokens: 2, source: "estimated", tokensPerSecond: 2 });

    // message_end carries the real usage; the rate is recomputed from it and
    // always refreshes (no throttle in the way after 1s elapsed).
    const finalized = tracker.finalize(assistantMessage("", 40), 2500);
    expect(finalized).toEqual({ outputTokens: 40, source: "reported", tokensPerSecond: 27 });
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

  it("waits for the first-display warm-up and throttles refreshes after", () => {
    const tracker = createTokenRateTracker(100);
    tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("abcd"),
      },
      1000,
    );
    // Before the 1s warm-up: nothing is shown, whatever the delta size. A
    // 400-char burst at 50ms would have read ~2000 tok/s without the gate.
    expect(
      tracker.update(
        {
          type: "message_update",
          message: assistantMessage(""),
          assistantMessageEvent: textDelta("x".repeat(400)),
        },
        1050,
      ),
    ).toBeUndefined();
    // At the 1s mark the first rate appears. The burst is accumulated but the
    // denominator is a full second, so the spike is gone: 102 tokens / 1s.
    const firstShown = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("ef"),
      },
      2000,
    );
    expect(firstShown).toEqual({ outputTokens: 102, source: "estimated", tokensPerSecond: 102 });
    // 50ms later: inside the window, no refresh.
    expect(
      tracker.update(
        {
          type: "message_update",
          message: assistantMessage(""),
          assistantMessageEvent: textDelta("gh"),
        },
        2050,
      ),
    ).toBeUndefined();
    // 100ms later (window edge): refresh is allowed again.
    const third = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("ij"),
      },
      2100,
    );
    expect(third).toBeDefined();
    expect(third?.source).toBe("estimated");
  });

  it("finalize always refreshes, bypassing the throttle window", () => {
    const tracker = createTokenRateTracker(10_000);
    tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("abcd"),
      },
      1000,
    );
    const shown = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("ef"),
      },
      2000,
    );
    expect(shown).toEqual({ outputTokens: 2, source: "estimated", tokensPerSecond: 2 });
    // A normal update 50ms later would be throttled for 10s...
    expect(
      tracker.update(
        {
          type: "message_update",
          message: assistantMessage(""),
          assistantMessageEvent: textDelta("gh"),
        },
        2050,
      ),
    ).toBeUndefined();
    // ...but the final real usage always gets through: 50 tokens / 1.1s ≈ 45.
    const finalized = tracker.finalize(assistantMessage("", 50), 2100);
    expect(finalized).toEqual({ outputTokens: 50, source: "reported", tokensPerSecond: 45 });
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

  it("finalize ignores missing or zero usage", () => {
    const tracker = createTokenRateTracker();
    tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("abcd"),
      },
      1000,
    );
    // No usage reported (provider omission): keep the estimate, do not clear.
    expect(
      tracker.finalize({ ...assistantMessage(""), usage: undefined } as never, 2000),
    ).toBeUndefined();
    expect(tracker.finalize(assistantMessage("", 0), 2000)).toBeUndefined();
    // Non-assistant messages never carry output usage.
    expect(
      tracker.finalize({ role: "user", content: [], timestamp: 0 } as never, 2000),
    ).toBeUndefined();
    // Finalize without any prior stream (no baseline) cannot compute a rate.
    tracker.reset();
    expect(tracker.finalize(assistantMessage("", 50), 2000)).toBeUndefined();
  });

  it("counts hangul and supplementary CJK ideographs as one token each", () => {
    // Hangul syllable block; 4 supplementary-plane ideographs (U+20000+)
    // used to fall into the latin bucket (4 chars -> 1 token).
    expect(estimateTokensFromChars("한글")).toBe(2);
    expect(estimateTokensFromChars("𠀀𠀁𠀂𠀃")).toBe(4);
  });

  it("corrects the estimate to the true mean at finalize", () => {
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
    const estimate = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("efgh"),
      },
      3000,
    );
    expect(estimate).toEqual({ outputTokens: 2, source: "estimated", tokensPerSecond: 2 });
    // Real usage at message_end replaces the estimate: the mean self-corrects
    // to the whole-segment truth (50/1.1s ≈ 45/s), no re-baselining needed.
    const reported = tracker.finalize(assistantMessage("", 50), 3100);
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

  it("equals grok when the final usage is reported at message end", () => {
    const tracker = createTokenRateTracker(0);
    const ttftMs = 850;
    const chunks = Array.from({ length: 40 }, (_, i) => ({
      at: ttftMs + i * 50,
      text: "x".repeat(20), // 5 estimated tokens per chunk
    }));
    feed(tracker, chunks);
    // grok computes exactly once, at stream end, from the true completion
    // token count: 200 / (2800 - 850)ms = 102.6/s -> 103.
    const last = tracker.finalize(assistantMessage("", 40 * 5), 2800);
    expect(last?.outputTokens).toBe(200);
    expect(last?.source).toBe("reported");
    expect(last?.tokensPerSecond).toBe(103);
  });
});

describe("streamHealth", () => {
  it("returns stalled on long silence", () => {
    expect(streamHealth(20_000, 0, null)).toBe("stalled");
    expect(streamHealth(19_999, 0, null)).toBe("slow");
  });

  it("returns stalled on sustained crawl", () => {
    expect(streamHealth(0, 30_001, 1.9)).toBe("stalled");
    expect(streamHealth(0, 30_000, 1.9)).toBe("slow");
    expect(streamHealth(0, 30_001, 2)).toBe("slow");
    expect(streamHealth(0, 30_001, null)).toBe("healthy");
  });

  it("returns slow on moderate silence or crawl", () => {
    expect(streamHealth(5_000, 0, null)).toBe("slow");
    expect(streamHealth(4_999, 0, null)).toBe("healthy");
    expect(streamHealth(0, 15_001, 4.9)).toBe("slow");
    expect(streamHealth(0, 15_000, 4.9)).toBe("healthy");
    expect(streamHealth(0, 15_001, 5)).toBe("healthy");
  });

  it("prioritizes stalled over slow", () => {
    expect(streamHealth(20_000, 15_001, 4.9)).toBe("stalled");
    expect(streamHealth(5_000, 30_001, 1.9)).toBe("stalled");
  });
});
