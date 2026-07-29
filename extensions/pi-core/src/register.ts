import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutocompleteAbove } from "./tui/autocomplete-above.ts";
import { registerBuiltInToolRendering } from "./tui/built-in-tools.ts";
import { registerOutputPaddingSync } from "./tui/output-padding.ts";
import { registerSelectorTabNav } from "./tui/selector-tab-nav.ts";

export function registerExtension(pi: ExtensionAPI): void {
  registerOutputPaddingSync(pi);
  registerBuiltInToolRendering(pi);
  registerAutocompleteAbove(pi);
  registerSelectorTabNav(pi);
}
