import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerCodexToolRendering } from "../src/tui/built-in-tools.ts";

interface RegisteredTool {
  name: string;
  renderShell?: string;
  execute?(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ): Promise<unknown>;
}

function collectRegistered(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  const pi = { registerTool: (tool: RegisteredTool) => registered.push(tool) };
  registerCodexToolRendering(pi as never);
  return registered;
}

describe("registerCodexToolRendering", () => {
  it("registers the four read-only tools with Codex presentation", () => {
    const registered = collectRegistered();
    expect(registered.map((tool) => tool.name).sort()).toEqual(["find", "grep", "ls", "read"]);
    for (const tool of registered) {
      expect(tool.renderShell).toBe("self");
    }
  });

  // The host resolves paths against ctx.cwd natively (Pi 0.85+), so the
  // registered execute() is the factory's own — this pins that behavior.
  it("executes reads against the call's cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-core-builtin-"));
    try {
      writeFileSync(join(dir, "probe.txt"), "probe-content\n");
      const read = collectRegistered().find((tool) => tool.name === "read");
      expect(read).toBeDefined();

      const result = await read?.execute?.("t1", { path: "probe.txt" }, undefined, undefined, {
        cwd: dir,
      });
      expect(JSON.stringify(result)).toContain("probe-content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
