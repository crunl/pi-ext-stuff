import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTokenRateTracker, type TokenRateSnapshot } from "./token-rate.ts";
import { isInteractiveTui } from "./ui-guard.ts";

export const TOKEN_RATE_WIDGET_KEY = "pi-core:working-token-rate";

interface UiContext {
  hasUI: boolean;
  mode: string;
  ui: {
    setWidget(key: string, content: string[] | undefined): void;
    setWorkingMessage(message?: string): void;
    setWorkingIndicator(): void;
  };
}

/** "Working 042 tok/s" — fixed-width rate so the line doesn't jitter; the
 * estimate marker (≈) stays when the provider has not reported usage yet. */
function formatWorkingMessage(snapshot: TokenRateSnapshot): string {
  const rate = String(snapshot.tokensPerSecond).padStart(3, "0");
  const marker = snapshot.source === "estimated" ? "≈" : "";
  return `Working ${marker}${rate} tok/s`;
}

/** Adapter layer: tracks assistant streaming output and shows the token rate
 * as part of the footer working line (`⠋ Working 042 tok/s`) via
 * `setWorkingMessage` — which only updates the text and never restarts the
 * spinner animation. The last rate stays visible across tool phases; the
 * default message/spinner are restored when the agent goes idle. Non-TUI
 * modes never touch the UI. */
export function registerWorkingTokenRate(pi: ExtensionAPI, now: () => number = Date.now): void {
  const tracker = createTokenRateTracker();
  // Last message text applied to the working line; skips identical updates
  // so the footer isn't re-rendered on every stream tick.
  let lastMessage = "";

  const clearRate = (context: UiContext): void => {
    tracker.reset();
    lastMessage = "";
    if (isInteractiveTui(context)) {
      // Defensive: clear the above-editor widget previously shown by older
      // versions of this extension, if it is still mounted.
      context.ui.setWidget(TOKEN_RATE_WIDGET_KEY, undefined);
      // Restore pi's default working message and spinner.
      context.ui.setWorkingMessage(undefined);
      context.ui.setWorkingIndicator();
    }
  };

  pi.on("agent_start", (_event, context) => {
    clearRate(context);
  });

  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    // New stream: recompute from a fresh baseline; the working line keeps
    // its content until the first snapshot replaces it.
    tracker.reset();
  });

  pi.on("message_update", (event, context) => {
    if (event.message.role !== "assistant") return;
    const snapshot = tracker.update(event, now());
    if (snapshot === undefined || !isInteractiveTui(context)) return;
    const message = formatWorkingMessage(snapshot);
    if (message !== lastMessage) {
      lastMessage = message;
      context.ui.setWorkingMessage(message);
    }
  });

  pi.on("tool_execution_start", () => {
    // Tools produce no output tokens; restart the counter but keep the last
    // rate visible so the working line never blanks during working.
    tracker.reset();
  });

  pi.on("agent_end", (_event, context) => {
    // Idle: the working line is restored to pi's default.
    clearRate(context);
  });
}
