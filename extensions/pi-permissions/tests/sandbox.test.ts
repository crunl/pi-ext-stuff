import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { defaultProtectedWritePaths, packageRoot } from "../src/filesystem-policy.ts";
import {
  copyGuardianEvidenceScope,
  createGuardianEvidenceScope,
  createGuardianReadOnlySandboxConfig,
  createSandboxedBashOperations,
  createSandboxedFileOperations,
  createSandboxedGuardianFileOperations,
  createSandboxedReadOnlyCommandRunner,
  createSandboxRuntimeConfig,
  DEFAULT_BASH_TIMEOUT_MS,
  DEFAULT_FILE_OPERATION_TIMEOUT_MS,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxPolicy,
  withAdditionalWriteRoots,
} from "../src/sandbox.ts";

const guardianEvidenceScope = createGuardianEvidenceScope(process.cwd(), {
  filesystem: {
    allowWrite: [process.cwd()],
    denyRead: ["/tmp/guardian-secret"],
    denyWrite: [],
  },
  network: { allowedDomains: [], deniedDomains: [] },
});

type TestWrap = (
  command: string,
  shell?: string,
  config?: SandboxPolicy,
  signal?: AbortSignal,
) => Promise<string>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function killTestProcess(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function runTestCommand(command: string, request: SandboxExecutionRequest) {
  return new Promise<SandboxExecutionResult>((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", command], {
      cwd: request.cwd,
      env: request.env,
      detached: true,
      stdio: [
        request.stdin !== undefined && request.stdin !== "ignore" ? "pipe" : "ignore",
        "pipe",
        "pipe",
      ],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputError: Error | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timedOut = false;
    const cleanup = (): void => {
      request.signal?.removeEventListener("abort", onAbort);
      if (timeoutHandle) clearTimeout(timeoutHandle);
    };
    const onAbort = (): void => killTestProcess(child);
    const collect = (
      chunks: Buffer[],
      chunk: Buffer,
      current: number,
      bound: number | undefined,
      name: "stdout" | "stderr",
      onData?: (chunk: Buffer) => void,
    ): number => {
      onData?.(chunk);
      if (outputError) return current;
      const next = current + chunk.length;
      if (bound !== undefined && next > bound) {
        outputError = new Error(`${name} exceeded the Guardian bound`);
        killTestProcess(child);
      } else {
        chunks.push(chunk);
      }
      return next;
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
    if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killTestProcess(child);
      }, request.timeoutMs);
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes = collect(
        stdout,
        chunk,
        stdoutBytes,
        request.maxStdoutBytes,
        "stdout",
        request.onStdout,
      );
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes = collect(
        stderr,
        chunk,
        stderrBytes,
        request.maxStderrBytes,
        "stderr",
        request.onStderr,
      );
    });
    child.once("error", (error) => {
      cleanup();
      reject(outputError ?? error);
    });
    child.once("close", (exitCode) => {
      cleanup();
      if (request.signal?.aborted) reject(new Error("aborted"));
      else if (timedOut) reject(new Error(`timeout:${(request.timeoutMs ?? 0) / 1000}`));
      else if (outputError) reject(outputError);
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode });
    });
    if (request.stdin !== undefined && request.stdin !== "ignore" && child.stdin) {
      child.stdin.end(request.stdin);
    }
  });
}

function testSandboxManager(handler: TestWrap = async (command) => command) {
  const wrapWithSandbox = vi.fn<TestWrap>(handler);
  const execute = vi.fn(async (request: SandboxExecutionRequest) => {
    const command = [request.program.executable, ...request.program.args].map(shellQuote).join(" ");
    return runTestCommand(
      await wrapWithSandbox(command, undefined, request.policy, request.signal),
      request,
    );
  });
  const manager = {
    initialize: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
    wrapWithSandbox,
    execute,
  };
  return manager;
}

describe("sandbox integration", () => {
  it("resolves Guardian tilde paths against an explicit trusted home", async () => {
    const trustedHome = await mkdtemp(join(tmpdir(), "pi-permissions-guardian-home-"));
    const marker = join(trustedHome, "trusted-marker.txt");
    await writeFile(marker, "trusted home");
    try {
      const operations = createSandboxedGuardianFileOperations(
        testSandboxManager(),
        guardianEvidenceScope,
        undefined,
        trustedHome,
      );

      await expect(operations.resolveReadPath("~/trusted-marker.txt", "/tmp")).resolves.toBe(
        marker,
      );
    } finally {
      await rm(trustedHome, { recursive: true, force: true });
    }
  });

  it("runs sandboxed Guardian read-only file operations without changing the parent manager", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-permissions-guardian-"));
    const file = join(directory, "external.txt");
    await writeFile(file, "Guardian-visible evidence");
    await chmod(file, 0o444);
    const manager = testSandboxManager();
    const operations = createSandboxedGuardianFileOperations(manager, guardianEvidenceScope);

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
      expect(config).toEqual(createGuardianReadOnlySandboxConfig(guardianEvidenceScope));
    }
    expect(manager.initialize).not.toHaveBeenCalled();
    expect(manager.reset).not.toHaveBeenCalled();
  });

  it("binds a read-only command runner to a resolved executable and literal arguments", async () => {
    const manager = testSandboxManager();
    const run = createSandboxedReadOnlyCommandRunner(manager, "node", guardianEvidenceScope);
    const literalArgument = "spaces 'quotes' $(must-not-run)\nnext-line";

    const result = await run(["-e", "process.stdout.write(process.argv[1])", literalArgument]);

    expect(result.stdout.toString()).toBe(literalArgument);
    expect(manager.wrapWithSandbox).toHaveBeenCalledWith(
      expect.stringContaining(`'${process.execPath}'`),
      undefined,
      createGuardianReadOnlySandboxConfig(guardianEvidenceScope),
      undefined,
    );
    expect(manager.wrapWithSandbox).toHaveBeenCalledWith(
      expect.stringContaining("'spaces '\\''quotes'\\'' $(must-not-run)\nnext-line'"),
      undefined,
      createGuardianReadOnlySandboxConfig(guardianEvidenceScope),
      undefined,
    );

    expect(manager.initialize).not.toHaveBeenCalled();
    expect(manager.reset).not.toHaveBeenCalled();
  });

  it("constructs a fresh Guardian config for every read-only command", async () => {
    const configs: SandboxPolicy[] = [];
    const manager = testSandboxManager(async (command, _shell, config) => {
      if (!config?.filesystem) throw new Error("missing Guardian config");
      configs.push(config);
      if (configs.length === 1) config.filesystem.allowWrite.push("/parent-write-root");
      return command;
    });
    const run = createSandboxedReadOnlyCommandRunner(manager, "node", guardianEvidenceScope);

    await run(["-e", ""]);
    await run(["-e", ""]);

    expect(configs).toHaveLength(2);
    expect(configs[0]).not.toBe(configs[1]);
    expect(configs[1]).toEqual(createGuardianReadOnlySandboxConfig(guardianEvidenceScope));
  });

  it("reports sandboxed exists permission failures instead of missing paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-permissions-guardian-permissions-"));
    const blockedDirectory = join(directory, "blocked");
    await mkdir(blockedDirectory);
    const manager = testSandboxManager();
    const operations = createSandboxedGuardianFileOperations(manager, guardianEvidenceScope);

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
    const manager = testSandboxManager();
    const run = createSandboxedReadOnlyCommandRunner(manager, "node", guardianEvidenceScope);

    const controller = new AbortController();
    const aborted = run(["-e", "setInterval(() => {}, 1_000)"], controller.signal);
    const abortedExpectation = expect(aborted).rejects.toThrow("aborted");
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    await abortedExpectation;
    expect(manager.initialize).not.toHaveBeenCalled();
    expect(manager.reset).not.toHaveBeenCalled();
  });

  it("times out a hanging read-only helper at 30s and kills its process group", async () => {
    const manager = testSandboxManager();
    const run = createSandboxedReadOnlyCommandRunner(manager, "node", guardianEvidenceScope);
    const killSpy = vi.spyOn(process, "kill");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const execution = run(["-e", "setInterval(() => {}, 1_000)"]);
      await vi.advanceTimersByTimeAsync(DEFAULT_FILE_OPERATION_TIMEOUT_MS);

      await expect(execution).rejects.toThrow("timeout:30");
      expect(
        killSpy.mock.calls.some(
          ([pid, signal]) => typeof pid === "number" && pid < 0 && signal === "SIGKILL",
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
      killSpy.mockRestore();
    }
  });

  it("terminates a read-only command before stdout can exceed the Guardian bound", async () => {
    const manager = testSandboxManager();
    const run = createSandboxedReadOnlyCommandRunner(manager, "node", guardianEvidenceScope);

    const outcome = await run(["-e", "process.stdout.write('x'.repeat(6 * 1024 * 1024))"]).catch(
      (error: unknown) => error,
    );

    expect(outcome instanceof Error).toBe(true);
    if (outcome instanceof Error) {
      expect(outcome.message).toMatch(/stdout.*Guardian bound/i);
    }
  });

  it("bounds Guardian file reads before the helper writes stdout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-permissions-guardian-read-bound-"));
    const file = join(directory, "large.txt");
    await writeFile(file, Buffer.alloc(5 * 1024 * 1024, 0x78));
    const manager = testSandboxManager();

    try {
      const operations = createSandboxedGuardianFileOperations(manager, guardianEvidenceScope);
      const outcome = await operations.read.readFile(file).catch((error: unknown) => error);
      expect(outcome instanceof Error).toBe(true);
      if (outcome instanceof Error) {
        expect(outcome.message).toMatch(/file.*reviewer byte bound/i);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds Guardian directory entries inside the helper", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-permissions-guardian-entry-bound-"));
    const entryCount = 1_001;
    await Promise.all(
      Array.from({ length: entryCount }, (_, index) =>
        writeFile(join(directory, `${String(index).padStart(4, "0")}.txt`), ""),
      ),
    );
    const manager = testSandboxManager();

    try {
      const operations = createSandboxedGuardianFileOperations(manager, guardianEvidenceScope);
      const entries = await operations.ls.readdir(directory);
      expect(entries.length).toBeLessThan(entryCount);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns an independent Guardian read-only sandbox config", () => {
    const first = createGuardianReadOnlySandboxConfig(guardianEvidenceScope);
    const second = createGuardianReadOnlySandboxConfig(guardianEvidenceScope);

    expect(first).toEqual({
      filesystem: {
        allowWrite: [],
        denyRead: ["/tmp/guardian-secret"],
        denyWrite: [],
      },
      network: {
        allowedDomains: [],
        deniedDomains: ["*"],
        trustedFakeIpRanges: [],
        allowLocalBinding: false,
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
        denyRead: ["/tmp/guardian-secret"],
        denyWrite: [],
      },
      network: {
        allowedDomains: [],
        deniedDomains: ["*"],
        trustedFakeIpRanges: [],
        allowLocalBinding: false,
      },
    });
  });

  it("intersects Guardian evidence with the parent's denyRead boundary", () => {
    const parent: SandboxPolicy = {
      filesystem: {
        allowWrite: ["/workspace", "/outside"],
        denyRead: ["/z-secret", "/a-secret", "/z-secret"],
        denyWrite: ["/protected"],
      },
      network: { allowedDomains: ["example.com"], deniedDomains: [] },
    };
    const scope = createGuardianEvidenceScope("/workspace", parent);

    expect(scope).toEqual({
      cwd: "/workspace",
      denyRead: ["/a-secret", "/z-secret"],
      authorityFingerprint: expect.any(String),
    });
    expect(createGuardianReadOnlySandboxConfig(scope)).toEqual({
      filesystem: {
        allowWrite: [],
        denyRead: ["/a-secret", "/z-secret"],
        denyWrite: [],
      },
      network: {
        allowedDomains: [],
        deniedDomains: ["*"],
        trustedFakeIpRanges: [],
        allowLocalBinding: false,
      },
    });
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.denyRead)).toBe(true);
  });

  it("rejects forged or non-normalized Guardian evidence authority", () => {
    expect(() =>
      createGuardianEvidenceScope("/workspace", {
        filesystem: { allowWrite: [], denyRead: ["relative-secret"], denyWrite: [] },
        network: { allowedDomains: [], deniedDomains: [] },
      }),
    ).toThrow(/absolute paths/i);

    expect(() =>
      copyGuardianEvidenceScope({
        ...guardianEvidenceScope,
        authorityFingerprint: "forged",
      }),
    ).toThrow(/fingerprint/i);
  });

  it("resolves the configured workspace root without an OS-specific filter", () => {
    const runtime = createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, homedir());
    expect(runtime.filesystem.allowWrite).toContain(homedir());
    expect(runtime.filesystem.allowWrite).toContain("/tmp");
    expect(runtime.filesystem.allowWrite).toContain("/private/tmp");
  });

  it("keeps Codex-style defaults while resolving protected workspace metadata", () => {
    const runtime = createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, "/workspace/project");

    expect(runtime.filesystem.allowWrite).toContain("/workspace/project");
    expect(runtime.filesystem.denyRead).toEqual([]);
    expect(runtime.filesystem.denyWrite).not.toContain("/workspace/project/**/.env");
    expect(runtime.filesystem.denyWrite).not.toContain("/workspace/project/**/*.key");
    expect(runtime.filesystem.denyWrite).toContain("/workspace/project/.git");
    expect(runtime.filesystem.denyWrite).toContain("/workspace/project/.agents");
    expect(runtime.filesystem.denyWrite).toContain("/workspace/project/.codex");
    expect(runtime.filesystem.denyWrite).not.toContain("/workspace/project/.pi/permissions.json");
    expect(runtime.network.allowedDomains).toEqual([]);
  });

  it("keeps an explicit Git metadata root deny-only", () => {
    const runtime = createSandboxRuntimeConfig(
      {
        ...DEFAULT_CONFIG.sandbox,
        filesystem: {
          ...DEFAULT_CONFIG.sandbox.filesystem,
          denyWrite: ["/workspace/project/.git"],
        },
      },
      "/workspace/project",
      ["/other/project/.git"],
    );

    expect(runtime.filesystem.denyWrite).toContain("/workspace/project/.git");
  });

  it("keeps Git config, hooks, and metadata roots hard-denied for extra roots", () => {
    const cwd = "/workspace/project";
    const gitRoot = `${cwd}/.git`;
    const runtime = createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, cwd, undefined, [gitRoot]);

    expect(runtime.filesystem.denyWrite).toEqual(
      expect.arrayContaining([gitRoot, `${gitRoot}/hooks`, `${gitRoot}/config`]),
    );

    const exact = withAdditionalWriteRoots(runtime, [gitRoot]);
    expect(exact.filesystem.allowWrite).toContain(gitRoot);
    expect(exact.filesystem.denyWrite).toContain(gitRoot);
    expect(exact.filesystem.denyWrite).toEqual(
      expect.arrayContaining([`${gitRoot}/hooks`, `${gitRoot}/config`]),
    );

    const broad = withAdditionalWriteRoots(runtime, [cwd]);
    expect(broad.filesystem.allowWrite).toContain(cwd);
    expect(broad.filesystem.denyWrite).toContain(gitRoot);
  });

  it("does not form descendant deny patterns below a lexical .git pointer", () => {
    const cwd = "/workspace/project";
    const metadataRoot = "/tmp/project-metadata.git";
    const runtime = createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, cwd, undefined, [
      metadataRoot,
    ]);

    expect(runtime.filesystem.denyWrite).toContain(`${cwd}/.git`);
    expect(runtime.filesystem.denyWrite).not.toContain(`${cwd}/.git/hooks`);
    expect(runtime.filesystem.denyWrite).not.toContain(`${cwd}/.git/config`);
    expect(runtime.filesystem.denyWrite).toEqual(
      expect.arrayContaining([metadataRoot, `${metadataRoot}/hooks`, `${metadataRoot}/config`]),
    );
  });

  it("expands macOS symlink aliases so /tmp rules apply to /private/tmp", () => {
    const runtime = createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, "/workspace/project");
    // Default allowWrite contains "." and "/tmp"; the resolved policy must cover
    // both spellings because sandbox-exec resolves /tmp to /private/tmp.
    expect(runtime.filesystem.allowWrite).toContain("/tmp");
    expect(runtime.filesystem.allowWrite).toContain("/private/tmp");

    const expanded = withAdditionalWriteRoots(runtime, ["/tmp", "/private/var/run"]);
    expect(expanded.filesystem.allowWrite).toContain("/private/tmp");
    expect(expanded.filesystem.allowWrite).toContain("/var/run");
    expect(expanded.filesystem.allowWrite).toContain("/private/var/run");

    const denyRuntime = createSandboxRuntimeConfig(
      {
        ...DEFAULT_CONFIG.sandbox,
        filesystem: {
          ...DEFAULT_CONFIG.sandbox.filesystem,
          denyRead: ["/tmp/secrets"],
          denyWrite: ["/var/spool/x"],
        },
      },
      "/workspace/project",
    );
    expect(denyRuntime.filesystem.denyRead).toContain("/private/tmp/secrets");
    expect(denyRuntime.filesystem.denyWrite).toContain("/private/var/spool/x");
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
    const manager = testSandboxManager(async () => "printf sandboxed");
    const output: Buffer[] = [];

    const runtime = createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, process.cwd());
    const result = await createSandboxedBashOperations(manager, runtime).exec(
      "printf unsandboxed",
      join(process.cwd()),
      { onData: (data) => output.push(data) },
    );

    expect(manager.wrapWithSandbox).toHaveBeenCalledWith(
      expect.stringContaining("printf unsandboxed"),
      undefined,
      runtime,
      undefined,
    );
    expect(Buffer.concat(output).toString()).toBe("sandboxed");
    expect(result.exitCode).toBe(0);
  });

  it("refreshes Git metadata denies for later bash and file executions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-git-refresh-worktree-"));
    const metadata = await mkdtemp(join(tmpdir(), "pi-permissions-git-refresh-metadata-"));
    const policy: SandboxPolicy = {
      filesystem: {
        allowWrite: [tmpdir()],
        denyRead: ["/baseline/read"],
        denyWrite: ["/baseline/write"],
      },
      network: {
        allowedDomains: ["allowed.example"],
        deniedDomains: [],
        trustedFakeIpRanges: [],
        allowLocalBinding: false,
      },
    };
    const manager = testSandboxManager();

    try {
      await createSandboxedBashOperations(manager, policy).exec("true", cwd, {
        onData: () => undefined,
      });
      await writeFile(join(cwd, ".git"), `gitdir: ${metadata}\n`);

      await createSandboxedFileOperations(
        manager,
        policy,
        [],
        undefined,
        "git-refresh",
        cwd,
      ).access(join(cwd, ".git"));

      const lastRequest = manager.execute.mock.calls.at(-1)?.[0];
      if (!lastRequest) throw new Error("missing refreshed sandbox request");
      const refreshed = lastRequest.policy;
      expect(refreshed.filesystem.allowWrite).toEqual(policy.filesystem.allowWrite);
      expect(refreshed.filesystem.denyRead).toEqual(policy.filesystem.denyRead);
      expect(refreshed.filesystem.denyWrite).toEqual(
        expect.arrayContaining([
          ...policy.filesystem.denyWrite,
          metadata,
          join(metadata, "hooks"),
          join(metadata, "config"),
        ]),
      );
      expect(refreshed.network).toEqual(policy.network);
      expect(policy.filesystem.denyWrite).toEqual(["/baseline/write"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(metadata, { recursive: true, force: true });
    }
  });

  it("fails closed before executing when Git metadata becomes malformed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-git-refresh-invalid-"));
    const policy = createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, cwd);
    const manager = testSandboxManager();

    try {
      await writeFile(join(cwd, ".git"), "gitdir: missing-metadata\n");
      await expect(
        createSandboxedBashOperations(manager, policy).exec("true", cwd, {
          onData: () => undefined,
        }),
      ).rejects.toThrow(/unsafe Git metadata/);
      await expect(
        createSandboxedFileOperations(manager, policy, [], undefined, "invalid-git", cwd).access(
          join(cwd, ".git"),
        ),
      ).rejects.toThrow(/unsafe Git metadata/);
      expect(manager.execute).not.toHaveBeenCalled();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("forces local targets through the parent guard when inline network auth is active", async () => {
    const manager = testSandboxManager(async () => "true");
    const runtime: SandboxPolicy = {
      ...createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, process.cwd()),
      network: {
        ...createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, process.cwd()).network,
        allowLocalBinding: false,
      },
    };
    const networkAuthorize = vi.fn(async () => ({ allowed: true }));

    await createSandboxedBashOperations(manager, runtime, { networkAuthorize }).exec(
      "true",
      process.cwd(),
      {
        onData: () => undefined,
        env: {
          NO_PROXY: "localhost,internal.example",
          no_proxy: "localhost,internal.example",
          CUSTOM_TEST_ENV: "preserved",
        },
      },
    );

    const request = manager.execute.mock.calls[0]?.[0];
    expect(request?.env).toMatchObject({
      NO_PROXY: "",
      no_proxy: "",
      CUSTOM_TEST_ENV: "preserved",
    });
  });

  it("routes local binding through the callback when explicit local binding is enabled", async () => {
    const manager = testSandboxManager(async () => "true");
    const runtime: SandboxPolicy = {
      ...createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, process.cwd()),
      network: {
        ...createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, process.cwd()).network,
        allowLocalBinding: true,
      },
    };

    await createSandboxedBashOperations(manager, runtime, {
      networkAuthorize: async () => ({ allowed: true }),
    }).exec("true", process.cwd(), {
      onData: () => undefined,
      env: { NO_PROXY: "localhost", no_proxy: "localhost" },
    });

    const request = manager.execute.mock.calls[0]?.[0];
    expect(request?.env).toMatchObject({ NO_PROXY: "", no_proxy: "" });
  });

  it("gives bash a default host deadline when timeout is omitted", async () => {
    const manager = testSandboxManager(async () => "true");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    try {
      await createSandboxedBashOperations(manager).exec("ignored", process.cwd(), {
        onData: vi.fn(),
      });

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), DEFAULT_BASH_TIMEOUT_MS);
      expect(manager.execute.mock.calls[0]?.[0].policy.network.deniedDomains).toEqual(["*"]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("uses an explicit positive bash timeout instead of the default", async () => {
    const manager = testSandboxManager(async () => "true");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    try {
      await createSandboxedBashOperations(manager).exec("ignored", process.cwd(), {
        onData: vi.fn(),
        timeout: 2.5,
      });

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2_500);
      expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), DEFAULT_BASH_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("gives native file operations their default host deadline", async () => {
    const manager = testSandboxManager(async () => "true");
    const runtime = createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, process.cwd());
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    try {
      await createSandboxedFileOperations(manager, runtime).readFile("ignored");

      expect(setTimeoutSpy).toHaveBeenCalledWith(
        expect.any(Function),
        DEFAULT_FILE_OPERATION_TIMEOUT_MS,
      );
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("records invocation-local preparation identity and a sticky content-write latch", async () => {
    const events: any[] = [];
    const execute = vi.fn(async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("EACCES unrelated path"),
      exitCode: 1,
    }));
    const manager = { initialize: vi.fn(), reset: vi.fn(), execute };
    const policy: SandboxPolicy = {
      filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
      network: { allowedDomains: [], deniedDomains: [] },
    };
    const operations = createSandboxedFileOperations(
      manager,
      policy,
      [],
      undefined,
      "local",
      process.cwd(),
      { observe: (event) => events.push(event) },
    );
    for (const operation of ["mkdir", "access", "readFile"] as const) {
      await expect(operations[operation]("/tmp/ folder / file ")).rejects.toThrow(
        "EACCES unrelated path",
      );
      expect(events.at(-1)).toMatchObject({
        kind: "failed",
        operation: operation === "readFile" ? "read" : operation,
        path: "/tmp/ folder / file ",
        cwd: process.cwd(),
        contentWriteStarted: false,
        exitCode: 1,
      });
    }
    execute.mockResolvedValueOnce({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 0,
    });
    await operations.access("/tmp/success");
    expect(events.at(-1)).toMatchObject({ kind: "succeeded" });
    await expect(operations.writeFile("/tmp/file", "content")).rejects.toThrow("EACCES");
    expect(events.at(-1)).toMatchObject({
      kind: "failed",
      operation: "write",
      contentWriteStarted: true,
    });
    await expect(operations.access("/tmp/file")).rejects.toThrow();
    expect(events.at(-1)).toMatchObject({ contentWriteStarted: true });
    execute.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(operations.access("/tmp/file")).rejects.toThrow("cleanup failed");
    expect(events.at(-1)).toMatchObject({ kind: "started" });
  });

  it("runs native file operations through the sandbox with one-call write roots", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-native-"));
    const path = join(cwd, "nested", "note.txt");
    const manager = testSandboxManager();
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

  it("does not let a broad write root erase nested protected paths", () => {
    const runtime = createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, "/workspace/project");
    const gitRoot = "/workspace/project/.git";
    const agentsRoot = "/workspace/project/.agents";

    const broad = withAdditionalWriteRoots(runtime, ["/workspace"]);
    expect(broad.filesystem.denyWrite).toContain(gitRoot);

    const exact = withAdditionalWriteRoots(runtime, [gitRoot]);
    expect(exact.filesystem.denyWrite).toContain(gitRoot);
    expect(exact.filesystem.denyWrite).toContain(agentsRoot);
    expect(exact.filesystem.denyWrite).toContain("/workspace/project/.codex");
  });

  it("keeps hard protected paths denied even when requested exactly", () => {
    const runtime = createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, "/workspace/project");
    const agentsRoot = "/workspace/project/.agents";

    const requested = withAdditionalWriteRoots(runtime, [agentsRoot]);
    expect(requested.filesystem.allowWrite).toContain(agentsRoot);
    expect(requested.filesystem.denyWrite).toContain(agentsRoot);
  });

  it("preserves explicit additional roots and nested file grants", () => {
    const runtime = createSandboxRuntimeConfig(DEFAULT_CONFIG.sandbox, "/workspace/project");
    const file = join(homedir(), ".pi", "agent", "models.json");
    const expanded = withAdditionalWriteRoots(runtime, [homedir(), file]);
    expect(expanded.filesystem.allowWrite).toContain(homedir());
    expect(expanded.filesystem.allowWrite).toContain(file);
  });
});
