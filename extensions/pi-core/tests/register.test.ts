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

describe("pi-core registration", () => {
  it("registers no tools (tool rendering lives in pi-tool-render)", () => {
    const tools = new Map<string, any>();
    registerExtension(createPiMock({ registerTool: (tool: any) => tools.set(tool.name, tool) }));

    expect([...tools.keys()]).toEqual([]);
  });

  it("registers the six token-rate lifecycle handlers", () => {
    const events = new Set<string>();
    registerExtension(createPiMock({ on: (event: string) => events.add(event) }));

    for (const event of [
      "agent_start",
      "message_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "agent_end",
    ]) {
      expect(events.has(event)).toBe(true);
    }
  });

  it("subscribes the editor chrome to the pi-safety:mode bus and session_start", () => {
    const sessionEvents = new Set<string>();
    const busEvents = new Set<string>();
    registerExtension(
      createPiMock({
        on: (event: string) => sessionEvents.add(event),
        events: { on: (event: string) => busEvents.add(event) },
      }),
    );

    expect(sessionEvents.has("session_start")).toBe(true);
    expect(busEvents.has("pi-safety:mode")).toBe(true);
  });

  it("registers /effort and /exit commands", () => {
    const commands = new Map<string, any>();
    registerExtension(createPiMock({ registerCommand: (n: string, c: any) => commands.set(n, c) }));
    expect(commands.has("effort")).toBe(true);
    expect(commands.has("exit")).toBe(true);
  });
});
