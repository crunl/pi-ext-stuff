import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOutputPaddingSync } from "../../../packages/shared-tool-presentation/src/index.ts";
import { registerCodexToolRendering } from "./built-in-tools.ts";
import { registerCanonicalBuiltinFallback } from "./canonical-tool-fallback.ts";
import { registerCodemodeTreeTool } from "./codemode-tool.ts";
import { registerStepGroupFold } from "./step-group-fold.ts";

export function registerExtension(pi: ExtensionAPI): void {
  // Order is load-bearing:
  // 1. registerOutputPaddingSync precedes registerCodexToolRendering so the
  //    shared padding controller is tracked when tool rows render.
  // 2. registerCanonicalBuiltinFallback follows the read-only and codemode
  //    registrations so its session_start snapshot sees all effective tool
  //    owners before any fallback registration.
  // 3. registerStepGroupFold wraps resolved built-in tool renderers and syncs
  //    session branch history after canonical fallback registration on session_start.
  registerOutputPaddingSync(pi);
  registerCodexToolRendering(pi);
  registerCodemodeTreeTool(pi);
  registerCanonicalBuiltinFallback(pi);
  registerStepGroupFold(pi);
}
