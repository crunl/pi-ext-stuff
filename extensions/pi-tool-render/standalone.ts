/**
 * standalone — the side-effect-free cross-extension surface of pi-tool-render.
 *
 * Import from here (not index.ts, not src/* deep paths) when another
 * extension needs tool-presentation modules without pulling the register
 * graph into its own jiti instance:
 *   - pi-safety → withCodexToolPresentation / createCodexToolRendering / …
 *   - permission UIs → markToolCall
 *
 * Contract: importing this module (and anything it re-exports) runs no
 * host patching. Host registration only happens when a register* function is
 * explicitly called.
 */

export {
  codexBashToolSpec,
  codexEditToolSpec,
  codexWriteToolSpec,
  colorizeEditDiffSummary,
  compactBashStatusSpacing,
  createCodexToolRendering,
  createEditDiffBox,
  summarizeEditDiff,
  withCodexToolPresentation,
} from "../../packages/shared-tool-presentation/src/index.ts";
export { markToolCall, type ToolCallMark } from "./src/tool-call-mark.ts";
