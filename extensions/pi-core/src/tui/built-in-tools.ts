import {
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  codexFindToolSpec,
  codexGrepToolSpec,
  codexLsToolSpec,
  codexReadToolSpec,
} from "./codex-tool-specs.ts";
import { createCodexToolRendering } from "./tool-renderer.ts";

export function registerBuiltInToolRendering(pi: ExtensionAPI): void {
  // write / edit / bash are intentionally NOT registered here: pi-permissions
  // registers them because their execute needs the permission gate, and tool
  // registration is first-wins. Their Codex rendering specs (icon, verbs,
  // collapsed summaries) live in codex-tool-specs.ts and are applied there.
  const initialCwd = process.cwd();

  const initialRead = createReadTool(initialCwd);
  pi.registerTool({
    ...initialRead,
    ...createCodexToolRendering(codexReadToolSpec),
    execute(id, params, signal, onUpdate, ctx) {
      return createReadTool(ctx.cwd).execute(id, params, signal, onUpdate);
    },
  });

  const initialGrep = createGrepTool(initialCwd);
  pi.registerTool({
    ...initialGrep,
    ...createCodexToolRendering(codexGrepToolSpec),
    execute(id, params, signal, onUpdate, ctx) {
      return createGrepTool(ctx.cwd).execute(id, params, signal, onUpdate);
    },
  });

  const initialFind = createFindTool(initialCwd);
  pi.registerTool({
    ...initialFind,
    ...createCodexToolRendering(codexFindToolSpec),
    execute(id, params, signal, onUpdate, ctx) {
      return createFindTool(ctx.cwd).execute(id, params, signal, onUpdate);
    },
  });

  const initialLs = createLsTool(initialCwd);
  pi.registerTool({
    ...initialLs,
    ...createCodexToolRendering(codexLsToolSpec),
    execute(id, params, signal, onUpdate, ctx) {
      return createLsTool(ctx.cwd).execute(id, params, signal, onUpdate);
    },
  });
}
