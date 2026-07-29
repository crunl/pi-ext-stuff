import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtension } from "./src/register.ts";

export default function piCore(pi: ExtensionAPI): void {
  registerExtension(pi);
}

export { registerExtension };
export {
  createEditDiffBox,
  parseEditDiff,
  type EditDiffBoxOptions,
  type EditDiffKind,
  type EditDiffRow,
} from "./src/tui/edit-diff.ts";
export {
  colorizeEditDiffSummary,
  compactBashStatusSpacing,
  createCodexToolRendering,
  renderEditDiff,
  summarizeEditDiff,
  type CodexToolRendererSpec,
  type ExpandedResultRenderer,
} from "./src/tui/tool-renderer.ts";
