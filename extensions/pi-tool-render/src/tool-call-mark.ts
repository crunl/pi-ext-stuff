export interface ToolCallMark {
  readonly icon: string;
  readonly color: "warning";
}

interface ToolCallMarkUi {
  markToolCall?: (toolCallId: string, mark: ToolCallMark) => void;
}

/**
 * Ask a compatible Pi TUI host to persistently mark one tool call.
 *
 * Older hosts do not expose this optional capability; returning false keeps
 * cross-extension consumers compatible without coupling authorization to UI.
 */
export function markToolCall(ui: ToolCallMarkUi, toolCallId: string, mark: ToolCallMark): boolean {
  if (!ui.markToolCall) return false;
  try {
    ui.markToolCall(toolCallId, mark);
    return true;
  } catch {
    return false;
  }
}
