import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyThinkingGlance,
  formatThinkingGlance,
  resetThinkingGlance,
  THINKING_GLANCE_CHEVRON,
  THINKING_GLANCE_TREE,
  thinkingMessageKey,
} from "../src/tui/thinking-glance.ts";
import { createThinkingTimingTracker } from "../src/tui/thinking-timing.ts";

beforeAll(() => {
  initTheme("dark", false);
});

describe("formatThinkingGlance", () => {
  it("formats running, settled, failure, and unknown glance rows without expand chevron", () => {
    expect(formatThinkingGlance({ status: "open" })).toBe(`${THINKING_GLANCE_TREE}Thinking…`);
    expect(formatThinkingGlance({ status: "settled", durationMs: 1400 })).toBe(
      `${THINKING_GLANCE_TREE}Thought for 1.4s`,
    );
    expect(formatThinkingGlance({ status: "failed" })).toBe(
      `${THINKING_GLANCE_TREE}Thought · failed`,
    );
    expect(formatThinkingGlance({ status: "interrupted" })).toBe(
      `${THINKING_GLANCE_TREE}Thought · interrupted`,
    );
    expect(formatThinkingGlance({ status: "unknown" })).toBe(`${THINKING_GLANCE_TREE}Thought`);
    expect(THINKING_GLANCE_CHEVRON).toBe("");
  });
});

describe("thinking timing tracker", () => {
  it("records a single thinking run duration through text_delta", () => {
    const tracker = createThinkingTimingTracker();
    tracker.bindMessageKey("msg|1");
    tracker.onMessageStart();
    tracker.onMessageUpdate({ type: "thinking_start" }, 1000);
    tracker.onMessageUpdate({ type: "thinking_delta" }, 1500);
    tracker.onMessageUpdate({ type: "text_delta" }, 2400);
    const snap = tracker.lookup("msg|1", 0);
    expect(snap?.durationMs).toBe(1400);
    expect(snap?.status).toBe("settled");
  });

  it("settles open thinking on text_delta without an explicit message_end", () => {
    const tracker = createThinkingTimingTracker();
    tracker.bindMessageKey("msg|quick");
    tracker.onMessageStart();
    tracker.onMessageUpdate({ type: "thinking_start" }, 500);
    tracker.onMessageUpdate({ type: "thinking_delta" }, 800);
    tracker.onMessageUpdate({ type: "text_delta" }, 1200);
    const snap = tracker.lookup("msg|quick", 0);
    expect(snap?.status).toBe("settled");
    expect(snap?.durationMs).toBe(700);
  });

  it("keeps multiple thinking runs independent", () => {
    const tracker = createThinkingTimingTracker();
    tracker.bindMessageKey("msg|2");
    tracker.onMessageStart();
    tracker.onMessageUpdate({ type: "thinking_start" }, 0);
    tracker.onMessageUpdate({ type: "text_delta" }, 1000);
    tracker.onMessageUpdate({ type: "thinking_start" }, 2000);
    tracker.onMessageEnd("stop", 2600);
    expect(tracker.lookup("msg|2", 0)?.durationMs).toBe(1000);
    expect(tracker.lookup("msg|2", 0)?.status).toBe("settled");
    expect(tracker.lookup("msg|2", 1)?.durationMs).toBe(600);
    expect(tracker.lookup("msg|2", 1)?.status).toBe("settled");
  });

  it("marks open runs interrupted on aborted message_end", () => {
    const tracker = createThinkingTimingTracker();
    tracker.bindMessageKey("msg|3");
    tracker.onMessageStart();
    tracker.onMessageUpdate({ type: "thinking_start" }, 0);
    tracker.onMessageEnd("aborted", 300);
    expect(tracker.lookup("msg|3", 0)?.status).toBe("interrupted");
  });
});

describe("thinkingMessageKey", () => {
  it("is stable across content growth", () => {
    const a = thinkingMessageKey({ timestamp: "t1", responseId: "r", content: [] });
    const b = thinkingMessageKey({
      timestamp: "t1",
      responseId: "r",
      content: [{ type: "thinking", thinking: "x" }],
    });
    expect(a).toBe(b);
  });
});

describe("applyThinkingGlance", () => {
  it("patches AssistantMessageComponent.updateContent without throwing on empty messages", () => {
    applyThinkingGlance(createThinkingTimingTracker());
    try {
      const component = new AssistantMessageComponent(undefined, true);
      component.updateContent({ content: [], stopReason: "stop" } as never, false);
      expect(typeof component.updateContent).toBe("function");
    } finally {
      resetThinkingGlance();
    }
  });

  it("renders per-run tree glance for hidden thinking with known duration", () => {
    const tracker = createThinkingTimingTracker();
    applyThinkingGlance(tracker);
    try {
      const component = new AssistantMessageComponent(undefined, true);
      const message = {
        role: "assistant",
        timestamp: "t-glance",
        responseId: "r1",
        content: [
          { type: "thinking", thinking: "step one" },
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "step two" },
        ],
        stopReason: "stop",
      } as never;
      tracker.bindMessageKey(thinkingMessageKey(message as never));
      tracker.onMessageStart();
      tracker.onMessageUpdate({ type: "thinking_start" }, 0);
      tracker.onMessageUpdate({ type: "text_delta" }, 1200);
      tracker.onMessageUpdate({ type: "thinking_start" }, 2000);
      tracker.onMessageEnd("stop", 2500);

      component.updateContent(message, false);
      const lines = (component as unknown as { render(width: number): string[] })
        .render(80)
        .map((line) => stripTerminalSequences(line));
      const joined = lines.join("\n");
      expect(joined).toContain(`${THINKING_GLANCE_TREE}Thought for 1.2s${THINKING_GLANCE_CHEVRON}`);
      expect(joined).toContain(`${THINKING_GLANCE_TREE}Thought for 0.5s${THINKING_GLANCE_CHEVRON}`);
      expect(joined).not.toContain("▶");
      expect(joined).not.toContain("Thinking… ▶");
    } finally {
      resetThinkingGlance();
    }
  });
});

describe("strip glance ANSI", () => {
  it("glance text remains readable after ANSI strip", () => {
    const text = formatThinkingGlance({ status: "settled", durationMs: 2000 });
    expect(stripTerminalSequences(text)).toContain("Thought for 2.0s");
  });
});
