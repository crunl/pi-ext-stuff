/**
 * standalone — the side-effect-free cross-extension surface of pi-core.
 *
 * Import from here (not index.ts, not src/tui/* deep paths) when another
 * extension needs pi-core components without pulling the register graph
 * into its own jiti instance:
 *   - pi-permissions → withCodexToolPresentation / createCodexToolRendering / …
 *   - permission UIs → markToolCall
 *   - statusline     → applyAutocompleteAbove / outputPaddingController
 *
 * Contract: importing this module (and anything it re-exports) runs no
 * side effects. Host patching only happens when a register/apply/install
 * function is explicitly called.
 */

export { applyAutocompleteAbove } from "./src/tui/autocomplete-above.ts";
export { withCodexToolPresentation } from "./src/tui/codex-tool-presentation.ts";
/**
 * @deprecated Migration-compatibility surface: these piecewise spec/helper
 * exports predate `withCodexToolPresentation`, which decorates a complete
 * tool definition in one step. Retained for existing consumers; prefer the
 * decorator for new code.
 */
export {
  codexBashToolSpec,
  codexEditToolSpec,
  codexWriteToolSpec,
  colorizeEditDiffSummary,
  compactBashStatusSpacing,
  summarizeEditDiff,
} from "./src/tui/codex-tool-specs.ts";
export { createEditDiffBox } from "./src/tui/edit-diff.ts";
/** Shared live `outputPad` (0|1); started by pi-core's register graph. */
export { outputPaddingController } from "./src/tui/output-padding.ts";
export { markToolCall, type ToolCallMark } from "./src/tui/tool-call-mark.ts";
export { createCodexToolRendering } from "./src/tui/tool-renderer.ts";
