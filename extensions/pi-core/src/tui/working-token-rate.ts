import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTokenRateTracker, type TokenRateSnapshot } from "./token-rate.ts";

export const TOKEN_RATE_STATUS_KEY = "pi-core:working-token-rate";

interface UiContext {
  hasUI: boolean;
  mode: string;
  ui: { setStatus(key: string, text?: string): void };
}

function isInteractiveTui(context: UiContext): boolean {
  return context.hasUI && context.mode === "tui";
}

function formatSnapshot(snapshot: TokenRateSnapshot): string {
  const rate = `${snapshot.tokensPerSecond} tokens/s`;
  return snapshot.source === "reported" ? rate : `≈${rate}`;
}

/** Adapter layer: tracks assistant streaming output and shows the token rate
 * in the status/footer area via `setStatus`. The working message itself is
 * left untouched so other extensions keep owning the base copy. */
export function registerWorkingTokenRate(pi: ExtensionAPI, now: () => number = Date.now): void {
  const tracker = createTokenRateTracker();

  const clearStatus = (context: UiContext): void => {
    tracker.reset();
    if (isInteractiveTui(context)) {
      context.ui.setStatus(TOKEN_RATE_STATUS_KEY, undefined);
    }
  };

  pi.on("agent_start", (_event, context) => {
    clearStatus(context);
  });

  pi.on("message_start", (event, context) => {
    if (event.message.role !== "assistant") return;
    clearStatus(context);
  });

  pi.on("message_update", (event, context) => {
    if (event.message.role !== "assistant") return;
    const snapshot = tracker.update(event, now());
    if (snapshot === undefined || !isInteractiveTui(context)) return;
    context.ui.setStatus(TOKEN_RATE_STATUS_KEY, formatSnapshot(snapshot));
  });

  pi.on("tool_execution_start", (_event, context) => {
    clearStatus(context);
  });

  pi.on("agent_end", (_event, context) => {
    clearStatus(context);
  });
}
