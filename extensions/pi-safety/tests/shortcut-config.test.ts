import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shiftTabAvailability } from "../src/shortcut-config.ts";

describe("Shift+Tab availability", () => {
  it("treats the built-in default as reserved when no override exists", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-shortcuts-"));
    await expect(shiftTabAvailability(agentDir)).resolves.toBe("reserved");
  });

  it("recognizes Shift+Tab after thinking cycle is migrated", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-shortcuts-"));
    await writeFile(
      join(agentDir, "keybindings.json"),
      JSON.stringify({ "app.thinking.cycle": "ctrl+shift+t" }),
    );
    await expect(shiftTabAvailability(agentDir)).resolves.toBe("available");
  });

  it("keeps Shift+Tab reserved when it remains in an override array", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-shortcuts-"));
    await writeFile(
      join(agentDir, "keybindings.json"),
      JSON.stringify({
        "app.thinking.cycle": ["ctrl+shift+t", "shift+tab"],
      }),
    );
    await expect(shiftTabAvailability(agentDir)).resolves.toBe("reserved");
  });

  it("fails closed for malformed keybinding files", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-shortcuts-"));
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "keybindings.json"), "{");
    await expect(shiftTabAvailability(agentDir)).resolves.toBe("reserved");
  });
});
