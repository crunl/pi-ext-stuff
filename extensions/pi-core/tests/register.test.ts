import { describe, expect, it, vi } from "vitest";
import registerExtension from "../index.ts";

function createPiMock(overrides: Record<string, unknown> = {}) {
  return {
    on: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => "off"),
    getAllTools: vi.fn(() => []),
    ...overrides,
  } as any;
}

describe("pi-core registration", () => {
  it("owns only non-permission built-in tools and gives them self-rendered shells", () => {
    const tools = new Map<string, any>();
    registerExtension(createPiMock({ registerTool: (tool: any) => tools.set(tool.name, tool) }));

    expect([...tools.keys()]).toEqual(["read", "grep", "find", "ls"]);
    expect([...tools.values()].every((tool) => tool.renderShell === "self")).toBe(true);
    expect([...tools.values()].every((tool) => typeof tool.promptSnippet === "string")).toBe(true);
    expect(tools.get("read")?.promptGuidelines).toContain(
      "Use read to examine files instead of cat or sed.",
    );
    expect(tools.has("bash")).toBe(false);
    expect(tools.has("write")).toBe(false);
    expect(tools.has("edit")).toBe(false);
    expect(vi.isMockFunction(tools.get("read")?.execute)).toBe(false);
  });

  it("registers the five token-rate lifecycle handlers", () => {
    const events = new Set<string>();
    registerExtension(createPiMock({ on: (event: string) => events.add(event) }));

    for (const event of [
      "agent_start",
      "message_start",
      "message_update",
      "tool_execution_start",
      "agent_end",
    ]) {
      expect(events.has(event)).toBe(true);
    }
  });

  it("keeps completed read and search calls on one collapsed line", () => {
    const tools = new Map<string, any>();
    registerExtension(createPiMock({ registerTool: (tool: any) => tools.set(tool.name, tool) }));
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };

    for (const example of [
      {
        name: "read",
        args: { path: "src/index.ts" },
        output: "file contents",
        expected: " Read src/index.ts",
      },
      {
        name: "grep",
        args: { pattern: "renderCall", path: "src" },
        output: "src/a.ts:1\nsrc/b.ts:2",
        expected: ' Searched "renderCall" in src · 2 matches',
      },
      {
        name: "find",
        args: { pattern: "*.ts", path: "src" },
        output: "src/a.ts\nsrc/b.ts",
        expected: " Found *.ts in src · 2 files",
      },
      {
        name: "ls",
        args: { path: "src" },
        output: "a.ts\nb.ts",
        expected: " Listed src · 2 entries",
      },
    ]) {
      const tool = tools.get(example.name);
      const state = {};
      const context = {
        args: example.args,
        state,
        cwd: "/repo",
        isError: false,
      };
      const header = tool.renderCall(example.args, theme, context);
      const result = tool.renderResult(
        { content: [{ type: "text", text: example.output }] },
        { expanded: false, isPartial: false },
        theme,
        context,
      );

      expect(header.render(100).join("\n")).toContain(example.expected);
      expect(result.render(100)).toEqual([]);
    }
  });
});
