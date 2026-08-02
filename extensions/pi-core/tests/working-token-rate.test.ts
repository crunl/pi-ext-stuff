import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerWorkingTokenRate,
  TOKEN_RATE_WIDGET_KEY,
} from "../src/tui/working-token-rate.ts";
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
  const context = {
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "tui",
    ui: { setWidget, setWorkingMessage },
  };

  return { handlers, context, setWidget, setWorkingMessage };
}

describe("working token rate adapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the estimated rate in the editor widget", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setWidget } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("1234"), "1234"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("12345678"), "5678"), context);

    expect(setWidget).toHaveBeenCalledWith(TOKEN_RATE_WIDGET_KEY, undefined);
    expect(setWidget).toHaveBeenLastCalledWith(TOKEN_RATE_WIDGET_KEY, ["≈2 tokens/s"]);
  });

  it("formats reported usage without the estimate marker", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setWidget } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("abcd", 0), "abcd"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("abcdefgh", 30), "efgh"), context);

    expect(setWidget).toHaveBeenLastCalledWith(TOKEN_RATE_WIDGET_KEY, ["30 tokens/s"]);
  });

  it("keeps the rate visible across tool calls and clears only when idle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { handlers, context, setWidget } = registerForTest();
    handlers.get("agent_start")?.({}, context);
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    vi.setSystemTime(1000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("1234"), "1234"), context);
    vi.setSystemTime(2000);
    handlers.get("message_update")?.(messageUpdate(assistantMessage("12345678"), "5678"), context);

    // Tool execution keeps the last rate visible (working phase).
    handlers.get("tool_execution_start")?.({}, context);
    expect(setWidget).toHaveBeenLastCalledWith(TOKEN_RATE_WIDGET_KEY, ["≈2 tokens/s"]);

    // The next assistant message restarts the counter; the widget keeps its
    // previous content until the new snapshot replaces it.
    handlers.get("message_start")?.({ message: assistantMessage("") }, context);
    expect(setWidget).toHaveBeenLastCalledWith(TOKEN_RATE_WIDGET_KEY, ["≈2 tokens/s"]);

    // Idle (agent_end) removes the widget.
    handlers.get("agent_end")?.({}, context);
    expect(setWidget).toHaveBeenLastCalledWith(TOKEN_RATE_WIDGET_KEY, undefined);
  });

  it("starts a new agent run with a cleared widget", () => {
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
    handlers.get("message_update")?.(
      { message: { role: "toolResult", content: [] } },
      context,
    );
    expect(setWidget).not.toHaveBeenCalled();
  });
});
