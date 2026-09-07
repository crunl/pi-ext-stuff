import { type ChildProcess, spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  SandboxAskCallback,
  SandboxRuntimeConfig,
  SandboxViolationStore,
} from "@anthropic-ai/sandbox-runtime";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { SandboxConnectGuard } from "../src/sandbox/connect-guard.ts";
import { SRT_DRAIN_TIMEOUT_MS, SrtProcessCoordinator } from "../src/sandbox/srt-coordinator.ts";
import {
  assertSrtPolicySupported,
  denialCapabilityFromViolationLine,
  type SrtRuntimeLike,
  SrtSandboxManager,
} from "../src/sandbox/srt-enforcer.ts";
import {
  createGuardianEvidenceScope,
  createSandboxedReadOnlyCommandRunner,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxNetworkAuthorization,
  type SandboxNetworkEndpoint,
  type SandboxPolicy,
} from "../src/sandbox.ts";

const basePolicy = (): SandboxPolicy => ({
  filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
  network: { allowedDomains: [], deniedDomains: [] },
});

function nodeProgram(source: string): { executable: string; args: string[] } {
  return { executable: process.execPath, args: ["-e", source] };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function controlledChild(): {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
} {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    pid: undefined,
    stdout,
    stderr,
    stdin: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return { child, stdout, stderr };
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
  failReset = false;
  failInitialize = false;
  failUpdateCall: number | undefined;
  updateCalls = 0;
  wrapDelayMs = 0;
  wrapGate: Promise<void> | undefined;
  onWrapComplete: (() => void) | undefined;
  output = "ok";
  source = "process.stdout.write(process.argv[1])";
  wrappedEnv: NodeJS.ProcessEnv = {};
  askNetwork: SandboxAskCallback | undefined;
  networkRequest: { host: string; port: number } | undefined;
  networkDecision: boolean | undefined;

  async initialize(config: SandboxRuntimeConfig, askNetwork?: SandboxAskCallback): Promise<void> {
    this.initialized.push(config);
    this.askNetwork = askNetwork;
    if (this.failInitialize) throw new Error("initialize sentinel");
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
    if (this.networkRequest && this.askNetwork) {
      this.networkDecision = await this.askNetwork(this.networkRequest);
    }
    this.activeWraps += 1;
    this.maxActiveWraps = Math.max(this.maxActiveWraps, this.activeWraps);
    if (this.wrapDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.wrapDelayMs));
    }
    if (this.wrapGate) await this.wrapGate;
    this.activeWraps -= 1;
    this.onWrapComplete?.();
    return {
      argv: [process.execPath, "-e", this.source, this.output],
      env: this.wrappedEnv,
    };
  }

  updateConfig(config: SandboxRuntimeConfig): void {
    this.updated.push(config);
    this.updateCalls += 1;
    if (this.failUpdateCall === this.updateCalls) throw new Error("update sentinel");
  }

  cleanupAfterCommand(): void {
    this.cleanupCalls += 1;
    if (this.failCleanup) throw new Error("cleanup sentinel");
  }

  async reset(): Promise<void> {
    if (this.failReset) throw new Error("reset sentinel");
    this.askNetwork = undefined;
  }

  getSandboxViolationStore(): SandboxViolationStore {
    const byCommand = this.violationsByCommand;
    return {
      getViolationsForCommand: (command: string) => byCommand.get(command) ?? [],
    } as unknown as SandboxViolationStore;
  }
}

class FakeConnectGuard extends SandboxConnectGuard {
  startCalls = 0;
  closeCalls = 0;
  resetCalls = 0;
  issueCalls = 0;
  activeTickets = 0;
  failClose = false;
  failResetExecutionAt: number | undefined;

  override get parentProxyUrl(): string {
    return "http://pi-permissions:test@127.0.0.1:43123";
  }

  override async start(): Promise<void> {
    this.startCalls += 1;
  }

  override async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.failClose) throw new Error("guard close sentinel");
    this.activeTickets = 0;
  }

  override resetExecution(): void {
    this.resetCalls += 1;
    if (this.failResetExecutionAt === this.resetCalls) {
      throw new Error("guard reset sentinel");
    }
    this.activeTickets = 0;
  }

  override issue(_endpoint: SandboxNetworkEndpoint): boolean {
    this.issueCalls += 1;
    this.activeTickets += 1;
    return true;
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
  it("lets the next execution run after a timed-out initialization drains", async () => {
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

    await expect(first).rejects.toThrow("timeout:0.01");
    expect(firstSettled).toBe(true);
    expect(manager.isHealthy()).toBe(false);

    let secondSettled = false;
    const second = execute(manager).finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(runtime.initialized).toHaveLength(1);

    runtime.initialize = async () => undefined;
    releaseInitialize();
    await expect(second).resolves.toMatchObject({ exitCode: 0 });
    expect(secondSettled).toBe(true);
    expect(manager.isHealthy()).toBe(true);
    await manager.reset();
  });

  it("keeps the initialization lease through cancellation and drops a queued caller", async () => {
    const runtime = new FakeSrtRuntime();
    const initGate = deferred<void>();
    runtime.initialize = async (config) => {
      runtime.initialized.push(config);
      await initGate.promise;
    };
    const manager = new SrtSandboxManager(runtime);
    const firstController = new AbortController();
    const first = execute(manager, basePolicy(), { signal: firstController.signal });
    await flushMicrotasks();
    expect(runtime.initialized).toHaveLength(1);

    firstController.abort();
    await expect(first).rejects.toThrow("aborted");
    expect(manager.isHealthy()).toBe(false);

    const queuedController = new AbortController();
    const queued = execute(manager, basePolicy(), { signal: queuedController.signal });
    queuedController.abort();
    await expect(queued).rejects.toThrow("aborted");
    expect(runtime.initialized).toHaveLength(1);

    initGate.resolve(undefined);
    await flushMicrotasks();
    runtime.initialize = async () => undefined;
    await expect(execute(manager)).resolves.toMatchObject({ exitCode: 0 });
    expect(manager.isHealthy()).toBe(true);
    await manager.reset();
  });

  it("keeps the wrapping lease through cancellation and prevents overlap", async () => {
    const runtime = new FakeSrtRuntime();
    const manager = new SrtSandboxManager(runtime);
    await manager.activate(basePolicy());
    const wrapGate = deferred<void>();
    runtime.wrapGate = wrapGate.promise;
    const firstController = new AbortController();
    const first = execute(manager, basePolicy(), { signal: firstController.signal });
    await flushMicrotasks();
    expect(runtime.activeWraps).toBe(1);

    firstController.abort();
    await expect(first).rejects.toThrow("aborted");
    expect(manager.isHealthy()).toBe(false);

    const queuedController = new AbortController();
    const queued = execute(manager, basePolicy(), { signal: queuedController.signal });
    queuedController.abort();
    await expect(queued).rejects.toThrow("aborted");

    wrapGate.resolve(undefined);
    await flushMicrotasks();
    runtime.wrapGate = undefined;
    await expect(execute(manager)).resolves.toMatchObject({ exitCode: 0 });
    expect(runtime.maxActiveWraps).toBe(1);
    await manager.reset();
  });

  it("poisons a drain deadline without releasing an unsettled lease", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new SrtProcessCoordinator();
      const operationGate = deferred<void>();
      const ownerController = new AbortController();
      let operationStarted = false;
      const owner = coordinator.runExclusiveDetached(async () => {
        operationStarted = true;
        await operationGate.promise;
      }, ownerController.signal);
      await flushMicrotasks();
      expect(operationStarted).toBe(true);

      ownerController.abort();
      await expect(owner).rejects.toThrow("aborted");
      expect(coordinator.isDraining).toBe(true);

      const queuedController = new AbortController();
      const queued = coordinator.runExclusiveDetached(
        async () => undefined,
        queuedController.signal,
      );
      queuedController.abort();
      await expect(queued).rejects.toThrow("aborted");

      let activationStarted = false;
      const activation = coordinator.runExclusiveDetached(
        async () => {
          activationStarted = true;
        },
        undefined,
        undefined,
        { allowPoisoned: true },
      );
      const waiting = coordinator.runExclusiveDetached(async () => undefined);
      void waiting.catch(() => undefined);
      await flushMicrotasks();
      expect(activationStarted).toBe(false);

      vi.advanceTimersByTime(SRT_DRAIN_TIMEOUT_MS - 1);
      await flushMicrotasks();
      expect(coordinator.isPoisoned).toBe(false);
      vi.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(coordinator.isPoisoned).toBe(true);
      expect(coordinator.isDraining).toBe(true);
      await expect(waiting).rejects.toThrow(/drain-timeout/);
      await expect(coordinator.runExclusiveDetached(async () => undefined)).rejects.toThrow(
        /executor is poisoned/,
      );
      expect(activationStarted).toBe(false);

      operationGate.resolve(undefined);
      await expect(activation).resolves.toBeUndefined();
      expect(coordinator.isDraining).toBe(false);
      expect(coordinator.isPoisoned).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the lease until a child error is followed by close", async () => {
    const runtime = new FakeSrtRuntime();
    const manager = new SrtSandboxManager(runtime);
    await manager.activate(basePolicy());
    const { child } = controlledChild();
    const spawnReady = deferred<void>();
    vi.mocked(spawnProcess).mockImplementationOnce(() => {
      spawnReady.resolve(undefined);
      return child;
    });

    const first = execute(manager);
    let firstSettled = false;
    void first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    await spawnReady.promise;
    child.emit("error", new Error("child sentinel"));
    await flushMicrotasks();
    expect(firstSettled).toBe(false);
    const second = execute(manager);
    let secondSettled = false;
    void second.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );
    await flushMicrotasks();
    expect(secondSettled).toBe(false);

    child.emit("close", -1);
    await expect(first).rejects.toThrow("child sentinel");
    await expect(second).resolves.toMatchObject({ exitCode: 0 });
    await manager.reset();
  });

  it("does not forward output that arrives after cancellation", async () => {
    const runtime = new FakeSrtRuntime();
    const manager = new SrtSandboxManager(runtime);
    await manager.activate(basePolicy());
    const { child, stdout, stderr } = controlledChild();
    const spawnReady = deferred<void>();
    vi.mocked(spawnProcess).mockImplementationOnce(() => {
      spawnReady.resolve(undefined);
      return child;
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const caller = new AbortController();
    const first = execute(manager, basePolicy(), {
      signal: caller.signal,
      onStdout: (chunk) => stdoutChunks.push(chunk),
      onStderr: (chunk) => stderrChunks.push(chunk),
    });
    await spawnReady.promise;

    caller.abort();
    await expect(first).rejects.toThrow("aborted");
    expect(manager.isHealthy()).toBe(false);
    stdout.emit("data", Buffer.from("late stdout"));
    stderr.emit("data", Buffer.from("late stderr"));
    expect(stdoutChunks).toHaveLength(0);
    expect(stderrChunks).toHaveLength(0);

    const next = execute(manager);
    child.emit("close", null);
    await expect(next).resolves.toMatchObject({ exitCode: 0 });
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

  it("preserves caller env for the POSIX SRT broker while retaining SRT output", async () => {
    const runtime = new FakeSrtRuntime();
    runtime.wrappedEnv = {
      HTTP_PROXY: "http://srt-http.internal",
      HTTPS_PROXY: "https://srt-https.internal",
      ALL_PROXY: "socks5://srt-all.internal",
      NO_PROXY: "srt-no.internal",
      no_proxy: "srt-no.internal",
      SRT_ONLY: "present",
      OPENAI_API_KEY: undefined,
      PI_SESSION_ID: "wrapped-session",
      PI_SESSION_FILE: "wrapped-file",
      PI_PROVIDER: "wrapped-provider",
      PI_MODEL: "wrapped-model",
      PI_REASONING_LEVEL: "wrapped-reasoning",
      PI_TEST: "wrapped-pi-test",
    };
    runtime.source =
      "process.stdout.write(JSON.stringify({http:process.env.HTTP_PROXY,https:process.env.HTTPS_PROXY,all:process.env.ALL_PROXY,no:process.env.NO_PROXY,noLower:process.env.no_proxy,custom:process.env.CUSTOM_TEST_ENV,session:process.env.PI_SESSION_ID,file:process.env.PI_SESSION_FILE,provider:process.env.PI_PROVIDER,model:process.env.PI_MODEL,reasoning:process.env.PI_REASONING_LEVEL,pi:process.env.PI_TEST,masked:process.env.OPENAI_API_KEY,srt:process.env.SRT_ONLY}))";
    const manager = new SrtSandboxManager(runtime);

    const result = await execute(manager, basePolicy(), {
      env: {
        HTTP_PROXY: "http://host-proxy.internal",
        HTTPS_PROXY: "https://host-proxy.internal",
        ALL_PROXY: "socks5://host-proxy.internal",
        NO_PROXY: "host-no.internal",
        no_proxy: "host-no.internal",
        CUSTOM_TEST_ENV: "preserved",
        PI_SESSION_ID: "request-session",
        PI_SESSION_FILE: "request-file",
        PI_PROVIDER: "request-provider",
        PI_MODEL: "request-model",
        PI_REASONING_LEVEL: "request-reasoning",
        PI_TEST: "request-pi-test",
      },
    });

    expect(JSON.parse(result.stdout.toString())).toEqual({
      http: "http://host-proxy.internal",
      https: "https://host-proxy.internal",
      all: "socks5://host-proxy.internal",
      no: "host-no.internal",
      noLower: "host-no.internal",
      custom: "preserved",
      session: "request-session",
      file: "request-file",
      provider: "request-provider",
      model: "request-model",
      reasoning: "request-reasoning",
      pi: "request-pi-test",
      srt: "present",
    });
    await manager.reset();
  });

  it("overrides SRT's POSIX NO_PROXY assignments inside the tool command", async () => {
    const runtime = new FakeSrtRuntime();
    const manager = new SrtSandboxManager(runtime);
    const policy: SandboxPolicy = {
      ...basePolicy(),
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: false,
      },
    };

    await execute(manager, policy, {
      networkAuthorize: async () => ({ allowed: false, reason: "denied" }),
    });

    const wrapped = runtime.wrapped[runtime.wrapped.length - 1];
    if (process.platform === "win32") {
      expect(wrapped).not.toContain('NO_PROXY="" no_proxy=""');
    } else {
      expect(wrapped).toMatch(/^NO_PROXY="" no_proxy="" /);
    }
    await manager.reset();

    const localBindingPolicy: SandboxPolicy = {
      ...policy,
      network: { ...policy.network, allowLocalBinding: true },
    };
    await execute(manager, localBindingPolicy, {
      networkAuthorize: async () => ({ allowed: false, reason: "denied" }),
    });
    const localBindingWrapped = runtime.wrapped[runtime.wrapped.length - 1];
    if (process.platform === "win32") {
      expect(localBindingWrapped).not.toContain('NO_PROXY="" no_proxy=""');
    } else {
      expect(localBindingWrapped).toMatch(/^NO_PROXY="" no_proxy="" /);
    }
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

  it("poisons after policy restore failure and recovers only through activation", async () => {
    const runtime = new FakeSrtRuntime();
    const manager = new SrtSandboxManager(runtime);
    const changedPolicy: SandboxPolicy = {
      ...basePolicy(),
      filesystem: { allowWrite: ["/workspace"], denyRead: [], denyWrite: [] },
    };
    await manager.activate(basePolicy());
    runtime.failUpdateCall = 2;

    await expect(execute(manager, changedPolicy)).rejects.toThrow(/SRT restore failed/);
    await expect(execute(manager, basePolicy())).rejects.toThrow(/executor is poisoned/);

    runtime.failUpdateCall = undefined;
    await manager.activate(basePolicy());
    await expect(execute(manager, basePolicy())).resolves.toMatchObject({ exitCode: 0 });
    await manager.reset();
  });

  it("poisons after reset or guard cleanup failure and activation recovers", async () => {
    const runtime = new FakeSrtRuntime();
    const manager = new SrtSandboxManager(runtime);
    runtime.failReset = true;

    await expect(manager.reset()).rejects.toThrow(/SRT reset failed/);
    await expect(execute(manager)).rejects.toThrow(/previous SRT reset failure/);

    runtime.failReset = false;
    await manager.activate(basePolicy());
    await expect(execute(manager)).resolves.toMatchObject({ exitCode: 0 });
    await manager.reset();

    const guardedRuntime = new FakeSrtRuntime();
    const guard = new FakeConnectGuard();
    const guardedManager = new SrtSandboxManager(guardedRuntime, guard);
    await guardedManager.activate(basePolicy());
    guard.failResetExecutionAt = guard.resetCalls + 2;

    await expect(execute(guardedManager)).rejects.toThrow(/SRT cleanup failed/);
    await expect(execute(guardedManager)).rejects.toThrow(/previous SRT cleanup failure/);

    guard.failResetExecutionAt = undefined;
    await guardedManager.activate(basePolicy());
    await expect(execute(guardedManager)).resolves.toMatchObject({ exitCode: 0 });
    await guardedManager.reset();

    guard.failClose = true;
    await expect(guardedManager.reset()).rejects.toThrow(/SRT reset failed/);
    await expect(execute(guardedManager)).rejects.toThrow(/previous SRT reset failure/);
    guard.failClose = false;
    await guardedManager.activate(basePolicy());
    await expect(execute(guardedManager)).resolves.toMatchObject({ exitCode: 0 });
    await guardedManager.reset();
  });
});

describe("SRT network authorization seam", () => {
  const networkPolicy = (): SandboxPolicy => ({
    ...basePolicy(),
    network: {
      allowedDomains: ["allowed.example"],
      deniedDomains: ["blocked.example", "[::1]"],
      trustedFakeIpRanges: ["198.18.0.0/15"],
      allowLocalBinding: true,
    },
  });

  const authorization = (
    endpoint: SandboxNetworkEndpoint | undefined,
  ): SandboxNetworkAuthorization =>
    endpoint ? { allowed: true, endpoint } : { allowed: false, reason: "denied" };

  it("routes the SRT callback through the parent guard with exact host and port", async () => {
    const runtime = new FakeSrtRuntime();
    const guard = new FakeConnectGuard();
    const manager = new SrtSandboxManager(runtime, guard);
    const policy = networkPolicy();
    runtime.networkRequest = { host: "allowed.example", port: 443 };

    await manager.activate(policy);
    const initialized = runtime.initialized[runtime.initialized.length - 1];
    expect(initialized?.network).toMatchObject({
      allowedDomains: [],
      deniedDomains: ["blocked.example", "[::1]"],
      allowLocalBinding: true,
      parentProxy: {
        http: guard.parentProxyUrl,
        https: guard.parentProxyUrl,
        noProxy: "",
      },
    });

    guard.resetCalls = 0;
    await execute(manager, policy, {
      networkAuthorize: async ({ host, port }) =>
        authorization({ host, port, addresses: ["93.184.216.34"] }),
    });

    expect(runtime.networkDecision).toBe(true);
    expect(guard.issueCalls).toBe(1);
    expect(guard.activeTickets).toBe(0);
    expect(guard.resetCalls).toBe(2);
    await manager.reset();
  });

  it("does not mint tickets for SRT's unconditional loopback parent bypass", async () => {
    const runtime = new FakeSrtRuntime();
    const guard = new FakeConnectGuard();
    const manager = new SrtSandboxManager(runtime, guard);
    const policy = networkPolicy();
    runtime.networkRequest = { host: "localhost", port: 8080 };

    await manager.activate(policy);
    await execute(manager, policy, {
      networkAuthorize: async ({ host, port }) =>
        authorization({ host, port, addresses: ["127.0.0.1", "::1"] }),
    });

    expect(runtime.networkDecision).toBe(true);
    expect(guard.issueCalls).toBe(0);
    await manager.reset();
  });

  it("fails closed for a mismatched or missing endpoint and does not issue a ticket", async () => {
    const runtime = new FakeSrtRuntime();
    const guard = new FakeConnectGuard();
    const manager = new SrtSandboxManager(runtime, guard);
    const policy = networkPolicy();
    runtime.networkRequest = { host: "allowed.example", port: 443 };

    await manager.activate(policy);
    await execute(manager, policy, {
      networkAuthorize: async () =>
        authorization({ host: "other.example", port: 443, addresses: ["93.184.216.34"] }),
    });
    expect(runtime.networkDecision).toBe(false);
    expect(guard.issueCalls).toBe(0);

    runtime.networkDecision = undefined;
    await execute(manager, policy, {
      networkAuthorize: async () => authorization(undefined),
    });
    expect(runtime.networkDecision).toBe(false);
    expect(guard.issueCalls).toBe(0);
    await manager.reset();
  });

  it("rejects a delayed authorization that resolves after cancellation", async () => {
    const runtime = new FakeSrtRuntime();
    const guard = new FakeConnectGuard();
    const manager = new SrtSandboxManager(runtime, guard);
    const policy = networkPolicy();
    runtime.networkRequest = { host: "allowed.example", port: 443 };
    await manager.activate(policy);
    const authorizationGate = deferred<SandboxNetworkAuthorization>();
    let authorizationSignal: AbortSignal | undefined;
    const caller = new AbortController();
    const first = execute(manager, policy, {
      signal: caller.signal,
      networkAuthorize: async ({ signal }) => {
        authorizationSignal = signal;
        return authorizationGate.promise;
      },
    });
    await flushMicrotasks();
    expect(authorizationSignal).toBeDefined();

    caller.abort();
    await expect(first).rejects.toThrow("aborted");
    expect(authorizationSignal?.aborted).toBe(true);

    const next = execute(manager, policy);
    authorizationGate.resolve(
      authorization({ host: "allowed.example", port: 443, addresses: ["93.184.216.34"] }),
    );
    await expect(next).resolves.toMatchObject({ exitCode: 0 });
    expect(guard.issueCalls).toBe(0);
    await manager.reset();
  });

  it("restores the authorization handler and clears guard state after lazy initialization fails", async () => {
    const runtime = new FakeSrtRuntime();
    const guard = new FakeConnectGuard();
    const manager = new SrtSandboxManager(runtime, guard);
    runtime.failInitialize = true;
    runtime.networkRequest = { host: "allowed.example", port: 443 };

    await expect(
      execute(manager, networkPolicy(), {
        networkAuthorize: async ({ host, port }) =>
          authorization({ host, port, addresses: ["93.184.216.34"] }),
      }),
    ).rejects.toThrow("initialize sentinel");
    expect(guard.activeTickets).toBe(0);
    expect(guard.closeCalls).toBeGreaterThan(0);
    expect(guard.resetCalls).toBeGreaterThan(0);

    runtime.failInitialize = false;
    await manager.activate(networkPolicy());
    runtime.networkDecision = undefined;
    await execute(manager, networkPolicy());
    expect(runtime.networkDecision).toBe(false);
    expect(guard.issueCalls).toBe(0);
    await manager.reset();
  });

  it("restores policy and authorization state after cleanup failure", async () => {
    const runtime = new FakeSrtRuntime();
    const guard = new FakeConnectGuard();
    const manager = new SrtSandboxManager(runtime, guard);
    const policy = networkPolicy();
    runtime.networkRequest = { host: "allowed.example", port: 443 };
    await manager.activate(policy);

    runtime.failCleanup = true;
    await expect(
      execute(manager, policy, {
        networkAuthorize: async ({ host, port }) =>
          authorization({ host, port, addresses: ["93.184.216.34"] }),
      }),
    ).rejects.toThrow(/SRT cleanup failed/);
    expect(guard.issueCalls).toBe(1);
    expect(guard.activeTickets).toBe(0);

    runtime.failCleanup = false;
    await manager.activate(policy);
    runtime.networkDecision = undefined;
    await execute(manager, policy);
    expect(runtime.networkDecision).toBe(false);
    expect(guard.issueCalls).toBe(1);
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
    const run = createSandboxedReadOnlyCommandRunner(
      manager,
      "node",
      createGuardianEvidenceScope(process.cwd(), basePolicy()),
    );
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
