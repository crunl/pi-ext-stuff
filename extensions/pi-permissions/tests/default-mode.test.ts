import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type PermissionsConfig } from "../src/config.ts";
import { evaluateDefaultRequest } from "../src/default-mode.ts";

function config(overrides: Partial<PermissionsConfig> = {}): PermissionsConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...overrides,
  };
}

describe("Default mode gate", () => {
  it("allows ordinary workspace reads and writes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    await expect(evaluateDefaultRequest("read", { path: "README.md" }, cwd, config()))
      .resolves.toMatchObject({ action: "allow", risk: "LOW" });
    await expect(evaluateDefaultRequest("write", { path: "notes.txt", content: "hello" }, cwd, config()))
      .resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("blocks protected secrets without a one-off prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    await expect(evaluateDefaultRequest("read", { path: ".env" }, cwd, config()))
      .resolves.toMatchObject({ action: "block" });
    await expect(evaluateDefaultRequest("write", { path: "deploy.key", content: "secret" }, cwd, config()))
      .resolves.toMatchObject({ action: "block" });
  });

  it("prompts for external writes and dangerous Bash", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    await expect(evaluateDefaultRequest("write", { path: "/var/tmp/out.txt", content: "x" }, cwd, config()))
      .resolves.toMatchObject({ action: "prompt", risk: "REVIEW" });
    await expect(evaluateDefaultRequest("bash", { command: "rm -rf build" }, cwd, config()))
      .resolves.toMatchObject({ action: "prompt", risk: "HARD" });
  });

  it("applies deny, ask, and allow rules without allowing HARD bypass", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    const rules: PermissionsConfig["rules"] = [
      { action: "deny", tool: "bash", pattern: "npm publish*" },
      { action: "ask", tool: "bash", pattern: "npm test*" },
      { action: "allow", tool: "bash", pattern: "npm run lint*" },
      { action: "allow", tool: "bash", pattern: "rm *" },
    ];
    const configured = config({ rules });

    await expect(evaluateDefaultRequest("bash", { command: "npm publish" }, cwd, configured))
      .resolves.toMatchObject({ action: "block" });
    await expect(evaluateDefaultRequest("bash", { command: "npm test" }, cwd, configured))
      .resolves.toMatchObject({ action: "prompt" });
    await expect(evaluateDefaultRequest("bash", { command: "npm run lint" }, cwd, configured))
      .resolves.toMatchObject({ action: "allow" });
    await expect(evaluateDefaultRequest("bash", { command: "rm -rf build" }, cwd, configured))
      .resolves.toMatchObject({ action: "prompt", risk: "HARD" });
  });

  it("summarizes requests without including write content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    const decision = await evaluateDefaultRequest(
      "write",
      { path: "/var/tmp/out.txt", content: "DO_NOT_RENDER_THIS_SECRET" },
      cwd,
      config(),
    );

    expect(decision.action).toBe("prompt");
    if (decision.action === "prompt") {
      expect(decision.summary).toContain("/var/tmp/out.txt");
      expect(decision.summary).not.toContain("DO_NOT_RENDER_THIS_SECRET");
    }
  });
});
