import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodexToolRendering } from "./tui/built-in-tools.ts";
import { registerCanonicalBuiltinFallback } from "./tui/canonical-tool-fallback.ts";
import { registerCodemodeTreeTool } from "./tui/codemode-tool.ts";
import { registerEditorChrome } from "./tui/editor-chrome.ts";
import { registerEffortCommand } from "./tui/effort-command.ts";
import { registerExitCommand } from "./tui/exit-command.ts";
import { registerOutputPaddingSync } from "./tui/output-padding.ts";
import { registerWorkingTokenRate } from "./tui/working-token-rate.ts";

export function registerExtension(pi: ExtensionAPI): void {
  // Everything below goes through public Pi API surface: tool/command
  // registration, setWidget/setWorkingMessage, settings watch, and the
  // editor chrome (an official CustomEditor subclass installed via
  // setEditorComponent — the mode badge needs a public seam and has one).
  // The former TUI *prototype* patches — autocomplete-above, selector
  // float/tab-nav, user message bar, markdown code frame, thinking glance —
  // were removed in favour of stock host rendering; none had a public hook,
  // so their visuals now follow Pi's defaults.
  registerOutputPaddingSync(pi);
  registerCodexToolRendering(pi);
  registerCodemodeTreeTool(pi);
  registerCanonicalBuiltinFallback(pi);
  registerEditorChrome(pi);
  registerEffortCommand(pi);
  registerExitCommand(pi);
  registerWorkingTokenRate(pi);
}
