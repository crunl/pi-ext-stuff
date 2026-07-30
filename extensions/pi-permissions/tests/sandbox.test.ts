import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { defaultProtectedWritePaths } from "../src/filesystem-policy.ts";
import {
  createSandboxedBashOperations,
  createSandboxedFileOperations,
  createSandboxRuntimeConfig,
  detectLocalProxyPorts,
  withAdditionalWriteRoots,
  withLocalProxy,
} from "../src/sandbox.ts";

describe("sandbox integration", () => {
  it("resolves workspace-relative paths before initializing the runtime", () => {
    const runtime = createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, "/workspace/project");

    expect(runtime.filesystem.allowWrite).toContain("/workspace/project");
    expect(runtime.filesystem.denyRead).toContain("/workspace/project/**/.env");
    expect(runtime.filesystem.denyRead).toContain("/workspace/project/**/.env.*");
    expect(runtime.filesystem.denyWrite).toContain("/workspace/project/**/*.key");
    expect(runtime.filesystem.denyWrite).toContain("/workspace/project/.git");
    expect(runtime.filesystem.denyWrite).toContain("/workspace/project/.agents");
    expect(runtime.filesystem.denyWrite).toContain("/workspace/project/.codex");
    expect(runtime.filesystem.denyWrite).not.toContain("/workspace/project/.pi/permissions.json");
    expect(runtime.network.allowedDomains).toEqual([]);
  });

  it("protects the plugin-local global configuration path", () => {
    expect(defaultProtectedWritePaths("/workspace/project", "/workspace/agent")).toContain(
      "/workspace/agent/extensions/pi-permissions/config.json",
    );
    expect(defaultProtectedWritePaths("/workspace/project", "/workspace/agent")).not.toContain(
      "/workspace/agent/permissions.json",
    );
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

    const runtime = createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, process.cwd());
    const result = await createSandboxedBashOperations(manager, runtime).exec(
      "printf unsandboxed",
      join(process.cwd()),
      { onData: (data) => output.push(data) },
    );

    expect(manager.wrapWithSandbox).toHaveBeenCalledWith(
      "printf unsandboxed",
      undefined,
      runtime,
      undefined,
    );
    expect(Buffer.concat(output).toString()).toBe("sandboxed");
    expect(result.exitCode).toBe(0);
  });

  it("runs native file operations through the sandbox with one-call write roots", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-native-"));
    const path = join(cwd, "nested", "note.txt");
    const manager = {
      initialize: vi.fn(async () => undefined),
      reset: vi.fn(async () => undefined),
      wrapWithSandbox: vi.fn(async (command: string) => command),
    };
    const runtime = createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, cwd);
    const operations = createSandboxedFileOperations(manager, runtime, [path]);

    await operations.mkdir(join(cwd, "nested"));
    await operations.writeFile(path, "sandboxed native write");
    await operations.access(path);

    expect((await operations.readFile(path)).toString()).toBe("sandboxed native write");
    expect(await readFile(path, "utf8")).toBe("sandboxed native write");
    expect(manager.wrapWithSandbox).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      expect.objectContaining({
        filesystem: expect.objectContaining({
          allowWrite: expect.arrayContaining([path]),
        }),
      }),
      undefined,
    );
  });

  it("detects only loopback system proxies and applies them to one runtime", () => {
    const ports = detectLocalProxyPorts({
      HTTPS_PROXY: "http://127.0.0.1:7890",
      ALL_PROXY: "socks5://localhost:7891",
    });
    expect(ports).toEqual({ http: 7890, socks: 7891 });
    expect(
      detectLocalProxyPorts({
        HTTPS_PROXY: "http://proxy.example.com:8080",
      }),
    ).toEqual({ http: undefined, socks: undefined });

    const runtime = withLocalProxy(
      createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, "/workspace/project"),
      ports,
    );
    expect(runtime.network.httpProxyPort).toBe(7890);
    expect(runtime.network.socksProxyPort).toBe(7891);
  });

  it("does not let a broad write root erase nested protected paths", () => {
    const runtime = createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, "/workspace/project");
    const gitRoot = "/workspace/project/.git";

    const broad = withAdditionalWriteRoots(runtime, ["/workspace"]);
    expect(broad.filesystem.denyWrite).toContain(gitRoot);

    const exact = withAdditionalWriteRoots(runtime, [gitRoot]);
    expect(exact.filesystem.denyWrite).not.toContain(gitRoot);
    expect(exact.filesystem.denyWrite).toContain("/workspace/project/.agents");
    expect(exact.filesystem.denyWrite).toContain("/workspace/project/.codex");
  });
});
