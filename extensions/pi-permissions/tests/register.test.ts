import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerExtension } from "../src/register.ts";

function harness(agentDir: string, approved = false, hasUI = true) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, { handler: (...args: any[]) => any }>();
  const tools = new Map<string, any>();
  const setStatus = vi.fn();
  const notify = vi.fn();
  const confirm = vi.fn(async () => approved);
  const sandboxManager = {
    initialize: vi.fn(async () => undefined),
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
  const pi = {
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    registerCommand: (name: string, command: { handler: (...args: any[]) => any }) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
  };
  registerExtension(pi as any, { agentDir, sandboxManager, bashToolFactory: bashToolFactory as any });
  const context = {
    cwd: agentDir,
    hasUI,
    isProjectTrusted: () => false,
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
    expect(app.sandboxManager.initialize).toHaveBeenCalledOnce();
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

  it("executes an approved call and fails closed without UI", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const approved = harness(agentDir, true);
    const headless = harness(agentDir, false, false);
    const event = { toolName: "bash", input: { command: "npm test" } };

    await expect(approved.handlers.get("tool_call")!(event, approved.context)).resolves.toBeUndefined();
    await expect(headless.handlers.get("tool_call")!(event, headless.context))
      .resolves.toMatchObject({ block: true, reason: expect.stringContaining("interactive approval") });
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
