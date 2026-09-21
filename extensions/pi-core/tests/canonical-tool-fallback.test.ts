import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CanonicalBuiltinFallbackDependencies,
  CORE_BUILTIN_PRESENTATION_FLAG,
  registerCanonicalBuiltinFallback,
} from "../src/tui/canonical-tool-fallback.ts";

type ToolName = "bash" | "write" | "edit";
type Handler = (event: unknown, context: ExtensionContext) => unknown;

function makeDefinition(name: ToolName, description = `${name} description`) {
  return {
    name,
    label: name,
    description,
    parameters: {
      type: "object",
      properties: { [name]: { type: "string" } },
    },
    promptGuidelines: [`${name} guideline`],
    execute: vi.fn(async () => ({ content: [], details: undefined })),
  };
}

function makeOwner(
  name: ToolName,
  source: string = "builtin",
  description = `${name} description`,
): ToolInfo {
  const definition = makeDefinition(name, description);
  return {
    name,
    description: definition.description,
    parameters: definition.parameters as never,
    promptGuidelines: definition.promptGuidelines,
    sourceInfo: {
      path: source === "builtin" ? `<builtin:${name}>` : `<${source}:${name}>`,
      source,
      scope: "temporary",
      origin: "top-level",
    },
  };
}

function makeContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  return {
    mode: "tui",
    hasUI: true,
    cwd: "/workspace",
    isProjectTrusted: () => true,
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push({ message, type });
      },
    },
    notifications,
    ...overrides,
  } as unknown as ExtensionContext;
}

function makeDependencies(): CanonicalBuiltinFallbackDependencies & {
  settings: {
    drainErrors: ReturnType<typeof vi.fn>;
    getShellPath: ReturnType<typeof vi.fn>;
    getShellCommandPrefix: ReturnType<typeof vi.fn>;
  };
  bashOptions: unknown[];
} {
  const settings = {
    drainErrors: vi.fn(() => []),
    getShellPath: vi.fn(() => "/bin/zsh"),
    getShellCommandPrefix: vi.fn(() => "source ~/.profile &&"),
  };
  const bashOptions: unknown[] = [];
  return {
    createBashToolDefinition: vi.fn((_cwd: string, options: unknown) => {
      bashOptions.push(options);
      return makeDefinition("bash");
    }),
    createWriteToolDefinition: vi.fn(() => makeDefinition("write")),
    createEditToolDefinition: vi.fn(() => makeDefinition("edit")),
    createSettingsManager: vi.fn(() => settings as unknown as SettingsManager),
    getAgentDir: vi.fn(() => "/agent-dir"),
    settings,
    bashOptions,
  } as unknown as CanonicalBuiltinFallbackDependencies & {
    settings: typeof settings;
    bashOptions: unknown[];
  };
}

function makeHarness(owners: ToolInfo[], flag: string = "auto") {
  const handlers = new Map<string, Handler>();
  const registered: Array<{ name: ToolName; renderShell?: string }> = [];
  const setActiveTools = vi.fn();
  let currentOwners = owners;
  const pi = {
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => flag),
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    getAllTools: vi.fn(() => currentOwners),
    setActiveTools,
    registerTool: vi.fn((tool: { name: ToolName; renderShell?: string }) => {
      registered.push(tool);
    }),
  } as unknown as ExtensionAPI;
  return {
    pi,
    handlers,
    registered,
    setActiveTools,
    setOwners(next: ToolInfo[]) {
      currentOwners = next;
    },
  };
}

function sessionStart(harness: ReturnType<typeof makeHarness>, context: ExtensionContext): void {
  const handler = harness.handlers.get("session_start");
  if (!handler) throw new Error("session_start handler was not registered");
  handler({ type: "session_start", reason: "startup" }, context);
}

async function assertPublicRuntimeKeepsExtensionOwner(coreFirst: boolean): Promise<void> {
  const cwd = process.cwd();
  const settingsManager = SettingsManager.inMemory();
  const sentinel: { execute?: unknown } = {};
  const ownerFactory = (pi: ExtensionAPI): void => {
    const definition = createBashToolDefinition(cwd);
    sentinel.execute = definition.execute;
    pi.registerTool({ ...definition, execute: definition.execute });
  };
  const coreFactory = (pi: ExtensionAPI): void => {
    registerCanonicalBuiltinFallback(pi);
  };
  const extensionFactories = coreFirst ? [coreFactory, ownerFactory] : [ownerFactory, coreFactory];
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    extensionFactories,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    settingsManager,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
  });

  try {
    await session.bindExtensions({ mode: "tui", uiContext: {} as never });
    expect(session.getToolDefinition("bash")?.execute).toBe(sentinel.execute);
  } finally {
    session.dispose();
  }
}

describe("canonical builtin presentation fallback", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("registers all three canonical mutating tools in core-only TUI mode", () => {
    const harness = makeHarness([makeOwner("bash"), makeOwner("write"), makeOwner("edit")]);
    registerCanonicalBuiltinFallback(harness.pi, makeDependencies());

    sessionStart(harness, makeContext());

    expect(harness.registered.map((tool) => tool.name)).toEqual(["bash", "write", "edit"]);
    expect(harness.registered.every((tool) => tool.renderShell === "self")).toBe(true);
    expect(harness.setActiveTools).not.toHaveBeenCalled();
  });

  it("does not register outside interactive TUI", () => {
    for (const context of [
      makeContext({ mode: "print" }),
      makeContext({ mode: "rpc" }),
      makeContext({ hasUI: false }),
    ]) {
      const harness = makeHarness([makeOwner("bash"), makeOwner("write"), makeOwner("edit")]);
      registerCanonicalBuiltinFallback(harness.pi, makeDependencies());
      sessionStart(harness, context);
      expect(harness.registered).toHaveLength(0);
    }
  });

  it("skips extension, SDK, and missing owners independently", () => {
    for (const owners of [
      [makeOwner("bash"), makeOwner("write", "extension"), makeOwner("edit", "sdk")],
      [makeOwner("bash")],
    ]) {
      const harness = makeHarness(owners);
      registerCanonicalBuiltinFallback(harness.pi, makeDependencies());
      sessionStart(harness, makeContext());
      expect(harness.registered.map((tool) => tool.name)).toEqual(["bash"]);
    }
  });

  it("requires Pi's synthetic builtin source path as an additional guard", () => {
    const owner = makeOwner("bash");
    owner.sourceInfo.path = "/sdk/base-tools-override";
    const harness = makeHarness([owner]);
    registerCanonicalBuiltinFallback(harness.pi, makeDependencies());
    sessionStart(harness, makeContext());
    expect(harness.registered).toHaveLength(0);
  });

  it("takes the owner snapshot before the first registration refresh", () => {
    const harness = makeHarness([makeOwner("bash"), makeOwner("write"), makeOwner("edit")]);
    const getAllTools = harness.pi.getAllTools as unknown as ReturnType<typeof vi.fn>;
    harness.pi.registerTool = vi.fn((tool: { name: ToolName; renderShell?: string }) => {
      harness.registered.push(tool);
      getAllTools.mockReturnValue([]);
    }) as never;
    registerCanonicalBuiltinFallback(harness.pi, makeDependencies());
    sessionStart(harness, makeContext());
    expect(harness.registered.map((tool) => tool.name)).toEqual(["bash", "write", "edit"]);
  });

  it("skips a builtin whose public metadata differs", () => {
    const harness = makeHarness([
      makeOwner("bash", "builtin", "different description"),
      makeOwner("write"),
      makeOwner("edit"),
    ]);
    const context = makeContext();
    registerCanonicalBuiltinFallback(harness.pi, makeDependencies());
    sessionStart(harness, context);
    expect(harness.registered.map((tool) => tool.name)).toEqual(["write", "edit"]);
    expect((context as unknown as { notifications: unknown[] }).notifications).toHaveLength(1);
  });

  it("passes cwd, agent dir, shell settings, and trust to bash", () => {
    const dependencies = makeDependencies();
    const harness = makeHarness([makeOwner("bash")]);
    const context = makeContext({
      cwd: "/project",
      isProjectTrusted: () => false,
    });
    registerCanonicalBuiltinFallback(harness.pi, dependencies);
    sessionStart(harness, context);

    expect(dependencies.createSettingsManager).toHaveBeenCalledWith("/project", "/agent-dir", {
      projectTrusted: false,
    });
    expect(dependencies.bashOptions).toEqual([
      { shellPath: "/bin/zsh", commandPrefix: "source ~/.profile &&" },
    ]);
  });

  it("skips only bash when settings loading fails", () => {
    const dependencies = makeDependencies();
    dependencies.settings.drainErrors.mockReturnValue([
      { scope: "global", error: new Error("bad") },
    ]);
    const harness = makeHarness([makeOwner("bash"), makeOwner("write"), makeOwner("edit")]);
    const context = makeContext();
    registerCanonicalBuiltinFallback(harness.pi, dependencies);
    sessionStart(harness, context);
    expect(harness.registered.map((tool) => tool.name)).toEqual(["write", "edit"]);
    expect((context as unknown as { notifications: unknown[] }).notifications).toHaveLength(1);
  });

  it("does not touch active tools and honors off/invalid flags", () => {
    const invalidContext = makeContext();
    const invalidHarness = makeHarness(
      [makeOwner("bash"), makeOwner("write"), makeOwner("edit")],
      "invalid",
    );
    registerCanonicalBuiltinFallback(invalidHarness.pi, makeDependencies());
    sessionStart(invalidHarness, invalidContext);
    sessionStart(invalidHarness, invalidContext);
    expect(invalidHarness.registered).toHaveLength(0);
    expect(invalidHarness.setActiveTools).not.toHaveBeenCalled();
    expect(
      (invalidContext as unknown as { notifications: Array<{ message: string }> }).notifications,
    ).toEqual([
      expect.objectContaining({ message: expect.stringContaining("expected auto or off") }),
    ]);

    for (const flag of ["off"] as const) {
      const harness = makeHarness([makeOwner("bash"), makeOwner("write"), makeOwner("edit")], flag);
      registerCanonicalBuiltinFallback(harness.pi, makeDependencies());
      sessionStart(harness, makeContext());
      expect(harness.registered).toHaveLength(0);
      expect(harness.setActiveTools).not.toHaveBeenCalled();
    }
  });

  it("can retry a tool when its first registration throws", () => {
    const harness = makeHarness([makeOwner("bash")]);
    let attempts = 0;
    harness.pi.registerTool = vi.fn((tool: { name: ToolName; renderShell?: string }) => {
      attempts += 1;
      if (attempts === 1) throw new Error("refresh failed");
      harness.registered.push(tool);
    }) as never;
    registerCanonicalBuiltinFallback(harness.pi, makeDependencies());

    expect(() => sessionStart(harness, makeContext())).toThrow("refresh failed");
    sessionStart(harness, makeContext());
    expect(harness.registered.map((tool) => tool.name)).toEqual(["bash"]);
  });

  it("is idempotent across repeated session_start events", () => {
    const harness = makeHarness([makeOwner("bash"), makeOwner("write"), makeOwner("edit")]);
    registerCanonicalBuiltinFallback(harness.pi, makeDependencies());
    sessionStart(harness, makeContext());
    sessionStart(harness, makeContext());
    expect(harness.registered.map((tool) => tool.name)).toEqual(["bash", "write", "edit"]);
  });

  it("does not install a fallback after the owner becomes an extension", () => {
    const harness = makeHarness([makeOwner("bash"), makeOwner("write"), makeOwner("edit")]);
    registerCanonicalBuiltinFallback(harness.pi, makeDependencies());
    sessionStart(harness, makeContext());
    harness.setOwners([
      makeOwner("bash", "extension"),
      makeOwner("write", "extension"),
      makeOwner("edit", "extension"),
    ]);
    sessionStart(harness, makeContext());
    expect(harness.registered).toHaveLength(3);
  });

  it("registers the stable public flag with auto default", () => {
    const harness = makeHarness([]);
    registerCanonicalBuiltinFallback(harness.pi, makeDependencies());
    expect(harness.pi.registerFlag).toHaveBeenCalledWith(
      CORE_BUILTIN_PRESENTATION_FLAG,
      expect.objectContaining({ type: "string", default: "auto" }),
    );
  });

  it("preserves an extension owner in Pi's public runtime in either load order", async () => {
    await assertPublicRuntimeKeepsExtensionOwner(true);
    await assertPublicRuntimeKeepsExtensionOwner(false);
  });
});
