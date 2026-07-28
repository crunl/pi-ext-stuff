import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerExtension } from "../src/register.ts";

function harness(agentDir: string, approved = false, hasUI = true) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, { handler: (...args: any[]) => any }>();
  const setStatus = vi.fn();
  const notify = vi.fn();
  const confirm = vi.fn(async () => approved);
  const pi = {
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    registerCommand: (name: string, command: { handler: (...args: any[]) => any }) => commands.set(name, command),
  };
  registerExtension(pi as any, { agentDir });
  const context = {
    cwd: agentDir,
    hasUI,
    isProjectTrusted: () => false,
    ui: { setStatus, notify, confirm },
  };
  return { handlers, commands, context, setStatus, notify, confirm };
}

describe("Default mode registration", () => {
  it("loads Default mode and exposes status commands", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-"));
    const app = harness(agentDir);

    await app.handlers.get("session_start")?.({ type: "session_start" }, app.context);

    expect(app.setStatus).toHaveBeenCalledWith("pi-permissions", "Default");
    expect(app.commands.has("default")).toBe(true);
    expect(app.commands.has("permissions")).toBe(true);
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
});
