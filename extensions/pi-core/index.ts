import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtension } from "./src/register.ts";

export default function piCore(pi: ExtensionAPI): void {
  registerExtension(pi);
}

export {
  applyAutocompleteAbove,
  frameLines,
  registerAutocompleteAbove,
} from "./src/tui/autocomplete-above.ts";
export {
  createEditDiffBox,
  type EditDiffBoxOptions,
  type EditDiffKind,
  type EditDiffRow,
  parseEditDiff,
} from "./src/tui/edit-diff.ts";
export {
  computePanelRow,
  EditorFloatPanel,
  type EditorFloatPanelShowOptions,
  type FloatingTui,
  locateEditor,
} from "./src/tui/editor-float-panel.ts";
export {
  type CodexToolRendererSpec,
  colorizeEditDiffSummary,
  compactBashStatusSpacing,
  createCodexToolRendering,
  type ExpandedResultRenderer,
  summarizeEditDiff,
} from "./src/tui/tool-renderer.ts";
export { registerExtension };
