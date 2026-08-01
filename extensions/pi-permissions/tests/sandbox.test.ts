import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { defaultProtectedWritePaths, packageRoot } from "../src/filesystem-policy.ts";
import {
  createSandboxedBashOperations,
  createSandboxedFileOperations,
  createSandboxedGuardianFileOperations,
  createSandboxedReadOnlyCommandRunner,
  createGuardianReadOnlySandboxConfig,
  createSandboxRuntimeConfig,
  detectLocalProxyPorts,
  type SandboxManagerLike,
  withAdditionalWriteRoots,
  withLocalProxy,
} from "../src/sandbox.ts";

describe("sandbox integration", () => {
  it("runs sandboxed Guardian read-only file operations without changing the parent manager", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-permissions-guardian-"));
    const file = join(directory, "external.txt");
    await writeFile(file, "Guardian-visible evidence");
    await chmod(file, 0o444);
    const manager = {
      initialize: vi.fn(async () => undefined),
      reset: vi.fn(async () => undefined),
      wrapWithSandbox: vi.fn(async (
        ...[command]: Parameters<SandboxManagerLike["wrapWithSandbox"]>
      ) => command),
    };
    const operations = createSandboxedGuardianFileOperations(manager);

    await expect(operations.read.readFile(file)).resolves.toEqual(
      Buffer.from("Guardian-visible evidence"),
    );
    await expect(operations.read.access(file)).resolves.toBeUndefined();
    await expect(operations.grep.isDirectory(directory)).resolves.toBe(true);
    await expect(operations.grep.readFile(file)).resolves.toBe("Guardian-visible evidence");
    await expect(operations.find.exists(file)).resolves.toBe(true);
    await expect(operations.ls.exists(file)).resolves.toBe(true);
    await expect(operations.ls.exists(join(directory, "missing.txt"))).resolves.toBe(false);
    const directoryStat = await operations.ls.stat(directory);
    expect(directoryStat.isDirectory()).toBe(true);
    await expect(operations.ls.readdir(directory)).resolves.toEqual(["external.txt"]);

    expect(manager.wrapWithSandbox).toHaveBeenCalledTimes(9);
    for (const [, shell, config, signal] of manager.wrapWithSandbox.mock.calls) {
      expect(shell).toBeUndefined();
      expect(signal).toBeUndefined();
      expect(config).toEqual(createGuardianReadOnlySandboxConfig());
    }
    expect(manager.initialize).not.toHaveBeenCalled();
    expect(manager.reset).not.toHaveBeenCalled();
  });

  it("binds a read-only command runner to a resolved executable and literal arguments", async () => {
    const manager = {
      initialize: vi.fn(async () => undefined),
      reset: vi.fn(async () => undefined),
      wrapWithSandbox: vi.fn(async (command: string) => command),
    };
    const run = createSandboxedReadOnlyCommandRunner(manager, "node");
    const literalArgument = "spaces 'quotes' $(must-not-run)\nnext-line";

    const result = await run(
      ["-e", "process.stdout.write(process.argv[1])", literalArgument],
    );

    expect(result.stdout.toString()).toBe(literalArgument);
    expect(manager.wrapWithSandbox).toHaveBeenCalledWith(
      expect.stringContaining(`'${process.execPath}'`),
      undefined,
      createGuardianReadOnlySandboxConfig(),
      undefined,
    );
    expect(manager.wrapWithSandbox).toHaveBeenCalledWith(
      expect.stringContaining("'spaces '\\''quotes'\\'' $(must-not-run)\nnext-line'"),
      undefined,
      createGuardianReadOnlySandboxConfig(),
      undefined,
    );

    expect(manager.initialize).not.toHaveBeenCalled();
    expect(manager.reset).not.toHaveBeenCalled();
  });

  it("constructs a fresh Guardian config for every read-only command", async () => {
    const configs: Array<NonNullable<Parameters<SandboxManagerLike["wrapWithSandbox"]>[2]>> = [];
    const manager = {
      initialize: vi.fn(async () => undefined),
      reset: vi.fn(async () => undefined),
      wrapWithSandbox: vi.fn(async (
        ...[command, , config]: Parameters<SandboxManagerLike["wrapWithSandbox"]>
      ) => {
        if (!config?.filesystem) throw new Error("missing Guardian config");
        configs.push(config);
        if (configs.length === 1) config.filesystem.allowWrite.push("/parent-write-root");
        return command;
      }),
    };
    const run = createSandboxedReadOnlyCommandRunner(manager, "node");

    await run(["-e", ""]);
    await run(["-e", ""]);

    expect(configs).toHaveLength(2);
    expect(configs[0]).not.toBe(configs[1]);
    expect(configs[1]).toEqual(createGuardianReadOnlySandboxConfig());
  });

  it("reports sandboxed exists permission failures instead of missing paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-permissions-guardian-permissions-"));
    const blockedDirectory = join(directory, "blocked");
    await mkdir(blockedDirectory);
    const manager = {
      initialize: vi.fn(async () => undefined),
      reset: vi.fn(async () => undefined),
      wrapWithSandbox: vi.fn(async (command: string) => command),
    };
    const operations = createSandboxedGuardianFileOperations(manager);

    await chmod(blockedDirectory, 0o000);
    try {
      await expect(operations.ls.exists(join(blockedDirectory, "secret"))).rejects.toThrow(
        /EACCES|permission denied/i,
      );
    } finally {
      await chmod(blockedDirectory, 0o700);
    }
  });

  it("rejects aborted read-only commands after child cleanup", async () => {
    const manager = {
      initialize: vi.fn(async () => undefined),
      reset: vi.fn(async () => undefined),
      wrapWithSandbox: vi.fn(async (command: string) => command),
    };
    const run = createSandboxedReadOnlyCommandRunner(manager, "node");

    const controller = new AbortController();
    const aborted = run(
      ["-e", "setInterval(() => {}, 1_000)"],
      controller.signal,
    );
    const abortedExpectation = expect(aborted).rejects.toThrow("aborted");
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    await abortedExpectation;
    expect(manager.initialize).not.toHaveBeenCalled();
    expect(manager.reset).not.toHaveBeenCalled();
  });

  it("returns an independent Guardian read-only sandbox config", () => {
    const first = createGuardianReadOnlySandboxConfig();
    const second = createGuardianReadOnlySandboxConfig();

    expect(first).toEqual({
      filesystem: {
        allowWrite: [],
        denyRead: [],
        denyWrite: [],
      },
      network: {
        allowedDomains: [],
        deniedDomains: [],
      },
    });

    first.filesystem.allowWrite.push("/tmp/example");
    first.filesystem.denyRead.push("/tmp/secret");
    first.filesystem.denyWrite.push("/tmp/protected");
    first.network.allowedDomains.push("example.com");
    first.network.deniedDomains.push("blocked.example.com");

    expect(second).toEqual({
      filesystem: {
        allowWrite: [],
        denyRead: [],
        denyWrite: [],
      },
      network: {
        allowedDomains: [],
        deniedDomains: [],
      },
    });
  });

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

  it("does not protect the extension package root by default", () => {
    expect(defaultProtectedWritePaths("/workspace/project", "/workspace/agent")).not.toContain(
      packageRoot,
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
