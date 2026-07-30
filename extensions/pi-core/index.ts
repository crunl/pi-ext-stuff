import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtension } from "./src/register.ts";

/**
 * pi-core extension entry. Named barrel exports are the cross-extension public
 * surface only — see consumers:
 *   - pi-permissions → createCodexToolRendering / createEditDiffBox / …
 *   - statusline → applyAutocompleteAbove (deep-imports src/tui/ to avoid
 *     pulling this register graph into statusline's jiti instance)
 *
 * Internal helpers stay importable from src/tui/* for tests and in-tree use.
 */
export default function piCore(pi: ExtensionAPI): void {
  registerExtension(pi);
}

export { applyAutocompleteAbove } from "./src/tui/autocomplete-above.ts";
export { createEditDiffBox } from "./src/tui/edit-diff.ts";
export {
  colorizeEditDiffSummary,
  compactBashStatusSpacing,
  createCodexToolRendering,
  summarizeEditDiff,
} from "./src/tui/tool-renderer.ts";
