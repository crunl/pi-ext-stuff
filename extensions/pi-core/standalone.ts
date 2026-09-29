/**
 * standalone — the side-effect-free cross-extension surface of pi-core.
 *
 * Import from here (not index.ts, not src/tui/* deep paths) when another
 * extension needs pi-core components without pulling the register graph
 * into its own jiti instance:
 *   - pi-safety → withCodexToolPresentation / createCodexToolRendering / …
 *   - permission UIs → markToolCall
 *
 * Contract: importing this module (and anything it re-exports) runs no
 * side effects. Host patching only happens when a register/apply/install
 * function is explicitly called.
 */

export { applyAutocompleteAbove } from "./src/tui/autocomplete-above.ts";
export {
  withCodexToolPresentation,
  codexBashToolSpec,
  codexEditToolSpec,
  codexWriteToolSpec,
  colorizeEditDiffSummary,
  compactBashStatusSpacing,
  summarizeEditDiff,
  createEditDiffBox,
  createCodexToolRendering,
} from "../../packages/shared-tool-presentation/src/index.ts";
export { markToolCall, type ToolCallMark } from "./src/tui/tool-call-mark.ts";
