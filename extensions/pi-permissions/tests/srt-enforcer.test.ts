import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxRuntimeConfig, SandboxViolationStore } from "@anthropic-ai/sandbox-runtime";
import { describe, expect, it } from "vitest";
import { expandSymlinkAliases } from "../src/filesystem-policy.ts";
import {
  assertSrtPolicySupported,
  denialCapabilityFromViolationLine,
  type SrtRuntimeLike,
  SrtSandboxManager,
} from "../src/sandbox/srt-enforcer.ts";
import {
  createSandboxedBashOperations,
  createSandboxedReadOnlyCommandRunner,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxPolicy,
} from "../src/sandbox.ts";

const basePolicy = (): SandboxPolicy => ({
  filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
  network: { allowedDomains: [], deniedDomains: [] },
});

function nodeProgram(source: string): { executable: string; args: string[] } {
  return { executable: process.execPath, args: ["-e", source] };
}

class FakeSrtRuntime implements SrtRuntimeLike {
  readonly initialized: SandboxRuntimeConfig[] = [];
  readonly updated: SandboxRuntimeConfig[] = [];
  readonly wrapped: string[] = [];
  readonly violationsByCommand = new Map<string, Array<{ line: string }>>();
  lastWrapOptions: { commandId?: string; commandText?: string } | undefined;
  cleanupCalls = 0;
  activeWraps = 0;
  maxActiveWraps = 0;
  failCleanup = false;
  wrapDelayMs = 0;
  output = "ok";
  source = "process.stdout.write(process.argv[1])";

  async initialize(config: SandboxRuntimeConfig): Promise<void> {
    this.initialized.push(config);
  }

  isSupportedPlatform(): boolean {
    return true;
  }

  async checkDependenciesAsync(): Promise<{ errors: string[]; warnings: string[] }> {
    return { errors: [], warnings: [] };
  }

  async wrapWithSandboxArgv(
    command: string,
    _binShell?: string,
    _customConfig?: Partial<SandboxRuntimeConfig>,
    _abortSignal?: AbortSignal,
    _cwd?: string,
    options?: { commandId?: string; commandText?: string },
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
    this.wrapped.push(command);
    this.lastWrapOptions = options;
    this.activeWraps += 1;
    this.maxActiveWraps = Math.max(this.maxActiveWraps, this.activeWraps);
    if (this.wrapDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.wrapDelayMs));
    }
    this.activeWraps -= 1;
    return {
      argv: [process.execPath, "-e", this.source, this.output],
      env: {},
    };
  }

  updateConfig(config: SandboxRuntimeConfig): void {
    this.updated.push(config);
  }

  cleanupAfterCommand(): void {
    this.cleanupCalls += 1;
    if (this.failCleanup) throw new Error("cleanup sentinel");
  }

  async reset(): Promise<void> {}

  getSandboxViolationStore(): SandboxViolationStore {
    const byCommand = this.violationsByCommand;
    return {
      getViolationsForCommand: (command: string) => byCommand.get(command) ?? [],
    } as unknown as SandboxViolationStore;
  }
}

async function execute(
  manager: SrtSandboxManager,
  policy: SandboxPolicy = basePolicy(),
  overrides: Partial<SandboxExecutionRequest> = {},
): Promise<SandboxExecutionResult> {
  return manager.execute({
    policy,
    program: nodeProgram("process.stdout.write(process.argv[1])"),
    cwd: process.cwd(),
    ...overrides,
  });
}

describe("SRT executor contract", () => {
  it("detaches a timed-out caller while draining initialize under the process-global lease", async () => {
    const runtime = new FakeSrtRuntime();
    let releaseInitialize!: () => void;
    runtime.initialize = async (config) => {
      runtime.initialized.push(config);
      await new Promise<void>((resolve) => {
        releaseInitialize = resolve;
      });
    };
    const manager = new SrtSandboxManager(runtime);
    let firstSettled = false;
    const first = execute(manager, basePolicy(), { timeoutMs: 10 }).finally(() => {
      firstSettled = true;
    });
    void first.catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(firstSettled).toBe(true);
    await expect(first).rejects.toThrow("timeout:0.01");

    let secondSettled = false;
    const second = execute(manager).finally(() => {
      secondSettled = true;
    });
    await expect(second).rejects.toThrow(/executor is poisoned/);

    expect(secondSettled).toBe(true);
    expect(runtime.initialized).toHaveLength(1);

    runtime.initialize = async () => undefined;
    let recoverySettled = false;
    const recovery = manager.activate(basePolicy()).finally(() => {
      recoverySettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recoverySettled).toBe(false);

    releaseInitialize();
    await expect(recovery).resolves.toBeUndefined();
    await manager.reset();
  });

  it("keeps deny rules independent from writable roots", async () => {
    const runtime = new FakeSrtRuntime();
    const manager = new SrtSandboxManager(runtime);
    await execute(manager, basePolicy());

    const policy: SandboxPolicy = {
      filesystem: {
        allowWrite: ["/workspace"],
        denyRead: ["/workspace/.env"],
        denyWrite: ["/workspace/.git"],
      },
      network: { allowedDomains: ["registry.npmjs.org"], deniedDomains: ["bad.example"] },
    };
    await execute(manager, policy);

    expect(runtime.updated[0]).toEqual({
      filesystem: {
        allowWrite: ["/workspace"],
        denyRead: ["/workspace/.env"],
        denyWrite: ["/workspace/.git"],
      },
      network: { allowedDomains: ["registry.npmjs.org"], deniedDomains: ["bad.example"] },
    });
    expect(runtime.updated[0]?.filesystem).not.toHaveProperty("allowRead");
    await manager.reset();
  });

  it("serializes two manager instances over one process-global SRT lease", async () => {
    const runtime = new FakeSrtRuntime();
    runtime.wrapDelayMs = 15;
    const first = new SrtSandboxManager(runtime);
    const second = new SrtSandboxManager(runtime);
    await first.activate(basePolicy());

    await Promise.all([
      execute(first, basePolicy()),
      execute(second, {
        ...basePolicy(),
        filesystem: { allowWrite: ["/workspace"], denyRead: [], denyWrite: [] },
      }),
    ]);

    expect(runtime.maxActiveWraps).toBe(1);
    expect(runtime.updated.at(-1)?.filesystem.allowWrite).toEqual([]);
    await first.reset();
  });

  it("uses absolute argv and rejects Linux glob policies deterministically", () => {
    expect(() =>
      assertSrtPolicySupported(
        {
          ...basePolicy(),
          filesystem: { allowWrite: [], denyRead: ["/workspace/**/.env"], denyWrite: [] },
        },
        "linux",
      ),
    ).toThrow(/Linux SRT cannot enforce glob deny rules/);
    expect(() => assertSrtPolicySupported(basePolicy(), "linux")).not.toThrow();
  });

  it("kills timed-out children, bounds output, and cleans up", async () => {
    const runtime = new FakeSrtRuntime();
    runtime.source = "setTimeout(() => process.stdout.write('late'), 1000)";
    const manager = new SrtSandboxManager(runtime);
    await expect(execute(manager, basePolicy(), { timeoutMs: 20 })).rejects.toThrow("timeout:0.02");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.cleanupCalls).toBeGreaterThan(0);

    await manager.activate(basePolicy());
    runtime.source = "process.stdout.write('0123456789')";
    await expect(execute(manager, basePolicy(), { maxStdoutBytes: 4 })).rejects.toThrow(
      "stdout exceeded",
    );
    await manager.reset();
  });

  it("poisons after cleanup failure and recovers only through activation", async () => {
    const runtime = new FakeSrtRuntime();
    const manager = new SrtSandboxManager(runtime);
    await manager.activate(basePolicy());
    runtime.failCleanup = true;
    await expect(execute(manager)).rejects.toThrow(/cleanup failed/);
    await expect(execute(manager)).rejects.toThrow(/executor is poisoned/);

    runtime.failCleanup = false;
    await manager.activate(basePolicy());
    await expect(execute(manager)).resolves.toMatchObject({ exitCode: 0 });
    await manager.reset();
  });
});

describe("Guardian environment seam", () => {
  it("uses a replacement environment instead of inheriting credentials", async () => {
    let request: SandboxExecutionRequest | undefined;
    const manager = {
      initialize: async (): Promise<void> => undefined,
      reset: async (): Promise<void> => undefined,
      execute: async (next: SandboxExecutionRequest): Promise<SandboxExecutionResult> => {
        request = next;
        next.onStdout?.(Buffer.from("ok"));
        return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
      },
    };
    const run = createSandboxedReadOnlyCommandRunner(manager, "node");
    await run(["-e", "process.stdout.write('ok')"]);

    expect(request?.envMode).toBe("replace");
    expect(request?.env).toEqual({
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: expect.any(String),
      TMPDIR: expect.any(String),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TERM: "dumb",
    });
    expect(request?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(request?.program.executable).toBe(process.execPath);
  });

  it("executes only the typed Git init plan with fixed config-safe environment", async () => {
    let request: SandboxExecutionRequest | undefined;
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-git-init-"));
    const gitRoots = [...new Set(expandSymlinkAliases(join(cwd, ".git")))];
    const policy: SandboxPolicy = {
      filesystem: {
        allowWrite: gitRoots,
        denyRead: [],
        denyWrite: gitRoots.flatMap((root) => [join(root, "hooks"), join(root, "config")]),
      },
      network: { allowedDomains: [], deniedDomains: [] },
    };
    const manager = {
      initialize: async (): Promise<void> => undefined,
      reset: async (): Promise<void> => undefined,
      execute: async (next: SandboxExecutionRequest): Promise<SandboxExecutionResult> => {
        request = next;
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
      },
    };
    const plan = {
      kind: "git-init" as const,
      executable: "/usr/bin/git",
      args: ["init"] as ["init"],
      cwd,
    };
    try {
      await createSandboxedBashOperations(manager, policy, { gitInitPlan: plan }).exec(
        "git init",
        cwd,
        { onData: () => undefined },
      );

      expect(request?.program).toEqual({ executable: plan.executable, args: plan.args });
      expect(request?.allowGitConfig).toBe(true);
      expect(request?.envMode).toBe("replace");
      expect(request?.env).toMatchObject({
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TEMPLATE_DIR: expect.stringContaining("pi-permissions-git-template-"),
      });
      expect(request?.env?.GIT_TEMPLATE_DIR).not.toBe("");
      expect(request?.env?.HOME).toMatch(/pi-permissions-git-home-/);
      expect(request?.env?.XDG_CONFIG_HOME).toBe(request?.env?.HOME);
      expect(request?.policy.filesystem.denyWrite).toEqual(
        expect.arrayContaining(gitRoots.flatMap((root) => [join(root, "hooks")])),
      );
      expect(request?.policy.filesystem.denyWrite).not.toEqual(
        expect.arrayContaining(gitRoots.flatMap((root) => [join(root, "config")])),
      );
      await expect(lstat(join(cwd, ".git"))).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("removes only its newly prepared Git metadata after a failed init", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-git-init-failed-"));
    const gitRoots = [...new Set(expandSymlinkAliases(join(cwd, ".git")))];
    const policy: SandboxPolicy = {
      filesystem: {
        allowWrite: gitRoots,
        denyRead: [],
        denyWrite: gitRoots.flatMap((root) => [join(root, "hooks"), join(root, "config")]),
      },
      network: { allowedDomains: [], deniedDomains: [] },
    };
    const manager = {
      initialize: async (): Promise<void> => undefined,
      reset: async (): Promise<void> => undefined,
      execute: async (): Promise<SandboxExecutionResult> => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("git init failed"),
        exitCode: 1,
      }),
    };
    const plan = {
      kind: "git-init" as const,
      executable: "/usr/bin/git",
      args: ["init"] as ["init"],
      cwd,
    };

    try {
      await expect(
        createSandboxedBashOperations(manager, policy, { gitInitPlan: plan }).exec(
          "git init",
          cwd,
          { onData: () => undefined },
        ),
      ).resolves.toEqual({ exitCode: 1 });
      await expect(lstat(join(cwd, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each(["file", "symlink"] as const)(
    "rejects an existing .git %s before invoking the Git helper",
    async (kind) => {
      const cwd = await mkdtemp(join(tmpdir(), `pi-permissions-git-init-${kind}-`));
      const gitRoot = join(cwd, ".git");
      const gitRoots = [...new Set(expandSymlinkAliases(gitRoot))];
      const policy: SandboxPolicy = {
        filesystem: {
          allowWrite: gitRoots,
          denyRead: [],
          denyWrite: gitRoots.flatMap((root) => [join(root, "hooks"), join(root, "config")]),
        },
        network: { allowedDomains: [], deniedDomains: [] },
      };
      if (kind === "file") await writeFile(gitRoot, "not a repository");
      else await symlink(cwd, gitRoot);
      let executed = false;
      const manager = {
        initialize: async (): Promise<void> => undefined,
        reset: async (): Promise<void> => undefined,
        execute: async (): Promise<SandboxExecutionResult> => {
          executed = true;
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
        },
      };
      const plan = {
        kind: "git-init" as const,
        executable: "/usr/bin/git",
        args: ["init"] as ["init"],
        cwd,
      };

      try {
        await expect(
          createSandboxedBashOperations(manager, policy, { gitInitPlan: plan }).exec(
            "git init",
            cwd,
            { onData: () => undefined },
          ),
        ).rejects.toThrow(/existing \.git/);
        expect(executed).toBe(false);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
});

describe("Runtime denial classification", () => {
  it("maps authoritative denial lines to exact capabilities", () => {
    expect(
      denialCapabilityFromViolationLine(
        "bash(20614) deny(1) file-write-create /private/tmp/out/new.txt",
      ),
    ).toEqual({ kind: "filesystem", operation: "write", path: "/private/tmp/out/new.txt" });
    expect(
      denialCapabilityFromViolationLine(
        "deny network-outbound example.com:443 (host is not on the allow list)",
      ),
    ).toEqual({ kind: "network", host: "example.com" });
  });

  it("never escalates read denials or kernel noise", () => {
    expect(
      denialCapabilityFromViolationLine("cat(20655) deny(1) file-read-data /private/tmp/secret"),
    ).toBeUndefined();
    expect(
      denialCapabilityFromViolationLine("bash(20441) deny(1) sysctl-read kern.iossupportversion"),
    ).toBeUndefined();
    expect(
      denialCapabilityFromViolationLine(
        "curl(20693) deny(1) mach-lookup com.apple.SystemConfiguration.configd",
      ),
    ).toBeUndefined();
  });

  it("threads the invocation commandId into the sandbox wrap", async () => {
    const runtime = new FakeSrtRuntime();
    const manager = new SrtSandboxManager(runtime);
    await execute(manager, basePolicy(), { commandId: "call-42" });
    expect(runtime.lastWrapOptions?.commandId).toBe("call-42");
    await manager.reset();
  });

  it("returns the exact denied capability recorded for the invocation", async () => {
    const runtime = new FakeSrtRuntime();
    runtime.violationsByCommand.set("call-1", [
      { line: "bash(1) deny(1) sysctl-read kern.iossupportversion" },
      { line: "bash(2) deny(1) file-write-create /private/workspace/report.txt" },
    ]);
    runtime.violationsByCommand.set("other-call", [
      { line: "bash(3) deny(1) file-write-create /elsewhere/file.txt" },
    ]);
    const manager = new SrtSandboxManager(runtime);

    await expect(manager.classifyDenial("call-1")).resolves.toEqual({
      kind: "filesystem",
      operation: "write",
      path: "/private/workspace/report.txt",
    });
    await manager.reset();
  });

  it("waits within the bounded drain for late denial events", async () => {
    const runtime = new FakeSrtRuntime();
    const manager = new SrtSandboxManager(runtime);
    setTimeout(() => {
      runtime.violationsByCommand.set("call-late", [
        { line: "deny network-outbound api.example.com:443 (host is not on the allow list)" },
      ]);
    }, 250);

    await expect(manager.classifyDenial("call-late")).resolves.toEqual({
      kind: "network",
      host: "api.example.com",
    });
    await manager.reset();
  });

  it("fails closed when only noise violations exist", async () => {
    const runtime = new FakeSrtRuntime();
    runtime.violationsByCommand.set("call-noise", [
      { line: "bash(1) deny(1) sysctl-read kern.iossupportversion" },
    ]);
    const manager = new SrtSandboxManager(runtime);

    await expect(manager.classifyDenial("call-noise")).resolves.toBeUndefined();
    await manager.reset();
  }, 10_000);
});
