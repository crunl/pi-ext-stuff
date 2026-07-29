import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBuiltInToolRendering } from "./tui/built-in-tools.ts";
import { registerOutputPaddingSync } from "./tui/output-padding.ts";

export function registerExtension(pi: ExtensionAPI): void {
  registerOutputPaddingSync(pi);
  registerBuiltInToolRendering(pi);
}
