/**
 * @crunl/shared-tool-presentation
 *
 * Side-effect-free Codex-style tool rendering specifications, components,
 * and high-order presentation decorators for Pi coding agent tools.
 */

export { withCodexToolPresentation } from "./codex-tool-presentation.ts";
export {
  codexBashToolSpec,
  codexEditToolSpec,
  codexFindToolSpec,
  codexGrepToolSpec,
  codexLsToolSpec,
  codexReadToolSpec,
  codexWriteToolSpec,
  colorizeEditDiffSummary,
  colorizeWriteSummary,
  compactBashStatusSpacing,
  countWrittenLines,
  displayPath,
  summarizeBashOutput,
  summarizeEditDiff,
} from "./codex-tool-specs.ts";
export { createEditDiffBox, parseEditDiff } from "./edit-diff.ts";
export { createBashExpandedEvidence, commandGlance, BASH_GLANCE_BUDGET } from "./bash-evidence.ts";
export { highlightShellCommandLines, MAX_COMMAND_CHARS } from "./shell-command-highlight.ts";
export {
  createCodexToolRendering,
  type CodexToolRendererSpec,
} from "./tool-renderer.ts";
export { type OutputPad, type OutputPaddingSource } from "./output-padding.ts";
