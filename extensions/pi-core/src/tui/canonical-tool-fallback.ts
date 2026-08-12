import {
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  SettingsManager,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { withCodexToolPresentation } from "./codex-tool-presentation.ts";
import { isInteractiveTui } from "./ui-guard.ts";

/** Public flag used to disable the canonical builtin presentation fallback. */
export const CORE_BUILTIN_PRESENTATION_FLAG = "core-builtin-presentation";

type PresentationMode = "auto" | "off";
type CanonicalBuiltinName = "bash" | "write" | "edit";

/** Injectable host seams keep this adapter testable without private Pi imports. */
export interface CanonicalBuiltinFallbackDependencies {
  createBashToolDefinition: typeof createBashToolDefinition;
  createWriteToolDefinition: typeof createWriteToolDefinition;
  createEditToolDefinition: typeof createEditToolDefinition;
  createSettingsManager: (
    cwd: string,
    agentDir: string,
    options: { projectTrusted: boolean },
  ) => SettingsManager;
  getAgentDir: typeof getAgentDir;
}

const defaultDependencies: CanonicalBuiltinFallbackDependencies = {
  createBashToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createSettingsManager: (cwd, agentDir, options) => SettingsManager.create(cwd, agentDir, options),
  getAgentDir,
};

const canonicalNames: readonly CanonicalBuiltinName[] = ["bash", "write", "edit"];

type ToolInfoSnapshot = Readonly<ToolInfo>;
type ToolMetadata = Pick<ToolInfo, "name" | "description" | "parameters" | "promptGuidelines">;

/**
 * Register a Codex presentation for canonical Pi mutating tools when no
 * extension has claimed them. This adapter never changes the active tool set.
 */
export function registerCanonicalBuiltinFallback(
  pi: ExtensionAPI,
  dependencies: CanonicalBuiltinFallbackDependencies = defaultDependencies,
): void {
  pi.registerFlag(CORE_BUILTIN_PRESENTATION_FLAG, {
    type: "string",
    default: "auto",
    description: "Render Pi's canonical bash/write/edit tools with pi-core presentation (auto|off)",
  });

  const warned = new Set<string>();
  const installed = new Set<CanonicalBuiltinName>();
  pi.on("session_start", (_event, ctx) => {
    if (!isInteractiveTui(ctx)) return;

    const mode = readPresentationMode(pi.getFlag(CORE_BUILTIN_PRESENTATION_FLAG), ctx, warned);
    if (mode !== "auto") return;

    // Capture every owner before the first registerTool() refreshes Pi's
    // first-wins registry. Decisions below intentionally use only this map.
    const owners = new Map(
      snapshotToolInfos(pi.getAllTools()).map((tool) => [tool.name, tool] as const),
    );

    registerCanonicalCandidates(pi, owners, ctx, dependencies, warned, installed);
  });
}

function readPresentationMode(
  value: boolean | string | undefined,
  ctx: ExtensionContext,
  warned: Set<string>,
): PresentationMode {
  if (value === undefined || value === "auto") return "auto";
  if (value === "off") return "off";

  warnOnce(
    ctx,
    warned,
    "invalid-flag",
    `pi-core: ignoring invalid --${CORE_BUILTIN_PRESENTATION_FLAG} value; expected auto or off`,
  );
  return "off";
}

function registerCanonicalCandidates(
  pi: ExtensionAPI,
  owners: ReadonlyMap<string, ToolInfoSnapshot>,
  ctx: ExtensionContext,
  dependencies: CanonicalBuiltinFallbackDependencies,
  warned: Set<string>,
  installed: Set<CanonicalBuiltinName>,
): void {
  for (const name of canonicalNames) {
    if (installed.has(name)) continue;
    const owner = owners.get(name);
    if (!owner || !isCanonicalBuiltin(owner, name)) continue;

    if (name === "write") {
      const definition = dependencies.createWriteToolDefinition(ctx.cwd);
      registerIfCanonical(pi, name, owner, definition, ctx, warned, installed);
      continue;
    }

    if (name === "edit") {
      const definition = dependencies.createEditToolDefinition(ctx.cwd);
      registerIfCanonical(pi, name, owner, definition, ctx, warned, installed);
      continue;
    }

    const definition = resolveBashCanonicalDefinition(ctx, dependencies, warned);
    if (definition) registerIfCanonical(pi, name, owner, definition, ctx, warned, installed);
  }
}

function resolveBashCanonicalDefinition(
  ctx: ExtensionContext,
  dependencies: CanonicalBuiltinFallbackDependencies,
  warned: Set<string>,
): ReturnType<typeof createBashToolDefinition> | undefined {
  try {
    // ExtensionContext does not expose the host SettingsManager. Recreating it
    // is equivalent for the standard file-backed CLI; SDK hosts with injected
    // settings must disable this fallback via core-builtin-presentation=off.
    const settings = dependencies.createSettingsManager(ctx.cwd, dependencies.getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    const settingsErrors = settings.drainErrors();
    if (settingsErrors.length > 0) {
      return skipBashForSettings(ctx, warned);
    }

    return dependencies.createBashToolDefinition(ctx.cwd, {
      shellPath: settings.getShellPath(),
      commandPrefix: settings.getShellCommandPrefix(),
    });
  } catch {
    return skipBashForSettings(ctx, warned);
  }
}

function skipBashForSettings(ctx: ExtensionContext, warned: Set<string>): undefined {
  warnOnce(
    ctx,
    warned,
    "bash-settings",
    "pi-core: skipped bash presentation because Pi settings could not be loaded",
  );
  return undefined;
}

function registerIfCanonical<P extends ToolDefinition["parameters"], D, S>(
  pi: ExtensionAPI,
  name: CanonicalBuiltinName,
  owner: ToolInfoSnapshot,
  definition: ToolDefinition<P, D, S>,
  ctx: ExtensionContext,
  warned: Set<string>,
  installed: Set<CanonicalBuiltinName>,
): void {
  if (!matchesCanonicalMetadata(owner, definition)) {
    warnOnce(
      ctx,
      warned,
      `metadata-${name}`,
      `pi-core: skipped ${name} presentation because Pi's canonical metadata differs`,
    );
    return;
  }

  pi.registerTool(withCodexToolPresentation(definition));
  installed.add(name);
}

function isCanonicalBuiltin(owner: ToolInfoSnapshot, name: CanonicalBuiltinName): boolean {
  return owner.sourceInfo.source === "builtin" && owner.sourceInfo.path === `<builtin:${name}>`;
}

function matchesCanonicalMetadata(owner: ToolInfoSnapshot, definition: ToolMetadata): boolean {
  return (
    owner.name === definition.name &&
    owner.description === definition.description &&
    sameValue(owner.parameters, definition.parameters) &&
    sameValue(owner.promptGuidelines, definition.promptGuidelines)
  );
}

function snapshotToolInfos(tools: ToolInfo[]): ToolInfoSnapshot[] {
  return Object.freeze(
    tools.map((tool) =>
      Object.freeze({
        ...tool,
        promptGuidelines: tool.promptGuidelines
          ? Object.freeze([...tool.promptGuidelines])
          : undefined,
        sourceInfo: Object.freeze({ ...tool.sourceInfo }),
      }),
    ),
  ) as unknown as ToolInfoSnapshot[];
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }

  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
    );
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && sameValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function warnOnce(ctx: ExtensionContext, warned: Set<string>, key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  ctx.ui.notify(message, "warning");
}
