import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withCodexToolPresentation } from "./codex-tool-presentation.ts";

/**
 * Register the Codex-style rendering for the built-in read-only tools.
 *
 * write / edit / bash are handled by canonical-tool-fallback.ts when Pi's
 * canonical definitions remain the effective owner. pi-permissions registers
 * them first when a permission gate is installed; tool registration is
 * first-wins. Both paths use the same side-effect-free presentation decorator.
 *
 * Presentation only: since Pi 0.85.0 the factories' execute() resolves paths
 * against ctx.cwd natively, so the per-call definition rebuilds this module
 * used to carry are dead code — the definitions register as-is.
 *
 * The four call sites below look like table-fodder, but registerTool infers
 * the tool's schema from the spread argument, so each tool needs its own
 * call site (an `as const` union over factories still fails assignability).
 * The shared helper carries only the presentation step.
 */
function registerPresented<P extends ToolDefinition["parameters"], D, S>(
  pi: ExtensionAPI,
  definition: ToolDefinition<P, D, S>,
): void {
  pi.registerTool(withCodexToolPresentation(definition));
}

export function registerCodexToolRendering(pi: ExtensionAPI): void {
  const initialCwd = process.cwd();

  registerPresented(pi, createReadToolDefinition(initialCwd));
  registerPresented(pi, createGrepToolDefinition(initialCwd));
  registerPresented(pi, createFindToolDefinition(initialCwd));
  registerPresented(pi, createLsToolDefinition(initialCwd));
}
