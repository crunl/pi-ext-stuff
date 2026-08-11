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
  const setWorkingIndicator = vi.fn();
  const context = {
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "tui",
    ui: {
      setWidget,
      setWorkingIndicator,
      // Identity fg so frame text stays plain in assertions.
      theme: { fg: (_color: string, text: string) => text },
    },
  };

  return { handlers, context, setWidget, setWorkingIndicator };
}

describe("working token rate adapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the estimated rate in the working indicator", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setWidget, setWorkingIndicator } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("1234"), "1234"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("12345678"), "5678"), context);

    // The widget is only ever cleared (legacy cleanup), never populated.
    expect(setWidget).toHaveBeenCalledTimes(1);
    expect(setWidget).toHaveBeenCalledWith(TOKEN_RATE_WIDGET_KEY, undefined);
    // The rate lives in the working indicator frames now.
    const options = setWorkingIndicator.mock.lastCall?.[0];
    expect(options.frames[0]).toBe("⠋ ≈2 tokens/s");
  });

  it("formats reported usage without the estimate marker", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setWorkingIndicator } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("abcd", 0), "abcd"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(
      messageUpdate(assistantMessage("abcdefgh", 30), "efgh"),
      context,
    );

    const options = setWorkingIndicator.mock.lastCall?.[0];
    expect(options.frames[0]).toBe("⠋ 30 tokens/s");
  });

  it("keeps the rate visible across tool calls and restores the default when idle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setWorkingIndicator } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("1234"), "1234"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("12345678"), "5678"), context);

    // Tool execution keeps the last rate applied (working phase): no new call.
    handlers.get("tool_execution_start")?.({}, context);
    expect(setWorkingIndicator).toHaveBeenCalledTimes(2);

    // Idle (agent_end) restores pi's default working indicator.
    handlers.get("agent_end")?.({}, context);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith();
  });

  it("embeds the rate into every spinner frame", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setWorkingIndicator } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("1234"), "1234"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("12345678"), "5678"), context);

    // agent_start restores the default indicator once; the update applies the frames.
    expect(setWorkingIndicator).toHaveBeenCalledTimes(2);
    const options = setWorkingIndicator.mock.calls[1]?.[0];
    expect(options.frames).toHaveLength(10);
    expect(options.frames[0]).toBe("⠋ ≈2 tokens/s");
    expect(options.intervalMs).toBe(80);
  });

  it("does not re-apply identical indicator frames (keeps the spinner animating)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setWorkingIndicator } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("1234"), "1234"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("12345678"), "5678"), context);
    // Same rate text again: the indicator frames are not re-set.
    vi.setSystemTime(2500);
    handlers.get("message_update")?.(
      messageUpdate(assistantMessage("123456789012"), "9012"),
      context,
    );

    // agent_start restore + the first rate change only.
    expect(setWorkingIndicator).toHaveBeenCalledTimes(2);
  });

  it("restores the default working indicator when idle", () => {
    const { handlers, context, setWidget, setWorkingIndicator } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("1234"), "1234"), context);

    handlers.get("agent_end")?.({}, context);
    expect(setWidget).toHaveBeenLastCalledWith(TOKEN_RATE_WIDGET_KEY, undefined);
    // Called with no arguments -> restore pi's default spinner.
    expect(setWorkingIndicator).toHaveBeenLastCalledWith();
  });

  it("starts a new agent run with the legacy widget cleared", () => {
    const { handlers, context, setWidget } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    expect(setWidget).toHaveBeenLastCalledWith(TOKEN_RATE_WIDGET_KEY, undefined);
  });

  it("does not touch any UI in non-TUI modes", () => {
    const { handlers, context, setWidget, setWorkingIndicator } = registerForTest({
      hasUI: false,
      mode: "print",
    });
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("abcd"), "abcd"), context);
    handlers.get("agent_end")?.({}, context);

    expect(setWidget).not.toHaveBeenCalled();
    expect(setWorkingIndicator).not.toHaveBeenCalled();
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
