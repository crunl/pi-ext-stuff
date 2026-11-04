/**
 * @crunl/shared-tool-presentation
 *
 * Side-effect-free Codex-style tool rendering specifications, components,
 * and high-order presentation decorators for Pi coding agent tools.
 */

export {
  BADGE_CAP_WIDTH,
  contrastTextFor,
  makeModeBadgeDecorator,
  PL_LEFT,
  PL_RIGHT,
  parseTruecolor,
} from "./badge.ts";
export {
  BASH_GLANCE_BUDGET,
  commandGlance,
  createBashExpandedEvidence,
} from "./bash-evidence.ts";
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
export {
  type OutputPad,
  type OutputPaddingSource,
  outputPaddingController,
  registerOutputPaddingSync,
} from "./output-padding.ts";
export {
  isPermissionsModeEvent,
  type ModeSeverity,
  type PermissionsModeEvent,
  PermissionsModeState,
} from "./permissions-mode.ts";
export {
  highlightShellCommandLines,
  MAX_COMMAND_CHARS,
} from "./shell-command-highlight.ts";
export {
  countStepGroupItems,
  createSettledStepGroupComponent,
  createUnsettledToolStepComponent,
  emptyStepGroupComponent,
  findStepSpanAtY,
  formatStepGroupClauses,
  formatStepGroupHeader,
  formatStepGroupSummaryText,
  isStepGroupToolName,
  type RenderableStepGroupItem,
  renderThoughtStepLines,
  type SettledStepGroupOptions,
  STEP_GROUP_TOOL_NAMES,
  type StepGroupCounts,
  type StepGroupItemDescriptor,
  type StepGroupMouseEvent,
  type StepGroupSpan,
  type StepGroupTheme,
  type StepGroupToolName,
  type UnsettledThoughtItem,
  type UnsettledToolStepOptions,
} from "./step-group.ts";
export {
  type CodexToolRendererSpec,
  createCodexToolRendering,
} from "./tool-renderer.ts";
export { isInteractiveTui } from "./ui-guard.ts";
