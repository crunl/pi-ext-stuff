import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtension } from "./src/register.ts";

export default function piCore(pi: ExtensionAPI): void {
  registerExtension(pi);
}

export { registerExtension };
export {
  colorizeEditDiffSummary,
  compactBashStatusSpacing,
  createCodexToolRendering,
  renderEditDiff,
  summarizeEditDiff,
  type CodexToolRendererSpec,
} from "./src/tui/tool-renderer.ts";
