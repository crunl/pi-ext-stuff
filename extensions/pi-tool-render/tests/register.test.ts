import { describe, expect, it, vi } from "vitest";
import registerExtension from "../index.ts";

function createPiMock(overrides: Record<string, unknown> = {}) {
  return {
    on: vi.fn(),
    events: { on: vi.fn() },
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => "off"),
    getAllTools: vi.fn(() => []),
    ...overrides,
  } as any;
}

describe("pi-tool-render registration", () => {
  it("owns only non-permission built-in tools and gives them self-rendered shells", () => {
    const tools = new Map<string, any>();
    registerExtension(createPiMock({ registerTool: (tool: any) => tools.set(tool.name, tool) }));

    expect([...tools.keys()]).toEqual(["read", "grep", "find", "ls", "codemode"]);
    // Codex tools and the codemode tree both own their shell (no host chrome).
    expect([...tools.values()].every((tool) => tool.renderShell === "self")).toBe(true);
    expect(typeof tools.get("codemode")?.renderResult).toBe("function");
    expect(
      [...tools.keys()]
        .filter((name) => name !== "codemode")
        .every((name) => typeof tools.get(name)?.promptSnippet === "string"),
    ).toBe(true);
    expect(tools.get("read")?.promptGuidelines).toContain(
      "Use read to examine files instead of cat or sed.",
    );
    expect(tools.has("bash")).toBe(false);
    expect(tools.has("write")).toBe(false);
    expect(tools.has("edit")).toBe(false);
    expect(vi.isMockFunction(tools.get("read")?.execute)).toBe(false);
  });

  it("subscribes output-padding, canonical fallback, and step-group fold lifecycle hooks", () => {
    const events = new Set<string>();
    const flags = new Set<string>();
    const registerToolRenderer = vi.fn();
    registerExtension(
      createPiMock({
        on: (event: string) => events.add(event),
        registerFlag: (flag: string) => flags.add(flag),
        registerToolRenderer,
      }),
    );

    expect(events.has("session_start")).toBe(true);
    expect(events.has("session_tree")).toBe(true);
    expect(events.has("session_shutdown")).toBe(true);
    expect(events.has("message_start")).toBe(true);
    expect(events.has("message_update")).toBe(true);
    expect(events.has("message_end")).toBe(true);
    expect(flags.has("core-builtin-presentation")).toBe(true);
    expect(registerToolRenderer).toHaveBeenCalledTimes(1);
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
        expected: "\uF15C Read src/index.ts · 1 line",
      },
      {
        name: "grep",
        args: { pattern: "renderCall", path: "src" },
        output: "src/a.ts:1\nsrc/b.ts:2",
        expected: '\uF0B0 Searched "renderCall" in src · 2 matches',
      },
      {
        name: "find",
        args: { pattern: "*.ts", path: "src" },
        output: "src/a.ts\nsrc/b.ts",
        expected: "\uF002 Found *.ts in src · 2 files",
      },
      {
        name: "ls",
        args: { path: "src" },
        output: "a.ts\nb.ts",
        expected: "\uF07B Listed src · 2 entries",
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
