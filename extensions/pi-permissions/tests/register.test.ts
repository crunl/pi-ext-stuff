import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AutoReviewRequest, AutoReviewResult } from "../src/auto-review-request.ts";
import { type AutoReviewer, AutoReviewerFailure } from "../src/auto-reviewer.ts";
import { NetworkBoundary } from "../src/network-boundary.ts";
import { registerExtension } from "../src/register.ts";
import type { RiskDecision } from "../src/risk-policy.ts";
import type {
  SandboxDenialCapability,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxPolicy,
} from "../src/sandbox.ts";

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
    wrapWithSandbox: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
    classifyDenial: ReturnType<typeof vi.fn>;
    readFailureDiagnostics: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  };
  bashToolFactory: ReturnType<typeof vi.fn>;
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
  const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-register-agent-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-register-workspace-"));
  tempDirectories.push(agentDir, cwd);
  const configDirectory = join(agentDir, "extensions", "pi-permissions");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    join(agentDir, "keybindings.json"),
    JSON.stringify({ "app.thinking.cycle": "ctrl+shift+t" }),
  );
  if (options.config) {
    await writeFile(join(configDirectory, "config.json"), JSON.stringify(options.config));
  }

  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const commands = new Map<string, { handler: (...args: unknown[]) => unknown }>();
  const shortcuts = new Map<string, { handler: (...args: unknown[]) => unknown }>();
  const tools = new Map<
    string,
    {
      label?: string;
      description?: string;
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
    wrapWithSandbox,
    execute,
    classifyDenial,
    reset,
    readFailureDiagnostics: vi.fn(async () => options.sandboxDiagnostics),
  };

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
  const autoReviewer: AutoReviewer = { invalidateSession, review };

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
    if (options.eventBusError && eventName === "pi-permissions:review") {
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
    modelRegistry: {},
    model: undefined,
    scopedModels: [],
    signal: undefined,
    abort,
    hasPendingMessages: () => false,
    ui,
  };

  registerExtension(pi as never, {
    agentDir,
    sandboxManager: sandboxManager as never,
    bashToolFactory: options.useRealBashTool ? undefined : (bashToolFactory as never),
    sandboxCoordinator: sandboxCoordinator as never,
    autoReviewer,
    riskEvaluator: riskEvaluator as never,
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

describe("Permission mode registration", () => {
  it("registers Auto status and initializes the sandbox on session_start", async () => {
    const app = await makeHarness();

    await startSession(app);

    expect(app.setStatus).toHaveBeenLastCalledWith("pi-permissions", "Approve for me");
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

    await executeHostCall(app, "WebFetch", "host-context-file");

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

  it("reviews Bash network access at the exact boundary without replaying the command", async () => {
    const host = "api.example.com";
    const app = await makeHarness({
      risk: () => lowRisk(),
      sandboxNetworkAttempt: { host, port: 443 },
    });
    await startSession(app);
    await startAgent(app);
    app.setStatus.mockClear();

    await executeBash(app, "runtime-network", "curl https://api.example.com/data");

    expect(app.riskEvaluator).toHaveBeenCalledOnce();
    expect(app.reviewInputs).toHaveLength(1);
    expect(app.reviewInputs[0]?.permissionContext.requestedNetworkTargets).toEqual([
      { host, port: 443 },
    ]);
    expect(app.sandboxManager.execute).toHaveBeenCalledOnce();
    expect(reviewStatusCalls(app)).toHaveLength(0);
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

  it("sends a private DNS answer through normal runtime review when local binding is enabled", async () => {
    const host = "router.internal";
    const app = await makeHarness({
      config: { sandbox: { network: { allowLocalBinding: true } } },
      risk: () => lowRisk(),
      sandboxNetworkAttempt: { host, port: 80 },
      sandboxNetworkAnswers: { [host]: ["192.168.1.20"] },
    });
    await startSession(app);
    await startAgent(app);

    await expect(executeBash(app, "local-binding", `curl http://${host}/admin`)).resolves.toEqual({
      content: [],
      details: undefined,
    });
    expect(app.reviewInputs).toHaveLength(1);
    expect(app.reviewInputs[0]?.permissionContext.requestedNetworkTargets).toEqual([
      { host, port: 80 },
    ]);
    expect(app.sandboxManager.execute).toHaveBeenCalledOnce();
  });

  it("blocks an outside Bash write after the sandbox reports the exact path", async () => {
    const path = "/opt/pi-permissions-runtime-denial/result.txt";
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

  it("reviews a registered native mkdir preparation failure and re-enters Write once under SRT", async () => {
    const parent = await mkdtemp(join(tmpdir(), "native retry parent "));
    tempDirectories.push(parent);
    const path = join(parent, " file .txt ");
    const operations: string[] = [];
    const policies: SandboxPolicy[] = [];
    const app = await makeHarness({
      config: { sandbox: { filesystem: { allowWrite: ["."] } } },
      risk: () => lowRisk(),
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
    expect(app.reviewInputs).toHaveLength(1);
    expect(app.reviewInputs[0]?.permissionContext.filesystemWriteRoots).toContain(parent);
    expect(JSON.stringify(app.reviewInputs[0])).toMatch(/subtree/);
    expect(JSON.stringify(app.reviewInputs[0])).toMatch(/partial directory effects/);
    expect(JSON.stringify(app.reviewInputs[0])).toContain("retry once");
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
        risk: () => lowRisk(),
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
      expect(app.reviewInputs).toHaveLength(0);
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
    await expect(executeBash(app, "log-only-bash", "printf original")).rejects.toThrow(
      /EPERM original Bash failure[\s\S]*SRT diagnostic/,
    );
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
    const outsideDirectory = "/opt/pi-permissions-register-outside";
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

  it("reviews a generic host tool without claiming sandbox enforcement", async () => {
    const app = await makeHarness({ risk: () => promptRisk() });
    await startSession(app);
    await startAgent(app);

    await expect(executeHostCall(app, "WebFetch", "host-approve")).resolves.toBeUndefined();

    expect(app.reviewInputs).toHaveLength(1);
    expect(app.reviewInputs[0]?.permissionContext.sandboxEnforcesAction).toBe(false);
    expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
  });

  it("lets a default-allowed host tool bypass Guardian", async () => {
    const app = await makeHarness({ risk: () => lowRisk() });
    await startSession(app);
    await startAgent(app);

    await expect(
      executeHostCall(app, "mcp__github__get_issue", "host-default"),
    ).resolves.toBeUndefined();

    expect(app.reviewInputs).toHaveLength(0);
    expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
  });

  it("reviews an explicitly asked host tool even when the main sandbox is disabled", async () => {
    const app = await makeHarness({
      config: { sandbox: { enabled: false } },
      risk: () => promptRisk(),
    });
    await startSession(app);
    await startAgent(app);

    await expect(
      executeHostCall(app, "WebFetch", "host-disabled-sandbox"),
    ).resolves.toBeUndefined();

    expect(app.reviewInputs).toHaveLength(1);
    expect(app.reviewInputs[0]?.permissionContext.sandboxEnforcesAction).toBe(false);
    expect(app.reviewInputs[0]?.permissionContext.filesystemDenyRead).toEqual([]);
    expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
  });

  it("adds no-workaround guidance for a generic denial and never reviews a hard block", async () => {
    const app = await makeHarness({
      risk: (tool) => (tool === "HardTool" ? blockRisk("Hard policy") : promptRisk()),
      review: () => denied("Not authorized."),
    });
    await startSession(app);
    await startAgent(app);

    const deniedCall = await executeHostCall(app, "WebFetch", "host-deny");
    expect(deniedCall).toMatchObject({ block: true });
    expect((deniedCall as { reason?: string }).reason).toContain(
      "must not attempt to achieve the same outcome through a workaround",
    );

    const reviewCount = app.reviewInputs.length;
    const hardCall = await executeHostCall(app, "HardTool", "host-hard");
    expect(hardCall).toMatchObject({ block: true });
    expect(app.reviewInputs).toHaveLength(reviewCount);
  });

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
      expect.objectContaining({ customType: "pi-permissions-auto-override" }),
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
      .filter((call) => call[0] === "pi-permissions-state")
      .map((call) => call[1] as { auto: Record<string, unknown> });
    expect(persistedStates.at(-1)?.auto).toEqual({ consecutiveDenials: 3, paused: true });
    expect(persistedStates.every((state) => !Object.hasOwn(state.auto, "recentDenials"))).toBe(
      true,
    );

    await endAgent(app);
    await startAgent(app);
    const resetState = app.appendEntry.mock.calls
      .filter((call) => call[0] === "pi-permissions-state")
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
    const outside = await mkdtemp(join(tmpdir(), "pi-permissions-register-outside-"));
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
    const outside = await mkdtemp(join(tmpdir(), "pi-permissions-register-outside-"));
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

  it("blocks declared host-tool capabilities outside the envelope", async () => {
    const app = await makeHarness({
      config: { delegation: { networkHosts: [] } },
      risk: (tool) =>
        tool === "WebFetch" ? promptRisk({ networkHosts: ["outside.example"] }) : lowRisk(),
    });
    await startSession(app);
    await startAgent(app);
    await startAgent(app);

    const blocked = await executeHostCall(app, "WebFetch", "child-fetch");
    expect(blocked).toMatchObject({ block: true });
    expect((blocked as { reason?: string }).reason).toContain("delegation envelope");
    expect(app.reviewInputs).toHaveLength(0);

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
