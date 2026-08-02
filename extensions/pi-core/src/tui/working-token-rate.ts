import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTokenRateTracker, type TokenRateSnapshot } from "./token-rate.ts";
import { isInteractiveTui } from "./ui-guard.ts";

export const TOKEN_RATE_WIDGET_KEY = "pi-core:working-token-rate";

interface UiContext {
  hasUI: boolean;
  mode: string;
  ui: { setWidget(key: string, content: string[] | undefined): void };
}

function formatSnapshot(snapshot: TokenRateSnapshot): string {
  const rate = `${snapshot.tokensPerSecond} tokens/s`;
  return snapshot.source === "reported" ? rate : `≈${rate}`;
}

/** Adapter layer: tracks assistant streaming output and shows the token rate
 * in a persistent widget above the editor (`setWidget`, default placement).
 * The widget appears while working (streaming and tool phases keep the last
 * rate visible) and is removed only when the agent goes idle. Non-TUI modes
 * never touch the UI. */
export function registerWorkingTokenRate(pi: ExtensionAPI, now: () => number = Date.now): void {
  const tracker = createTokenRateTracker();

  const clearRate = (context: UiContext): void => {
    tracker.reset();
    if (isInteractiveTui(context)) {
      context.ui.setWidget(TOKEN_RATE_WIDGET_KEY, undefined);
    }
  };

  pi.on("agent_start", (_event, context) => {
    clearRate(context);
  });

  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    // New stream: recompute from a fresh baseline, but keep the widget
    // content until the first snapshot replaces it.
    tracker.reset();
  });

  pi.on("message_update", (event, context) => {
    if (event.message.role !== "assistant") return;
    const snapshot = tracker.update(event, now());
    if (snapshot === undefined || !isInteractiveTui(context)) return;
    context.ui.setWidget(TOKEN_RATE_WIDGET_KEY, [formatSnapshot(snapshot)]);
  });

  pi.on("tool_execution_start", () => {
    // Tools produce no output tokens; restart the counter but keep the last
    // rate visible so the widget never blanks during working.
    tracker.reset();
  });

  pi.on("agent_end", (_event, context) => {
    // Idle: the widget disappears until the next agent run.
    clearRate(context);
  });
}
