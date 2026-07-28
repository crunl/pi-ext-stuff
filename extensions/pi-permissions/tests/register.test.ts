import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerExtension } from "../src/register.ts";
import { extractShellNetworkHosts } from "../src/permissions/risk.ts";

function harness(
  agentDir: string,
  approved = false,
  hasUI = true,
  localProxyPorts: { http?: number; socks?: number } = {},
) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, { handler: (...args: any[]) => any }>();
  const tools = new Map<string, any>();
  const setStatus = vi.fn();
  const notify = vi.fn();
  const confirm = vi.fn(async () => approved);
  let sandboxAsk: ((request: { host: string; port: number | undefined }) => Promise<boolean>) | undefined;
  const networkDecisions: boolean[] = [];
  const sandboxManager = {
    initialize: vi.fn(async (
      _config: unknown,
      ask?: (request: { host: string; port: number | undefined }) => Promise<boolean>,
    ) => {
      sandboxAsk = ask;
    }),
    wrapWithSandbox: vi.fn(async (command: string) => command),
    reset: vi.fn(async () => undefined),
  };
  const bashExecute = vi.fn(async (_id: string, params: { command: string }) => {
    if (sandboxAsk) {
      for (const host of extractShellNetworkHosts(params.command)) {
        networkDecisions.push(await sandboxAsk({ host, port: 443 }));
      }
    }
    return { content: [], details: undefined };
  });
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
  registerExtension(pi as any, {
    agentDir,
    sandboxManager,
    bashToolFactory: bashToolFactory as any,
    localProxyPorts,
  });
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
    networkDecisions,
    askNetwork: async (host: string) =>
      sandboxAsk ? sandboxAsk({ host, port: 443 }) : false,
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
    const event = { toolName: "bash", input: { command: "rm -rf build" } };

    await expect(approved.handlers.get("tool_call")!(event, approved.context)).resolves.toBeUndefined();
    await expect(headless.handlers.get("tool_call")!(event, headless.context))
      .resolves.toMatchObject({ block: true, reason: expect.stringContaining("interactive approval") });
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

    expect(app.networkDecisions).toEqual([true]);
    await expect(app.askNetwork("example.com")).resolves.toBe(false);
    expect(app.confirm).toHaveBeenCalledWith(
      "pi-permissions · HARD",
      expect.stringContaining("Network for this command: example.com"),
    );
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
    expect(app.networkDecisions).toEqual([]);
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
    expect(app.sandboxManager.initialize.mock.calls[1]?.[0]).toMatchObject({
      network: { httpProxyPort: 7890, socksProxyPort: 7891 },
    });
    expect(app.sandboxManager.initialize.mock.calls[2]?.[1]).toEqual(expect.any(Function));
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
    expect(app.sandboxManager.initialize.mock.calls[2]?.[1]).toEqual(expect.any(Function));
    await expect(app.askNetwork("example.com")).resolves.toBe(false);
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
