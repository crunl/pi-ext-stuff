import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  type ExtensionAPI,
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
 * The four blocks below look like table-fodder, but registerTool infers the
 * tool's schema from the spread argument, so each tool needs its own call
 * site (an `as const` union over factories still fails assignability).
 */
export function registerCodexToolRendering(pi: ExtensionAPI): void {
  const initialCwd = process.cwd();

  const initialRead = createReadToolDefinition(initialCwd);
  pi.registerTool(
    withCodexToolPresentation({
      ...initialRead,
      execute(id, params, signal, onUpdate, ctx) {
        return createReadToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
      },
    }),
  );

  const initialGrep = createGrepToolDefinition(initialCwd);
  pi.registerTool(
    withCodexToolPresentation({
      ...initialGrep,
      execute(id, params, signal, onUpdate, ctx) {
        return createGrepToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
      },
    }),
  );

  const initialFind = createFindToolDefinition(initialCwd);
  pi.registerTool(
    withCodexToolPresentation({
      ...initialFind,
      execute(id, params, signal, onUpdate, ctx) {
        return createFindToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
      },
    }),
  );

  const initialLs = createLsToolDefinition(initialCwd);
  pi.registerTool(
    withCodexToolPresentation({
      ...initialLs,
      execute(id, params, signal, onUpdate, ctx) {
        return createLsToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
      },
    }),
  );
}
