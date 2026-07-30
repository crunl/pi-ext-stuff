/**
 * standalone — the side-effect-free cross-extension surface of pi-core.
 *
 * Import from here (not index.ts, not src/tui/* deep paths) when another
 * extension needs pi-core components without pulling the register graph
 * into its own jiti instance:
 *   - pi-permissions → createCodexToolRendering / createEditDiffBox / …
 *   - statusline     → applyAutocompleteAbove
 *
 * Contract: importing this module (and anything it re-exports) runs no
 * side effects. Host patching only happens when a register/apply/install
 * function is explicitly called.
 */

export { applyAutocompleteAbove } from "./src/tui/autocomplete-above.ts";
export { createEditDiffBox } from "./src/tui/edit-diff.ts";
export {
  colorizeEditDiffSummary,
  compactBashStatusSpacing,
  createCodexToolRendering,
  summarizeEditDiff,
} from "./src/tui/tool-renderer.ts";
