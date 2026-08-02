import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWorkingTokenRate, TOKEN_RATE_STATUS_KEY } from "../src/tui/working-token-rate.ts";

type Handler = (event: unknown, context: unknown) => void;

function registerForTest(options: { hasUI?: boolean; mode?: string } = {}) {
  const handlers = new Map<string, Handler>();
  registerWorkingTokenRate({
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
  } as any);

  const setStatus = vi.fn();
  const setWorkingMessage = vi.fn();
  const context = {
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "tui",
    ui: { setStatus, setWorkingMessage },
  };

  return { handlers, context, setStatus, setWorkingMessage };
}

function assistantMessage(text: string, output = 0) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    usage: {
      input: 0,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    api: "openai-completions" as const,
    provider: "test",
    model: "test-model",
    stopReason: "stop" as const,
    timestamp: 0,
  };
}

function messageUpdate(message: ReturnType<typeof assistantMessage>, delta: string) {
  return {
    type: "message_update" as const,
    message,
    assistantMessageEvent: {
      type: "text_delta" as const,
      contentIndex: 0,
      delta,
      partial: message,
    },
  };
}

describe("working token rate adapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the estimated rate in the status key and clears on lifecycle boundaries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setStatus } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("1234"), "1234"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("12345678"), "5678"), context);

    expect(setStatus).toHaveBeenCalledWith(TOKEN_RATE_STATUS_KEY, undefined);
    expect(setStatus).toHaveBeenLastCalledWith(TOKEN_RATE_STATUS_KEY, "≈2 tokens/s");

    // A tool call resets the tracker and clears the status.
    handlers.get("tool_execution_start")?.({}, context);
    expect(setStatus).toHaveBeenLastCalledWith(TOKEN_RATE_STATUS_KEY, undefined);

    // The next assistant message restarts from a fresh baseline.
    vi.setSystemTime(3000);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("abcd"), "abcd"), context);
    expect(setStatus).toHaveBeenLastCalledWith(TOKEN_RATE_STATUS_KEY, undefined);

    // agent_end clears the status again.
    handlers.get("agent_end")?.({}, context);
    expect(setStatus).toHaveBeenLastCalledWith(TOKEN_RATE_STATUS_KEY, undefined);
  });

  it("formats reported usage without the estimate marker", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setStatus } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("abcd", 0), "abcd"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(
      messageUpdate(assistantMessage("abcdefgh", 30), "efgh"),
      context,
    );

    expect(setStatus).toHaveBeenLastCalledWith(TOKEN_RATE_STATUS_KEY, "30 tokens/s");
  });

  it("does not touch any UI in non-TUI modes and never calls setWorkingMessage", () => {
    const { handlers, context, setStatus, setWorkingMessage } = registerForTest({
      hasUI: false,
      mode: "print",
    });
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("abcd"), "abcd"), context);
    handlers.get("agent_end")?.({}, context);

    expect(setStatus).not.toHaveBeenCalled();
    expect(setWorkingMessage).not.toHaveBeenCalled();
  });

  it("ignores non-assistant message events", () => {
    const { handlers, context, setStatus } = registerForTest();
    handlers.get("message_start")?.(
      { message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      context,
    );
    handlers.get("message_update")?.({ message: { role: "toolResult", content: [] } }, context);
    expect(setStatus).not.toHaveBeenCalled();
  });
});
