import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEditorChrome } from "./tui/editor-chrome.ts";
import { registerEffortCommand } from "./tui/effort-command.ts";
import { registerExitCommand } from "./tui/exit-command.ts";
import { registerWorkingTokenRate } from "./tui/working-token-rate.ts";

export function registerExtension(pi: ExtensionAPI): void {
  // Everything below goes through public Pi API surface: command registration,
  // setWidget/setWorkingMessage, and the editor chrome (an official
  // CustomEditor subclass installed via setEditorComponent — the mode badge
  // needs a public seam and has one). Tool presentation and codemode tree
  // rendering live in pi-tool-render.
  registerEditorChrome(pi);
  registerEffortCommand(pi);
  registerExitCommand(pi);
  registerWorkingTokenRate(pi);
}
