import type { ExtensionAPI, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { createTokenRateTracker, type TokenRateSnapshot } from "./token-rate.ts";
import { isInteractiveTui } from "./ui-guard.ts";

export const TOKEN_RATE_WIDGET_KEY = "pi-core:working-token-rate";
/** pi-tui's default spinner frames, so the customized indicator keeps the
 * built-in look with the rate appended. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

interface UiContext {
  hasUI: boolean;
  mode: string;
  ui: {
    setWidget(key: string, content: string[] | undefined): void;
    setWorkingIndicator(options?: WorkingIndicatorOptions): void;
    theme: { fg(color: string, text: string): string };
  };
}

function formatSnapshot(snapshot: TokenRateSnapshot): string {
  const rate = `${snapshot.tokensPerSecond} tokens/s`;
  return snapshot.source === "reported" ? rate : `≈${rate}`;
}

/** Working-indicator frames with the current rate embedded after the spinner
 * (spinner keeps the accent color, rate is muted). */
function indicatorFrames(
  rateText: string,
  theme: UiContext["ui"]["theme"],
): WorkingIndicatorOptions {
  return {
    frames: SPINNER_FRAMES.map(
      (frame) => `${theme.fg("accent", frame)} ${theme.fg("muted", rateText)}`,
    ),
    intervalMs: SPINNER_INTERVAL_MS,
  };
}

/** Adapter layer: tracks assistant streaming output and shows the token rate
 * after the working spinner in the footer (`setWorkingIndicator`), with the
 * last rate staying visible across tool phases. Non-TUI modes never touch
 * the UI. */
export function registerWorkingTokenRate(pi: ExtensionAPI, now: () => number = Date.now): void {
  const tracker = createTokenRateTracker();
  // Last rate text applied to the working indicator; avoids re-applying the
  // same frames (which would restart the spinner animation).
  let lastIndicatorRate = "";

  const clearRate = (context: UiContext): void => {
    tracker.reset();
    lastIndicatorRate = "";
    if (isInteractiveTui(context)) {
      // Defensive: clear the above-editor widget previously shown by older
      // versions of this extension, if it is still mounted.
      context.ui.setWidget(TOKEN_RATE_WIDGET_KEY, undefined);
      // Restore pi's default working indicator.
      context.ui.setWorkingIndicator();
    }
  };

  pi.on("agent_start", (_event, context) => {
    clearRate(context);
  });

  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    // New stream: recompute from a fresh baseline; the indicator keeps its
    // content until the first snapshot replaces it.
    tracker.reset();
  });

  pi.on("message_update", (event, context) => {
    if (event.message.role !== "assistant") return;
    const snapshot = tracker.update(event, now());
    if (snapshot === undefined || !isInteractiveTui(context)) return;
    const rateText = formatSnapshot(snapshot);
    // setWorkingIndicator restarts the frame animation from frame 0, so only
    // re-apply it when the rate text actually changed — otherwise the spinner
    // would freeze on the first frame.
    if (rateText !== lastIndicatorRate) {
      lastIndicatorRate = rateText;
      context.ui.setWorkingIndicator(indicatorFrames(rateText, context.ui.theme));
    }
  });

  pi.on("tool_execution_start", () => {
    // Tools produce no output tokens; restart the counter but keep the last
    // rate visible so the indicator never blanks during working.
    tracker.reset();
  });

  pi.on("agent_end", (_event, context) => {
    // Idle: the indicator is restored to pi's default.
    clearRate(context);
  });
}
