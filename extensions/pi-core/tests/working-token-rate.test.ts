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
    expect(setWorkingMessage).toHaveBeenLastCalledWith("Working ≈002 tok/s");
  });

  it("formats reported usage without the estimate marker", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setWorkingMessage } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("abcd", 0), "abcd"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(
      messageUpdate(assistantMessage("abcdefgh", 30), "efgh"),
      context,
    );

    expect(setWorkingMessage).toHaveBeenLastCalledWith("Working 030 tok/s");
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

    // Idle (agent_end) restores pi's default working message and spinner.
    handlers.get("agent_end")?.({}, context);
    expect(setWorkingMessage).toHaveBeenLastCalledWith(undefined);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith();
  });

  it("keeps pi's default spinner frames (only the message text changes)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setWorkingIndicator } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("1234"), "1234"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("12345678"), "5678"), context);

    // The spinner is only ever touched to restore the default — never
    // re-applied with custom frames, so its animation is never restarted.
    expect(setWorkingIndicator).toHaveBeenCalledTimes(1);
    expect(setWorkingIndicator).toHaveBeenCalledWith();
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
