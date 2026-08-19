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
  };
}

/** "Working 111 tok/s" / "Working  50 tok/s" — a 3-wide, space-right-
 * aligned rate column so 2- and 3-digit rates don't make the line jitter;
 * the estimate marker (≈) counts toward the column width. */
function formatWorkingMessage(snapshot: TokenRateSnapshot): string {
  const marker = snapshot.source === "estimated" ? "≈" : "";
  const rate = `${marker}${snapshot.tokensPerSecond}`.padStart(3, " ");
  return `Working ${rate} tok/s`;
}

function isPureToolCallMessage(message: { content?: unknown }): boolean {
  const content = (message as { content?: unknown[] }).content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((c: unknown) => {
    const type = (c as { type?: string } | null)?.type;
    return type === "toolCall" || type === "tool_call";
  });
}

/** Adapter layer: tracks assistant streaming output and shows the token rate
 * as part of the footer working line (`⠋ Working  50 tok/s`) via
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
      // Clear only the message this extension owns. The indicator frames may
      // be owned by another extension, so never reset them here.
      context.ui.setWorkingMessage(undefined);
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
    if (event.message.role !== "assistant" || !isInteractiveTui(context)) return;
    const snapshot = tracker.update(event, now());
    if (snapshot === undefined) return;
    const message = formatWorkingMessage(snapshot);
    if (message !== lastMessage) {
      lastMessage = message;
      context.ui.setWorkingMessage(message);
    }
  });

  pi.on("message_end", (event, context) => {
    // message_update never carries usage (pi attaches it only on stream
    // completion), so the final message is the one point where the rate can
    // be corrected to the true decode throughput - same computation moment
    // as grok-build's per-call telemetry. Pure tool-call messages are short
    // and noisy; keeping the last meaningful (text/thinking) rate frozen
    // during tool execution is more informative than flashing the tool JSON's
    // rate.
    if (event.message.role !== "assistant" || !isInteractiveTui(context)) return;
    if (isPureToolCallMessage(event.message as { content?: unknown[] })) return;
    const snapshot = tracker.finalize(event.message, now());
    if (snapshot === undefined) return;
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

  pi.on("model_select", () => {
    // A model switch changes the measurement baseline (tokenizer estimate
    // ratio, usage reporting semantics — reported usage must not be clamped
    // to the previous model's cumulative value). Reset the measurement; the
    // working line keeps the last rate until the next stream replaces it,
    // same behaviour as message_start.
    tracker.reset();
  });

  pi.on("agent_end", (_event, context) => {
    // Idle: the working line is restored to pi's default.
    clearRate(context);
  });
}
