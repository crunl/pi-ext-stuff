import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  codexBashToolSpec,
  codexEditToolSpec,
  codexFindToolSpec,
  codexGrepToolSpec,
  codexLsToolSpec,
  codexReadToolSpec,
  codexWriteToolSpec,
} from "./codex-tool-specs.ts";
import { createCodexToolRendering } from "./tool-renderer.ts";

/**
 * The built-in tools for which pi-core owns a Codex-style presentation.
 *
 * This map is deliberately private. Callers should provide a complete tool
 * definition to `withCodexToolPresentation`, rather than selecting a spec and
 * assembling a partial definition themselves.
 */
const codexToolSpecs = {
  bash: codexBashToolSpec,
  edit: codexEditToolSpec,
  find: codexFindToolSpec,
  grep: codexGrepToolSpec,
  ls: codexLsToolSpec,
  read: codexReadToolSpec,
  write: codexWriteToolSpec,
} as const;

/**
 * Apply pi-core's presentation to a complete built-in tool definition.
 *
 * The definition remains the authority for execution, schema, prompt metadata,
 * and execution policy. Only the three renderer fields are replaced. Keeping
 * this operation as a side-effect-free decorator lets a permission extension
 * build its secure definition first and add presentation last.
 */
export function withCodexToolPresentation<P extends ToolDefinition["parameters"], D>(
  definition: ToolDefinition<P, D>,
): ToolDefinition<P, D> {
  if (!Object.hasOwn(codexToolSpecs, definition.name)) {
    throw new Error(`pi-core: no Codex presentation is registered for tool "${definition.name}"`);
  }

  const spec = codexToolSpecs[definition.name as keyof typeof codexToolSpecs];

  const rendering = createCodexToolRendering(spec);
  return {
    ...definition,
    ...rendering,
  } as ToolDefinition<P, D>;
}
