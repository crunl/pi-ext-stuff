import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  codexFindToolSpec,
  codexGrepToolSpec,
  codexLsToolSpec,
  codexReadToolSpec,
} from "./codex-tool-specs.ts";
import { createCodexToolRendering } from "./tool-renderer.ts";

/**
 * Register the Codex-style rendering for the built-in read-only tools.
 *
 * write / edit / bash are intentionally NOT registered here: pi-permissions
 * registers them because their execute needs the permission gate, and tool
 * registration is first-wins. Their Codex rendering specs (icon, verbs,
 * collapsed summaries) live in codex-tool-specs.ts and are applied there.
 *
 * The four blocks below look like table-fodder, but registerTool infers the
 * tool's schema from the spread argument, so each tool needs its own call
 * site (an `as const` union over factories still fails assignability).
 */
export function registerCodexToolRendering(pi: ExtensionAPI): void {
  const initialCwd = process.cwd();

  const initialRead = createReadToolDefinition(initialCwd);
  pi.registerTool({
    ...initialRead,
    ...createCodexToolRendering(codexReadToolSpec),
    execute(id, params, signal, onUpdate, ctx) {
      return createReadToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
    },
  });

  const initialGrep = createGrepToolDefinition(initialCwd);
  pi.registerTool({
    ...initialGrep,
    ...createCodexToolRendering(codexGrepToolSpec),
    execute(id, params, signal, onUpdate, ctx) {
      return createGrepToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
    },
  });

  const initialFind = createFindToolDefinition(initialCwd);
  pi.registerTool({
    ...initialFind,
    ...createCodexToolRendering(codexFindToolSpec),
    execute(id, params, signal, onUpdate, ctx) {
      return createFindToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
    },
  });

  const initialLs = createLsToolDefinition(initialCwd);
  pi.registerTool({
    ...initialLs,
    ...createCodexToolRendering(codexLsToolSpec),
    execute(id, params, signal, onUpdate, ctx) {
      return createLsToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
    },
  });
}
