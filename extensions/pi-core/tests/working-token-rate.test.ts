import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWorkingTokenRate, TOKEN_RATE_WIDGET_KEY } from "../src/tui/working-token-rate.ts";
import { assistantMessage, messageUpdate } from "./helpers/token-rate-fixtures.ts";

type Handler = (event: unknown, context: unknown) => void;

function registerForTest(options: { hasUI?: boolean; mode?: string } = {}) {
  const handlers = new Map<string, Handler>();
  registerWorkingTokenRate({
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
  } as any);

  const setWidget = vi.fn();
  const setWorkingMessage = vi.fn();
  const setWorkingIndicator = vi.fn();
  const context = {
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "tui",
    ui: { setWidget, setWorkingMessage, setWorkingIndicator },
  };

  return { handlers, context, setWidget, setWorkingMessage, setWorkingIndicator };
}

describe("working token rate adapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the estimated rate in the working line", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setWidget, setWorkingMessage } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("1234"), "1234"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("12345678"), "5678"), context);

    // The widget is only ever cleared (legacy cleanup), never populated.
    expect(setWidget).toHaveBeenCalledTimes(1);
    expect(setWidget).toHaveBeenCalledWith(TOKEN_RATE_WIDGET_KEY, undefined);
    // The rate lives in the working line message now.
    expect(setWorkingMessage).toHaveBeenLastCalledWith("Working  ≈2 tok/s");
  });

  it("shows the estimate during streaming and the true rate at message_end", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setWorkingMessage } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("abcd", 0), "abcd"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("efgh", 0), "efgh"), context);
    // Streaming estimates show with the ≈ marker: 2 tokens over 1s.
    expect(setWorkingMessage).toHaveBeenLastCalledWith("Working  ≈2 tok/s");

    // message_end carries the true usage: the marker disappears.
    handlers.get("message_end")?.({ message: assistantMessage("abcdefgh", 30) }, context);
    expect(setWorkingMessage).toHaveBeenLastCalledWith("Working  30 tok/s");
  });

  it("keeps the rate visible across tool calls and restores the default when idle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setWorkingMessage, setWorkingIndicator } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("1234"), "1234"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("12345678"), "5678"), context);

    // agent_start restore + first rate change = 2 calls so far; tool
    // execution keeps the last rate applied (working phase): no new call.
    handlers.get("tool_execution_start")?.({}, context);
    expect(setWorkingMessage).toHaveBeenCalledTimes(2);

    // Idle (agent_end) restores pi's default working message.
    handlers.get("agent_end")?.({}, context);
    expect(setWorkingMessage).toHaveBeenLastCalledWith(undefined);
    expect(setWorkingIndicator).not.toHaveBeenCalled();
  });

  it("does not overwrite spinner frames owned by Pi or another extension", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setWorkingIndicator } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("1234"), "1234"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("12345678"), "5678"), context);

    expect(setWorkingIndicator).not.toHaveBeenCalled();
  });

  it("resets the measurement baseline on model switch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setWorkingMessage } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("abcd"), "abcd"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("efgh"), "efgh"), context);
    expect(setWorkingMessage).toHaveBeenLastCalledWith("Working  ≈2 tok/s");

    // Mid-turn switch (no new message_start): the tracker must start from a
    // fresh baseline instead of folding the new stream into model A's.
    handlers.get("model_select")?.(
      { model: { id: "model-b" }, previousModel: { id: "model-a" } },
      context,
    );
    vi.setSystemTime(3000);
    handlers.get("message_update")?.(
      messageUpdate(assistantMessage("a".repeat(400)), "a".repeat(400)),
      context,
    );
    // Anchored at 3000; at 4000 the rate is the new segment's 101 tokens/1s.
    vi.setSystemTime(4000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("efgh"), "efgh"), context);
    // The ≈ marker takes the full 3-wide column, so no leading pad space.
    expect(setWorkingMessage).toHaveBeenLastCalledWith("Working ≈101 tok/s");
  });

  it("does not re-apply an identical working message", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setWorkingMessage } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("1234"), "1234"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("12345678"), "5678"), context);
    // Same rate text again: the working line is not re-set.
    vi.setSystemTime(2500);
    handlers.get("message_update")?.(
      messageUpdate(assistantMessage("123456789012"), "9012"),
      context,
    );

    // agent_start restore + the first rate change only.
    expect(setWorkingMessage).toHaveBeenCalledTimes(2);
  });

  it("starts a new agent run with the legacy widget cleared", () => {
    const { handlers, context, setWidget } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    expect(setWidget).toHaveBeenLastCalledWith(TOKEN_RATE_WIDGET_KEY, undefined);
  });

  it("does not touch any UI in non-TUI modes", () => {
    const { handlers, context, setWidget, setWorkingMessage } = registerForTest({
      hasUI: false,
      mode: "print",
    });
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("abcd"), "abcd"), context);
    handlers.get("agent_end")?.({}, context);

    expect(setWidget).not.toHaveBeenCalled();
    expect(setWorkingMessage).not.toHaveBeenCalled();
  });

  it("ignores non-assistant message events", () => {
    const { handlers, context, setWidget } = registerForTest();
    handlers.get("message_start")?.(
      { message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      context,
    );
    handlers.get("message_update")?.({ message: { role: "toolResult", content: [] } }, context);
    expect(setWidget).not.toHaveBeenCalled();
  });
});
