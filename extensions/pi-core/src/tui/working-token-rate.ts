import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTokenRateTracker, type TokenRateSnapshot } from "./token-rate.ts";

export const TOKEN_RATE_STATUS_KEY = "pi-core:working-token-rate";

const WORKING_PREFIX = "Working...";

interface UiContext {
  hasUI: boolean;
  mode: string;
  ui: {
    setStatus(key: string, text?: string): void;
    setWorkingMessage(message?: string): void;
  };
}

function isInteractiveTui(context: UiContext): boolean {
  return context.hasUI && context.mode === "tui";
}

function formatSnapshot(snapshot: TokenRateSnapshot): string {
  const rate = `${snapshot.tokensPerSecond} tokens/s`;
  return snapshot.source === "reported" ? rate : `≈${rate}`;
}

/** Adapter layer: tracks assistant streaming output and shows the token rate
 * both in the working line while streaming (`Working... (≈42 tokens/s)`) and
 * persistently in the footer status area so the last rate stays visible when
 * idle. Non-TUI modes never touch the UI. */
export function registerWorkingTokenRate(pi: ExtensionAPI, now: () => number = Date.now): void {
  const tracker = createTokenRateTracker();

  const resetRate = (context: UiContext): void => {
    tracker.reset();
    if (!isInteractiveTui(context)) return;
    context.ui.setWorkingMessage();
    context.ui.setStatus(TOKEN_RATE_STATUS_KEY, undefined);
  };

  pi.on("agent_start", (_event, context) => {
    resetRate(context);
  });

  pi.on("message_start", (event, context) => {
    if (event.message.role !== "assistant") return;
    resetRate(context);
  });

  pi.on("message_update", (event, context) => {
    if (event.message.role !== "assistant") return;
    const snapshot = tracker.update(event, now());
    if (snapshot === undefined || !isInteractiveTui(context)) return;
    const formatted = formatSnapshot(snapshot);
    context.ui.setWorkingMessage(`${WORKING_PREFIX} (${formatted})`);
    context.ui.setStatus(TOKEN_RATE_STATUS_KEY, formatted);
  });

  pi.on("tool_execution_start", (_event, context) => {
    resetRate(context);
  });

  // agent_end resets tracker state but intentionally does NOT clear the
  // status: the last rate stays visible while idle (the working line itself
  // disappears with streaming).
  pi.on("agent_end", () => {
    tracker.reset();
  });
}
