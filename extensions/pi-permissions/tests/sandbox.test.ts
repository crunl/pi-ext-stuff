import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  createSandboxedBashOperations,
  createSandboxRuntimeConfig,
} from "../src/sandbox.ts";

describe("sandbox integration", () => {
  it("resolves workspace-relative paths before initializing the runtime", () => {
    const runtime = createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, "/workspace/project");

    expect(runtime.filesystem.allowWrite).toContain("/workspace/project");
    expect(runtime.filesystem.denyRead).toContain("/workspace/project/.env");
    expect(runtime.filesystem.denyWrite).toContain("/workspace/project/*.key");
  });

  it("removes project write roots in read-only profile", () => {
    const runtime = createSandboxRuntimeConfig(
      { ...DEFAULT_CONFIG.sandbox, profile: "read-only" },
      "/workspace/project",
    );

    expect(runtime.filesystem.allowWrite).toEqual([]);
  });

  it("executes only the command returned by the sandbox manager", async () => {
    const manager = {
      initialize: vi.fn(async () => undefined),
      reset: vi.fn(async () => undefined),
      wrapWithSandbox: vi.fn(async () => "printf sandboxed"),
    };
    const output: Buffer[] = [];

    const result = await createSandboxedBashOperations(manager).exec(
      "printf unsandboxed",
      join(process.cwd()),
      { onData: (data) => output.push(data) },
    );

    expect(manager.wrapWithSandbox).toHaveBeenCalledWith(
      "printf unsandboxed",
      undefined,
      undefined,
      undefined,
    );
    expect(Buffer.concat(output).toString()).toBe("sandboxed");
    expect(result.exitCode).toBe(0);
  });
});
