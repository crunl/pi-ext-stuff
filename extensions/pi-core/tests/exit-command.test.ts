import { describe, expect, it, vi } from "vitest";
import { registerExitCommand } from "../src/tui/exit-command.ts";

describe("registerExitCommand", () => {
  it("registers /exit as alias for /quit", async () => {
    const commands = new Map<string, any>();
    registerExitCommand({
      registerCommand: (name: string, opts: any) => commands.set(name, opts),
    } as any);

    expect(commands.has("exit")).toBe(true);
    expect(commands.get("exit").description).toMatch(/quit/i);

    const shutdown = vi.fn();
    await commands.get("exit").handler("", { shutdown } as any);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
