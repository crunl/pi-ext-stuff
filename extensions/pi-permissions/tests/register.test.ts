import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AutoReviewRequest, AutoReviewResult } from "../src/auto-review-request.ts";
import { type AutoReviewer, AutoReviewerFailure } from "../src/auto-reviewer.ts";
import { registerExtension } from "../src/register.ts";
import type { RiskDecision } from "../src/risk-policy.ts";
import type {
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
  sandboxInitializeError?: Error;
  sandboxExecuteError?: Error;
  sandboxResetErrorAfter?: number;
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
  autoReviewer: AutoReviewer;
  sandboxManager: {
    initialize: ReturnType<typeof vi.fn>;
    wrapWithSandbox: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  };
  sandboxCoordinator: {
    runShared: ReturnType<typeof vi.fn>;
    runExclusive: ReturnType<typeof vi.fn>;
  };
  bareBashExecute: ReturnType<typeof vi.fn>;
  sandboxBashExecute: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  markToolCall: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
}

const tempDirectories: string[] = [];
const REVIEW_STATUS_KEY = "pi-permissions-review";
const REVIEW_ICON = "\u{F105E}";

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
  const execute = vi.fn(
    async (request: SandboxExecutionRequest): Promise<SandboxExecutionResult> => {
      if (options.sandboxExecuteError) throw options.sandboxExecuteError;
      await wrapWithSandbox(
        [request.program.executable, ...request.program.args].map(shellQuote).join(" "),
        undefined,
        request.policy as SandboxPolicy,
        request.signal,
      );
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    },
  );
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
  const sandboxManager = { initialize, wrapWithSandbox, execute, reset };

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
        await factoryOptions.operations.exec(params.command, toolCwd, {
          onData: () => undefined,
          signal,
          timeout: params.timeout,
        });
        return { content: [], details: undefined };
      }
      return bareBashExecute(id, params, signal, onUpdate);
    },
  }));

  const reviewInputs: AutoReviewRequest[] = [];
  let reviewOrdinal = 0;
  const review = vi.fn(async (request: AutoReviewRequest) => {
    reviewInputs.push(request);
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
  const markToolCall = vi.fn();
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
    markToolCall,
    select,
    confirm: vi.fn(async () => true),
    input: vi.fn(async () => undefined),
  };
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
    bashToolFactory: bashToolFactory as never,
    sandboxCoordinator: sandboxCoordinator as never,
    autoReviewer,
    riskEvaluator: riskEvaluator as never,
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
    autoReviewer,
    sandboxManager,
    sandboxCoordinator,
    bareBashExecute,
    sandboxBashExecute,
    setStatus,
    notify,
    markToolCall,
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

async function executeWrite(app: Harness, id: string, path: string, content: string) {
  const write = app.tools.get("write");
  if (!write) throw new Error("missing write tool");
  return write.execute(id, { path, content }, undefined, undefined, app.context);
}

async function executeRequestPermissions(
  app: Harness,
  id: string,
  host: string,
  scope: "turn" | "session",
) {
  const requestPermissions = app.tools.get("request_permissions");
  if (!requestPermissions) throw new Error("missing request_permissions tool");
  return requestPermissions.execute(
    id,
    {
      reason: `Allow ${host}`,
      permissions: { network: { hosts: [host] } },
      scope,
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
    expect(app.reviewInputs[0]?.permissionContext.requestedNetworkHosts).toEqual([host]);
    expect(app.sandboxManager.wrapWithSandbox).toHaveBeenCalledOnce();
    const policy = app.sandboxManager.wrapWithSandbox.mock.calls[0]?.[2] as {
      network: { allowedDomains: string[] };
    };
    expect(policy.network.allowedDomains).toContain(host);
    expect(app.setStatus.mock.calls.filter(([key]) => key === REVIEW_STATUS_KEY)).toHaveLength(0);
    expect(app.notify).not.toHaveBeenCalled();
    expect(app.markToolCall).toHaveBeenCalledOnce();
    expect(app.markToolCall).toHaveBeenCalledWith("prompt-bash", {
      icon: REVIEW_ICON,
      color: "warning",
    });
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
      undefined,
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
    expect(app.setStatus.mock.calls.filter(([key]) => key === REVIEW_STATUS_KEY)).toHaveLength(0);
    expect(app.notify).toHaveBeenCalledWith(`${REVIEW_ICON} Permission denied`, "warning");
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

    expect(app.setStatus.mock.calls.filter(([key]) => key === REVIEW_STATUS_KEY)).toHaveLength(0);
    expect(app.notify).toHaveBeenCalledTimes(1);
    expect(app.notify).toHaveBeenCalledWith(`${REVIEW_ICON} ${label}`, "warning");
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
    expect(app.setStatus.mock.calls.filter(([key]) => key === REVIEW_STATUS_KEY)).toHaveLength(0);

    controller.abort();
    releaseReview(approved());

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(app.setStatus.mock.calls.filter(([key]) => key === REVIEW_STATUS_KEY)).toHaveLength(0);
    expect(app.notify).not.toHaveBeenCalled();
    expect(app.markToolCall).toHaveBeenCalledWith("aborted-review", {
      icon: REVIEW_ICON,
      color: "warning",
    });
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

    expect(app.setStatus.mock.calls.filter(([key]) => key === REVIEW_STATUS_KEY)).toHaveLength(0);
    expect(app.notify).not.toHaveBeenCalled();
    expect(app.markToolCall).not.toHaveBeenCalled();
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

    expect(app.setStatus.mock.calls.filter(([key]) => key === REVIEW_STATUS_KEY)).toHaveLength(0);
    expect(app.notify).not.toHaveBeenCalled();
    expect(app.markToolCall).toHaveBeenCalledWith("event-bus-error", {
      icon: REVIEW_ICON,
      color: "warning",
    });
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
    const outsideDirectory = await mkdtemp(join(tmpdir(), "pi-permissions-register-outside-"));
    tempDirectories.push(outsideDirectory);
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

  it("aborts an active YOLO turn when cycling down to Auto", async () => {
    const app = await makeHarness({ risk: () => lowRisk() });
    await startSession(app);
    const shortcut = app.shortcuts.get("shift+tab");
    if (!shortcut) throw new Error("missing shift+tab shortcut");
    await shortcut.handler(app.context);
    await startAgent(app);

    await executeBash(app, "active-yolo", "printf yolo");
    expect(app.bareBashExecute).toHaveBeenCalledOnce();

    await shortcut.handler(app.context);
    expect(app.abort).toHaveBeenCalledOnce();

    await endAgent(app);
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

  it("records a session permission across turns and clears a turn permission at agent_end", async () => {
    const sessionHost = "api.example.com";
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
            networkHosts: [String(input.command).includes("one-shot") ? turnHost : sessionHost],
          });
        }
        return undefined;
      },
    });
    await startSession(app);
    await startAgent(app);

    await executeRequestPermissions(app, "session-permission", sessionHost, "session");
    await endAgent(app);
    await startAgent(app);
    await executeBash(app, "session-host-bash", `printf ${sessionHost}`);
    expect(app.reviewInputs).toHaveLength(1);

    await executeRequestPermissions(app, "turn-permission", turnHost, "turn");
    await executeBash(app, "turn-host-bash", `printf ${turnHost}`);
    expect(app.reviewInputs).toHaveLength(2);
    await endAgent(app);
    await startAgent(app);
    await executeBash(app, "turn-host-new-turn", `printf ${turnHost}`);
    expect(app.reviewInputs).toHaveLength(3);
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
    const pending = executeBash(app, "stale-call", "printf stale");
    await vi.waitFor(() => expect(app.reviewInputs).toHaveLength(1));
    expect(app.setStatus.mock.calls.filter(([key]) => key === REVIEW_STATUS_KEY)).toHaveLength(0);

    await invoke(app, "session_before_tree", { type: "session_before_tree" });
    releaseReview(approved());

    await expect(pending).rejects.toMatchObject({ code: "stale-invocation" });
    expect(app.sandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
    expect(app.sandboxBashExecute).not.toHaveBeenCalled();
    expect(app.bareBashExecute).not.toHaveBeenCalled();
    expect(app.setStatus.mock.calls.filter(([key]) => key === REVIEW_STATUS_KEY)).toHaveLength(0);
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
});
