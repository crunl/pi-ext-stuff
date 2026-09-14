import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutocompleteAbove } from "./tui/autocomplete-above.ts";
import { registerCodexToolRendering } from "./tui/built-in-tools.ts";
import { registerCanonicalBuiltinFallback } from "./tui/canonical-tool-fallback.ts";
import { registerEffortCommand } from "./tui/effort-command.ts";
import { registerExitCommand } from "./tui/exit-command.ts";
import { applyMarkdownCodeFrame } from "./tui/markdown-code-frame.ts";
import { registerOutputPaddingSync } from "./tui/output-padding.ts";
import { registerSelectorTabNav } from "./tui/selector-tab-nav.ts";
import { registerUserMessageBar } from "./tui/user-message-bar.ts";
import { registerWorkingTokenRate } from "./tui/working-token-rate.ts";

export function registerExtension(pi: ExtensionAPI): void {
  registerOutputPaddingSync(pi);
  registerCodexToolRendering(pi);
  registerCanonicalBuiltinFallback(pi);
  registerAutocompleteAbove(pi);
  registerSelectorTabNav(pi);
  registerEffortCommand(pi);
  registerExitCommand(pi);
  registerWorkingTokenRate(pi);
  applyMarkdownCodeFrame();
  registerUserMessageBar(pi);
}
