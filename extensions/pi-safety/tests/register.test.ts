import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AutoReviewRequest, AutoReviewResult } from "../src/auto-review-request.ts";
import { type AutoReviewer, AutoReviewerFailure, PiAutoReviewer } from "../src/auto-reviewer.ts";
import { NetworkBoundary } from "../src/network-boundary.ts";
import { registerExtension } from "../src/register.ts";
import type { RiskDecision } from "../src/risk-policy.ts";
import { SandboxConnectGuard } from "../src/sandbox/connect-guard.ts";
import { SRT_DRAIN_TIMEOUT_MS } from "../src/sandbox/srt-coordinator.ts";
import { type SrtRuntimeLike, SrtSandboxManager } from "../src/sandbox/srt-enforcer.ts";
import type {
  SandboxDenialCapability,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxManagerLike,
  SandboxPolicy,
} from "../src/sandbox.ts";
import { SandboxExecutionCoordinator } from "../src/sandbox-coordinator.ts";

type RiskOverride = (
  tool: string,
  input: Record<string, unknown>,
) => RiskDecision | undefined | Promise<RiskDecision | undefined>;

type ReviewOverride = (
  request: AutoReviewRequest,
  ordinal: number,
) => AutoReviewResult | Promise<AutoReviewResult>;

type SandboxOperations = {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
};

type BashFactoryOptions = { operations?: SandboxOperations };

interface HarnessOptions {
  config?: Record<string, unknown>;
  hasUI?: boolean;
  mode?: "tui" | "rpc" | "json" | "print";
  risk?: RiskOverride;
  review?: ReviewOverride;
  eventBusError?: boolean;
  useRealBashTool?: boolean;
  /** Keep both production risk classification and activation/execution barriers. */
  useRealPermissionRuntime?: boolean;
  useRealCoordinator?: boolean;
  sandboxInitializeError?: Error;
  sandboxExecuteError?: Error;
  sandboxExecute?: (
    request: SandboxExecutionRequest,
    ordinal: number,
  ) => Promise<SandboxExecutionResult>;
  sandboxDenial?: SandboxDenialCapability;
  sandboxDiagnostics?: string;
  sandboxNetworkAttempt?: { host: string; port: number };
  sandboxNetworkAnswers?: Record<string, readonly string[]>;
  sandboxResetErrorAfter?: number;
  sandboxHealthy?: boolean;
  sandboxManagerOverride?: SandboxManagerLike;
  /** Replace the default stub reviewer (e.g. production PiAutoReviewer). */
  autoReviewer?: AutoReviewer;
  model?: unknown;
  modelRegistry?: unknown;
}

interface Harness {
  agentDir: string;
  cwd: string;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  commands: Map<string, { handler: (...args: unknown[]) => unknown }>;
  shortcuts: Map<string, { handler: (...args: unknown[]) => unknown }>;
  tools: Map<
    string,
    {
      label?: string;
      description?: string;
      parameters?: unknown;
      prepareArguments?: (args: unknown) => unknown;
      execute: (...args: unknown[]) => Promise<unknown>;
    }
  >;
  context: Record<string, unknown>;
  sessionManager: {
    getBranch: ReturnType<typeof vi.fn>;
    getSessionId: ReturnType<typeof vi.fn>;
  };
  riskEvaluator: ReturnType<typeof vi.fn>;
  reviewInputs: AutoReviewRequest[];
  reviewContexts: unknown[];
  autoReviewer: AutoReviewer;
  sandboxManager: {
    initialize: ReturnType<typeof vi.fn>;
    isHealthy: ReturnType<typeof vi.fn>;
    waitForIdle: ReturnType<typeof vi.fn>;
    wrapWithSandbox: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
    classifyDenial: ReturnType<typeof vi.fn>;
    readFailureDiagnostics: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  };
  bashToolFactory: ReturnType<typeof vi.fn>;
  executionCoordinator: SandboxExecutionCoordinator;
  sandboxCoordinator: {
    runShared: ReturnType<typeof vi.fn>;
    runExclusive: ReturnType<typeof vi.fn>;
  };
  bareBashExecute: ReturnType<typeof vi.fn>;
  sandboxBashExecute: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
}

const tempDirectories: string[] = [];
function reviewStatusCalls(app: Pick<Harness, "setStatus">): unknown[][] {
  return app.setStatus.mock.calls;
}

afterEach(async () => {
  const directories = tempDirectories.splice(0);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function approved(rationale = "Approved by the test Guardian."): AutoReviewResult {
  return {
    decision: "approve",
    risk: "low",
    userAuthorization: "high",
    rationale,
  };
}

function denied(rationale = "Denied by the test Guardian."): AutoReviewResult {
  return {
    decision: "deny",
    risk: "high",
    userAuthorization: "high",
    rationale,
  };
}

function lowRisk(): RiskDecision {
  return { action: "allow", risk: "LOW", reason: "LOW test operation" };
}

function promptRisk(
  overrides: Partial<Extract<RiskDecision, { action: "prompt" }>> = {},
): RiskDecision {
  return {
    action: "prompt",
    risk: "REVIEW",
    reason: "REVIEW test operation",
    summary: "test operation",
    ...overrides,
  };
}

function blockRisk(reason = "HARD test policy"): RiskDecision {
  return { action: "block", risk: "HARD", reason };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-safety-register-agent-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-safety-register-workspace-"));
  tempDirectories.push(agentDir, cwd);
  const configDirectory = agentDir;
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    join(agentDir, "keybindings.json"),
    JSON.stringify({ "app.thinking.cycle": "ctrl+shift+t" }),
  );
  if (options.config) {
    await writeFile(join(configDirectory, "safety.json"), JSON.stringify(options.config));
  }

  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const commands = new Map<string, { handler: (...args: unknown[]) => unknown }>();
  const shortcuts = new Map<string, { handler: (...args: unknown[]) => unknown }>();
  const tools = new Map<
    string,
    {
      label?: string;
      description?: string;
      parameters?: unknown;
      prepareArguments?: (args: unknown) => unknown;
      execute: (...args: unknown[]) => Promise<unknown>;
    }
  >();
  const branch: unknown[] = [];
  const getBranch = vi.fn(() => branch);
  const getSessionId = vi.fn(() => "stable-register-session");
  const sessionManager = { getBranch, getSessionId };

  const initialize = vi.fn(async (_config: unknown) => {
    if (options.sandboxInitializeError) throw options.sandboxInitializeError;
  });
  const wrapWithSandbox = vi.fn(
    async (command: string, _shell?: string, _config?: unknown, _signal?: AbortSignal) => command,
  );
  let executeOrdinal = 0;
  const execute = vi.fn(
    async (request: SandboxExecutionRequest): Promise<SandboxExecutionResult> => {
      executeOrdinal += 1;
      if (options.sandboxExecuteError) throw options.sandboxExecuteError;
      if (options.sandboxExecute) return options.sandboxExecute(request, executeOrdinal);
      await wrapWithSandbox(
        [request.program.executable, ...request.program.args].map(shellQuote).join(" "),
        undefined,
        request.policy as SandboxPolicy,
        request.signal,
      );
      if (options.sandboxNetworkAttempt && request.networkAuthorize) {
        const authorization = await request.networkAuthorize({
          ...options.sandboxNetworkAttempt,
          signal: request.signal,
        });
        if (!authorization.allowed) {
          const stderr = Buffer.from("connect tunnel failed: sandbox denied\n");
          request.onStderr?.(stderr);
          return { stdout: Buffer.alloc(0), stderr, exitCode: 1 };
        }
      }
      if (options.sandboxDenial && executeOrdinal === 1) {
        const stderr = Buffer.from("connect tunnel failed: sandbox denied\n");
        request.onStderr?.(stderr);
        return { stdout: Buffer.alloc(0), stderr, exitCode: 1 };
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    },
  );
  const classifyDenial = vi.fn(async () => options.sandboxDenial);
  let resetOrdinal = 0;
  const reset = vi.fn(async () => {
    resetOrdinal += 1;
    if (
      options.sandboxResetErrorAfter !== undefined &&
      resetOrdinal >= options.sandboxResetErrorAfter
    ) {
      throw new Error("timeout:5");
    }
  });
  const isHealthy = vi.fn(() => options.sandboxHealthy ?? true);
  const sandboxManager = {
    initialize,
    isHealthy,
    waitForIdle: vi.fn(async (_signal?: AbortSignal) => {}),
    wrapWithSandbox,
    execute,
    classifyDenial,
    reset,
    readFailureDiagnostics: vi.fn(async () => options.sandboxDiagnostics),
  };

  const executionCoordinator = new SandboxExecutionCoordinator();
  const runShared = vi.fn(async <T>(operation: () => Promise<T>) => operation());
  const runExclusive = vi.fn(async <T>(operation: () => Promise<T>) => operation());
  const sandboxCoordinator = { runShared, runExclusive };

  const bareBashExecute = vi.fn(async (..._args: unknown[]) => ({
    content: [],
    details: undefined,
  }));
  const sandboxBashExecute = vi.fn(async (..._args: unknown[]) => ({
    content: [],
    details: undefined,
  }));
  const bashToolFactory = vi.fn((toolCwd: string, factoryOptions?: BashFactoryOptions) => ({
    name: "bash",
    label: "bash",
    description: "bash",
    parameters: {},
    execute: async (
      id: string,
      params: { command: string; timeout?: number },
      signal: AbortSignal | undefined,
      onUpdate: unknown,
    ) => {
      if (factoryOptions?.operations) {
        sandboxBashExecute(id, params, signal, onUpdate);
        const output: Buffer[] = [];
        const result = await factoryOptions.operations.exec(params.command, toolCwd, {
          onData: (data) => output.push(data),
          signal,
          timeout: params.timeout,
        });
        if (result.exitCode !== 0 && result.exitCode !== null) {
          const message = Buffer.concat(output).toString("utf8").trimEnd();
          throw new Error(`${message}\n\nCommand exited with code ${result.exitCode}`);
        }
        return { content: [], details: undefined };
      }
      return bareBashExecute(id, params, signal, onUpdate);
    },
  }));

  const reviewInputs: AutoReviewRequest[] = [];
  const reviewContexts: unknown[] = [];
  let reviewOrdinal = 0;
  const review = vi.fn(async (request: AutoReviewRequest, context: unknown) => {
    reviewInputs.push(request);
    reviewContexts.push(context);
    reviewOrdinal += 1;
    return options.review ? options.review(request, reviewOrdinal) : approved();
  });
  const invalidateSession = vi.fn();
  const autoReviewer: AutoReviewer = options.autoReviewer ?? { invalidateSession, review };

  const riskEvaluator = vi.fn(
    async (tool: string, input: Record<string, unknown>): Promise<RiskDecision> => {
      const override = await options.risk?.(tool, input);
      return override ?? lowRisk();
    },
  );

  const setStatus = vi.fn();
  const notify = vi.fn();
  const select = vi.fn(async (_title: string, choices: string[]) => choices[0]);
  const abort = vi.fn();
  const appendEntry = vi.fn();
  const sendMessage = vi.fn();
  const emit = vi.fn((eventName: unknown) => {
    if (options.eventBusError && eventName === "pi-safety:review") {
      throw new Error("review event observer unavailable");
    }
  });

  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
    registerCommand: (name: string, command: { handler: (...args: unknown[]) => unknown }) =>
      commands.set(name, command),
    registerShortcut: (key: string, shortcut: { handler: (...args: unknown[]) => unknown }) =>
      shortcuts.set(key, shortcut),
    registerTool: (tool: {
      name: string;
      label?: string;
      description?: string;
      parameters?: unknown;
      prepareArguments?: (args: unknown) => unknown;
      execute: (...args: unknown[]) => Promise<unknown>;
    }) => tools.set(tool.name, tool),
    appendEntry,
    sendMessage,
    events: { emit },
  };

  const ui = {
    setStatus,
    notify,
    select,
    confirm: vi.fn(async () => true),
    input: vi.fn(async () => undefined),
  };
  const networkBoundary = new NetworkBoundary({
    resolveHost: async (host) => options.sandboxNetworkAnswers?.[host] ?? ["93.184.216.34"],
  });
  const context = {
    cwd,
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? ((options.hasUI ?? true) ? "tui" : "print"),
    isProjectTrusted: () => false,
    isIdle: () => true,
    sessionManager,
    modelRegistry: options.modelRegistry ?? {},
    model: options.model,
    scopedModels: [],
    signal: undefined,
    abort,
    hasPendingMessages: () => false,
    ui,
  };

  registerExtension(pi as never, {
    agentDir,
    sandboxManager: options.sandboxManagerOverride ?? (sandboxManager as never),
    bashToolFactory: options.useRealBashTool ? undefined : (bashToolFactory as never),
    sandboxCoordinator:
      options.useRealPermissionRuntime || options.useRealCoordinator
        ? executionCoordinator
        : (sandboxCoordinator as never),
    autoReviewer,
    riskEvaluator: options.useRealPermissionRuntime ? undefined : (riskEvaluator as never),
    networkBoundary,
  });

  return {
    agentDir,
    cwd,
    handlers,
    commands,
    shortcuts,
    tools,
    context,
    sessionManager,
    riskEvaluator,
    reviewInputs,
    reviewContexts,
    autoReviewer,
    sandboxManager,
    bashToolFactory,
    sandboxCoordinator,
    executionCoordinator,
    emit,
    bareBashExecute,
    sandboxBashExecute,
    setStatus,
    notify,
    select,
    abort,
    appendEntry,
    sendMessage,
  };
}

async function invoke(app: Harness, event: string, payload: unknown = {}): Promise<unknown> {
  const handler = app.handlers.get(event);
  if (!handler) throw new Error(`missing ${event} handler`);
  return handler(payload, app.context);
}

async function startSession(app: Harness): Promise<void> {
  await invoke(app, "session_start", { type: "session_start", reason: "startup" });
}

async function startAgent(app: Harness): Promise<void> {
  await invoke(app, "agent_start", { type: "agent_start" });
}

async function startTurn(app: Harness, turnIndex = 0): Promise<void> {
  await invoke(app, "turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() });
}

async function endAgent(app: Harness): Promise<void> {
  await invoke(app, "agent_end", { type: "agent_end" });
}

async function executeBash(app: Harness, id: string, command: string, signal?: AbortSignal) {
  const bash = app.tools.get("bash");
  if (!bash) throw new Error("missing bash tool");
  return bash.execute(id, { command }, signal, undefined, app.context);
}

async function executeBashWithParams(
  app: Harness,
  id: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const bash = app.tools.get("bash");
  if (!bash) throw new Error("missing bash tool");
  return bash.execute(id, params, signal, undefined, app.context);
}

async function executeWrite(app: Harness, id: string, path: string, content: string) {
  const write = app.tools.get("write");
  if (!write) throw new Error("missing write tool");
  return write.execute(id, { path, content }, undefined, undefined, app.context);
}

async function executeEdit(app: Harness, id: string, path: string) {
  const edit = app.tools.get("edit");
  if (!edit) throw new Error("missing edit tool");
  return edit.execute(
    id,
    { path, edits: [{ oldText: "before", newText: "after" }] },
    undefined,
    undefined,
    app.context,
  );
}

async function executeRequestPermissions(app: Harness, id: string, host: string) {
  const requestPermissions = app.tools.get("request_permissions");
  if (!requestPermissions) throw new Error("missing request_permissions tool");
  return requestPermissions.execute(
    id,
    {
      reason: `Allow ${host}`,
      scope: "turn",
      permissions: { network: { hosts: [host] } },
    },
    undefined,
    undefined,
    app.context,
  );
}

async function executeHostCall(app: Harness, toolName: string, id: string): Promise<unknown> {
  return invoke(app, "tool_call", {
    type: "tool_call",
    toolName,
    toolCallId: id,
    input: { url: "https://example.com" },
  });
}

// Host-policy fixture only: fake SRT advertises macOS, never kernel support.
// Keep the exact original descriptor through all awaited work and cleanup.
function withDarwin<T extends unknown[]>(run: (...args: T) => Promise<void>) {
  return async (...args: T): Promise<void> => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...original, value: "darwin" });
    try {
      await run(...args);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  };
}

describe("Permission mode registration", () => {
  it("strips unknown bash arguments on the registered tool", async () => {
    const app = await makeHarness();
    const input = {
      command: "pwd",
      description: "where am I",
      timeout: 180000,
    };

    expect(app.tools.get("bash")?.prepareArguments?.(input)).toEqual({
      command: "pwd",
      timeout: 180000,
    });
    expect(input.description).toBe("where am I");
  });

  it("runs the hermetic system registration fixture from a simulated Linux host descriptor", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...original, value: "linux" });
    const simulated = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      await withDarwin(async () => {
        const app = await makeHarness({
          useRealBashTool: true,
          useRealPermissionRuntime: true,
          config: { sandbox: { network: { macosTls: "system" } } },
        });
        try {
          await startSession(app);
          await startAgent(app);
          await executeBash(app, "simulated-host-system", "printf ok");
          expect(
            app.sandboxManager.execute.mock.calls[0]?.[0].policy.network.execution,
          ).toMatchObject({ kind: "proxy", tls: "system" });
        } finally {
          await invoke(app, "session_shutdown");
        }
      })();
      expect(Object.getOwnPropertyDescriptor(process, "platform")).toEqual(simulated);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it("registers Auto status and initializes the sandbox on session_start", async () => {
    const app = await makeHarness();

    await startSession(app);

    expect(app.setStatus).toHaveBeenLastCalledWith("pi-safety", "Approve for me");
    expect(app.sandboxManager.reset).toHaveBeenCalledOnce();
    expect(app.sandboxManager.initialize).toHaveBeenCalledOnce();
    expect(app.sessionManager.getSessionId).not.toHaveBeenCalled();
    expect(app.sessionManager.getBranch).toHaveBeenCalledOnce();
    expect(app.tools.get("bash")?.label).toBe("bash");
    expect(app.tools.get("bash")?.description).not.toContain("(sandboxed)");
  });

  it("keeps the Guardian session reusable across ordinary turn boundaries", async () => {
    const app = await makeHarness();
    await startSession(app);
    const invalidateSession = app.autoReviewer.invalidateSession as ReturnType<typeof vi.fn>;
    const invalidationsAfterSessionStart = invalidateSession.mock.calls.length;

    await startAgent(app);
    await endAgent(app);
    await startAgent(app);
    await endAgent(app);

    expect(invalidateSession).toHaveBeenCalledTimes(invalidationsAfterSessionStart);
  });

  it("does not pass repository context files into Guardian authorization context", async () => {
    const app = await makeHarness({ risk: () => promptRisk() });
    await startSession(app);
    expect(app.handlers.has("before_agent_start")).toBe(false);
    await startAgent(app);

    await executeBash(app, "guardian-context", "printf context");

    expect(app.reviewInputs).toHaveLength(1);
    const reviewerContext = app.reviewContexts[0] as Record<string, unknown>;
    expect(reviewerContext).not.toHaveProperty("parentInstructions");
  });

  it("reports sandbox activation failure without mislabeling it as a config error", async () => {
    const app = await makeHarness({
      sandboxInitializeError: new Error("sandbox helper is unavailable"),
    });

    await startSession(app);

    expect(app.notify).toHaveBeenCalledWith(
      expect.stringContaining("Sandbox activation failed"),
      "error",
    );
    const message = String(app.notify.mock.calls.at(-1)?.[0]);
    expect(message).toContain("previous sandbox could not be restored");
    expect(message).not.toContain("configuration is invalid");
  });

  it("reports an invalid configuration distinctly from sandbox activation", async () => {
    const app = await makeHarness({ config: { unexpected: true } });

    await startSession(app);

    expect(app.notify).toHaveBeenCalledWith(
      expect.stringContaining("Permission configuration is invalid"),
      "error",
    );
    expect(String(app.notify.mock.calls.at(-1)?.[0])).not.toContain("Sandbox activation failed");
  });

  it("humanizes a sandbox deadline when a permission mode change fails", async () => {
    const app = await makeHarness({ sandboxResetErrorAfter: 2 });
    await startSession(app);
    const shortcut = app.shortcuts.get("shift+tab");
    if (!shortcut) throw new Error("missing permission shortcut");

    await shortcut.handler(app.context);

    expect(app.notify).toHaveBeenCalledWith(
      expect.stringContaining("Reason: Timed out after 5 seconds."),
      "error",
    );
    expect(String(app.notify.mock.calls.at(-1)?.[0])).not.toContain("timeout:5");
  });

  it("executes a LOW bash command through the sandbox without Guardian", async () => {
    const app = await makeHarness({ risk: () => lowRisk() });
    await startSession(app);
    await startAgent(app);

    await executeBash(app, "low-bash", "printf low");

    expect(app.sandboxManager.wrapWithSandbox).toHaveBeenCalledOnce();
    expect(app.sandboxBashExecute).toHaveBeenCalledOnce();
    expect(app.bareBashExecute).not.toHaveBeenCalled();
    expect(app.reviewInputs).toHaveLength(0);
  });

  it("executes an approved escalated Bash call once, then keeps later calls sandboxed", async () => {
    const justification = "Update the isolated fixture repository";
    const app = await makeHarness({
      risk: (tool, input) =>
        tool === "bash" && input.sandbox_permissions === "require_escalated"
          ? promptRisk({
              reason: "Command requires escalated sandbox permissions",
              executionMode: "escalated",
              justification,
            })
          : lowRisk(),
    });
    await startSession(app);
    await startAgent(app);

    await executeBashWithParams(app, "escalated-bash", {
      command: "git add README.md && git commit -m update",
      sandbox_permissions: "require_escalated",
      justification,
    });

    expect(app.reviewInputs).toHaveLength(1);
    expect(app.reviewInputs[0]?.untrustedAction).toMatchObject({
      kind: "shell",
      command: "git add README.md && git commit -m update",
      cwd: app.cwd,
    });
    expect(app.reviewInputs[0]?.permissionContext).toMatchObject({
      executionMode: "escalated",
      sandboxEnforcesAction: false,
      filesystemWriteRoots: [],
      filesystemDenyRead: [],
      filesystemDenyWrite: [],
      allowedNetworkHosts: [],
      deniedNetworkHosts: [],
      justification,
    });
    expect(app.bareBashExecute).toHaveBeenCalledOnce();
    expect(app.bareBashExecute.mock.calls[0]?.[1]).toMatchObject({
      command: "git add README.md && git commit -m update",
      sandbox_permissions: "require_escalated",
      justification,
      timeout: 120,
    });
    expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
    expect(app.bashToolFactory.mock.calls.at(-1)?.[1]).toBeUndefined();

    await executeBash(app, "ordinary-after-escalation", "printf ordinary");
    expect(app.bareBashExecute).toHaveBeenCalledOnce();
    expect(app.sandboxBashExecute).toHaveBeenCalledOnce();
    expect(app.sandboxManager.wrapWithSandbox).toHaveBeenCalledOnce();
  });

  it("does not bare-execute when risk still marks escalated but denyRead makes eligibility false", async () => {
    const justification = "Run a controlled command";
    const app = await makeHarness({
      config: {
        sandbox: {
          filesystem: { denyRead: ["/explicit-secret"] },
        },
      },
      // Defense in depth: production risk already suppresses escalated under
      // denyRead. If a stale/incorrect escalated admission still arrives,
      // eligibility must refuse the unsandboxed lease.
      risk: (tool, input) =>
        tool === "bash" && input.sandbox_permissions === "require_escalated"
          ? promptRisk({
              reason: "Command requires escalated sandbox permissions",
              executionMode: "escalated",
              justification,
            })
          : lowRisk(),
    });
    await startSession(app);
    await startAgent(app);

    await expect(
      executeBashWithParams(app, "escalated-deny-read", {
        command: "printf no",
        sandbox_permissions: "require_escalated",
        justification,
      }),
    ).rejects.toMatchObject({ code: "enforcement-unavailable" });
    expect(app.reviewInputs).toHaveLength(0);
    expect(app.bareBashExecute).not.toHaveBeenCalled();
    expect(app.sandboxBashExecute).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "denied",
      review: () => denied("The exact command is not authorized."),
      code: "review-denied",
    },
    {
      label: "timed out",
      review: () => {
        throw new AutoReviewerFailure("timeout", "review timed out");
      },
      code: "review-timeout",
    },
    {
      label: "failed",
      review: () => {
        throw new AutoReviewerFailure("provider", "review provider unavailable");
      },
      code: "review-unavailable",
    },
  ] as const)(
    "does not execute an escalated command when review is $label",
    async ({ review, code }) => {
      const app = await makeHarness({
        risk: (tool, input) =>
          tool === "bash" && input.sandbox_permissions === "require_escalated"
            ? promptRisk({
                reason: "Command requires escalated sandbox permissions",
                executionMode: "escalated",
                justification: "Run a controlled command",
              })
            : lowRisk(),
        review,
      });
      await startSession(app);
      await startAgent(app);

      await expect(
        executeBashWithParams(app, `escalated-${code}`, {
          command: "printf no",
          sandbox_permissions: "require_escalated",
          justification: "Run a controlled command",
        }),
      ).rejects.toMatchObject({ code });
      expect(app.bareBashExecute).not.toHaveBeenCalled();
      expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
    },
  );

  it("cancels an escalated review without executing the command", async () => {
    let releaseReview: (result: AutoReviewResult) => void = () => undefined;
    const reviewGate = new Promise<AutoReviewResult>((resolveReview) => {
      releaseReview = resolveReview;
    });
    const app = await makeHarness({
      risk: (tool, input) =>
        tool === "bash" && input.sandbox_permissions === "require_escalated"
          ? promptRisk({
              reason: "Command requires escalated sandbox permissions",
              executionMode: "escalated",
              justification: "Run a controlled command",
            })
          : lowRisk(),
      review: async () => reviewGate,
    });
    await startSession(app);
    await startAgent(app);
    const controller = new AbortController();
    const pending = executeBashWithParams(
      app,
      "escalated-cancelled",
      {
        command: "printf no",
        sandbox_permissions: "require_escalated",
        justification: "Run a controlled command",
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(app.reviewInputs).toHaveLength(1));
    controller.abort();
    releaseReview(approved());

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(app.bareBashExecute).not.toHaveBeenCalled();
    expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
  });

  it("rechecks live sandbox health before an approved escalated execution", async () => {
    const app = await makeHarness({
      risk: (tool, input) =>
        tool === "bash" && input.sandbox_permissions === "require_escalated"
          ? promptRisk({
              reason: "Command requires escalated sandbox permissions",
              executionMode: "escalated",
              justification: "Run a controlled command",
            })
          : lowRisk(),
    });
    await startSession(app);
    await startAgent(app);
    app.sandboxManager.isHealthy.mockReturnValue(false);

    await expect(
      executeBashWithParams(app, "escalated-poisoned", {
        command: "printf no",
        sandbox_permissions: "require_escalated",
        justification: "Run a controlled command",
      }),
    ).rejects.toMatchObject({ code: "execution-failed" });
    expect(app.bareBashExecute).not.toHaveBeenCalled();
    expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
  });

  it("humanizes a sandbox execution deadline before returning it to the agent", async () => {
    const app = await makeHarness({
      risk: () => lowRisk(),
      sandboxExecuteError: new Error("timeout:120"),
    });
    await startSession(app);
    await startAgent(app);

    const failure = await executeBash(app, "timed-out-bash", "printf timeout").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: "execution-failed",
      message: expect.stringContaining("Timed out after 120 seconds"),
    });
    expect(String((failure as Error).message)).not.toContain("timeout:120");
  });

  it("reviews a bash network capability and leases the requested public host", async () => {
    const host = "api.example.com";
    const app = await makeHarness({
      risk: (tool) => (tool === "bash" ? promptRisk({ networkHosts: [host] }) : undefined),
    });
    await startSession(app);
    await startAgent(app);
    app.setStatus.mockClear();
    app.notify.mockClear();

    await executeBash(app, "prompt-bash", "printf approved");

    expect(app.reviewInputs).toHaveLength(1);
    expect(app.reviewInputs[0]?.permissionContext.requestedNetworkTargets).toEqual([{ host }]);
    expect(app.sandboxManager.wrapWithSandbox).toHaveBeenCalledOnce();
    const policy = app.sandboxManager.wrapWithSandbox.mock.calls[0]?.[2] as {
      network: { allowedDomains: string[] };
    };
    expect(policy.network.allowedDomains).toContain(host);
    expect(reviewStatusCalls(app)).toHaveLength(0);
    expect(app.notify).not.toHaveBeenCalled();
  });

  it("fail-closes uncovered Bash network at the boundary without inline Guardian", async () => {
    const host = "api.example.com";
    const app = await makeHarness({
      risk: () => lowRisk(),
      sandboxNetworkAttempt: { host, port: 443 },
    });
    await startSession(app);
    await startAgent(app);
    app.setStatus.mockClear();

    await expect(
      executeBash(app, "runtime-network", "curl https://api.example.com/data"),
    ).rejects.toMatchObject({ code: "permission-required" });

    expect(app.riskEvaluator).toHaveBeenCalledOnce();
    expect(app.reviewInputs).toHaveLength(0);
    expect(app.sandboxManager.execute).toHaveBeenCalledOnce();
  });

  it("defers a default private Bash target to the runtime boundary", async () => {
    const app = await makeHarness({
      risk: () => lowRisk(),
      sandboxNetworkAttempt: { host: "127.0.0.1", port: 80 },
    });
    await startSession(app);
    await startAgent(app);

    await expect(
      executeBash(app, "private-network", "curl http://127.0.0.1/admin"),
    ).rejects.toMatchObject({
      code: "policy-denied",
      message: expect.stringContaining("Private or special-use network target is blocked"),
    });

    // Static risk evaluation admitted the command; the single sandbox
    // execution reached the connection boundary and was denied there.
    expect(app.riskEvaluator).toHaveBeenCalledOnce();
    expect(app.sandboxManager.execute).toHaveBeenCalledOnce();
    expect(app.reviewInputs).toHaveLength(0);
    const request = app.sandboxManager.execute.mock.calls[0]?.[0] as SandboxExecutionRequest;
    expect(request.signal?.aborted).toBe(true);
  });

  it("aborts the whole Bash attempt for an explicit sandbox network deny", async () => {
    const host = "api.example.com";
    const app = await makeHarness({
      config: { sandbox: { network: { deniedDomains: [host] } } },
      risk: () => lowRisk(),
      sandboxNetworkAttempt: { host, port: 443 },
    });
    await startSession(app);
    await startAgent(app);

    await expect(
      executeBash(app, "denied-network", `curl https://${host}/data`),
    ).rejects.toMatchObject({
      code: "policy-denied",
      message: expect.stringContaining("Network target is denied by sandbox policy"),
    });

    expect(app.reviewInputs).toHaveLength(0);
    expect(app.sandboxManager.execute).toHaveBeenCalledOnce();
    const request = app.sandboxManager.execute.mock.calls[0]?.[0] as SandboxExecutionRequest;
    expect(request.signal?.aborted).toBe(true);
  });

  it("allows an exact local literal without invoking the reviewer", async () => {
    const app = await makeHarness({
      config: { sandbox: { network: { allowedDomains: ["127.0.0.1"] } } },
      risk: () => lowRisk(),
      sandboxNetworkAttempt: { host: "127.0.0.1", port: 80 },
    });
    await startSession(app);
    await startAgent(app);

    await expect(executeBash(app, "exact-local", "curl http://127.0.0.1/admin")).resolves.toEqual({
      content: [],
      details: undefined,
    });
    expect(app.reviewInputs).toHaveLength(0);
    expect(app.sandboxManager.execute).toHaveBeenCalledOnce();
  });

  it("fail-closes uncovered private DNS at runtime even when local binding is enabled", async () => {
    const host = "router.internal";
    const app = await makeHarness({
      config: { sandbox: { network: { allowLocalBinding: true } } },
      risk: () => lowRisk(),
      sandboxNetworkAttempt: { host, port: 80 },
      sandboxNetworkAnswers: { [host]: ["192.168.1.20"] },
    });
    await startSession(app);
    await startAgent(app);

    await expect(
      executeBash(app, "local-binding", `curl http://${host}/admin`),
    ).rejects.toMatchObject({ code: "permission-required" });
    expect(app.reviewInputs).toHaveLength(0);
    expect(app.sandboxManager.execute).toHaveBeenCalledOnce();
  });

  it("blocks an outside Bash write after the sandbox reports the exact path", async () => {
    const path = "/opt/pi-safety-runtime-denial/result.txt";
    const app = await makeHarness({
      risk: () => lowRisk(),
      sandboxDenial: { kind: "filesystem", operation: "write", path },
    });
    await startSession(app);
    await startAgent(app);
    app.setStatus.mockClear();

    await expect(executeBash(app, "runtime-write", `truncate -s 0 ${path}`)).rejects.toMatchObject({
      code: "runtime-denied",
    });

    expect(app.reviewInputs).toHaveLength(0);
    expect(app.sandboxManager.execute).toHaveBeenCalledOnce();
    expect(reviewStatusCalls(app)).toHaveLength(0);
  });

  it("reviews a registered native mkdir preparation failure and re-enters Write once with real risk and coordinator", async () => {
    const parent = await mkdtemp(join(tmpdir(), "native retry parent "));
    tempDirectories.push(parent);
    const path = join(parent, " file .txt ");
    const operations: string[] = [];
    const policies: SandboxPolicy[] = [];
    const app = await makeHarness({
      config: { sandbox: { filesystem: { allowWrite: ["."] } } },
      useRealPermissionRuntime: true,
      sandboxExecute: async (request, ordinal) => {
        operations.push(request.program.args[2]);
        policies.push(request.policy);
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(ordinal === 1 ? "EACCES: preparation failed, no denied path" : ""),
          exitCode: ordinal === 1 ? 1 : 0,
        };
      },
    });
    await startSession(app);
    await startAgent(app);
    await expect(
      executeWrite(app, "runtime-native-write", path, "retry once"),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: `Successfully wrote to ${path}` }],
    });
    expect(operations).toEqual(["mkdir", "mkdir", "write"]);
    expect(app.reviewInputs).toHaveLength(2);
    expect(app.reviewInputs[0]?.permissionContext.filesystemWriteRoots).not.toContain(parent);
    expect(app.reviewInputs[1]?.permissionContext.filesystemWriteRoots).toContain(parent);
    expect(JSON.stringify(app.reviewInputs[1])).toMatch(/subtree/);
    expect(JSON.stringify(app.reviewInputs[1])).toMatch(/partial directory effects/);
    expect(JSON.stringify(app.reviewInputs[1])).toContain("retry once");
    expect(policies[1]).toEqual({
      ...policies[0],
      filesystem: {
        ...policies[0].filesystem,
        allowWrite: [...policies[0].filesystem.allowWrite, parent],
      },
    });
    await executeWrite(app, "next-write", join(app.cwd, "next.txt"), "next");
    expect(policies[3].filesystem.allowWrite).not.toContain(parent);
  });

  it.each(["write", "edit"])(
    "preserves registered %s helper evidence after cancellation without diagnostics or replay",
    async (tool) => {
      const controller = new AbortController();
      const helperError = "EACCES: permission denied, native preparation";
      const app = await makeHarness({
        risk: () => lowRisk(),
        sandboxExecute: async () => {
          controller.abort();
          return { stdout: Buffer.alloc(0), stderr: Buffer.from(helperError), exitCode: 1 };
        },
      });
      await startSession(app);
      await startAgent(app);
      const nativeTool = app.tools.get(tool);
      if (!nativeTool) throw new Error("missing native tool");
      const params =
        tool === "write"
          ? { path: "/outside/file", content: "original" }
          : { path: "/outside/file", edits: [{ oldText: "before", newText: "after" }] };
      await expect(
        nativeTool.execute(
          "cancelled-preparation",
          params,
          controller.signal,
          undefined,
          app.context,
        ),
      ).rejects.toMatchObject({
        code: "aborted",
        effectsMayHaveOccurred: true,
        reason: expect.stringMatching(
          /EACCES: permission denied, native preparation[\s\S]*Effects warning/,
        ),
      });
      expect(app.sandboxManager.execute).toHaveBeenCalledOnce();
      expect(app.sandboxManager.readFailureDiagnostics).not.toHaveBeenCalled();
      expect(app.reviewInputs).toHaveLength(0);
    },
  );

  it.each(["access", "read"])(
    "recovers registered Edit %s preparation using original action, not log scope",
    async (stage) => {
      const operations: string[] = [];
      let failed = false;
      const app = await makeHarness({
        config: { sandbox: { filesystem: { allowWrite: ["."] } } },
        useRealCoordinator: true,
        risk: () => lowRisk(),
        sandboxDiagnostics:
          "SRT diagnostic observations (potentially sanitized or unrelated; not authorization evidence): /unrelated wrong path",
        sandboxExecute: async (request) => {
          const operation = request.program.args[2];
          operations.push(operation);
          if (operation === stage && !failed) {
            failed = true;
            return {
              stdout: Buffer.alloc(0),
              stderr: Buffer.from("EACCES: helper preparation"),
              exitCode: 1,
            };
          }
          if (operation === "write") expect(request.stdin).toBe("after current");
          return {
            stdout: Buffer.from(operation === "read" ? "before current" : ""),
            stderr: Buffer.alloc(0),
            exitCode: 0,
          };
        },
      });
      await startSession(app);
      await startAgent(app);
      await expect(executeEdit(app, "edit-preparation", "/outside/ file ")).resolves.toMatchObject({
        content: [{ type: "text" }],
      });
      expect(operations).toEqual(
        stage === "access"
          ? ["access", "access", "read", "write"]
          : ["access", "read", "access", "read", "write"],
      );
      expect(app.reviewInputs).toHaveLength(1);
      expect(app.reviewInputs[0].permissionContext.filesystemWriteRoots).toContain(
        "/outside/ file ",
      );
      expect(app.reviewInputs[0].permissionContext.filesystemWriteRoots).not.toContain(
        "/unrelated",
      );
      const evidence = JSON.stringify(app.reviewInputs[0]);
      expect(evidence).toContain("original complete edit");
      expect(evidence).toContain("EACCES: helper preparation");
      if (stage === "access") expect(evidence).toContain("Could not edit file");
    },
  );

  it.each(["access", "read"])(
    "does not retry registered Edit %s when real risk already granted its exact file",
    async (stage) => {
      const operations: string[] = [];
      const app = await makeHarness({
        useRealPermissionRuntime: true,
        config: { sandbox: { filesystem: { allowWrite: ["."] } } },
        sandboxExecute: async (request) => {
          const operation = request.program.args[2];
          operations.push(operation);
          return {
            stdout: Buffer.alloc(0),
            stderr: Buffer.from(
              operation === stage ? "EACCES: original already-covered file failure" : "",
            ),
            exitCode: operation === stage ? 1 : 0,
          };
        },
      });
      await startSession(app);
      await startAgent(app);
      await expect(executeEdit(app, "real-edit-covered", "/outside/file")).rejects.toMatchObject({
        code: "enforcement-unavailable",
        reason: expect.stringMatching(
          /already covered[\s\S]*original already-covered file failure/,
        ),
      });
      expect(app.reviewInputs).toHaveLength(1);
      expect(app.reviewInputs[0].permissionContext.filesystemWriteRoots).toContain("/outside/file");
      expect(operations).toEqual(stage === "access" ? ["access"] : ["access", "read"]);
      expect(app.sandboxManager.execute).toHaveBeenCalledTimes(operations.length);
    },
  );

  it("does not reuse Edit preparation evidence after successful operations or retry native matching failures", async () => {
    let ordinal = 0;
    const app = await makeHarness({
      risk: () => lowRisk(),
      sandboxExecute: async (request) => {
        ordinal++;
        return {
          stdout: Buffer.from(
            request.program.args[2] === "read" ? "changed without matching text" : "",
          ),
          stderr: Buffer.from(ordinal === 1 ? "EACCES: access first" : ""),
          exitCode: ordinal === 1 ? 1 : 0,
        };
      },
    });
    await startSession(app);
    await startAgent(app);
    await expect(executeEdit(app, "changed-match", "/outside/file")).rejects.toThrow(
      /Could not find[\s\S]*EACCES: access first/,
    );
    expect(app.reviewInputs).toHaveLength(1);
    expect(app.sandboxManager.execute).toHaveBeenCalledTimes(3);
    await expect(executeEdit(app, "next-match", "/outside/file")).rejects.toThrow(/Could not find/);
    expect(app.reviewInputs).toHaveLength(1);
    expect(app.sandboxManager.execute).toHaveBeenCalledTimes(5);
  });

  it.each(["write", "edit"])(
    "never replays registered %s after content-write entry despite misleading logs",
    async (tool) => {
      const operations: string[] = [];
      const app = await makeHarness({
        useRealPermissionRuntime: true,
        sandboxDiagnostics:
          "SRT diagnostic observations (potentially sanitized or unrelated; not authorization evidence): deny file-write /unrelated",
        sandboxExecute: async (request) => {
          const operation = request.program.args[2];
          operations.push(operation);
          return {
            stdout: Buffer.from(operation === "read" ? "before" : ""),
            stderr: Buffer.from(operation === "write" ? "EPERM content may be truncated" : ""),
            exitCode: operation === "write" ? 1 : 0,
          };
        },
      });
      await startSession(app);
      await startAgent(app);
      await expect(
        tool === "write"
          ? executeWrite(app, "truncation", "/outside/file", "content")
          : executeEdit(app, "truncation", "/outside/file"),
      ).rejects.toThrow(
        /EPERM content may be truncated[\s\S]*SRT diagnostic[\s\S]*Effects warning/,
      );
      expect(app.reviewInputs).toHaveLength(1); // Initial action-risk review only; no recovery after content entry.
      expect(operations).toEqual(
        tool === "write" ? ["mkdir", "write"] : ["access", "read", "write"],
      );
    },
  );

  it("keeps misleading Bash diagnostics terminal and retains the original failure", async () => {
    const app = await makeHarness({
      useRealBashTool: true,
      risk: () => lowRisk(),
      sandboxDiagnostics:
        "SRT diagnostic observations (potentially sanitized or unrelated; not authorization evidence): deny file-write /wrong path",
      sandboxExecute: async (request) => {
        const stderr = Buffer.from("EPERM original Bash failure");
        request.onStderr?.(stderr);
        return { stdout: Buffer.alloc(0), stderr, exitCode: 1 };
      },
    });
    await startSession(app);
    await startAgent(app);
    const result = await executeBash(app, "log-only-bash", "printf original");
    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringMatching(/EPERM original Bash failure[\s\S]*SRT diagnostic/),
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("The permitted action failed");
    expect(app.reviewInputs).toHaveLength(0);
    expect(app.sandboxManager.execute).toHaveBeenCalledOnce();
    expect(app.sandboxManager.classifyDenial).toHaveBeenCalledOnce();
  });

  it("rejects a retry parent outside the live file-only delegation ceiling", async () => {
    const app = await makeHarness({
      config: { delegation: { writeRoots: ["sub/file"] } },
      risk: () => lowRisk(),
      sandboxExecute: async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("EACCES: mkdir partial"),
        exitCode: 1,
      }),
    });
    await startSession(app);
    await startAgent(app);
    await startAgent(app);
    await expect(executeWrite(app, "parent-ceiling", "sub/file", "content")).rejects.toThrow(
      /delegation envelope[\s\S]*EACCES: mkdir partial/,
    );
    expect(app.reviewInputs).toHaveLength(0);
    expect(app.sandboxManager.execute).toHaveBeenCalledOnce();
  });

  it.each([
    "/file",
    `${process.env.HOME}/file`,
    `${process.env.HOME}/Library/file`,
    "/outside/[literal]/file",
    "@/outside/file",
  ])("does not recover broad or unsupported native path identity %s", async (path) => {
    const app = await makeHarness({
      risk: () => lowRisk(),
      sandboxExecute: async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("EACCES: mkdir preparation"),
        exitCode: 1,
      }),
    });
    await startSession(app);
    await startAgent(app);
    await expect(executeWrite(app, "unsafe-identity", path, "content")).rejects.toThrow();
    expect(app.reviewInputs).toHaveLength(0);
    expect(app.sandboxManager.execute).toHaveBeenCalledOnce();
  });

  it("captures bash input before async risk review and executes only the canonical value", async () => {
    const host = "api.example.com";
    let releaseReview: (result: AutoReviewResult) => void = () => undefined;
    const reviewGate = new Promise<AutoReviewResult>((resolve) => {
      releaseReview = resolve;
    });
    const app = await makeHarness({
      risk: (tool, input) => {
        if (tool !== "bash") return undefined;
        input.command = "mutated by risk evaluator";
        return promptRisk({ networkHosts: [host] });
      },
      review: async () => reviewGate,
    });
    await startSession(app);
    await startAgent(app);

    const bash = app.tools.get("bash");
    if (!bash) throw new Error("missing bash tool");
    const params = { command: "printf safe" };
    const execution = bash.execute("canonical-bash", params, undefined, undefined, app.context);
    await vi.waitFor(() => expect(app.reviewInputs).toHaveLength(1));
    params.command = "rm -rf /";
    releaseReview(approved("The captured command is safe."));

    await expect(execution).resolves.toMatchObject({ content: [] });
    expect(app.reviewInputs[0]?.untrustedAction).toMatchObject({
      kind: "shell",
      command: "printf safe",
    });
    expect(app.sandboxBashExecute).toHaveBeenCalledWith(
      "canonical-bash",
      { command: "printf safe" },
      expect.any(AbortSignal),
      undefined,
    );
  });

  it("denies a prompted bash command before invoking any backend", async () => {
    const app = await makeHarness({
      risk: (tool) => (tool === "bash" ? promptRisk() : undefined),
      review: () => denied("No shell access."),
    });
    await startSession(app);
    await startAgent(app);
    app.setStatus.mockClear();
    app.notify.mockClear();

    await expect(executeBash(app, "denied-bash", "printf denied")).rejects.toMatchObject({
      code: "review-denied",
      message: expect.stringContaining(
        "must not attempt to achieve the same outcome through a workaround",
      ),
    });
    expect(app.reviewInputs).toHaveLength(1);
    expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
    expect(app.sandboxBashExecute).not.toHaveBeenCalled();
    expect(app.bareBashExecute).not.toHaveBeenCalled();
    expect(reviewStatusCalls(app)).toHaveLength(0);
    expect(app.notify).toHaveBeenCalledWith("Permission denied", "warning");
  });

  it.each([
    {
      kind: "timeout",
      failure: "review timed out",
      code: "review-timeout",
      label: "Review timed out",
    },
    {
      kind: "provider",
      failure: "review provider unavailable",
      code: "review-unavailable",
      label: "Review failed",
    },
  ] as const)("notifies on a $code review outcome", async ({ kind, failure, code, label }) => {
    const app = await makeHarness({
      risk: (tool) => (tool === "bash" ? promptRisk() : undefined),
      review: () => {
        throw new AutoReviewerFailure(kind, failure);
      },
    });
    await startSession(app);
    await startAgent(app);
    app.setStatus.mockClear();
    app.notify.mockClear();

    await expect(executeBash(app, `${code}-bash`, "printf failed")).rejects.toMatchObject({ code });

    expect(reviewStatusCalls(app)).toHaveLength(0);
    expect(app.notify).toHaveBeenCalledTimes(1);
    expect(app.notify).toHaveBeenCalledWith(label, "warning");
  });

  it("keeps an aborted review silent", async () => {
    let releaseReview: (result: AutoReviewResult) => void = () => undefined;
    const reviewGate = new Promise<AutoReviewResult>((resolveReview) => {
      releaseReview = resolveReview;
    });
    const app = await makeHarness({
      risk: (tool) => (tool === "bash" ? promptRisk() : undefined),
      review: async () => reviewGate,
    });
    await startSession(app);
    await startAgent(app);
    app.setStatus.mockClear();
    app.notify.mockClear();

    const controller = new AbortController();
    const pending = executeBash(app, "aborted-review", "printf aborted", controller.signal);
    await vi.waitFor(() => expect(app.reviewInputs).toHaveLength(1));
    expect(reviewStatusCalls(app)).toHaveLength(0);

    controller.abort();
    releaseReview(approved());

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(reviewStatusCalls(app)).toHaveLength(0);
    expect(app.notify).not.toHaveBeenCalled();
  });

  it("does not apply review UI presentation outside TUI mode", async () => {
    const app = await makeHarness({
      hasUI: true,
      mode: "rpc",
      risk: (tool) => (tool === "bash" ? promptRisk() : undefined),
    });
    await startSession(app);
    await startAgent(app);
    app.setStatus.mockClear();
    app.notify.mockClear();

    await executeBash(app, "rpc-approval", "printf approved");

    expect(reviewStatusCalls(app)).toHaveLength(0);
    expect(app.notify).not.toHaveBeenCalled();
  });

  it("keeps the local review presenter independent from event-bus observers", async () => {
    const app = await makeHarness({
      eventBusError: true,
      risk: (tool) => (tool === "bash" ? promptRisk() : undefined),
    });
    await startSession(app);
    await startAgent(app);
    app.setStatus.mockClear();
    app.notify.mockClear();

    await executeBash(app, "event-bus-error", "printf approved");

    expect(reviewStatusCalls(app)).toHaveLength(0);
    expect(app.notify).not.toHaveBeenCalled();
  });

  it("presents managed-tool policy evaluation failures without internal error codes", async () => {
    const app = await makeHarness({
      risk: () => {
        throw new Error("risk evaluator unavailable");
      },
    });
    await startSession(app);
    await startAgent(app);

    await expect(executeBash(app, "policy-error", "printf blocked")).rejects.toMatchObject({
      code: "policy-error",
      message: expect.stringContaining("The active permission policy could not evaluate"),
    });
    expect(app.sandboxBashExecute).not.toHaveBeenCalled();
  });

  it("approves an outside write with only the exact target in the lease", async () => {
    const app = await makeHarness({
      risk: (tool) => (tool === "write" ? promptRisk() : undefined),
    });
    await startSession(app);
    await startAgent(app);
    const outsideDirectory = "/opt/pi-safety-register-outside";
    const target = resolve(outsideDirectory, "result.txt");

    await executeWrite(app, "outside-write", target, "approved");

    expect(app.reviewInputs).toHaveLength(1);
    expect(app.reviewInputs[0]?.permissionContext.filesystemWriteRoots).toContain(target);
    expect(app.sandboxManager.wrapWithSandbox).toHaveBeenCalled();
    for (const call of app.sandboxManager.wrapWithSandbox.mock.calls) {
      const policy = call[2] as { filesystem: { allowWrite: string[] } };
      expect(policy.filesystem.allowWrite).toContain(target);
      expect(policy.filesystem.allowWrite).not.toContain(outsideDirectory);
    }
  });

  it("uses the bare bash backend in YOLO and fails closed when Auto has no sandbox", async () => {
    const yolo = await makeHarness({ risk: () => blockRisk() });
    await startSession(yolo);
    const shortcut = yolo.shortcuts.get("shift+tab");
    if (!shortcut) throw new Error("missing shift+tab shortcut");
    await shortcut.handler(yolo.context);

    expect(yolo.sandboxManager.reset).toHaveBeenCalledTimes(2);
    await executeBash(yolo, "yolo-bash", "printf yolo");

    expect(yolo.bareBashExecute).toHaveBeenCalledOnce();
    expect(yolo.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
    expect(yolo.reviewInputs).toHaveLength(0);
    expect(yolo.riskEvaluator).not.toHaveBeenCalled();

    const disabled = await makeHarness({
      config: { sandbox: { enabled: false } },
      risk: () => lowRisk(),
    });
    await startSession(disabled);
    await startAgent(disabled);

    await expect(executeBash(disabled, "disabled-bash", "printf blocked")).rejects.toMatchObject({
      code: "enforcement-unavailable",
    });
    expect(disabled.bareBashExecute).not.toHaveBeenCalled();
    expect(disabled.sandboxBashExecute).not.toHaveBeenCalled();
    expect(disabled.reviewInputs).toHaveLength(0);
  });

  it("does not inspect Git metadata while activating YOLO", async () => {
    const app = await makeHarness();
    await startSession(app);
    await writeFile(join(app.cwd, ".git"), "not a valid Git pointer\n");

    const shortcut = app.shortcuts.get("shift+tab");
    if (!shortcut) throw new Error("missing permission shortcut");
    await expect(shortcut.handler(app.context)).resolves.toBeUndefined();

    await executeBash(app, "yolo-with-invalid-git", "printf yolo");
    expect(app.bareBashExecute).toHaveBeenCalledOnce();
    expect(app.sandboxManager.initialize).toHaveBeenCalledOnce();
  });

  it("rechecks queued preparation across a real-coordinator mode transition while preserving the active YOLO snapshot", async () => {
    const app = await makeHarness({
      useRealBashTool: true,
      useRealPermissionRuntime: true,
      config: { sandbox: { network: { access: { kind: "explicit", transport: "proxy" } } } },
    });
    await startSession(app);
    const shortcut = app.shortcuts.get("shift+tab")!;
    await shortcut.handler(app.context);
    await startAgent(app);
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = app.executionCoordinator.runExclusive(async () => {
      entered();
      await gate;
    });
    await entry;
    const activations = app.sandboxManager.initialize.mock.calls.length;
    const downshift = shortcut.handler(app.context);
    const amendment = executeRequestPermissions(app, "queued-yolo-request", "api.example.com");
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(app.sandboxManager.initialize).toHaveBeenCalledTimes(activations);
      expect(app.reviewInputs).toHaveLength(0);
    } finally {
      release();
    }
    await writer;
    await downshift;
    expect(await amendment).toMatchObject({
      content: [{ text: expect.stringContaining("Bypass permissions is already active") }],
    });
    expect(app.abort).not.toHaveBeenCalled();
    await endAgent(app);
    await startAgent(app);
    await executeBash(app, "new-auto-after-queue", "printf auto");
    expect(app.sandboxManager.execute.mock.calls[0]?.[0].policy.network.execution).toEqual({
      kind: "restricted",
    });
    expect(app.reviewInputs).toHaveLength(0);
  });

  it("keeps the active YOLO snapshot when cycling down to Auto", async () => {
    const app = await makeHarness({ risk: () => lowRisk() });
    await startSession(app);
    const invalidateSession = app.autoReviewer.invalidateSession as ReturnType<typeof vi.fn>;
    const shortcut = app.shortcuts.get("shift+tab");
    if (!shortcut) throw new Error("missing shift+tab shortcut");
    await shortcut.handler(app.context);
    await startAgent(app);

    await executeBash(app, "active-yolo", "printf yolo");
    expect(app.bareBashExecute).toHaveBeenCalledOnce();

    const invalidationsBeforeActiveModeChange = invalidateSession.mock.calls.length;
    await shortcut.handler(app.context);
    expect(app.abort).not.toHaveBeenCalled();
    expect(invalidateSession).toHaveBeenCalledTimes(invalidationsBeforeActiveModeChange);

    await endAgent(app);
    expect(invalidateSession).toHaveBeenCalledTimes(invalidationsBeforeActiveModeChange + 1);
    await startAgent(app);
    await executeBash(app, "next-auto", "printf auto");
    expect(app.sandboxBashExecute).toHaveBeenCalledOnce();
    expect(app.sandboxManager.wrapWithSandbox).toHaveBeenCalledOnce();
  });

  it("applies a mid-turn Auto→YOLO cycle at the next turn_start, not at the cycle instant", async () => {
    const app = await makeHarness({ risk: () => lowRisk() });
    await startSession(app);
    const shortcut = app.shortcuts.get("shift+tab");
    if (!shortcut) throw new Error("missing shift+tab shortcut");
    await startAgent(app);

    await executeBash(app, "before-cycle-auto", "printf auto");
    expect(app.sandboxBashExecute).toHaveBeenCalledOnce();

    const resetsBeforeCycle = app.sandboxManager.reset.mock.calls.length;
    await shortcut.handler(app.context);
    expect(app.sandboxManager.reset).toHaveBeenCalledTimes(resetsBeforeCycle);

    await executeBash(app, "same-step-still-auto", "printf auto");
    expect(app.sandboxBashExecute).toHaveBeenCalledTimes(2);
    expect(app.bareBashExecute).not.toHaveBeenCalled();

    await startTurn(app, 1);
    await executeBash(app, "next-step-yolo", "printf yolo");
    expect(app.bareBashExecute).toHaveBeenCalledOnce();
    expect(app.sandboxManager.reset.mock.calls.length).toBeGreaterThan(resetsBeforeCycle);
  });

  it("applies a mid-turn YOLO→Auto cycle at turn_start and uses the sandbox again", async () => {
    const app = await makeHarness({ risk: () => lowRisk() });
    await startSession(app);
    const invalidateSession = app.autoReviewer.invalidateSession as ReturnType<typeof vi.fn>;
    const shortcut = app.shortcuts.get("shift+tab");
    if (!shortcut) throw new Error("missing shift+tab shortcut");
    await shortcut.handler(app.context);
    await startAgent(app);

    await executeBash(app, "before-downshift", "printf yolo");
    expect(app.bareBashExecute).toHaveBeenCalledOnce();

    await shortcut.handler(app.context);
    await executeBash(app, "same-step-still-yolo", "printf yolo");
    expect(app.bareBashExecute).toHaveBeenCalledTimes(2);
    expect(app.sandboxBashExecute).not.toHaveBeenCalled();

    const invalidationsBeforeApply = invalidateSession.mock.calls.length;
    await startTurn(app, 1);
    await executeBash(app, "next-step-auto", "printf auto");
    expect(app.sandboxBashExecute).toHaveBeenCalledOnce();
    // Step-boundary apply must not force-invalidate the live Engine turn
    // (commitActivation force=true would wipe grants/circuit). Only the
    // deferred Guardian trunk retirement is expected.
    expect(invalidateSession.mock.calls.length).toBe(invalidationsBeforeApply + 1);
  });

  it("keeps the latest desired mode when Shift+Tab is pressed twice before turn_start", async () => {
    const app = await makeHarness({ risk: () => lowRisk() });
    await startSession(app);
    const shortcut = app.shortcuts.get("shift+tab");
    if (!shortcut) throw new Error("missing shift+tab shortcut");
    await startAgent(app);
    await executeBash(app, "start-auto", "printf auto");

    await shortcut.handler(app.context); // auto -> yolo
    await shortcut.handler(app.context); // yolo -> auto
    await startTurn(app, 1);
    await executeBash(app, "still-auto-after-double-cycle", "printf auto");
    expect(app.sandboxBashExecute).toHaveBeenCalledTimes(2);
    expect(app.bareBashExecute).not.toHaveBeenCalled();
  });

  it("leaves the applied mode unchanged when the step-boundary auto activation fails", async () => {
    const app = await makeHarness({
      risk: () => lowRisk(),
      sandboxResetErrorAfter: 3,
    });
    await startSession(app);
    const shortcut = app.shortcuts.get("shift+tab");
    if (!shortcut) throw new Error("missing shift+tab shortcut");
    await shortcut.handler(app.context);
    await startAgent(app);

    await executeBash(app, "yolo-before-failed-downshift", "printf yolo");
    expect(app.bareBashExecute).toHaveBeenCalledOnce();

    await shortcut.handler(app.context);
    await startTurn(app, 1);
    expect(app.notify).toHaveBeenCalledWith(expect.stringContaining("failed"), "error");
    // Still yolo: a failed auto activation must not open unrestricted tools
    // as auto, nor leave auto authorization without SRT.
    await executeBash(app, "still-yolo-after-failed-activate", "printf yolo");
    expect(app.bareBashExecute).toHaveBeenCalledTimes(2);
    expect(app.sandboxBashExecute).not.toHaveBeenCalled();
  });

  it("keeps nested child snapshots aligned when the step boundary applies a mode change", async () => {
    const app = await makeHarness({ risk: () => lowRisk() });
    await startSession(app);
    const shortcut = app.shortcuts.get("shift+tab");
    if (!shortcut) throw new Error("missing shift+tab shortcut");
    await startAgent(app);
    await executeBash(app, "outer-auto", "printf auto");
    expect(app.sandboxBashExecute).toHaveBeenCalledOnce();

    await startAgent(app); // nested child
    await executeBash(app, "child-auto", "printf auto");
    expect(app.sandboxBashExecute).toHaveBeenCalledTimes(2);

    await shortcut.handler(app.context);
    await startTurn(app, 1);
    await executeBash(app, "child-yolo", "printf yolo");
    expect(app.bareBashExecute).toHaveBeenCalledOnce();
  });

  it("lets the registration tool_call hook skip managed tools", async () => {
    const app = await makeHarness({
      risk: () => promptRisk(),
      review: () => denied(),
    });
    await startSession(app);

    const calls = [
      ["bash", { command: "printf skip" }],
      ["write", { path: "skip.txt", content: "skip" }],
      ["edit", { path: "skip.txt", edits: [] }],
      ["request_permissions", { permissions: { network: { hosts: ["example.com"] } } }],
    ] as const;
    for (const [toolName, input] of calls) {
      await expect(
        invoke(app, "tool_call", {
          type: "tool_call",
          toolName,
          toolCallId: `skip-${toolName}`,
          input,
        }),
      ).resolves.toBeUndefined();
    }

    expect(app.riskEvaluator).not.toHaveBeenCalled();
    expect(app.reviewInputs).toHaveLength(0);
    expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
  });

  it("passes foreign host tools through without risk or Guardian", async () => {
    const app = await makeHarness({ risk: () => promptRisk() });
    await startSession(app);
    await startAgent(app);

    for (const toolName of ["WebFetch", "mcp__github__get_issue", "HardTool"]) {
      await expect(executeHostCall(app, toolName, `foreign-${toolName}`)).resolves.toBeUndefined();
    }

    expect(app.reviewInputs).toHaveLength(0);
    expect(app.riskEvaluator).not.toHaveBeenCalled();
    expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
  });

  it("passes host-first tools through when rules are empty", async () => {
    const app = await makeHarness({ risk: () => promptRisk() });
    await startSession(app);
    await startAgent(app);

    for (const toolName of ["read", "grep", "find", "ls"]) {
      await expect(
        invoke(app, "tool_call", {
          type: "tool_call",
          toolName,
          toolCallId: `hf-${toolName}`,
          input: { path: "README.md" },
        }),
      ).resolves.toBeUndefined();
    }

    expect(app.reviewInputs).toHaveLength(0);
    expect(app.riskEvaluator).not.toHaveBeenCalled();
    expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
  });

  it("blocks host-first tools only on configured rules deny, without Guardian", async () => {
    const app = await makeHarness({
      config: {
        rules: [
          { action: "deny", tool: "read", pattern: "*/Library/*" },
          { action: "deny", tool: "ls" },
          { action: "ask", tool: "grep", pattern: "*" },
        ],
      },
      risk: () => promptRisk(),
    });
    await startSession(app);
    await startAgent(app);

    const denied = await invoke(app, "tool_call", {
      type: "tool_call",
      toolName: "read",
      toolCallId: "hf-deny-read",
      input: { path: "/Users/example/Library/Preferences/x" },
    });
    expect(denied).toMatchObject({ block: true });
    expect((denied as { reason?: string }).reason).toContain("Denied by permissions rule");

    const deniedLs = await invoke(app, "tool_call", {
      type: "tool_call",
      toolName: "ls",
      toolCallId: "hf-deny-ls",
      input: { path: "." },
    });
    expect(deniedLs).toMatchObject({ block: true });

    // rules.ask on host-first is ignored — no Engine/Guardian prompt path.
    await expect(
      invoke(app, "tool_call", {
        type: "tool_call",
        toolName: "grep",
        toolCallId: "hf-ask-ignored",
        input: { pattern: "foo" },
      }),
    ).resolves.toBeUndefined();

    // Non-matching path still passes.
    await expect(
      invoke(app, "tool_call", {
        type: "tool_call",
        toolName: "read",
        toolCallId: "hf-allow-read",
        input: { path: "README.md" },
      }),
    ).resolves.toBeUndefined();

    expect(app.reviewInputs).toHaveLength(0);
    expect(app.riskEvaluator).not.toHaveBeenCalled();
    expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();

    // Exact host API block shape: only block + reason.
    const keys = Object.keys(denied as object).sort();
    expect(keys).toEqual(["block", "reason"].sort());
  });

  it("yolo skips host-first B deny and subagent spawn gate (documented exception)", async () => {
    const app = await makeHarness({
      config: {
        rules: [{ action: "deny", tool: "read", pattern: "*" }],
        delegation: { allowReDelegate: false, maxDepth: 0 },
      },
      risk: () => promptRisk(),
    });
    await startSession(app);
    const shortcut = app.shortcuts.get("shift+tab");
    if (!shortcut) throw new Error("missing shift+tab shortcut");
    await shortcut.handler(app.context);
    await startAgent(app);

    await expect(
      invoke(app, "tool_call", {
        type: "tool_call",
        toolName: "read",
        toolCallId: "yolo-read",
        input: { path: "secret.env" },
      }),
    ).resolves.toBeUndefined();

    await expect(executeHostCall(app, "subagent", "yolo-spawn")).resolves.toBeUndefined();

    expect(app.reviewInputs).toHaveLength(0);
    expect(app.riskEvaluator).not.toHaveBeenCalled();
  });

  it("retains real permissions-command activation and rollback for explicit policy", async () => {
    const app = await makeHarness({
      useRealBashTool: true,
      useRealPermissionRuntime: true,
      config: { sandbox: { network: { access: { kind: "explicit", transport: "proxy" } } } },
    });
    await startSession(app);
    await startAgent(app);
    const command = app.commands.get("permissions")!;
    await writeFile(
      join(app.agentDir, "safety.json"),
      JSON.stringify({
        sandbox: {
          network: {
            access: { kind: "explicit", transport: "proxy" },
            allowedDomains: ["api.example.com"],
          },
        },
      }),
    );
    app.sandboxManager.initialize.mockRejectedValueOnce(
      new Error("explicit backend activation sentinel"),
    );
    await command.handler("", app.context);
    expect(app.notify).toHaveBeenCalledWith(
      expect.stringContaining("previous sandbox remains active"),
      "error",
    );
    expect(app.sandboxManager.initialize).toHaveBeenCalledTimes(3);
    expect(app.sandboxManager.initialize.mock.calls[1]?.[0].network.allowedDomains).toEqual([
      "api.example.com",
    ]);
    expect(app.sandboxManager.initialize.mock.calls[2]?.[0].network.allowedDomains).toEqual([]);
    await executeBash(app, "rollback-old-policy", "printf old");
    expect(app.sandboxManager.execute.mock.calls[0]?.[0].policy.network.execution).toEqual({
      kind: "restricted",
    });
    await command.handler("", app.context);
    expect(app.sandboxManager.initialize).toHaveBeenCalledTimes(4);
    await expect(executeBash(app, "stale-after-reload", "printf stale")).rejects.toThrow(
      /permission context is unavailable/,
    );
    await endAgent(app);
    await startAgent(app);
    await executeBash(app, "activated-new-policy", "printf new");
    expect(app.sandboxManager.execute.mock.calls[1]?.[0].policy.network).toMatchObject({
      execution: { kind: "proxy", inlineReview: false },
      allowedDomains: ["api.example.com"],
    });
    expect(app.reviewInputs).toHaveLength(0);
  });

  it.each(["unchanged", "generation", "fault"])(
    "queues cached preparation behind an existing exclusive writer (%s)",
    async (mutation) => {
      const app = await makeHarness({
        useRealBashTool: true,
        useRealPermissionRuntime: true,
        config: { sandbox: { network: { access: { kind: "explicit", transport: "proxy" } } } },
      });
      await startSession(app);
      await startAgent(app);
      let entered!: () => void;
      const entry = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reader = app.executionCoordinator.runShared(async () => {
        entered();
        await gate;
      });
      await entry;
      let writerRan = false;
      const writer = app.executionCoordinator.runExclusive(async () => {
        writerRan = true;
        if (mutation === "generation") await invoke(app, "session_before_tree");
        if (mutation === "fault") app.sandboxManager.isHealthy.mockReturnValue(false);
      });
      const amendment = executeRequestPermissions(app, "behind-writer", "api.example.com").then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        // Drain the current event-loop turn, not an elapsed-time sleep. The old
        // uncoordinated cache path could finish its host-only review in this turn.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(writerRan).toBe(false);
        expect(app.reviewInputs).toHaveLength(0);
      } finally {
        release();
      }
      await Promise.all([reader, writer]);
      const result = await amendment;
      if (mutation === "generation")
        expect(result).toMatchObject({ error: { name: "ActivationSupersededError" } });
      else if (mutation === "fault")
        expect(result).toMatchObject({ error: { code: "enforcement-unavailable" } });
      else expect(result).toHaveProperty("value");
      expect(app.reviewInputs).toHaveLength(mutation === "unchanged" ? 1 : 0);
      expect(app.sandboxManager.execute).not.toHaveBeenCalled();
    },
  );

  it("waits for actual forced activation and refuses its obsolete permission snapshot", async () => {
    const app = await makeHarness({
      useRealBashTool: true,
      useRealPermissionRuntime: true,
      config: { sandbox: { network: { access: { kind: "explicit", transport: "proxy" } } } },
    });
    await startSession(app);
    await startAgent(app);
    await writeFile(
      join(app.agentDir, "safety.json"),
      JSON.stringify({
        sandbox: {
          network: {
            access: { kind: "explicit", transport: "proxy" },
            deniedDomains: ["api.example.com"],
          },
        },
      }),
    );
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.sandboxManager.initialize.mockImplementationOnce(async () => {
      entered();
      await gate;
    });
    const activation = app.commands.get("permissions")!.handler("", app.context);
    await entry;
    const amendment = executeRequestPermissions(app, "during-activation", "api.example.com").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(app.reviewInputs).toHaveLength(0);
    } finally {
      release();
    }
    await activation;
    expect(await amendment).toMatchObject({
      error: { message: expect.stringContaining("permission context is unavailable") },
    });
    await endAgent(app);
    await startAgent(app);
    await expect(
      executeRequestPermissions(app, "after-activation", "api.example.com"),
    ).rejects.toMatchObject({ code: "policy-denied" });
    expect(app.reviewInputs).toHaveLength(0);
    expect(app.sandboxManager.execute).not.toHaveBeenCalled();
  });

  it.each(
    ["direct", "system", "binding"].flatMap((surface) =>
      ["bash", "write", "edit"].flatMap((tool) =>
        [false, true].map((childInstalled) => ({ surface, tool, childInstalled })),
      ),
    ),
  )(
    "checks late parent review at actual shared launch: $surface / $tool / child=$childInstalled",
    withDarwin(async ({ surface, tool, childInstalled }) => {
      let entered!: () => void;
      const entry = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const app = await makeHarness({
        useRealBashTool: true,
        useRealPermissionRuntime: true,
        config: {
          sandbox: {
            filesystem: { allowWrite: ["."] },
            network: {
              access: { kind: "explicit", transport: surface !== "system" ? "direct" : "proxy" },
              network_access: true,
              ...(surface === "system"
                ? { macosTls: "system", allowLocalBinding: false }
                : { allowPrivateTargets: true, allowLocalBinding: surface === "binding" }),
            },
          },
          delegation: { enabled: true, networkHosts: ["api.example.com"] },
        },
        sandboxExecute: async (request) => ({
          stdout: Buffer.from(request.program.args[2] === "read" ? "before" : ""),
          stderr: Buffer.alloc(0),
          exitCode: 0,
        }),
        review: async () => {
          entered();
          await gate;
          return approved();
        },
      });
      await startSession(app);
      await startAgent(app);
      let reviewed = false;
      const launchEntries: boolean[] = [];
      const shared = app.executionCoordinator.runShared.bind(app.executionCoordinator);
      vi.spyOn(app.executionCoordinator, "runShared").mockImplementation((operation, signal) =>
        shared(async () => {
          launchEntries.push(reviewed);
          return operation();
        }, signal),
      );
      const path = join(app.agentDir, "late-parent-file");
      const parent = (
        tool === "bash"
          ? executeBash(app, "late-raw-review", "rm -rf /tmp/risk-only-fixture")
          : tool === "write"
            ? executeWrite(app, "late-write-review", path, "after")
            : executeEdit(app, "late-edit-review", path)
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await entry;
      try {
        if (childInstalled) await startAgent(app);
      } finally {
        reviewed = true;
        release();
      }
      const result = await parent;
      expect(launchEntries).toContain(true); // Real shared callback entered after review, not a pre-queue check.
      expect(app.reviewInputs).toHaveLength(1);
      if (!childInstalled) {
        expect(result).toHaveProperty("value");
        expect(app.sandboxManager.execute).toHaveBeenCalled();
        return;
      }
      expect(result).toMatchObject({
        error: { reason: expect.stringContaining("outside the current permission scope") },
      });
      expect(app.sandboxManager.execute).not.toHaveBeenCalled();
      await executeBash(app, "child-after-late-review", "printf child");
      expect(app.sandboxManager.execute.mock.calls[0]?.[0].policy.network).toMatchObject({
        network_access: false,
        macosTls: "strict",
        execution: { kind: "proxy", inlineReview: false },
      });
    }),
  );

  it.each(["success", "poison", "stale"] as const)(
    "handles %s cancelled registered drain through the real SRT manager and process coordinator",
    async (outcome) => {
      let entered!: () => void;
      const entry = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const configs: unknown[] = [];
      const runtime: SrtRuntimeLike = {
        isSupportedPlatform: () => true,
        checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
        initialize: async () => {},
        updateConfig: () => {},
        cleanupAfterCommand: () => {},
        reset: async () => {},
        getSandboxViolationStore: () => {
          throw new Error("No diagnostic authority in this fake backend");
        },
        wrapWithSandboxArgv: async (_command, _shell, config) => {
          configs.push(structuredClone(config));
          if (configs.length === 1) {
            entered();
            await gate;
          }
          return { argv: [process.execPath, "-e", ""], env: {} };
        },
      };
      const weakerWrap = { enableWeakerNetworkIsolation: true };
      const guard = new SandboxConnectGuard();
      vi.spyOn(guard, "start").mockResolvedValue(undefined);
      vi.spyOn(guard, "close").mockResolvedValue(undefined);
      // start() is stubbed so port never binds; product still keys weaker
      // isolation off parentProxyUrl when a guard seam is present.
      Object.defineProperty(guard, "parentProxyUrl", {
        get: () => "http://pi-safety:test@127.0.0.1:43123",
      });
      const manager = new SrtSandboxManager(runtime, guard);
      const app = await makeHarness({
        useRealBashTool: true,
        useRealPermissionRuntime: true,
        sandboxManagerOverride: manager,
        config: {
          sandbox: {
            network: {
              access: { kind: "explicit", transport: "direct" },
              network_access: true,
              allowPrivateTargets: true,
            },
          },
          delegation: { enabled: true, networkHosts: ["api.example.com"] },
        },
      });
      await startSession(app);
      await startAgent(app);
      const controller = new AbortController();
      const parent = app.tools
        .get("bash")!
        .execute(
          "cancelled-raw",
          { command: "printf parent" },
          controller.signal,
          undefined,
          app.context,
        )
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      await entry;
      if (outcome === "poison") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      controller.abort();
      expect(await parent).toHaveProperty("error");
      expect(manager.describeState()).toMatchObject({ healthy: false, draining: true });
      const child = startAgent(app);
      const blockedTool =
        outcome === "success"
          ? undefined
          : executeBash(app, "while-real-drain", "printf no").then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(
          app.emit.mock.calls.filter(([name]) => name === "pi-safety:delegation"),
        ).toHaveLength(0);
        expect(manager.describeState().draining).toBe(true);
        if (outcome === "stale") await endAgent(app);
        if (outcome === "poison") {
          await vi.advanceTimersByTimeAsync(SRT_DRAIN_TIMEOUT_MS);
          await child;
          expect(manager.describeState()).toMatchObject({
            healthy: false,
            draining: true,
            execution: "active-lifecycle",
          });
          await expect(manager.waitForIdle()).rejects.toThrow(/drain-timeout/);
          expect(configs).toHaveLength(1); // Caller rejected, but unsettled native lease is still owned.
        }
      } finally {
        release();
        vi.useRealTimers();
      }
      try {
        await child;
        if (outcome !== "success") {
          expect(await blockedTool).toHaveProperty("error");
          expect(app.abort).toHaveBeenCalled();
          await expect(executeBash(app, "after-real-failed-drain", "printf no")).rejects.toThrow();
          expect(configs).toHaveLength(1);
          if (outcome === "poison") {
            await vi.waitFor(() => expect(manager.describeState().draining).toBe(false));
            expect(manager.describeState().healthy).toBe(false);
            await expect(manager.waitForIdle()).rejects.toThrow(/drain-timeout/);
          }
          return;
        }
        expect(manager.describeState()).toMatchObject({ healthy: true, draining: false });
        await executeBash(app, "post-drain-child", "printf child");
        expect(configs).toEqual([weakerWrap, weakerWrap]);
        expect(app.reviewInputs).toHaveLength(0);
      } finally {
        // Teardown only after the detached operation settles and failure assertions;
        // reset is not an admission retry and never releases the held wrap gate.
        await manager.reset();
      }
    },
  );

  it("freezes attempt authority after initial review, not invocation submission, then resists queued widening", async () => {
    let enterAction!: () => void;
    const actionEntered = new Promise<void>((resolve) => {
      enterAction = resolve;
    });
    let releaseAction!: () => void;
    const actionGate = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    let enterBroad!: () => void;
    const broadEntered = new Promise<void>((resolve) => {
      enterBroad = resolve;
    });
    let releaseBroad!: () => void;
    const broadGate = new Promise<void>((resolve) => {
      releaseBroad = resolve;
    });
    const app = await makeHarness({
      useRealBashTool: true,
      useRealPermissionRuntime: true,
      config: { sandbox: { network: { access: { kind: "explicit", transport: "proxy" } } } },
      review: async (_request, ordinal) => {
        if (ordinal === 1) {
          enterAction();
          await actionGate;
        }
        if (ordinal === 3) {
          enterBroad();
          await broadGate;
        }
        return approved();
      },
    });
    await startSession(app);
    await startAgent(app);
    const params = { command: "rm -rf /tmp/risk-only-fixture" };
    const first = executeBashWithParams(app, "pending-action", params);
    await actionEntered;
    params.command = "printf changed";
    const status = async () => {
      await app.commands.get("permissions")!.handler("status", app.context);
      return JSON.parse(String(app.notify.mock.calls.at(-1)?.[0]).split("\n").slice(1).join("\n"));
    };
    expect((await status()).authority).toMatchObject({
      attempts: [],
      pendingReviews: 1,
      turn: { networkAll: false, networkHosts: [] },
    });
    expect(app.reviewInputs[0]?.permissionContext).toMatchObject({
      baselineNetwork: { wholeNetwork: false },
      effectiveNetwork: { wholeNetwork: false },
    });
    await executeRequestPermissions(app, "intervening-host", "api.example.com");
    const broad = app.tools
      .get("request_permissions")!
      .execute(
        "later-broad",
        { permissions: { network: { network_access: true } } },
        undefined,
        undefined,
        app.context,
      );
    await broadEntered;
    let enterWriter!: () => void;
    const writerEntered = new Promise<void>((resolve) => {
      enterWriter = resolve;
    });
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writer = app.executionCoordinator.runExclusive(async () => {
      enterWriter();
      await writerGate;
    });
    await writerEntered;
    try {
      releaseAction();
      await vi.waitFor(async () => {
        expect((await status()).authority.attempts).toHaveLength(1);
      });
      const queued = (await status()).authority.attempts[0];
      expect(queued).toMatchObject({
        callId: "pending-action",
        phase: "planned-or-executing",
        lease: { policy: { network: { allowedDomains: ["api.example.com"] } } },
      });
      expect(queued.lease.policy.network.network_access).not.toBe(true);
      releaseBroad();
      await broad;
      const observed = await status();
      expect(observed.authority.turn.networkAll).toBe(true);
      expect(observed.authority.attempts[0].lease.policy.network.network_access).not.toBe(true);
      observed.authority.attempts[0].lease.policy.network.network_access = true;
      expect((await status()).authority.attempts[0].lease.policy.network.network_access).not.toBe(
        true,
      );
      expect(app.sandboxManager.execute).not.toHaveBeenCalled();
    } finally {
      releaseAction();
      releaseBroad();
      releaseWriter();
    }
    await Promise.all([writer, first, broad]);
    const request = app.sandboxManager.execute.mock.calls[0]?.[0];
    expect(request.program.args).toContain("rm -rf /tmp/risk-only-fixture");
    expect(request.policy.network.allowedDomains).toEqual(["api.example.com"]);
    expect(request.policy.network.network_access).not.toBe(true);
    await executeBash(app, "after-queued-grant", "printf B");
    expect(app.sandboxManager.execute.mock.calls[1]?.[0].policy.network.network_access).toBe(true);
    expect(app.reviewInputs).toHaveLength(3);
  });

  it("reports no pending inline AllowOnce after uncovered network fail-closed", async () => {
    const app = await makeHarness({
      useRealBashTool: true,
      useRealPermissionRuntime: true,
      sandboxNetworkAttempt: { host: "api.example.com", port: 443 },
      review: async () => approved(),
    });
    await startSession(app);
    await startAgent(app);
    await expect(executeBash(app, "pending-inline", "printf A")).rejects.toMatchObject({
      code: "permission-required",
    });
    expect(app.reviewInputs).toHaveLength(0);
    await app.commands.get("permissions")!.handler("status", app.context);
    const view = JSON.parse(
      String(app.notify.mock.calls.at(-1)?.[0]).split("\n").slice(1).join("\n"),
    );
    expect(view.authority).toMatchObject({
      pendingReviews: 0,
      pendingConnections: 0,
      actionGrants: [],
      turn: { networkAll: false, networkHosts: [] },
    });
  });

  it("does not show a turn grant invalidated by default permissions activation", async () => {
    const app = await makeHarness({
      useRealBashTool: true,
      useRealPermissionRuntime: true,
      config: { sandbox: { network: { access: { kind: "explicit", transport: "proxy" } } } },
    });
    await startSession(app);
    await startAgent(app);
    await app.tools
      .get("request_permissions")!
      .execute(
        "reload-grant",
        { permissions: { network: { network_access: true } } },
        undefined,
        undefined,
        app.context,
      );
    await app.commands.get("permissions")!.handler("", app.context);
    await app.commands.get("permissions")!.handler("status", app.context);
    const view = JSON.parse(
      String(app.notify.mock.calls.at(-1)?.[0]).split("\n").slice(1).join("\n"),
    );
    expect(view).not.toHaveProperty("authority");
    await executeBash(app, "after-default-reload", "printf A");
    expect(app.sandboxManager.execute.mock.calls[0]?.[0].policy.network.execution).toEqual({
      kind: "restricted",
    });
  });

  it("reviews a risky action independently under broad baseline authority without granting another scope", async () => {
    const app = await makeHarness({
      useRealBashTool: true,
      useRealPermissionRuntime: true,
      config: {
        sandbox: {
          network: { access: { kind: "explicit", transport: "proxy" }, network_access: true },
        },
      },
    });
    await startSession(app);
    await startAgent(app);
    await executeBash(app, "broad-risk", "rm -rf /tmp/risk-only-fixture");
    expect(app.reviewInputs).toHaveLength(1);
    expect(app.reviewInputs[0]?.permissionContext).toMatchObject({
      permissionLifetime: "exact-action-only",
      requestedWholeNetwork: false,
      baselineNetwork: { wholeNetwork: true },
      effectiveNetwork: { wholeNetwork: true },
    });
    await app.commands.get("permissions")!.handler("status", app.context);
    const view = JSON.parse(
      String(app.notify.mock.calls.at(-1)?.[0]).split("\n").slice(1).join("\n"),
    );
    expect(view.authority.turn.networkAll).toBe(false);
    expect(view.authority.actionGrants).toEqual([]);
  });

  it(
    "reports Engine authority read-only without reload, poisoning or leaking expired grants",
    withDarwin(async () => {
      const app = await makeHarness({
        useRealBashTool: true,
        useRealPermissionRuntime: true,
        config: {
          sandbox: {
            network: { access: { kind: "explicit", transport: "proxy" }, macosTls: "system" },
          },
        },
      });
      await startSession(app);
      await startAgent(app);
      await app.commands.get("permissions")!.handler("status", app.context);
      const status = () =>
        JSON.parse(String(app.notify.mock.calls.at(-1)?.[0]).split("\n").slice(1).join("\n"));
      expect(status().nextAttemptNetwork).toMatchObject({
        configuredTls: "system",
        effectiveTls: "strict",
        required: { kind: "restricted" },
        wholeNetwork: false,
      });
      await app.tools
        .get("request_permissions")!
        .execute(
          "status-broad",
          { permissions: { network: { network_access: true } } },
          undefined,
          undefined,
          app.context,
        );
      expect(app.reviewInputs[0]?.permissionContext).toMatchObject({
        requestedWholeNetwork: true,
        permissionLifetime: "turn-end-after-confirmation",
        baselineNetwork: { wholeNetwork: false, effectiveTls: "strict" },
        effectiveNetwork: { wholeNetwork: true, effectiveTls: "system", helperEgressRisk: true },
      });
      const initialized = app.sandboxManager.initialize.mock.calls.length;
      const persisted = app.appendEntry.mock.calls.length;
      await writeFile(join(app.agentDir, "safety.json"), "{invalid");
      await app.commands.get("permissions")!.handler("status", app.context);
      const observed = status();
      expect(observed.configured.error).toBeTypeOf("string");
      expect(observed.authority.turn).toMatchObject({
        networkAll: true,
        networkHosts: [],
        expires: "turn-end",
      });
      expect(observed.nextAttemptNetwork).toMatchObject({
        required: { kind: "proxy", tls: "system" },
        helperEgressRisk: true,
      });
      expect(observed.backend.nativeEnforcement).toBe("unknown");
      expect(app.sandboxManager.initialize).toHaveBeenCalledTimes(initialized);
      expect(app.appendEntry).toHaveBeenCalledTimes(persisted);
      observed.authority.effective.network.network_access = false;
      await app.commands.get("permissions")!.handler("status", app.context);
      expect(status().authority.turn.networkAll).toBe(true);
      await writeFile(
        join(app.agentDir, "safety.json"),
        JSON.stringify({
          sandbox: {
            network: { access: { kind: "explicit", transport: "proxy" }, macosTls: "system" },
          },
        }),
      );
      await executeBash(app, "after-status", "printf ok");
      expect(app.sandboxManager.execute.mock.calls[0]?.[0].policy.network.execution).toEqual({
        kind: "proxy",
        inlineReview: false,
        tls: "system",
      });
      await endAgent(app);
      await app.commands.get("permissions")!.handler("status", app.context);
      expect(status()).not.toHaveProperty("authority");
      expect(app.reviewInputs).toHaveLength(1);
    }),
  );

  it.each([false, true])(
    "keeps private eligibility independent of authority and binding (private=%s)",
    async (allowPrivateTargets) => {
      const app = await makeHarness({
        useRealBashTool: true,
        useRealPermissionRuntime: true,
        config: {
          sandbox: {
            network: { access: { kind: "explicit", transport: "proxy" }, allowPrivateTargets },
          },
        },
        sandboxNetworkAttempt: { host: "10.1.2.3", port: 443 },
      });
      await startSession(app);
      await startAgent(app);
      await expect(executeBash(app, "private-ungranted", "printf A")).rejects.toMatchObject({
        code: allowPrivateTargets ? "permission-required" : "policy-denied",
      });
      if (!allowPrivateTargets) {
        await expect(
          executeRequestPermissions(app, "private-host-rejected", "10.1.2.3"),
        ).rejects.toMatchObject({ code: "policy-denied" });
      }
      await app.tools
        .get("request_permissions")!
        .execute(
          "public-broad",
          { permissions: { network: { network_access: true } } },
          undefined,
          undefined,
          app.context,
        );
      const execution = executeBash(app, "private-broad", "printf B");
      if (allowPrivateTargets) await expect(execution).resolves.toBeDefined();
      else await expect(execution).rejects.toMatchObject({ code: "policy-denied" });
      expect(
        app.sandboxManager.execute.mock.calls[1]?.[0].policy.network.allowLocalBinding,
      ).toBeUndefined();
      expect(app.reviewInputs).toHaveLength(1);
    },
  );

  it.each(["localhost", "localhost:443"])(
    "keeps exact-local amendment eligibility consistent without widening %s",
    async (baseline) => {
      const app = await makeHarness({
        useRealBashTool: true,
        useRealPermissionRuntime: true,
        config: {
          sandbox: {
            network: {
              access: { kind: "explicit", transport: "proxy" },
              allowedDomains: [baseline],
            },
          },
        },
        sandboxNetworkAttempt: { host: "localhost", port: 443 },
        sandboxNetworkAnswers: { localhost: ["127.0.0.1"] },
      });
      await startSession(app);
      await startAgent(app);
      const amendment = executeRequestPermissions(app, "exact-local-request", "localhost");
      if (baseline === "localhost") await expect(amendment).resolves.toBeDefined();
      else await expect(amendment).rejects.toMatchObject({ code: "policy-denied" });
      await executeBash(app, "exact-local-covered", "printf A");
      expect(app.sandboxManager.execute.mock.calls[0]?.[0].policy.network.network_access).not.toBe(
        true,
      );
      expect(app.reviewInputs).toHaveLength(baseline === "localhost" ? 1 : 0);
    },
  );

  it(
    "rejects all-denied broad authority and system/private-host conflicts before review",
    withDarwin(async () => {
      for (const system of [false, true]) {
        const app = await makeHarness({
          useRealBashTool: true,
          useRealPermissionRuntime: true,
          config: {
            sandbox: {
              network: {
                access: { kind: "explicit", transport: "proxy" },
                ...(system
                  ? { macosTls: "system", allowPrivateTargets: true }
                  : { deniedDomains: ["*"] }),
              },
            },
          },
        });
        await startSession(app);
        await startAgent(app);
        await expect(
          app.tools.get("request_permissions")!.execute(
            "hard-network-conflict",
            {
              permissions: {
                network: system ? { hosts: ["127.0.0.1"] } : { network_access: true },
              },
            },
            undefined,
            undefined,
            app.context,
          ),
        ).rejects.toMatchObject({ code: "policy-denied" });
        expect(app.reviewInputs).toHaveLength(0);
        expect(app.sandboxManager.execute).not.toHaveBeenCalled();
      }
    }),
  );

  it("grants one eligible private host without silently granting all-network", async () => {
    const target = { host: "10.1.2.3", port: 443 };
    const app = await makeHarness({
      useRealBashTool: true,
      useRealPermissionRuntime: true,
      config: {
        sandbox: {
          network: { access: { kind: "explicit", transport: "proxy" }, allowPrivateTargets: true },
        },
      },
      sandboxNetworkAttempt: target,
    });
    await startSession(app);
    await startAgent(app);
    await executeRequestPermissions(app, "one-private", target.host);
    await executeBash(app, "private-covered", "printf yes");
    target.host = "10.1.2.4";
    await expect(executeBash(app, "private-uncovered", "printf no")).rejects.toMatchObject({
      code: "permission-required",
    });
    expect(app.sandboxManager.execute.mock.calls[0]?.[0].policy.network).toMatchObject({
      allowedDomains: ["10.1.2.3"],
    });
    expect(
      app.sandboxManager.execute.mock.calls[0]?.[0].policy.network.allowLocalBinding,
    ).toBeUndefined();
    expect(app.sandboxManager.execute.mock.calls[0]?.[0].policy.network.network_access).not.toBe(
      true,
    );
    expect(app.reviewInputs).toHaveLength(1);
  });

  it.each([true, false])(
    "intersects broad configured parent into a finite child even with delegation.enabled=%s",
    async (enabled) => {
      const app = await makeHarness({
        useRealBashTool: true,
        useRealPermissionRuntime: true,
        config: {
          sandbox: {
            network: {
              network_access: true,
              allowedDomains: ["api.example.com"],
              access: { kind: "explicit", transport: "proxy" },
            },
          },
          delegation: { enabled, networkHosts: ["api.example.com"] },
        },
      });
      await startSession(app);
      await startAgent(app);
      await startAgent(app);
      await expect(
        app.tools
          .get("request_permissions")!
          .execute(
            "child-broad",
            { permissions: { network: { network_access: true } } },
            undefined,
            undefined,
            app.context,
          ),
      ).rejects.toMatchObject({ code: "policy-denied" });
      await executeBash(app, "child-host-only", "printf child");
      expect(app.sandboxManager.execute.mock.calls[0]?.[0].policy.network).toMatchObject({
        network_access: false,
        delegated: true,
        allowedDomains: ["api.example.com"],
        execution: { kind: "proxy", inlineReview: false },
      });
      expect(app.reviewInputs).toHaveLength(0);
    },
  );

  it("intersects a broad turn grant without reintroducing it through the child lease", async () => {
    const app = await makeHarness({
      useRealBashTool: true,
      useRealPermissionRuntime: true,
      config: {
        sandbox: { network: { access: { kind: "explicit", transport: "proxy" } } },
        delegation: { enabled: true, networkHosts: ["api.example.com"] },
      },
    });
    await startSession(app);
    await startAgent(app);
    await app.tools
      .get("request_permissions")!
      .execute(
        "parent-broad",
        { permissions: { network: { network_access: true } } },
        undefined,
        undefined,
        app.context,
      );
    await startAgent(app);
    await executeBash(app, "child-finite", "printf child");
    expect(app.sandboxManager.execute.mock.calls[0]?.[0].policy.network).toMatchObject({
      network_access: false,
      allowedDomains: ["api.example.com"],
    });
    await endAgent(app);
    await executeBash(app, "parent-resumed", "printf parent");
    expect(app.sandboxManager.execute.mock.calls[1]?.[0].policy.network.network_access).toBe(true);
  });

  it.each(["direct", "system"] as const)(
    "drains an active %s parent before installing a tighter child",
    withDarwin(async (surface) => {
      let entered!: () => void;
      const entry = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const app = await makeHarness({
        useRealBashTool: true,
        useRealPermissionRuntime: true,
        config: {
          sandbox: {
            network: {
              access: { kind: "explicit", transport: surface === "direct" ? "direct" : "proxy" },
              network_access: true,
              ...(surface === "direct"
                ? { allowPrivateTargets: true }
                : { macosTls: "system", allowLocalBinding: false }),
            },
          },
          delegation: { enabled: true, networkHosts: ["api.example.com"] },
        },
        sandboxExecute: async (_request, ordinal) => {
          if (ordinal === 1) {
            entered();
            await gate;
          }
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
        },
      });
      await startSession(app);
      await startAgent(app);
      const parent = executeBash(app, "raw-parent", "printf parent");
      await entry;
      const child = startAgent(app);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(app.sandboxManager.waitForIdle).not.toHaveBeenCalled();
        expect(
          app.emit.mock.calls.filter(([name]) => name === "pi-safety:delegation"),
        ).toHaveLength(0);
      } finally {
        release();
      }
      await parent;
      await child;
      expect(app.sandboxManager.waitForIdle).toHaveBeenCalledTimes(1);
      await executeBash(app, "tight-child", "printf child");
      expect(app.sandboxManager.execute.mock.calls[1]?.[0].policy.network).toMatchObject({
        network_access: false,
        macosTls: "strict",
        delegated: true,
        allowedDomains: ["api.example.com"],
        allowLocalBinding: false,
        execution: { kind: "proxy", inlineReview: false },
      });
    }),
  );

  it.each(["pending", "poison", "stale"] as const)(
    "handles %s backend drain before nested admission without borrowing a raw parent",
    async (outcome) => {
      const app = await makeHarness({
        useRealBashTool: true,
        useRealPermissionRuntime: true,
        config: {
          sandbox: {
            network: {
              access: { kind: "explicit", transport: "direct" },
              network_access: true,
              allowPrivateTargets: true,
            },
          },
          delegation: { enabled: true, networkHosts: ["api.example.com"] },
        },
      });
      await startSession(app);
      await startAgent(app);
      let entered!: () => void;
      const entry = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      app.sandboxManager.waitForIdle.mockImplementationOnce(async () => {
        entered();
        await gate;
        if (outcome === "poison") throw new Error("poisoned after drain failure");
      });
      const child = startAgent(app);
      await entry;
      const tool = executeBash(app, "while-draining", "printf child").then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(app.sandboxManager.execute).not.toHaveBeenCalled();
        if (outcome === "stale") await endAgent(app);
      } finally {
        release();
      }
      await child;
      if (outcome === "pending") {
        expect(await tool).toHaveProperty("value");
        expect(app.sandboxManager.execute.mock.calls[0]?.[0].policy.network.execution).toEqual({
          kind: "proxy",
          inlineReview: false,
        });
      } else {
        expect(await tool).toHaveProperty("error");
        expect(app.abort).toHaveBeenCalled();
        await expect(executeBash(app, "after-failed-drain", "printf no")).rejects.toThrow();
        expect(app.sandboxManager.execute).not.toHaveBeenCalled();
      }
    },
  );

  it("starts restricted then selects direct only after a whole-network amendment", async () => {
    const app = await makeHarness({
      useRealBashTool: true,
      useRealPermissionRuntime: true,
      config: {
        sandbox: {
          network: { access: { kind: "explicit", transport: "direct" }, allowPrivateTargets: true },
        },
      },
    });
    await startSession(app);
    await startAgent(app);
    await executeBash(app, "direct-A", "printf A");
    expect(app.sandboxManager.execute.mock.calls[0]?.[0].policy.network.execution).toMatchObject({
      kind: "restricted",
    });
    await expect(
      executeRequestPermissions(app, "narrow-direct", "api.example.com"),
    ).rejects.toMatchObject({ code: "policy-denied" });
    expect(app.reviewInputs).toHaveLength(0);
    await app.tools
      .get("request_permissions")!
      .execute(
        "direct-grant",
        { permissions: { network: { network_access: true } } },
        undefined,
        undefined,
        app.context,
      );
    await executeBash(app, "direct-B", "printf B");
    expect(app.sandboxManager.execute.mock.calls[1]?.[0].policy.network).toMatchObject({
      network_access: true,
      execution: { kind: "direct" },
    });
    expect(
      app.sandboxManager.execute.mock.calls[1]?.[0].policy.network.allowLocalBinding,
    ).toBeUndefined();
    expect(app.sandboxManager.execute.mock.calls[1]?.[0].policy.filesystem.denyWrite).toContain(
      join(app.cwd, ".git"),
    );
    expect(app.reviewInputs).toHaveLength(1);
  });

  it("grants whole-network authority only to later invocations and retains hard policy", async () => {
    const app = await makeHarness({
      useRealBashTool: true,
      useRealPermissionRuntime: true,
      config: {
        sandbox: {
          network: {
            access: { kind: "explicit", transport: "proxy" },
            deniedDomains: ["blocked.example.com"],
          },
        },
      },
      sandboxNetworkAttempt: { host: "other.example.com", port: 443 },
    });
    await startSession(app);
    await startAgent(app);
    await expect(executeBash(app, "no-broad", "printf A")).rejects.toMatchObject({
      code: "permission-required",
    });
    await app.tools
      .get("request_permissions")!
      .execute(
        "broad",
        { permissions: { network: { network_access: true } } },
        undefined,
        undefined,
        app.context,
      );
    await executeBash(app, "broad-B", "printf B");
    expect(app.reviewInputs).toHaveLength(1);
    expect(app.sandboxManager.execute.mock.calls[1]?.[0].policy.network).toMatchObject({
      network_access: true,
      allowedDomains: [],
      deniedDomains: ["blocked.example.com"],
    });
    await endAgent(app);
    await startAgent(app);
    await expect(executeBash(app, "expired-broad", "printf C")).rejects.toMatchObject({
      code: "permission-required",
    });
  });

  it.each(["host", "whole"] as const)(
    "freezes running real Bash A while explicit %s confirmation grants only new B",
    async (scope) => {
      let entered!: (request: SandboxExecutionRequest) => void;
      const entry = new Promise<SandboxExecutionRequest>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const decisions: boolean[] = [];
      const plans: SandboxPolicy[] = [];
      const app = await makeHarness({
        useRealBashTool: true,
        useRealPermissionRuntime: true,
        config: {
          sandbox: {
            network: {
              access: { kind: "explicit", transport: "proxy" },
              deniedDomains: ["blocked.example.com"],
            },
          },
        },
        sandboxExecute: async (request, ordinal) => {
          plans.push(structuredClone(request.policy));
          if (ordinal === 1) {
            entered(request);
            await gate;
          }
          const authorization = await request.networkAuthorize!({
            host: "api.example.com",
            port: 443,
          });
          decisions.push(authorization.allowed);
          return {
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            exitCode: authorization.allowed ? 0 : 1,
          };
        },
      });
      await startSession(app);
      await startAgent(app);
      const a = executeBash(app, "explicit-A", "printf A").then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const running = await entry;
      try {
        expect(running.policy.network.execution).toEqual({ kind: "restricted" });
        expect(app.reviewInputs).toHaveLength(0);
        const activations = app.sandboxManager.initialize.mock.calls.length;
        if (scope === "host")
          await executeRequestPermissions(app, "explicit-grant", "api.example.com");
        else
          await app.tools
            .get("request_permissions")!
            .execute(
              "explicit-grant",
              { permissions: { network: { network_access: true } } },
              undefined,
              undefined,
              app.context,
            );
        expect(app.sandboxManager.initialize).toHaveBeenCalledTimes(activations);
        expect(app.sandboxManager.execute).toHaveBeenCalledTimes(1);
        expect(running.policy.network.allowedDomains).toEqual([]);
        expect(running.policy.network.network_access).not.toBe(true);
        expect(running.policy.network.execution).toEqual({ kind: "restricted" });
        await app.commands.get("permissions")!.handler("status", app.context);
        const view = JSON.parse(
          String(app.notify.mock.calls.at(-1)?.[0]).split("\n").slice(1).join("\n"),
        );
        expect(view.authority.attempts[0].lease.policy.network.execution).toEqual({
          kind: "restricted",
        });
        expect(view.nextAttemptNetwork.required.kind).toBe("proxy");
      } finally {
        release();
      }
      expect(await a).toMatchObject({ error: { code: "permission-required" } });
      await executeBash(app, "explicit-B", "printf B");
      expect(decisions).toEqual([false, true]);
      expect(plans[1]?.network).toMatchObject({
        execution: { kind: "proxy", inlineReview: false },
        allowedDomains: scope === "host" ? ["api.example.com"] : [],
        deniedDomains: ["blocked.example.com"],
      });
      expect(app.reviewInputs).toHaveLength(1);
      await expect(
        executeRequestPermissions(app, "explicit-hard", "blocked.example.com"),
      ).rejects.toMatchObject({ code: "policy-denied" });
      expect(app.reviewInputs).toHaveLength(1);
      await endAgent(app);
      await startAgent(app);
      await expect(executeBash(app, "explicit-expired", "printf C")).rejects.toMatchObject({
        code: "permission-required",
      });
      expect(plans[2]?.network.execution).toEqual({ kind: "restricted" });
      expect(app.sandboxManager.execute).toHaveBeenCalledTimes(3);
      expect(app.reviewInputs).toHaveLength(1);
    },
  );

  it("freezes A and grants B through production PiAutoReviewer without host sandbox mutation", async () => {
    let entered!: (request: SandboxExecutionRequest) => void;
    const entry = new Promise<SandboxExecutionRequest>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const complete = vi.fn(async () => ({
      role: "assistant",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            risk_level: "low",
            user_authorization: "high",
            outcome: "allow",
            rationale: "Authorized by production auto-review.",
          }),
        },
      ],
      stopReason: "stop",
    }));
    // Default createTools is createIsolatedGuardianToolRuntime. Approve without
    // tool rounds so close() retires an unstarted worker (no spawn).
    const productionReviewer = new PiAutoReviewer(complete as never);
    const app = await makeHarness({
      useRealBashTool: true,
      useRealPermissionRuntime: true,
      autoReviewer: productionReviewer,
      model: { provider: "openai", id: "guardian-test" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "token" }),
      },
      config: {
        sandbox: {
          network: {
            access: { kind: "explicit", transport: "proxy" },
            deniedDomains: ["blocked.example.com"],
          },
        },
      },
      sandboxExecute: async (request, ordinal) => {
        if (ordinal === 1) {
          entered(request);
          await gate;
        }
        const authorization = await request.networkAuthorize!({
          host: "api.example.com",
          port: 443,
        });
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: authorization.allowed ? 0 : 1,
        };
      },
    });
    await startSession(app);
    await startAgent(app);
    const a = executeBash(app, "prod-A", "printf A").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const running = await entry;
    const activations = app.sandboxManager.initialize.mock.calls.length;
    const hostExecutes = app.sandboxManager.execute.mock.calls.length;
    try {
      expect(running.policy.network.execution).toEqual({ kind: "restricted" });
      await executeRequestPermissions(app, "prod-grant", "api.example.com");
      // Production review must not touch the host SRT manager while A is running.
      expect(app.sandboxManager.initialize).toHaveBeenCalledTimes(activations);
      expect(app.sandboxManager.execute).toHaveBeenCalledTimes(hostExecutes);
      expect(running.policy.network.execution).toEqual({ kind: "restricted" });
      expect(complete).toHaveBeenCalledOnce();
    } finally {
      release();
    }
    expect(await a).toMatchObject({ error: { code: "permission-required" } });
    await executeBash(app, "prod-B", "printf B");
    expect(app.sandboxManager.execute.mock.calls.at(-1)?.[0].policy.network).toMatchObject({
      execution: { kind: "proxy", inlineReview: false },
      allowedDomains: ["api.example.com"],
    });
    await expect(
      executeRequestPermissions(app, "prod-hard", "blocked.example.com"),
    ).rejects.toMatchObject({ code: "policy-denied" });
  });

  it.each(
    ["denied", "aborted", "stale"].flatMap((outcome) =>
      ["host", "whole"].map((scope) => ({ outcome, scope })),
    ),
  )("does not give new Bash a $outcome explicit $scope grant", async ({ outcome, scope }) => {
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await makeHarness({
      useRealBashTool: true,
      useRealPermissionRuntime: true,
      config: { sandbox: { network: { access: { kind: "explicit", transport: "proxy" } } } },
      review: async () => {
        entered();
        await gate;
        return outcome === "denied" ? denied() : approved();
      },
    });
    await startSession(app);
    await startAgent(app);
    const controller = new AbortController();
    const amendment = app.tools
      .get("request_permissions")!
      .execute(
        "not-granted",
        {
          permissions: {
            network: scope === "host" ? { hosts: ["api.example.com"] } : { network_access: true },
          },
        },
        controller.signal,
        undefined,
        app.context,
      )
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    await entry;
    if (outcome === "aborted") controller.abort();
    if (outcome === "stale") {
      await endAgent(app);
      await startAgent(app);
    }
    release();
    expect(await amendment).toMatchObject({
      error: {
        code:
          outcome === "denied"
            ? "review-denied"
            : outcome === "aborted"
              ? "aborted"
              : "stale-invocation",
      },
    });
    await executeBash(app, "after-failed-grant", "printf ok");
    expect(app.sandboxManager.execute.mock.calls[0]?.[0].policy.network).toMatchObject({
      execution: { kind: "restricted" },
      allowedDomains: [],
    });
    expect(app.sandboxManager.execute).toHaveBeenCalledOnce();
    expect(app.reviewInputs).toHaveLength(1);
  });

  it("tightens running explicit attempts at the live child ceiling without widening child hosts", async () => {
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const decisions: boolean[] = [];
    const app = await makeHarness({
      useRealBashTool: true,
      useRealPermissionRuntime: true,
      config: {
        sandbox: {
          network: {
            access: { kind: "explicit", transport: "proxy" },
            allowedDomains: ["api.example.com", "other.example.com"],
            deniedDomains: ["blocked.example.com"],
          },
          filesystem: { denyRead: ["/explicit-secret"], denyWrite: ["/explicit-secret"] },
        },
        delegation: { networkHosts: ["api.example.com"] },
      },
      sandboxExecute: async (request, ordinal) => {
        if (ordinal === 1) {
          decisions.push(
            (await request.networkAuthorize!({ host: "other.example.com", port: 443 })).allowed,
          );
          entered();
          await gate;
        }
        decisions.push(
          (
            await request.networkAuthorize!({
              host: ordinal === 1 ? "other.example.com" : "api.example.com",
              port: 443,
            })
          ).allowed,
        );
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
      },
    });
    await startSession(app);
    await startAgent(app);
    const a = executeBash(app, "parent-A", "printf A").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await entry;
    try {
      await startAgent(app);
    } finally {
      release();
    }
    expect(await a).toMatchObject({ error: { code: "policy-denied" } });
    await executeBash(app, "child-B", "printf B");
    expect(decisions).toEqual([true, false, true]);
    const childPolicy = app.sandboxManager.execute.mock.calls[1]?.[0].policy;
    expect(childPolicy.network).toMatchObject({
      access: { kind: "explicit", transport: "proxy" },
      execution: { kind: "proxy", inlineReview: false },
      allowedDomains: ["api.example.com"],
      deniedDomains: ["blocked.example.com"],
    });
    expect(childPolicy.filesystem.denyRead).toContain("/explicit-secret");
    expect(childPolicy.filesystem.denyWrite).toContain(join(app.cwd, ".git"));
    await expect(
      executeRequestPermissions(app, "child-outside", "other.example.com"),
    ).rejects.toMatchObject({ code: "policy-denied" });
    await expect(
      executeWrite(app, "child-hard-write", "/explicit-secret", "no"),
    ).rejects.toMatchObject({ code: "policy-denied" });
    await expect(
      executeWrite(app, "child-git-hooks", ".git/hooks/pre-commit", "no"),
    ).rejects.toMatchObject({ code: "policy-denied" });
    expect(app.reviewInputs).toHaveLength(0);
    expect(app.sandboxManager.execute).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "reviews risky real Bash independently without synthesizing network (baseline=%s)",
    async (baseline) => {
      const app = await makeHarness({
        useRealBashTool: true,
        useRealPermissionRuntime: true,
        config: {
          sandbox: {
            network: {
              access: { kind: "explicit", transport: "proxy" },
              allowedDomains: baseline ? ["api.example.com"] : [],
            },
          },
        },
      });
      await startSession(app);
      await startAgent(app);
      await executeBash(app, "ordinary-before", "printf ok");
      expect(app.reviewInputs).toHaveLength(0);
      await executeBash(app, "risky-action", "rm -rf scratch");
      expect(app.reviewInputs).toHaveLength(1);
      await executeBash(app, "ordinary-after", "printf ok");
      expect(app.reviewInputs).toHaveLength(1);
      for (const [request] of app.sandboxManager.execute.mock.calls) {
        expect(request.policy.network.allowedDomains).toEqual(baseline ? ["api.example.com"] : []);
        expect(request.policy.network.execution).toEqual(
          baseline ? { kind: "proxy", inlineReview: false } : { kind: "restricted" },
        );
      }
    },
  );

  it("retains port-limited baseline authority without inline review or host widening", async () => {
    let target = { host: "api.example.com", port: 443 };
    const app = await makeHarness({
      useRealBashTool: true,
      useRealPermissionRuntime: true,
      config: {
        sandbox: {
          network: {
            access: { kind: "explicit", transport: "proxy" },
            allowedDomains: ["api.example.com:443"],
          },
        },
      },
      sandboxExecute: async (request) => {
        const decision = await request.networkAuthorize!(target);
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: decision.allowed ? 0 : 1,
        };
      },
    });
    await startSession(app);
    await startAgent(app);
    await executeBash(app, "covered-port", "printf ok");
    target = { host: "api.example.com", port: 80 };
    await expect(executeBash(app, "other-port", "printf ok")).rejects.toMatchObject({
      code: "permission-required",
    });
    target = { host: "other.example.com", port: 443 };
    await expect(executeBash(app, "other-host", "printf ok")).rejects.toMatchObject({
      code: "permission-required",
    });
    expect(app.reviewInputs).toHaveLength(0);
    expect(app.sandboxManager.execute).toHaveBeenCalledTimes(3);
  });

  it("keeps uncovered Bash network fail-closed until request_permissions grants a lease", async () => {
    const app = await makeHarness({
      useRealBashTool: true,
      useRealPermissionRuntime: true,
      sandboxNetworkAttempt: { host: "api.example.com", port: 443 },
    });
    await startSession(app);
    await startAgent(app);
    await expect(executeBash(app, "legacy-A", "printf A")).rejects.toMatchObject({
      code: "permission-required",
    });
    await expect(executeBash(app, "legacy-B", "printf B")).rejects.toMatchObject({
      code: "permission-required",
    });
    expect(app.reviewInputs).toHaveLength(0);
    await executeRequestPermissions(app, "legacy-turn", "api.example.com");
    await executeBash(app, "legacy-C", "printf C");
    expect(app.reviewInputs).toHaveLength(1); // amendment review only
    expect(app.sandboxManager.execute.mock.calls[0]?.[0].policy.network).toMatchObject({
      allowedDomains: [],
    });
    expect(app.sandboxManager.execute.mock.calls[2]?.[0].policy.network.allowedDomains).toEqual([
      "api.example.com",
    ]);
  });

  it("registers request_permissions with a network_access schema that matches runtime", async () => {
    const app = await makeHarness({ useRealPermissionRuntime: true });
    await startSession(app);
    await startAgent(app);
    const tool = app.tools.get("request_permissions");
    expect(tool).toBeDefined();
    const serialized = JSON.stringify(tool?.parameters);
    expect(serialized).toContain("network_access");
    expect(serialized).not.toContain('"enabled"');
    expect(serialized).not.toContain("allowUnixSockets");
    expect(serialized).not.toContain("unixSockets");
    expect(serialized).not.toContain("dangerouslyAllowAllUnixSockets");
    await expect(
      tool?.execute(
        "schema-shaped",
        { permissions: { network: { network_access: true } } },
        undefined,
        undefined,
        app.context,
      ),
    ).resolves.toBeDefined();
    await expect(
      tool?.execute(
        "schema-legacy",
        { permissions: { network: { enabled: true } } },
        undefined,
        undefined,
        app.context,
      ),
    ).rejects.toMatchObject({ code: "policy-denied" });
  });

  it.each([
    { scope: "session", permissions: { network: { hosts: ["api.example.com"] } } },
    { permissions: { network: { hosts: ["api.example.com"], network_access: true } } },
    { permissions: { network: { network_access: false } } },
    { permissions: { network: { network_access: "true" } } },
    { permissions: { network: { network_access: true, port: 443 } } },
    { permissions: { network: { hosts: ["*"] } } },
    {
      permissions: {
        network: Object.assign(Object.create({ hosts: ["api.example.com"] }), {
          network_access: true,
        }),
      },
    },
    { permissions: { network: { hosts: ["api.example.com"], protocol: "udp" } } },
    { permissions: { network: { hosts: ["api.example.com"], port: 443 } } },
    { permissions: { network: { hosts: ["api.example.com:443"] } } },
    { permissions: { network: { hosts: ["api.example.com", null] } } },
    {
      permissions: {
        network: {
          hosts: ["api.example.com"],
          unixSockets: ["/Users/x1a2h1/.orbstack/run/docker.sock"],
        },
      },
    },
    {
      permissions: {
        network: {
          allowUnixSockets: ["/Users/x1a2h1/.orbstack/run/docker.sock"],
        },
      },
    },
    {
      permissions: {
        network: {
          network_access: true,
          dangerouslyAllowAllUnixSockets: true,
        },
      },
    },
  ])("rejects unsupported explicit scope without granting a broader host: %j", async (params) => {
    const app = await makeHarness({
      useRealBashTool: true,
      useRealPermissionRuntime: true,
      config: { sandbox: { network: { access: { kind: "explicit", transport: "proxy" } } } },
    });
    await startSession(app);
    await startAgent(app);
    await expect(
      app.tools
        .get("request_permissions")!
        .execute("unsupported", params, undefined, undefined, app.context),
    ).rejects.toMatchObject({ code: "policy-denied" });
    await executeBash(app, "after-unsupported", "printf ok");
    expect(app.reviewInputs).toHaveLength(0);
    expect(app.sandboxManager.execute.mock.calls[0]?.[0].policy.network).toMatchObject({
      execution: { kind: "restricted" },
      allowedDomains: [],
    });
  });

  it.each(["hidden-hosts", "hidden-port"] as const)(
    "rejects clone-erased network scope before review and grants: %s",
    async (shape) => {
      const network =
        shape === "hidden-hosts" ? { network_access: true } : { hosts: ["narrow.example"] };
      Object.defineProperty(network, shape === "hidden-hosts" ? "hosts" : "port", {
        value: shape === "hidden-hosts" ? ["narrow.example"] : 443,
        enumerable: false,
      });
      const app = await makeHarness({
        useRealBashTool: true,
        useRealPermissionRuntime: true,
        config: { sandbox: { network: { access: { kind: "explicit", transport: "proxy" } } } },
        sandboxNetworkAttempt: { host: "narrow.example", port: 80 },
      });
      await startSession(app);
      await startAgent(app);
      await expect(
        app.tools
          .get("request_permissions")!
          .execute(shape, { permissions: { network } }, undefined, undefined, app.context),
      ).rejects.toMatchObject({ code: "policy-denied" });
      expect(app.reviewInputs).toHaveLength(0);
      expect(app.sandboxManager.execute).not.toHaveBeenCalled();
      const expectNoGrants = async () => {
        await app.commands.get("permissions")!.handler("status", app.context);
        const view = JSON.parse(
          String(app.notify.mock.calls.at(-1)?.[0]).split("\n").slice(1).join("\n"),
        );
        expect(view.authority.turn).toMatchObject({ networkAll: false, networkHosts: [] });
        expect(view.authority.actionGrants).toEqual([]);
        expect(view.nextAttemptNetwork.required).toEqual({ kind: "restricted" });
      };
      await expectNoGrants();
      await expect(executeBash(app, "after-hidden-scope", "printf ok")).rejects.toMatchObject({
        code: "permission-required",
      });
      expect(app.reviewInputs).toHaveLength(0);
      expect(app.sandboxManager.execute).toHaveBeenCalledOnce();
      expect(app.sandboxManager.execute.mock.calls[0]?.[0].policy.network).toMatchObject({
        execution: { kind: "restricted" },
        allowedDomains: [],
      });
      expect(app.sandboxManager.execute.mock.calls[0]?.[0].policy.network.network_access).not.toBe(
        true,
      );
      await expectNoGrants();
    },
  );

  it("keeps request_permissions grants within the current turn", async () => {
    const firstTurnHost = "api.example.com";
    const turnHost = "one-shot.example.com";
    const app = await makeHarness({
      risk: (tool, input) => {
        if (tool === "request_permissions") {
          const permissions = input.permissions as { network?: { hosts?: string[] } };
          const host = permissions.network?.hosts?.[0];
          return promptRisk(host ? { networkHosts: [host] } : {});
        }
        if (tool === "bash") {
          return promptRisk({
            networkHosts: [String(input.command).includes("one-shot") ? turnHost : firstTurnHost],
          });
        }
        return undefined;
      },
    });
    await startSession(app);
    await startAgent(app);

    await executeRequestPermissions(app, "first-turn-permission", firstTurnHost);
    await endAgent(app);
    await startAgent(app);
    await executeBash(app, "first-turn-host-bash", `printf ${firstTurnHost}`);
    expect(app.reviewInputs).toHaveLength(2);

    await executeRequestPermissions(app, "turn-permission", turnHost);
    await executeBash(app, "turn-host-bash", `printf ${turnHost}`);
    expect(app.reviewInputs).toHaveLength(3);
    await endAgent(app);
    await startAgent(app);
    await executeBash(app, "turn-host-new-turn", `printf ${turnHost}`);
    expect(app.reviewInputs).toHaveLength(4);
  });

  it("carries /approve across turns to an exact fresh-call retry", async () => {
    const app = await makeHarness({
      risk: (tool) =>
        tool === "bash" ? promptRisk({ networkHosts: ["api.example.com"] }) : undefined,
      review: (_request, ordinal) =>
        ordinal === 1 ? denied("Needs user confirmation.") : approved(),
    });
    await startSession(app);
    await startAgent(app);

    await expect(executeBash(app, "original-call", "printf exact")).rejects.toMatchObject({
      code: "review-denied",
    });
    await endAgent(app);
    const approveCommand = app.commands.get("approve");
    if (!approveCommand) throw new Error("missing /approve command");
    await approveCommand.handler("", app.context);
    expect(app.select).toHaveBeenCalledOnce();
    expect(app.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pi-safety-auto-override" }),
      { triggerTurn: true },
    );

    await startAgent(app);
    await executeBash(app, "fresh-call", "printf exact");

    expect(app.reviewInputs).toHaveLength(2);
    expect(app.reviewInputs[1]?.toolCallId).toBe("fresh-call");
    expect(app.reviewInputs[1]?.approvalOverride).toMatchObject({
      denialId: "retry-1",
    });
    expect(app.sandboxBashExecute).toHaveBeenCalledOnce();
  });

  it("notifies and aborts once at three denials, then resets persisted Auto state", async () => {
    const app = await makeHarness({
      risk: (tool) => (tool === "bash" ? promptRisk() : undefined),
      review: () => denied("Repeatedly denied."),
    });
    await startSession(app);
    await startAgent(app);
    app.notify.mockImplementation((message: unknown) => {
      if (String(message).includes("interrupting the turn")) {
        throw new Error("notification UI unavailable");
      }
    });

    for (let index = 1; index <= 3; index += 1) {
      await expect(executeBash(app, `denial-${index}`, "printf denied")).rejects.toMatchObject({
        code: "review-denied",
      });
    }
    const interruptionNotices = app.notify.mock.calls.filter(([message]) =>
      String(message).includes("interrupting the turn"),
    );
    expect(interruptionNotices).toHaveLength(1);
    expect(app.abort).toHaveBeenCalledOnce();

    const persistedStates = app.appendEntry.mock.calls
      .filter((call) => call[0] === "pi-safety-state")
      .map((call) => call[1] as { auto: Record<string, unknown> });
    expect(persistedStates.at(-1)?.auto).toEqual({ consecutiveDenials: 3, paused: true });
    expect(persistedStates.every((state) => !Object.hasOwn(state.auto, "recentDenials"))).toBe(
      true,
    );

    await endAgent(app);
    await startAgent(app);
    const resetState = app.appendEntry.mock.calls
      .filter((call) => call[0] === "pi-safety-state")
      .map((call) => call[1] as { auto: Record<string, unknown> })
      .at(-1);
    expect(resetState?.auto).toEqual({ consecutiveDenials: 0, paused: false });
    expect(resetState?.auto).not.toHaveProperty("recentDenials");
  });

  it("fails closed when session_before_tree invalidates a pending Guardian review", async () => {
    let releaseReview: (result: AutoReviewResult) => void = () => undefined;
    const reviewGate = new Promise<AutoReviewResult>((resolveReview) => {
      releaseReview = resolveReview;
    });
    const app = await makeHarness({
      risk: (tool) =>
        tool === "bash" ? promptRisk({ networkHosts: ["api.example.com"] }) : undefined,
      review: async () => reviewGate,
    });
    await startSession(app);
    await startAgent(app);
    app.setStatus.mockClear();
    const pending = executeBash(app, "stale-call", "printf stale");
    await vi.waitFor(() => expect(app.reviewInputs).toHaveLength(1));
    expect(reviewStatusCalls(app)).toHaveLength(0);

    await invoke(app, "session_before_tree", { type: "session_before_tree" });
    releaseReview(approved());

    await expect(pending).rejects.toMatchObject({ code: "stale-invocation" });
    expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
    expect(app.sandboxBashExecute).not.toHaveBeenCalled();
    expect(app.bareBashExecute).not.toHaveBeenCalled();
    expect(reviewStatusCalls(app)).toHaveLength(0);
  });

  it("rejects a pre-aborted managed bash execute before backend execution", async () => {
    const app = await makeHarness({ risk: () => lowRisk() });
    await startSession(app);
    await startAgent(app);
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeBash(app, "aborted-bash", "printf aborted", controller.signal),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
    expect(app.sandboxBashExecute).not.toHaveBeenCalled();
    expect(app.bareBashExecute).not.toHaveBeenCalled();
    expect(app.reviewInputs).toHaveLength(0);
  });

  it("keeps the outer turn alive across nested end+settled pairs", async () => {
    const app = await makeHarness({ risk: () => lowRisk() });
    const settle = (): Promise<unknown> => invoke(app, "agent_settled", { type: "agent_settled" });
    await startSession(app);
    await startAgent(app);

    await startAgent(app);
    await endAgent(app);
    await settle();
    await executeBash(app, "nested-bash", "printf nested");
    expect(app.sandboxBashExecute).toHaveBeenCalledOnce();

    await startAgent(app);
    await endAgent(app);
    await settle();
    await executeBash(app, "sibling-bash", "printf sibling");
    expect(app.sandboxBashExecute).toHaveBeenCalledTimes(2);

    await endAgent(app);
    await settle();
    await expect(executeBash(app, "orphan-bash", "printf orphan")).rejects.toThrow(
      "The active permission context is unavailable",
    );
  });

  it("closes the turn on settled without a preceding end", async () => {
    const app = await makeHarness({ risk: () => lowRisk() });
    await startSession(app);
    await startAgent(app);
    await invoke(app, "agent_settled", { type: "agent_settled" });
    await expect(executeBash(app, "orphan-bash", "printf orphan")).rejects.toThrow(
      "The active permission context is unavailable",
    );
  });

  it("runs nested subagents on a narrowed child turn", async () => {
    const app = await makeHarness({
      config: { delegation: { writeRoots: ["sub"] } },
      risk: () => lowRisk(),
    });
    const settle = (): Promise<unknown> => invoke(app, "agent_settled", { type: "agent_settled" });
    await startSession(app);
    await startAgent(app);
    await startAgent(app);

    await executeWrite(app, "child-write-in", "sub/a.txt", "hi");
    const policies = app.sandboxManager.wrapWithSandbox.mock.calls.map(
      (call) => call[2] as { filesystem: { allowWrite: string[] } },
    );
    expect(policies.length).toBeGreaterThan(0);
    for (const policy of policies) {
      expect(policy.filesystem.allowWrite).not.toContain(app.cwd);
      expect(policy.filesystem.allowWrite).not.toContain("/tmp");
    }
    expect(policies.at(-1)?.filesystem.allowWrite).toContain(resolve(app.cwd, "sub"));

    await expect(executeWrite(app, "child-write-out", "other.txt", "no")).rejects.toThrow(
      /delegation envelope/,
    );

    await endAgent(app);
    await settle();
    // The parent turn resumes with its full policy after the child closes.
    await executeWrite(app, "parent-write", "other.txt", "yes");
  });

  it.each([
    {
      label: "workspace parent to child link",
      parentRoot: ".",
      childRoot: "link",
      requestPath: "link/escape.txt",
    },
    {
      label: "lexical link parent to child link",
      parentRoot: "link",
      childRoot: "link",
      requestPath: "link/escape.txt",
    },
    {
      label: "lexical link parent to child link subpath",
      parentRoot: "link",
      childRoot: "link/sub",
      requestPath: "link/sub/escape.txt",
    },
    {
      label: "lexical link parent to external absolute root",
      parentRoot: "link",
      childRoot: "external",
      requestPath: "escape.txt",
    },
  ])("keeps child delegation within the parent's lexical roots ($label)", async (scenario) => {
    const outside = await mkdtemp(join(tmpdir(), "pi-safety-register-outside-"));
    tempDirectories.push(outside);
    const app = await makeHarness({
      config: {
        sandbox: { filesystem: { allowWrite: [scenario.parentRoot] } },
        delegation: {
          writeRoots: [scenario.childRoot === "external" ? outside : scenario.childRoot],
        },
      },
      risk: () => lowRisk(),
    });
    await symlink(outside, join(app.cwd, "link"), "dir");

    await startSession(app);
    await startAgent(app);
    await startAgent(app);

    await expect(
      executeWrite(
        app,
        "child-symlink-escape",
        scenario.childRoot === "external"
          ? join(outside, scenario.requestPath)
          : scenario.requestPath,
        "no",
      ),
    ).rejects.toThrow(/delegation envelope/);
  });

  it("does not canonicalize a lexical parent symlink in an empty child scope", async () => {
    const app = await makeHarness({
      config: {
        sandbox: {
          filesystem: {
            allowWrite: ["link"],
            denyRead: ["read-secret"],
            denyWrite: ["write-secret"],
          },
        },
        delegation: { writeRoots: [] },
      },
      risk: () => lowRisk(),
    });
    const outside = await mkdtemp(join(tmpdir(), "pi-safety-register-outside-"));
    tempDirectories.push(outside);
    const parentLink = join(app.cwd, "link");
    await symlink(outside, parentLink, "dir");

    await startSession(app);
    await startAgent(app);
    await executeWrite(app, "lexical-parent-link", "link/parent.txt", "yes");
    const parentPolicy = app.sandboxManager.wrapWithSandbox.mock.calls.at(-1)?.[2] as SandboxPolicy;

    await startAgent(app);
    await executeWrite(app, "lexical-parent-link", "link/child.txt", "yes");

    const childPolicy = app.sandboxManager.wrapWithSandbox.mock.calls.at(-1)?.[2] as SandboxPolicy;
    expect(childPolicy.filesystem.allowWrite).toContain(parentLink);
    expect(childPolicy.filesystem.allowWrite).not.toContain(outside);
    expect(childPolicy.filesystem.denyRead).toEqual(parentPolicy.filesystem.denyRead);
    expect(childPolicy.filesystem.denyWrite).toEqual(parentPolicy.filesystem.denyWrite);
  });

  it("fails closed through nested sentinel scopes and restores the parent", async () => {
    const app = await makeHarness({
      config: { delegation: { writeRoots: ["**/not-concrete"] } },
      risk: () => lowRisk(),
    });
    const settle = (): Promise<unknown> => invoke(app, "agent_settled", { type: "agent_settled" });
    await startSession(app);
    await startAgent(app);
    await startAgent(app);

    await expect(executeWrite(app, "failed-child-write", "child.txt", "no")).rejects.toThrow(
      "The active permission context is unavailable",
    );

    await startAgent(app);
    await expect(
      executeWrite(app, "failed-grandchild-write", "grandchild.txt", "no"),
    ).rejects.toThrow("The active permission context is unavailable");

    await endAgent(app);
    await settle();
    await expect(
      executeWrite(app, "still-failed-child-write", "child-again.txt", "no"),
    ).rejects.toThrow("The active permission context is unavailable");

    await endAgent(app);
    await settle();
    await executeWrite(app, "restored-parent-write", "parent.txt", "yes");
  });

  it("keeps a successful child Engine when a grandchild enters a sentinel", async () => {
    const app = await makeHarness({
      config: { delegation: { writeRoots: ["dynamic"] } },
      risk: () => lowRisk(),
    });
    const dynamicRoot = join(app.cwd, "dynamic");
    await mkdir(dynamicRoot);
    const settle = (): Promise<unknown> => invoke(app, "agent_settled", { type: "agent_settled" });

    await startSession(app);
    await startAgent(app);
    await startAgent(app);
    await executeWrite(app, "successful-child-before-failure", "dynamic/child.txt", "yes");

    await rm(dynamicRoot, { recursive: true, force: true });
    await symlink(dynamicRoot, dynamicRoot, "dir");
    await startAgent(app);

    // Restore the child path so the successful child can continue after its
    // failed grandchild is closed.
    await rm(dynamicRoot, { recursive: true, force: true });
    await mkdir(dynamicRoot);
    await endAgent(app);
    await settle();
    await executeWrite(app, "successful-child-after-failure", "dynamic/child-again.txt", "yes");

    await endAgent(app);
    await settle();
    await executeWrite(app, "restored-outer-after-failure", "outer.txt", "yes");
  });

  it("does not install a rejected child sentinel after reset", async () => {
    const app = await makeHarness({
      config: { delegation: { writeRoots: ["loop"] } },
      risk: () => lowRisk(),
    });
    const loop = join(app.cwd, "loop");
    await symlink(loop, loop, "dir");

    await startSession(app);
    await startAgent(app);
    const pendingChild = startAgent(app);
    await invoke(app, "session_before_tree", { type: "session_before_tree" });
    await startAgent(app);
    await pendingChild;

    await executeWrite(app, "new-turn-after-rejected-child", "new-turn.txt", "yes");
  });

  it("does not install a child resolved before a session reset into the next turn", async () => {
    const app = await makeHarness({ risk: () => lowRisk() });
    await startSession(app);
    await startAgent(app);

    const pendingChild = startAgent(app);
    await invoke(app, "session_before_tree", { type: "session_before_tree" });
    await startAgent(app);
    await pendingChild;

    await executeWrite(app, "new-turn-write", "new-turn.txt", "yes");
    const policy = app.sandboxManager.wrapWithSandbox.mock.calls.at(-1)?.[2] as SandboxPolicy;
    expect(policy.filesystem.allowWrite).toContain(app.cwd);
  });

  it("blocks command escalation inside an active delegation envelope", async () => {
    const app = await makeHarness({
      config: { delegation: { writeRoots: ["sub"] } },
      risk: (tool, input) =>
        tool === "bash" && input.sandbox_permissions === "require_escalated"
          ? promptRisk({
              reason: "Command requires escalated sandbox permissions",
              executionMode: "escalated",
              justification: "Run a controlled command",
            })
          : lowRisk(),
    });
    await startSession(app);
    await startAgent(app);
    await startAgent(app);

    await expect(
      executeBashWithParams(app, "nested-escalated", {
        command: "printf no",
        sandbox_permissions: "require_escalated",
        justification: "Run a controlled command",
      }),
    ).rejects.toMatchObject({ code: "enforcement-unavailable" });
    expect(app.reviewInputs).toHaveLength(0);
    expect(app.bareBashExecute).not.toHaveBeenCalled();
    expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
  });

  it("gates subagent spawns on re-delegation and depth", async () => {
    const app = await makeHarness({
      config: { delegation: { allowReDelegate: false } },
      risk: () => lowRisk(),
    });
    await startSession(app);
    await startAgent(app);
    await expect(executeHostCall(app, "subagent", "spawn-outer")).resolves.toBeUndefined();

    await startAgent(app);
    const nested = await executeHostCall(app, "subagent", "spawn-nested");
    expect(nested).toMatchObject({ block: true });
    expect((nested as { reason?: string }).reason).toContain("Re-delegation is disabled");

    await endAgent(app);
    await invoke(app, "agent_settled", { type: "agent_settled" });

    // The closed child is historical audit only; a sibling may delegate.
    await expect(executeHostCall(app, "subagent", "spawn-sibling")).resolves.toBeUndefined();
  });

  it("refuses subagent spawns when delegation maxDepth is 0", async () => {
    const app = await makeHarness({
      config: { delegation: { maxDepth: 0 } },
      risk: () => lowRisk(),
    });
    await startSession(app);
    await startAgent(app);
    const blocked = await executeHostCall(app, "subagent", "spawn-blocked");
    expect(blocked).toMatchObject({ block: true });
    expect((blocked as { reason?: string }).reason).toContain("depth limit");
  });

  it("blocks admission-declared bash capabilities outside the envelope", async () => {
    const app = await makeHarness({
      config: { delegation: { writeRoots: ["sub"], networkHosts: [] } },
      risk: (tool) =>
        tool === "bash" ? promptRisk({ networkHosts: ["outside.example"] }) : lowRisk(),
    });
    await startSession(app);
    await startAgent(app);
    await startAgent(app);

    // Blocked before Guardian review: no lease expansion past the ceiling.
    await expect(
      executeBash(app, "child-bash-net", "curl https://outside.example"),
    ).rejects.toThrow(/delegation envelope/);
    expect(app.reviewInputs).toHaveLength(0);

    await endAgent(app);
    await invoke(app, "agent_settled", { type: "agent_settled" });
  });

  it("blocks host-first tools by rules deny inside a nested child turn", async () => {
    const app = await makeHarness({
      config: {
        rules: [{ action: "deny", tool: "read", pattern: "*/Library/*" }],
        delegation: { networkHosts: [] },
      },
      risk: () => promptRisk(),
    });
    await startSession(app);
    await startAgent(app);
    await startAgent(app);

    const blocked = await invoke(app, "tool_call", {
      type: "tool_call",
      toolName: "read",
      toolCallId: "child-read-deny",
      input: { path: "/Users/example/Library/Secrets" },
    });
    expect(blocked).toMatchObject({ block: true });
    expect((blocked as { reason?: string }).reason).toContain("Denied by permissions rule");
    expect(app.reviewInputs).toHaveLength(0);
    expect(app.riskEvaluator).not.toHaveBeenCalled();

    // Foreign tools remain pass-through even under an active delegation envelope.
    await expect(executeHostCall(app, "WebFetch", "child-fetch")).resolves.toBeUndefined();

    await endAgent(app);
    await invoke(app, "agent_settled", { type: "agent_settled" });
  });

  it("narrows envelopes across a two-level delegation chain", async () => {
    const app = await makeHarness({
      config: { delegation: { writeRoots: ["sub"] } },
      risk: () => lowRisk(),
    });
    const settle = (): Promise<unknown> => invoke(app, "agent_settled", { type: "agent_settled" });
    await startSession(app);
    await startAgent(app);
    await startAgent(app);
    await startAgent(app);

    await executeWrite(app, "l2-write-in", "sub/deep.txt", "hi");
    await expect(executeWrite(app, "l2-write-out", "other.txt", "no")).rejects.toThrow(
      /delegation envelope/,
    );

    await endAgent(app);
    await settle();
    await endAgent(app);
    await settle();
    // Back at the outer level the full policy applies again.
    await executeWrite(app, "outer-write", "other.txt", "yes");
    await endAgent(app);
    await settle();
  });

  it("keeps turn accounting exact through nesting saturation", async () => {
    const app = await makeHarness({ risk: () => lowRisk() });
    const settle = (): Promise<unknown> => invoke(app, "agent_settled", { type: "agent_settled" });
    await startSession(app);
    await startAgent(app);
    for (let i = 0; i < 40; i += 1) {
      await startAgent(app);
    }

    // Saturated levels share the parent turn instead of dying: still alive.
    await executeBash(app, "saturated-bash", "printf saturated");
    expect(app.sandboxBashExecute).toHaveBeenCalled();

    for (let i = 0; i < 40; i += 1) {
      await endAgent(app);
      await settle();
    }
    // Balanced unwind closes exactly once: no leak keeps the turn alive.
    await expect(executeBash(app, "orphan-bash", "printf orphan")).rejects.toThrow(
      "The active permission context is unavailable",
    );
  });
});
