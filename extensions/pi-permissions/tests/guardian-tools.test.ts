import type { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createGuardianToolRuntime, type GuardianToolFactory } from "../src/guardian-tools.ts";

type PiGuardianToolFactory = (cwd: string) => ReturnType<typeof createReadOnlyTools>;

type FakeToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: undefined;
  isError: boolean;
};

type FakeExecute = (
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal,
) => Promise<FakeToolResult>;

function fakeTool(
  name: string,
  execute: ReturnType<typeof vi.fn<FakeExecute>> = vi.fn(
    async (_toolCallId: string, _params: unknown, _signal?: AbortSignal) => ({
      content: [],
      details: undefined,
      isError: false,
    }),
  ),
) {
  return {
    name,
    label: name,
    description: `${name} description`,
    parameters: Type.Object({ path: Type.String() }),
    execute,
  };
}

describe("createGuardianToolRuntime", () => {
  it("uses the installed Pi Agent read-only tool factory contract", () => {
    expectTypeOf<GuardianToolFactory>().toEqualTypeOf<PiGuardianToolFactory>();
  });

  it("exposes exactly the read-only Guardian tools", () => {
    const runtime = createGuardianToolRuntime("/workspace", () => [
      fakeTool("read"),
      fakeTool("grep"),
      fakeTool("find"),
      fakeTool("ls"),
    ]);

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls"]);
    expect(runtime.tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([
        "bash",
        "write",
        "edit",
        "network",
        "mcp",
        "plugin",
        "skill",
        "approval",
      ]),
    );
  });

  it("executes injected tools with the caller abort signal", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (_toolCallId: string, _params: unknown, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      return {
        content: [{ type: "text" as const, text: "file contents" }],
        details: undefined,
        isError: false,
      };
    });
    const runtime = createGuardianToolRuntime("/workspace", () => [
      fakeTool("read", execute),
      fakeTool("grep"),
      fakeTool("find"),
      fakeTool("ls"),
    ]);

    const result = await runtime.execute(
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
      controller.signal,
    );

    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { path: "README.md" },
      controller.signal,
      undefined,
    );
    expect(result).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "file contents" }],
    });
  });

  it("does not impose a workspace-only boundary on the Codex-equivalent read-only surface", async () => {
    const execute = vi.fn(async (_toolCallId: string, _params: unknown) => ({
      content: [{ type: "text" as const, text: "external read-only evidence" }],
      details: undefined,
      isError: false,
    }));
    const runtime = createGuardianToolRuntime("/workspace", () => [fakeTool("read", execute)]);

    await expect(
      runtime.execute({
        type: "toolCall",
        id: "call-external",
        name: "read",
        arguments: { path: "/etc/hosts" },
      }),
    ).resolves.toMatchObject({
      isError: false,
      content: [{ type: "text", text: "external read-only evidence" }],
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects tools that are not in the Guardian runtime map", async () => {
    const runtime = createGuardianToolRuntime("/workspace", () => [
      fakeTool("read"),
      fakeTool("grep"),
      fakeTool("find"),
      fakeTool("ls"),
    ]);

    await expect(
      runtime.execute(
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "id" } },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/not available/i);
  });
});
