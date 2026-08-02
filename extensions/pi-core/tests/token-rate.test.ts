import { describe, expect, it } from "vitest";
import { createTokenRateTracker } from "../src/tui/token-rate.ts";
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

  it("uses a sliding window so the rate reflects recent output", () => {
    const tracker = createTokenRateTracker(100, 2000);
    tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta(""),
      },
      1000,
    );
    // Slow phase: 1 token per second. The first positive sample anchors the
    // baseline (zero elapsed time), so the first display lands at 3000.
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
    // Fast phase: +100 tokens in one second. The window spans only the fast
    // second, so the rate reads 100/s instead of the 34/s whole-run average.
    const fast = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("b".repeat(400)),
      },
      4000,
    );
    expect(fast).toEqual({ outputTokens: 102, source: "estimated", tokensPerSecond: 100 });
    // Two seconds later the window (2s) spans 3s-6s: (202-2)/3s = 66.7
    // while the whole-run average is still 34/s.
    const later = tracker.update(
      {
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: textDelta("b".repeat(400)),
      },
      6000,
    );
    expect(later).toEqual({ outputTokens: 202, source: "estimated", tokensPerSecond: 67 });
  });

  it("re-baselines to the warm-up average when the source flips", () => {
    const tracker = createTokenRateTracker(100, 2000);
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
    // usage arrives at +100ms: without re-baselining the window would read
    // (50-2)/0.1s = 480/s; the flip resets the baseline, so it shows the
    // warm-up average 50/1.1s ≈ 45/s.
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
