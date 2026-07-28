import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerExtension } from "../src/register.ts";
import {
  AutoReviewerFailure,
  type AutoReviewer,
} from "../src/auto-reviewer.ts";

function harness(
  agentDir: string,
  approved = false,
  hasUI = true,
  localProxyPorts: { http?: number; socks?: number } = {},
  sandboxCoordinator?: {
    runShared<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
    runExclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  },
  reviewer?: AutoReviewer,
) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, { handler: (...args: any[]) => any }>();
  const tools = new Map<string, any>();
  const setStatus = vi.fn();
  const notify = vi.fn();
  const confirm = vi.fn(async () => approved);
  const sandboxManager = {
    initialize: vi.fn(async (_config: unknown) => undefined),
    wrapWithSandbox: vi.fn(async (command: string) => command),
    reset: vi.fn(async () => undefined),
  };
  const bashExecute = vi.fn(async () => ({ content: [], details: undefined }));
  const bashToolFactory = vi.fn((_cwd: string, _options?: unknown) => ({
    name: "bash",
    label: "bash",
    description: "bash",
    parameters: {},
    execute: bashExecute,
  }));
  const filteringProxy = {
    ports: { http: 45670, socks: 45671 },
    close: vi.fn(async () => undefined),
  };
  const filteringProxyFactory = vi.fn(async () => filteringProxy);
  const appendEntry = vi.fn();
  const autoReviewer = reviewer ?? {
    review: vi.fn(async () => ({
      decision: "approve" as const,
      risk: "low" as const,
      rationale: "Authorized.",
    })),
  };
  const pi = {
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    registerCommand: (name: string, command: { handler: (...args: any[]) => any }) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    appendEntry,
  };
  registerExtension(pi as any, {
    agentDir,
    sandboxManager,
    bashToolFactory: bashToolFactory as any,
    localProxyPorts,
    filteringProxyFactory,
    sandboxCoordinator,
    autoReviewer,
  });
  const context = {
    cwd: agentDir,
    hasUI,
    mode: hasUI ? "tui" : "print",
    isProjectTrusted: () => false,
    isIdle: () => true,
    sessionManager: { getBranch: () => [] },
    modelRegistry: {},
    model: undefined,
    signal: undefined,
    ui: { setStatus, notify, confirm },
  };
  return {
    handlers,
    commands,
    tools,
    context,
    setStatus,
    notify,
    confirm,
    sandboxManager,
    bashToolFactory,
    bashExecute,
    filteringProxy,
    filteringProxyFactory,
    appendEntry,
    autoReviewer,
  };
}

describe("Default mode registration", () => {
  it("loads Default mode and exposes status commands", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const app = harness(agentDir);

    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);

    expect(app.setStatus).toHaveBeenCalledWith("pi-permissions", "Default");
    expect(app.commands.has("default")).toBe(true);
    expect(app.commands.has("permissions")).toBe(true);
    expect(app.tools.has("bash")).toBe(true);
    expect(app.tools.has("write")).toBe(true);
    expect(app.tools.has("edit")).toBe(true);
    expect(app.tools.get("write").executionMode).toBe("sequential");
    expect(app.tools.get("edit").executionMode).toBe("sequential");
    expect(app.tools.get("bash").parameters.properties).toHaveProperty("sandbox_permissions");
    expect(app.tools.get("bash").parameters.properties).toHaveProperty("additional_permissions");
    expect(app.tools.get("bash").parameters.properties).toHaveProperty("justification");
    expect(app.sandboxManager.initialize).toHaveBeenCalledOnce();
  });

  it("leaves explicit user !bash outside the extension sandbox", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const app = harness(agentDir);

    expect(app.handlers.has("user_bash")).toBe(false);
  });

  it("rolls back the active policy when a config reload cannot initialize", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const app = harness(agentDir);
    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);
    await writeFile(
      join(agentDir, "permissions.json"),
      JSON.stringify({ sandbox: { network: { allowedDomains: ["candidate.example"] } } }),
    );
    app.sandboxManager.initialize.mockImplementation(async (config: any) => {
      if (config.network.allowedDomains.includes("candidate.example")) {
        throw new Error("candidate rejected");
      }
    });

    await app.commands.get("default")?.handler("", app.context);
    await app.tools.get("bash").execute(
      "after-rollback",
      { command: "pwd" },
      undefined,
      undefined,
      app.context,
    );

    expect(app.sandboxManager.initialize).toHaveBeenCalledTimes(3);
    expect(app.sandboxManager.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        network: expect.objectContaining({ allowedDomains: [] }),
      }),
    );
    expect(app.notify).toHaveBeenCalledWith(
      expect.stringContaining("candidate rejected"),
      "error",
    );
    expect(app.bashExecute).toHaveBeenCalledOnce();
  });

  it("executes native write through sandbox operations", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const project = await mkdtemp(join(tmpdir(), "pi-permissions-project-"));
    const app = harness(agentDir);
    app.context.cwd = project;
    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);

    await app.tools.get("write").execute(
      "write-1",
      { path: "note.txt", content: "native sandbox" },
      undefined,
      undefined,
      app.context,
    );

    expect(await readFile(join(project, "note.txt"), "utf8")).toBe("native sandbox");
    expect(app.sandboxManager.wrapWithSandbox).toHaveBeenCalled();
  });

  it("allows LOW calls and blocks a denied approval", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const app = harness(agentDir, false);
    const handler = app.handlers.get("tool_call")!;

    await expect(handler({ toolName: "read", input: { path: "README.md" } }, app.context))
      .resolves.toBeUndefined();
    await expect(handler({ toolName: "bash", input: { command: "rm -rf build" } }, app.context))
      .resolves.toMatchObject({ block: true });
    expect(app.confirm).toHaveBeenCalledOnce();
  });

  it("routes only Default prompts through Auto reviewer", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    await writeFile(
      join(agentDir, "permissions.json"),
      JSON.stringify({ defaultMode: "auto" }),
    );
    const reviewer = {
      review: vi.fn(async () => ({
        decision: "approve" as const,
        risk: "low" as const,
        rationale: "The requested cleanup is authorized.",
      })),
    };
    const app = harness(agentDir, false, true, {}, undefined, reviewer);
    await app.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      app.context,
    );

    await expect(
      app.handlers.get("tool_call")!(
        {
          toolName: "bash",
          toolCallId: "auto-1",
          input: { command: "rm -rf build" },
        },
        app.context,
      ),
    ).resolves.toBeUndefined();

    expect(reviewer.review).toHaveBeenCalledOnce();
    expect(app.confirm).not.toHaveBeenCalled();
  });

  it("never sends deterministic blocks to the reviewer", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    await writeFile(
      join(agentDir, "permissions.json"),
      JSON.stringify({ defaultMode: "auto" }),
    );
    const reviewer = { review: vi.fn() };
    const app = harness(agentDir, false, true, {}, undefined, reviewer);
    await app.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      app.context,
    );

    await expect(
      app.handlers.get("tool_call")!(
        {
          toolName: "read",
          toolCallId: "secret",
          input: { path: ".env" },
        },
        app.context,
      ),
    ).resolves.toMatchObject({ block: true });

    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it("binds automatic approval to one exact execution", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    await writeFile(
      join(agentDir, "permissions.json"),
      JSON.stringify({ defaultMode: "auto" }),
    );
    const app = harness(agentDir, false, true);
    await app.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      app.context,
    );
    const event = {
      toolName: "bash",
      toolCallId: "bound-auto",
      input: { command: "rm -rf build" },
    };
    await app.handlers.get("tool_call")!(event, app.context);
    await app.tools.get("bash").execute(
      "bound-auto",
      event.input,
      undefined,
      undefined,
      app.context,
    );

    await expect(
      app.tools.get("bash").execute(
        "bound-auto",
        event.input,
        undefined,
        undefined,
        app.context,
      ),
    ).rejects.toThrow("no longer authorized");
  });

  it("returns reviewer denial to the agent and never executes", async () => {
    const reviewer = {
      review: vi.fn(async () => ({
        decision: "deny" as const,
        risk: "high" as const,
        rationale: "Production deletion was not requested.",
      })),
    };
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    await writeFile(
      join(agentDir, "permissions.json"),
      JSON.stringify({ defaultMode: "auto" }),
    );
    const app = harness(agentDir, false, true, {}, undefined, reviewer);
    await app.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      app.context,
    );

    await expect(
      app.handlers.get("tool_call")!(
        {
          toolName: "bash",
          toolCallId: "denied-auto",
          input: { command: "rm -rf build" },
        },
        app.context,
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining(
        "Production deletion was not requested.",
      ),
    });
    expect(app.bashExecute).not.toHaveBeenCalled();
  });

  it("falls back to human approval when the reviewer is unavailable", async () => {
    const reviewer = {
      review: vi.fn(async () => {
        throw new AutoReviewerFailure("timeout", "review timed out");
      }),
    };
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    await writeFile(
      join(agentDir, "permissions.json"),
      JSON.stringify({ defaultMode: "auto" }),
    );
    const app = harness(agentDir, true, true, {}, undefined, reviewer);
    await app.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      app.context,
    );

    await expect(
      app.handlers.get("tool_call")!(
        {
          toolName: "bash",
          toolCallId: "fallback",
          input: { command: "rm -rf build" },
        },
        app.context,
      ),
    ).resolves.toBeUndefined();
    expect(app.confirm).toHaveBeenCalledWith(
      expect.stringContaining("HARD"),
      expect.stringContaining("review timed out"),
    );
  });

  it("fails closed on reviewer failure without dialog-capable UI", async () => {
    const reviewer = {
      review: vi.fn(async () => {
        throw new AutoReviewerFailure("provider", "provider unavailable");
      }),
    };
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    await writeFile(
      join(agentDir, "permissions.json"),
      JSON.stringify({ defaultMode: "auto" }),
    );
    const app = harness(agentDir, false, false, {}, undefined, reviewer);
    await app.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      app.context,
    );

    await expect(
      app.handlers.get("tool_call")!(
        {
          toolName: "bash",
          toolCallId: "headless-fallback",
          input: { command: "rm -rf build" },
        },
        app.context,
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining("provider unavailable"),
    });
  });

  it("pauses after three denials and /auto explicitly resumes", async () => {
    const reviewer = {
      review: vi.fn(async () => ({
        decision: "deny" as const,
        risk: "high" as const,
        rationale: "Not authorized.",
      })),
    };
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    await writeFile(
      join(agentDir, "permissions.json"),
      JSON.stringify({ defaultMode: "auto" }),
    );
    const app = harness(agentDir, false, true, {}, undefined, reviewer);
    await app.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      app.context,
    );

    for (const id of ["deny-1", "deny-2", "deny-3"]) {
      await app.handlers.get("tool_call")!(
        {
          toolName: "bash",
          toolCallId: id,
          input: { command: "rm -rf build" },
        },
        app.context,
      );
    }
    app.confirm.mockResolvedValueOnce(false);
    await app.handlers.get("tool_call")!(
      {
        toolName: "bash",
        toolCallId: "paused-human",
        input: { command: "rm -rf build" },
      },
      app.context,
    );
    expect(reviewer.review).toHaveBeenCalledTimes(3);
    expect(app.confirm).toHaveBeenCalledOnce();

    await app.commands.get("auto")!.handler("", app.context);
    await app.handlers.get("tool_call")!(
      {
        toolName: "bash",
        toolCallId: "resumed-auto",
        input: { command: "rm -rf build" },
      },
      app.context,
    );
    expect(reviewer.review).toHaveBeenCalledTimes(4);
  });

  it("shows only the active mode in status", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const app = harness(agentDir);
    await app.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      app.context,
    );
    await app.commands.get("auto")!.handler("", app.context);
    expect(app.setStatus).toHaveBeenLastCalledWith("pi-permissions", "Auto");
    await app.commands.get("default")!.handler("", app.context);
    expect(app.setStatus).toHaveBeenLastCalledWith(
      "pi-permissions",
      "Default",
    );
  });

  it("invalidates a late Auto approval when mode changes", async () => {
    let resolveReview!: (value: {
      decision: "approve";
      risk: "low";
      rationale: string;
    }) => void;
    const reviewer = {
      review: vi.fn(
        async () =>
          new Promise<{
            decision: "approve";
            risk: "low";
            rationale: string;
          }>((resolvePromise) => {
            resolveReview = resolvePromise;
          }),
      ),
    };
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    await writeFile(
      join(agentDir, "permissions.json"),
      JSON.stringify({ defaultMode: "auto" }),
    );
    const app = harness(agentDir, false, true, {}, undefined, reviewer);
    await app.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      app.context,
    );
    const event = {
      toolName: "bash",
      toolCallId: "late-mode-change",
      input: { command: "rm -rf build" },
    };
    const pending = app.handlers.get("tool_call")!(event, app.context);
    await vi.waitFor(() => expect(reviewer.review).toHaveBeenCalledOnce());

    await app.commands.get("default")!.handler("", app.context);
    resolveReview({
      decision: "approve",
      risk: "low",
      rationale: "Late approval.",
    });

    await expect(pending).resolves.toMatchObject({ block: true });
    await expect(
      app.tools.get("bash").execute(
        event.toolCallId,
        event.input,
        undefined,
        undefined,
        app.context,
      ),
    ).rejects.toThrow("no longer authorized");
    expect(app.bashExecute).not.toHaveBeenCalled();
  });

  it("invalidates a late Auto approval on session shutdown", async () => {
    let resolveReview!: (value: {
      decision: "approve";
      risk: "low";
      rationale: string;
    }) => void;
    const reviewer = {
      review: vi.fn(
        async () =>
          new Promise<{
            decision: "approve";
            risk: "low";
            rationale: string;
          }>((resolvePromise) => {
            resolveReview = resolvePromise;
          }),
      ),
    };
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    await writeFile(
      join(agentDir, "permissions.json"),
      JSON.stringify({ defaultMode: "auto" }),
    );
    const app = harness(agentDir, false, true, {}, undefined, reviewer);
    await app.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      app.context,
    );
    const event = {
      toolName: "bash",
      toolCallId: "late-shutdown",
      input: { command: "rm -rf build" },
    };
    const pending = app.handlers.get("tool_call")!(event, app.context);
    await vi.waitFor(() => expect(reviewer.review).toHaveBeenCalledOnce());

    await app.handlers.get("session_shutdown")?.(
      { type: "session_shutdown" },
      app.context,
    );
    resolveReview({
      decision: "approve",
      risk: "low",
      rationale: "Late approval.",
    });

    await expect(pending).resolves.toMatchObject({ block: true });
    expect(app.bashExecute).not.toHaveBeenCalled();
  });

  it("executes an approved call and fails closed without UI", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const approved = harness(agentDir, true);
    const headless = harness(agentDir, false, false);
    const event = { toolName: "bash", input: { command: "rm -rf build" } };

    await expect(approved.handlers.get("tool_call")!(event, approved.context)).resolves.toBeUndefined();
    await expect(headless.handlers.get("tool_call")!(event, headless.context))
      .resolves.toMatchObject({ block: true, reason: expect.stringContaining("interactive approval") });
  });

  it("rejects an approved call after a successful policy reload changes its decision", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const app = harness(agentDir, true);
    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);
    const event = {
      toolName: "bash",
      toolCallId: "stale-approval",
      input: { command: "rm -rf build" },
    };

    await expect(app.handlers.get("tool_call")!(event, app.context)).resolves.toBeUndefined();
    await writeFile(
      join(agentDir, "permissions.json"),
      JSON.stringify({ rules: [{ action: "deny", tool: "bash", pattern: "rm *" }] }),
    );
    await app.commands.get("default")!.handler("", app.context);

    await expect(app.tools.get("bash").execute(
      "stale-approval",
      event.input,
      undefined,
      undefined,
      app.context,
    )).rejects.toThrow("no longer authorized");
    expect(app.bashExecute).not.toHaveBeenCalled();
  });

  it("revalidates an approval after acquiring the execution lease", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    let beforeShared: (() => Promise<void>) | undefined;
    const coordinator = {
      async runShared<T>(operation: () => Promise<T>): Promise<T> {
        const hook = beforeShared;
        beforeShared = undefined;
        await hook?.();
        return operation();
      },
      async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        return operation();
      },
    };
    const app = harness(agentDir, true, true, {}, coordinator);
    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);
    const event = {
      toolName: "bash",
      toolCallId: "lease-race",
      input: { command: "rm -rf build" },
    };
    await expect(app.handlers.get("tool_call")!(event, app.context)).resolves.toBeUndefined();

    beforeShared = async () => {
      await writeFile(
        join(agentDir, "permissions.json"),
        JSON.stringify({ rules: [{ action: "deny", tool: "bash", pattern: "rm *" }] }),
      );
      await app.commands.get("default")!.handler("", app.context);
    };

    await expect(app.tools.get("bash").execute(
      "lease-race",
      event.input,
      undefined,
      undefined,
      app.context,
    )).rejects.toThrow("no longer authorized");
    expect(app.bashExecute).not.toHaveBeenCalled();
  });

  it("does not let an approved tool-call id authorize different input", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const app = harness(agentDir, true);
    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);
    const event = {
      toolName: "bash",
      toolCallId: "swapped-input",
      input: { command: "rm -rf build" },
    };

    await expect(app.handlers.get("tool_call")!(event, app.context)).resolves.toBeUndefined();
    await expect(app.tools.get("bash").execute(
      "swapped-input",
      { command: "rm -rf /var/tmp/unapproved-target" },
      undefined,
      undefined,
      app.context,
    )).rejects.toThrow("no longer authorized");
    expect(app.bashExecute).not.toHaveBeenCalled();
  });

  it("does not let an approved native-write id authorize a sibling path", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const external = await mkdtemp(join(tmpdir(), "pi-permissions-external-"));
    const app = harness(agentDir, true);
    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);
    const event = {
      toolName: "write",
      toolCallId: "swapped-native-write",
      input: { path: join(external, "approved.txt"), content: "approved" },
    };

    try {
      await expect(app.handlers.get("tool_call")!(event, app.context)).resolves.toBeUndefined();
      await expect(app.tools.get("write").execute(
        "swapped-native-write",
        { path: join(external, "sibling.txt"), content: "unapproved" },
        undefined,
        undefined,
        app.context,
      )).rejects.toThrow("no longer authorized");
      await expect(readFile(join(external, "sibling.txt"), "utf8")).rejects.toThrow();
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it("grants an approved public host only while that bash call executes", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const app = harness(agentDir, true);
    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);
    const event = {
      toolName: "bash",
      toolCallId: "network-1",
      input: { command: "curl https://example.com" },
    };

    await expect(app.handlers.get("tool_call")!(event, app.context)).resolves.toBeUndefined();
    await app.tools.get("bash").execute(
      "network-1",
      event.input,
      undefined,
      undefined,
      app.context,
    );

    expect(app.sandboxManager.initialize).toHaveBeenCalledTimes(3);
    expect(app.sandboxManager.initialize.mock.calls[1]?.[0]).toMatchObject({
      network: { allowedDomains: ["example.com"] },
    });
    expect(app.sandboxManager.initialize.mock.calls[2]?.[0]).toMatchObject({
      network: { allowedDomains: [] },
    });
    expect(app.confirm).toHaveBeenCalledWith(
      "pi-permissions · HARD",
      expect.stringContaining("Network for this command: example.com"),
    );
  });

  it("grants Git metadata and GitHub network access in the same agent bash approval", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const project = await mkdtemp(join(tmpdir(), "pi-permissions-project-"));
    await mkdir(join(project, ".git"));
    await writeFile(join(project, ".git", "config"), "");
    const app = harness(agentDir, true);
    app.context.cwd = project;
    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);
    const event = {
      toolName: "bash",
      toolCallId: "git-network-1",
      input: { command: "gh pr checkout 123" },
    };

    await app.handlers.get("tool_call")!(event, app.context);
    await app.tools.get("bash").execute(
      "git-network-1",
      event.input,
      undefined,
      undefined,
      app.context,
    );

    const temporary = app.sandboxManager.initialize.mock.calls[1]?.[0] as any;
    const gitDirectory = await realpath(join(project, ".git"));
    expect(temporary.network.allowedDomains).toContain("api.github.com");
    expect(temporary.filesystem.allowWrite).toContain(gitDirectory);
    expect(temporary.filesystem.denyWrite).not.toContain(gitDirectory);
    expect(app.confirm).toHaveBeenCalledWith(
      "pi-permissions · HARD",
      expect.stringContaining(`Filesystem for this command: ${gitDirectory}`),
    );
  });

  it("applies a structured write root only to the approved agent bash call", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const app = harness(agentDir, true);
    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);
    const outputName = `pi-permissions-output-${Date.now()}`;
    const outputRoot = join("/var/tmp", outputName);
    const canonicalOutputRoot = join(await realpath("/var/tmp"), outputName);
    const event = {
      toolName: "bash",
      toolCallId: "filesystem-1",
      input: {
        command: `mkdir -p ${outputRoot}`,
        sandbox_permissions: "with_additional_permissions",
        additional_permissions: {
          file_system: { write: [outputRoot] },
        },
        justification: "Write the requested build artifact",
      },
    };

    await app.handlers.get("tool_call")!(event, app.context);
    await app.tools.get("bash").execute(
      "filesystem-1",
      event.input,
      undefined,
      undefined,
      app.context,
    );

    expect(app.sandboxManager.reset).toHaveBeenCalledOnce();
    expect(app.sandboxManager.initialize).toHaveBeenCalledOnce();
    const options = app.bashToolFactory.mock.calls.at(-1)?.[1] as any;
    const operations = options?.operations;
    expect(operations).toBeDefined();
    await operations.exec("printf isolated", agentDir, { onData: () => undefined });
    expect(app.sandboxManager.wrapWithSandbox).toHaveBeenLastCalledWith(
      "printf isolated",
      undefined,
      expect.objectContaining({
        filesystem: expect.objectContaining({
          allowWrite: expect.arrayContaining([canonicalOutputRoot]),
        }),
      }),
      undefined,
    );
    expect(app.confirm).toHaveBeenCalledWith(
      "pi-permissions · REVIEW",
      expect.stringMatching(
        new RegExp(
          `Filesystem for this command: ${canonicalOutputRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*Justification: Write the requested build artifact`,
          "s",
        ),
      ),
    );
  });

  it("waits for an active sandboxed command before reloading the runtime", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const app = harness(agentDir);
    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);
    let release!: () => void;
    const commandRunning = new Promise<void>((resolvePromise) => {
      app.bashExecute.mockImplementationOnce(async () => {
        await new Promise<void>((resolveCommand) => {
          release = resolveCommand;
          resolvePromise();
        });
        return { content: [], details: undefined };
      });
    });

    const execution = app.tools.get("bash").execute(
      "long-running",
      { command: "pwd" },
      undefined,
      undefined,
      app.context,
    );
    await commandRunning;
    const reload = app.commands.get("default")!.handler("", app.context);
    await Promise.resolve();

    expect(app.sandboxManager.reset).toHaveBeenCalledOnce();
    release();
    await Promise.all([execution, reload]);
    expect(app.sandboxManager.reset).toHaveBeenCalledTimes(2);
  });

  it("never grants a private network target even after approval", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const app = harness(agentDir, true);
    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);
    const event = {
      toolName: "bash",
      toolCallId: "network-private",
      input: { command: "curl http://127.0.0.1/admin" },
    };

    await expect(app.handlers.get("tool_call")!(event, app.context))
      .resolves.toMatchObject({ block: true, reason: expect.stringContaining("Private") });
    expect(app.confirm).not.toHaveBeenCalled();
    expect(app.sandboxManager.initialize).toHaveBeenCalledOnce();
  });

  it("temporarily uses a loopback system proxy for an approved network command", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const app = harness(agentDir, true, true, { http: 7890, socks: 7891 });
    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);
    const event = {
      toolName: "bash",
      toolCallId: "network-proxy",
      input: { command: "curl https://example.com" },
    };

    await app.handlers.get("tool_call")!(event, app.context);
    await app.tools.get("bash").execute(
      "network-proxy",
      event.input,
      undefined,
      undefined,
      app.context,
    );

    expect(app.sandboxManager.initialize).toHaveBeenCalledTimes(3);
    expect(app.filteringProxyFactory).toHaveBeenCalledWith(
      ["example.com"],
      { http: 7890, socks: 7891 },
      ["localhost", "127.0.0.1", "::1", "169.254.169.254"],
    );
    expect(app.sandboxManager.initialize.mock.calls[1]?.[0]).toMatchObject({
      network: {
        allowedDomains: ["example.com"],
        httpProxyPort: 45670,
        socksProxyPort: 45671,
      },
    });
    expect(app.sandboxManager.initialize.mock.calls[2]?.[0]).toMatchObject({
      network: { allowedDomains: [] },
    });
    expect(app.filteringProxy.close).toHaveBeenCalledOnce();
  });

  it("restores the base sandbox when temporary proxy initialization fails", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const app = harness(agentDir, true, true, { http: 7890 });
    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);
    app.sandboxManager.initialize.mockRejectedValueOnce(new Error("proxy failed"));
    const event = {
      toolName: "bash",
      toolCallId: "network-proxy-failure",
      input: { command: "curl https://example.com" },
    };

    await app.handlers.get("tool_call")!(event, app.context);
    await expect(app.tools.get("bash").execute(
      "network-proxy-failure",
      event.input,
      undefined,
      undefined,
      app.context,
    )).rejects.toThrow("proxy failed");

    expect(app.sandboxManager.initialize).toHaveBeenCalledTimes(3);
    expect(app.sandboxManager.initialize.mock.calls[2]?.[0]).toMatchObject({
      network: { allowedDomains: [] },
    });
    expect(app.filteringProxy.close).toHaveBeenCalledOnce();
  });

  it("runs the overridden bash tool with sandbox operations", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const app = harness(agentDir);
    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);

    await app.tools.get("bash").execute("call-1", { command: "pwd" }, undefined, undefined, app.context);

    expect(app.bashToolFactory).toHaveBeenLastCalledWith(
      agentDir,
      expect.objectContaining({ operations: expect.any(Object) }),
    );
    expect(app.bashExecute).toHaveBeenCalledOnce();
  });

  it("fails closed when sandbox initialization fails", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const app = harness(agentDir);
    app.sandboxManager.initialize.mockRejectedValueOnce(new Error("unsupported"));
    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);

    await expect(
      app.tools.get("bash").execute("call-1", { command: "pwd" }, undefined, undefined, app.context),
    ).rejects.toThrow("sandbox unavailable");
    expect(app.setStatus).toHaveBeenCalledWith("pi-permissions", "Default");
  });

  it("uses the native bash backend only when sandbox is explicitly disabled", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    await writeFile(
      join(agentDir, "permissions.json"),
      JSON.stringify({ sandbox: { enabled: false } }),
    );
    const app = harness(agentDir);
    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);

    await app.tools.get("bash").execute("call-1", { command: "pwd" }, undefined, undefined, app.context);

    expect(app.bashToolFactory).toHaveBeenLastCalledWith(agentDir);
    expect(app.sandboxManager.initialize).not.toHaveBeenCalled();
    expect(app.setStatus).toHaveBeenCalledWith("pi-permissions", "Default");
  });
});
