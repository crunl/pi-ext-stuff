import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type {
  BashOperations,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createWriteTool,
  getLanguageFromPath,
} from "@earendil-works/pi-coding-agent";
import {
  colorizeEditDiffSummary,
  compactBashStatusSpacing,
  createCodexToolRendering,
  createEditDiffBox,
  summarizeEditDiff,
} from "../../pi-core/index.ts";
import { AutoApprovalLedger } from "./auto-approval-ledger.ts";
import { reviewAutoPrompt } from "./auto-policy.ts";
import {
  AUTO_REVIEW_DENIED_ACTION_APPROVAL_DEVELOPER_PREFIX,
  buildAutoReviewRequest,
} from "./auto-review-request.ts";
import {
  type AutoReviewer,
  type AutoReviewerFailureKind,
  type GuardianReviewIdentity,
  PiAutoReviewer,
} from "./auto-reviewer.ts";
import {
  fingerprintConfig,
  fingerprintValue,
  type LoadedPermissionsConfig,
  loadPermissionsConfig,
  type PermissionsConfig,
} from "./config.ts";
import { hasCoreExecutionAbortGate } from "./core-capability.ts";
import { type DefaultDecision, evaluateDefaultRequest } from "./default-mode.ts";
import { defaultProtectedWritePaths } from "./filesystem-policy.ts";
import { type HostFilteringProxy, startHostFilteringProxy } from "./filtering-proxy.ts";
import type { GuardianReviewSessionManager } from "./guardian-session.ts";
import { PermissionModeRuntime } from "./mode-runtime.ts";
import {
  createSandboxedBashOperations,
  createSandboxedFileOperations,
  createSandboxRuntimeConfig,
  detectLocalProxyPorts,
  type LocalProxyPorts,
  type SandboxManagerLike,
  withAdditionalWriteRoots,
  withAllowedDomains,
  withLocalProxy,
} from "./sandbox.ts";
import { SandboxExecutionCoordinator } from "./sandbox-coordinator.ts";
import { permissionedBashParameters } from "./shell-permissions.ts";
import { shiftTabAvailability } from "./shortcut-config.ts";
import type { PermissionMode } from "./state.ts";

export interface RegisterExtensionOptions {
  agentDir?: string;
  sandboxManager?: SandboxManagerLike;
  bashToolFactory?: typeof createBashTool;
  localProxyPorts?: LocalProxyPorts;
  filteringProxyFactory?: (
    approvedHosts: readonly string[],
    upstream: LocalProxyPorts,
    deniedHosts?: readonly string[],
  ) => Promise<HostFilteringProxy>;
  sandboxCoordinator?: Pick<SandboxExecutionCoordinator, "runShared" | "runExclusive">;
  autoReviewer?: AutoReviewer;
  guardianSessionManager?: GuardianReviewSessionManager;
  riskEvaluator?: typeof evaluateDefaultRequest;
  coreExecutionAbortGateAvailable?: () => boolean;
}

interface ApprovedCall {
  authority: "user" | "auto-review";
  mode: "default" | "auto" | "user-transition";
  configFingerprint: string;
  cwd: string;
  requestFingerprint: string;
}

type ExecutablePermissionMode = Exclude<PermissionMode, "plan">;

type PermissionTurnPhase = "idle" | "active" | "between";

interface PermissionExecutionSnapshot {
  turnId: number;
  mode: ExecutablePermissionMode;
  config: PermissionsConfig;
  baseSandboxConfig?: SandboxRuntimeConfig;
  sandboxReady: boolean;
}

interface EffectiveExecutionContext {
  snapshot: PermissionExecutionSnapshot;
  mode: ExecutablePermissionMode;
  config: PermissionsConfig;
  baseSandboxConfig?: SandboxRuntimeConfig;
  sandboxReady: boolean;
}

interface PendingModeTransition {
  id: number;
  turnId: number;
  phase: "active";
}

interface ModeTransitionBarrier {
  id: number;
  completion: Promise<boolean>;
  settle(readyForNextTurn: boolean): void;
}

class ActivationSupersededError extends Error {
  constructor() {
    super("pi-permissions: permission activation was superseded by a newer session");
    this.name = "ActivationSupersededError";
  }
}

function isActivationSupersededError(error: unknown): error is ActivationSupersededError {
  return error instanceof ActivationSupersededError;
}

const DEFAULT_ALLOW_ONCE_CHOICE = "Allow Once";
const DEFAULT_ALLOW_AND_AUTO_CHOICE = "Allow, switch future approvals to Auto";
const DEFAULT_DENY_CHOICE = "Deny";
const PERMISSION_MODE_CHANGED_REASON = "permission mode changed";
const guardianFallbackNoticeKeys = new Set<string>();

function executableMode(mode: PermissionMode): ExecutablePermissionMode {
  return mode === "plan" ? "default" : mode;
}

function requiresSandbox(mode: ExecutablePermissionMode, config: PermissionsConfig): boolean {
  return mode !== "yolo" && config.sandbox.enabled;
}

function nextExecutableMode(mode: ExecutablePermissionMode): ExecutablePermissionMode {
  if (mode === "default") return "auto";
  if (mode === "auto") return "yolo";
  return "default";
}

function countWrittenLines(content: string): number {
  if (content.length === 0) return 0;
  const normalized = content.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").length;
  return normalized.endsWith("\n") ? lines - 1 : lines;
}

export function registerExtension(pi: ExtensionAPI, options: RegisterExtensionOptions = {}): void {
  const agentDir = options.agentDir ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const sandboxManager = options.sandboxManager ?? SandboxManager;
  const bashToolFactory = options.bashToolFactory ?? createBashTool;
  const baseBash = bashToolFactory(process.cwd());
  const baseWrite = createWriteTool(process.cwd());
  const baseEdit = createEditTool(process.cwd());
  const localProxyPorts = options.localProxyPorts ?? detectLocalProxyPorts();
  const filteringProxyFactory = options.filteringProxyFactory ?? startHostFilteringProxy;
  const sandboxCoordinator = options.sandboxCoordinator ?? new SandboxExecutionCoordinator();
  const riskEvaluator = options.riskEvaluator ?? evaluateDefaultRequest;
  const coreExecutionAbortGateAvailable =
    options.coreExecutionAbortGateAvailable ?? hasCoreExecutionAbortGate;
  const autoReviewer =
    options.autoReviewer ?? new PiAutoReviewer(undefined, options.guardianSessionManager);
  let loaded: LoadedPermissionsConfig | undefined;
  let loadedKey: string | undefined;
  let configFailure: Error | undefined;
  let activationFailure: { key: string; error: Error } | undefined;
  let modeRuntime: PermissionModeRuntime | undefined;
  let shortcutWarningShown = false;
  const trustedUserMessages: string[] = [];
  const autoApprovalLedger = new AutoApprovalLedger();
  const reviewControllers = new Map<string, AbortController>();
  let modeMutationTail: Promise<void> = Promise.resolve();
  let modeMutationGeneration = 0;
  let lastGuardianSelection:
    | {
        guardian: GuardianReviewIdentity;
        cwd: string;
        configFingerprint: string;
      }
    | undefined;
  const approvedCalls = new Map<string, ApprovedCall>();
  const approvedNetworkHosts = new Map<string, string[]>();
  const approvedWriteRoots = new Map<string, string[]>();
  let permissionContextEpoch = 0;
  let permissionTurnPhase: PermissionTurnPhase = "idle";
  let permissionTurnId = 0;
  let activeTurnId: number | undefined;
  let lifecycleEventsObserved = false;
  let activeExecutionSnapshot: PermissionExecutionSnapshot | undefined;
  let pendingModeTransition: PendingModeTransition | undefined;
  let modeTransitionId = 0;
  let modeTransitionBarrierId = 0;
  let inFlightModeTransition: ModeTransitionBarrier | undefined;
  let baseSandboxConfig: SandboxRuntimeConfig | undefined;
  let sandboxState:
    | { kind: "pending" }
    | { kind: "disabled" }
    | { kind: "ready"; profile: LoadedPermissionsConfig["config"]["sandbox"]["profile"] }
    | { kind: "failed"; error: string } = { kind: "pending" };

  const revokeApprovedCall = (toolCallId: string | undefined): void => {
    if (!toolCallId) return;
    approvedCalls.delete(toolCallId);
    approvedNetworkHosts.delete(toolCallId);
    approvedWriteRoots.delete(toolCallId);
  };

  const setDefaultStatus = (ctx: Pick<ExtensionContext, "ui">): void => {
    ctx.ui.setStatus("pi-permissions", modeRuntime?.statusLabel ?? "Default");
  };

  const runModeMutation = <T>(
    operation: (generation: number) => Promise<T>,
  ): Promise<T | undefined> => {
    const generation = modeMutationGeneration;
    const execute = async (): Promise<T | undefined> => {
      if (generation !== modeMutationGeneration) return undefined;
      return operation(generation);
    };
    const result = modeMutationTail.then(execute, execute);
    modeMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const invalidatePermissionContext = (
    reason: string,
    { preserveAutoDenials = false }: { preserveAutoDenials?: boolean } = {},
  ): void => {
    permissionContextEpoch += 1;
    for (const controller of reviewControllers.values()) {
      controller.abort(new Error(reason));
    }
    reviewControllers.clear();
    modeRuntime?.cancelReviews();
    approvedCalls.clear();
    approvedNetworkHosts.clear();
    approvedWriteRoots.clear();
    if (preserveAutoDenials) {
      autoApprovalLedger.clearPendingOverride();
    } else {
      autoApprovalLedger.clear();
    }
    autoReviewer.invalidateSession();
  };

  const resetBranchPermissionContext = (reason: string): void => {
    modeMutationGeneration += 1;
    cancelInFlightModeTransition();
    trustedUserMessages.length = 0;
    permissionTurnPhase = "idle";
    activeTurnId = undefined;
    activeExecutionSnapshot = undefined;
    pendingModeTransition = undefined;
    invalidatePermissionContext(reason);
  };

  const oneCallWriteRoots = (event: ToolCallEvent, cwd: string): string[] => {
    const tool = event.toolName.toLowerCase();
    if (tool !== "write" && tool !== "edit") return [];
    const input = event.input as Record<string, unknown>;
    if (typeof input.path !== "string") return [];
    const path = isAbsolute(input.path) ? resolve(input.path) : resolve(cwd, input.path);
    return [path, dirname(path)];
  };

  const ensureModeRuntime = (config: PermissionsConfig): PermissionModeRuntime => {
    modeRuntime ??= new PermissionModeRuntime(config, pi.appendEntry.bind(pi));
    return modeRuntime;
  };

  const captureExecutionSnapshot = (turnId: number): PermissionExecutionSnapshot | undefined => {
    if (activeExecutionSnapshot) return activeExecutionSnapshot;
    if (!loaded || !modeRuntime) return undefined;
    activeExecutionSnapshot = {
      turnId,
      mode: executableMode(modeRuntime.mode),
      config: loaded.config,
      baseSandboxConfig,
      sandboxReady: sandboxState.kind === "ready",
    };
    return activeExecutionSnapshot;
  };

  const currentExecutionSnapshot = (): PermissionExecutionSnapshot | undefined =>
    permissionTurnPhase === "active" &&
    activeTurnId !== undefined &&
    activeExecutionSnapshot?.turnId === activeTurnId
      ? activeExecutionSnapshot
      : undefined;

  const ensureExecutionSnapshot = (
    _ctx: Pick<ExtensionContext, "isIdle">,
  ): PermissionExecutionSnapshot | undefined => {
    const current = currentExecutionSnapshot();
    if (current) return current;
    if (inFlightModeTransition) return undefined;
    if (permissionTurnPhase === "between" || lifecycleEventsObserved) return undefined;

    // Direct tool-hook invocations without lifecycle events are themselves proof of active work.
    permissionTurnId += 1;
    activeTurnId = permissionTurnId;
    permissionTurnPhase = "active";
    return captureExecutionSnapshot(activeTurnId);
  };

  const isCurrentExecutionSnapshot = (snapshot: PermissionExecutionSnapshot): boolean =>
    currentExecutionSnapshot() === snapshot;

  const getEffectiveExecutionContext = (
    snapshot: PermissionExecutionSnapshot,
  ): EffectiveExecutionContext | undefined => {
    if (!isCurrentExecutionSnapshot(snapshot)) return undefined;
    if (!loaded || fingerprintConfig(loaded.config) !== fingerprintConfig(snapshot.config)) {
      return undefined;
    }
    return {
      snapshot,
      mode: snapshot.mode,
      config: snapshot.config,
      baseSandboxConfig: snapshot.baseSandboxConfig,
      sandboxReady: snapshot.sandboxReady,
    };
  };

  const scheduleModeTransition = (): PendingModeTransition | undefined => {
    if (permissionTurnPhase !== "active" || activeTurnId === undefined) return undefined;
    if (pendingModeTransition) {
      // Keep the first token as the owner for this turn. The lifecycle boundary
      // that owns it is the only path that may clear it.
      return pendingModeTransition;
    }
    pendingModeTransition = { id: ++modeTransitionId, turnId: activeTurnId, phase: "active" };
    return pendingModeTransition;
  };

  const clearPendingModeTransition = (turnId: number): void => {
    if (pendingModeTransition?.turnId === turnId) pendingModeTransition = undefined;
  };

  const isPendingModeTransitionCurrent = (transition: PendingModeTransition): boolean =>
    pendingModeTransition?.id === transition.id &&
    permissionTurnPhase === transition.phase &&
    activeTurnId === transition.turnId;

  const clearPendingModeTransitionIfCurrent = (transition: PendingModeTransition): void => {
    if (pendingModeTransition?.id === transition.id) pendingModeTransition = undefined;
  };

  const createModeTransitionBarrier = (): ModeTransitionBarrier => {
    let resolveCompletion!: (readyForNextTurn: boolean) => void;
    let settled = false;
    const barrier: ModeTransitionBarrier = {
      id: ++modeTransitionBarrierId,
      completion: new Promise<boolean>((resolvePromise) => {
        resolveCompletion = resolvePromise;
      }),
      settle(readyForNextTurn) {
        if (settled) return;
        settled = true;
        resolveCompletion(readyForNextTurn);
      },
    };
    inFlightModeTransition = barrier;
    return barrier;
  };

  const settleModeTransitionBarrier = (
    barrier: ModeTransitionBarrier,
    readyForNextTurn: boolean,
  ): void => {
    barrier.settle(readyForNextTurn);
    if (readyForNextTurn && inFlightModeTransition?.id === barrier.id) {
      inFlightModeTransition = undefined;
    }
  };

  const cancelInFlightModeTransition = (): void => {
    const barrier = inFlightModeTransition;
    if (!barrier) return;
    barrier.settle(false);
    if (inFlightModeTransition?.id === barrier.id) {
      inFlightModeTransition = undefined;
    }
  };

  const finishPermissionTurn = (reason: string): void => {
    if (permissionTurnPhase !== "active") return;
    const closingTurnId = activeTurnId;
    activeExecutionSnapshot = undefined;
    activeTurnId = undefined;
    permissionTurnPhase = "between";
    if (closingTurnId !== undefined) clearPendingModeTransition(closingTurnId);
    invalidatePermissionContext(reason, { preserveAutoDenials: true });
  };

  const grantApprovedCall = (
    event: ToolCallEvent,
    decision: Extract<DefaultDecision, { action: "prompt" }>,
    executionContext: EffectiveExecutionContext,
    cwd: string,
    authority: "user" | "auto-review",
    mode: ApprovedCall["mode"],
  ): void => {
    if (!event.toolCallId) return;
    approvedCalls.set(event.toolCallId, {
      authority,
      mode,
      configFingerprint: fingerprintConfig(executionContext.config),
      cwd: resolve(cwd),
      requestFingerprint: fingerprintValue({
        tool: event.toolName.toLowerCase(),
        input: event.input,
      }),
    });
    if (decision.networkHosts?.length) {
      approvedNetworkHosts.set(event.toolCallId, [...decision.networkHosts]);
    }
    const writeRoots = [
      ...new Set([...oneCallWriteRoots(event, cwd), ...(decision.filesystemWriteRoots ?? [])]),
    ];
    if (writeRoots.length > 0) {
      approvedWriteRoots.set(event.toolCallId, writeRoots);
    }
  };

  const configKey = (ctx: Pick<ExtensionContext, "cwd">): string => ctx.cwd;
  const isActivationCurrent = (expectedGeneration: number): boolean =>
    expectedGeneration === modeMutationGeneration;
  const assertActivationCurrent = (expectedGeneration: number): void => {
    if (!isActivationCurrent(expectedGeneration)) throw new ActivationSupersededError();
  };
  const assertYoloCapability = (mode: ExecutablePermissionMode): void => {
    if (mode === "yolo" && !coreExecutionAbortGateAvailable()) {
      throw new Error(
        "pi-permissions: YOLO requires the patched core execution abort gate; run npm run core:install",
      );
    }
  };

  const activateConfigUnlocked = async (
    ctx: Pick<ExtensionContext, "cwd" | "ui" | "hasUI">,
    force = false,
    targetMode?: ExecutablePermissionMode,
    candidateOverride?: LoadedPermissionsConfig,
    expectedGeneration = modeMutationGeneration,
  ): Promise<LoadedPermissionsConfig> => {
    // The exclusive coordinator can delay this work until after a session/tree reset.
    // Check before every cache shortcut so an old tool call cannot borrow the new
    // session's cached policy and synthesize a compatibility snapshot.
    assertActivationCurrent(expectedGeneration);
    const key = configKey(ctx);
    if (!force && configFailure) throw configFailure;
    const cachedMode = targetMode ?? (modeRuntime ? executableMode(modeRuntime.mode) : undefined);
    if (!force && loaded && loadedKey === key) {
      const effectiveCachedMode = cachedMode ?? executableMode(loaded.config.defaultMode);
      assertYoloCapability(effectiveCachedMode);
      if (!requiresSandbox(effectiveCachedMode, loaded.config) || sandboxState.kind === "ready") {
        return loaded;
      }
    }
    if (!force && activationFailure?.key === key && cachedMode !== "yolo") {
      throw activationFailure.error;
    }

    let candidate: LoadedPermissionsConfig;
    try {
      candidate = candidateOverride ?? (await loadPermissionsConfig(agentDir));
    } catch (error: unknown) {
      assertActivationCurrent(expectedGeneration);
      configFailure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
    // A session/tree reset can supersede the activation while its candidate config
    // is loading. Do not let that obsolete activation reset or initialize the
    // shared sandbox runtime for the new generation.
    assertActivationCurrent(expectedGeneration);
    const effectiveMode = cachedMode ?? executableMode(candidate.config.defaultMode);
    assertYoloCapability(effectiveMode);
    const previous = {
      loaded,
      loadedKey,
      baseSandboxConfig,
      sandboxState,
    };
    const candidateSandbox = candidate.config.sandbox.enabled
      ? createSandboxRuntimeConfig(
          candidate.config.sandbox,
          ctx.cwd,
          defaultProtectedWritePaths(ctx.cwd, agentDir),
        )
      : undefined;

    if (!requiresSandbox(effectiveMode, candidate.config)) {
      assertActivationCurrent(expectedGeneration);
      configFailure = undefined;
      activationFailure = undefined;
      if (force) invalidatePermissionContext("permission context changed");
      loaded = candidate;
      loadedKey = key;
      baseSandboxConfig = candidateSandbox;
      sandboxState = { kind: "disabled" };
      setDefaultStatus(ctx);
      return candidate;
    }

    try {
      await sandboxManager.reset();
      // reset() yields control to lifecycle handlers. A reset/session transition
      // that wins during that await must not let this old activation bring up a
      // sandbox for its obsolete configuration.
      assertActivationCurrent(expectedGeneration);
      if (candidateSandbox) await sandboxManager.initialize(candidateSandbox);
    } catch (error: unknown) {
      assertActivationCurrent(expectedGeneration);
      try {
        await sandboxManager.reset();
        assertActivationCurrent(expectedGeneration);
        if (previous.sandboxState.kind === "ready" && previous.baseSandboxConfig) {
          await sandboxManager.initialize(previous.baseSandboxConfig);
          assertActivationCurrent(expectedGeneration);
          sandboxState = previous.sandboxState;
        } else if (previous.sandboxState.kind === "disabled") {
          sandboxState = previous.sandboxState;
        } else {
          const message = error instanceof Error ? error.message : String(error);
          sandboxState = { kind: "failed", error: message };
        }
      } catch (rollbackError: unknown) {
        assertActivationCurrent(expectedGeneration);
        const message =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        sandboxState = { kind: "failed", error: `rollback failed: ${message}` };
      }
      assertActivationCurrent(expectedGeneration);
      loaded = previous.loaded;
      loadedKey = previous.loadedKey;
      baseSandboxConfig = previous.baseSandboxConfig;
      if (!previous.loaded) {
        const message = error instanceof Error ? error.message : String(error);
        activationFailure = {
          key,
          error: new Error(`pi-permissions sandbox unavailable: ${message}`),
        };
      }
      throw error;
    }

    assertActivationCurrent(expectedGeneration);
    activationFailure = undefined;
    configFailure = undefined;
    if (force) {
      invalidatePermissionContext("permission context changed");
    }
    loaded = candidate;
    loadedKey = key;
    baseSandboxConfig = candidateSandbox;
    sandboxState = candidateSandbox
      ? { kind: "ready", profile: candidate.config.sandbox.profile }
      : { kind: "disabled" };
    setDefaultStatus(ctx);
    return candidate;
  };

  const activateConfig = (
    ctx: Pick<ExtensionContext, "cwd" | "ui" | "hasUI">,
    force = false,
    targetMode?: ExecutablePermissionMode,
    candidateOverride?: LoadedPermissionsConfig,
    expectedGeneration = modeMutationGeneration,
  ): Promise<LoadedPermissionsConfig> =>
    targetMode === "yolo"
      ? activateConfigUnlocked(ctx, force, targetMode, candidateOverride, expectedGeneration)
      : sandboxCoordinator.runExclusive(() =>
          activateConfigUnlocked(ctx, force, targetMode, candidateOverride, expectedGeneration),
        );

  const assertExecutionAuthorized = async (
    tool: string,
    id: string,
    input: Record<string, unknown>,
    ctx: Pick<ExtensionContext, "cwd">,
    executionContext: EffectiveExecutionContext,
  ): Promise<void> => {
    if (!getEffectiveExecutionContext(executionContext.snapshot)) {
      throw new Error("pi-permissions: call is no longer authorized; request approval again");
    }
    const activeConfig = executionContext.config;
    const activeMode = executionContext.mode;
    const executionEpoch = permissionContextEpoch;
    const approval = approvedCalls.get(id);
    approvedCalls.delete(id);
    const approved =
      approval !== undefined &&
      approval.cwd === resolve(ctx.cwd) &&
      approval.configFingerprint === fingerprintConfig(activeConfig) &&
      (approval.mode === "user-transition" || approval.mode === activeMode) &&
      approval.requestFingerprint ===
        fingerprintValue({
          tool: tool.toLowerCase(),
          input,
        });
    const currentDecision = await evaluateDefaultRequest(
      tool,
      input,
      ctx.cwd,
      activeConfig,
      defaultProtectedWritePaths(ctx.cwd, agentDir),
    );
    if (
      permissionContextEpoch !== executionEpoch ||
      !getEffectiveExecutionContext(executionContext.snapshot)
    ) {
      throw new Error("pi-permissions: call is no longer authorized; request approval again");
    }
    if (currentDecision.action === "block" || (currentDecision.action === "prompt" && !approved)) {
      throw new Error("pi-permissions: call is no longer authorized; request approval again");
    }
  };

  const sandboxOperations = (
    customConfig?: SandboxRuntimeConfig,
    executionContext?: EffectiveExecutionContext,
  ): BashOperations => {
    if (!executionContext?.sandboxReady) {
      const reason = sandboxState.kind === "failed" ? sandboxState.error : "sandbox is unavailable";
      throw new Error(`pi-permissions sandbox unavailable: ${reason}`);
    }
    return createSandboxedBashOperations(sandboxManager, customConfig);
  };

  const sandboxFileOperations = (
    writeRoots: readonly string[],
    signal?: AbortSignal,
    executionContext?: EffectiveExecutionContext,
  ) => {
    if (!executionContext?.sandboxReady || !executionContext.baseSandboxConfig) {
      const reason = sandboxState.kind === "failed" ? sandboxState.error : "sandbox is unavailable";
      throw new Error(`pi-permissions sandbox unavailable: ${reason}`);
    }
    return createSandboxedFileOperations(
      sandboxManager,
      executionContext.baseSandboxConfig,
      writeRoots,
      signal,
    );
  };

  pi.registerTool({
    ...baseBash,
    ...createCodexToolRendering({
      icon: "",
      runningVerb: "Running",
      completedVerb: "Ran",
      argument: (args) => (typeof args.command === "string" ? args.command : ""),
      collapsed: "preview",
      transformOutput: compactBashStatusSpacing,
    }),
    label: "bash (sandboxed)",
    description: `${baseBash.description} To write outside the active sandbox, request sandbox_permissions="with_additional_permissions", list the minimum additional_permissions.file_system.write roots, and provide justification.`,
    promptGuidelines: [
      "When a command must write outside the workspace, request only the minimum additional filesystem write roots and explain why.",
    ],
    parameters: permissionedBashParameters,
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate, ctx) {
      const activationGeneration = modeMutationGeneration;
      await activateConfig(ctx, false, undefined, undefined, activationGeneration);
      assertActivationCurrent(activationGeneration);
      const executionSnapshot = ensureExecutionSnapshot(ctx);
      if (!executionSnapshot) {
        throw new Error("pi-permissions: active permission turn snapshot is unavailable");
      }
      const executionContext = getEffectiveExecutionContext(executionSnapshot);
      if (!executionContext) {
        throw new Error("pi-permissions: call is no longer authorized; request approval again");
      }
      if (executionContext.mode === "yolo") {
        revokeApprovedCall(id);
        return bashToolFactory(ctx.cwd).execute(id, params, signal, onUpdate);
      }
      const needsExclusiveLease = (approvedNetworkHosts.get(id)?.length ?? 0) > 0;

      const executeWithSnapshot = async (allowNetworkEscalation: boolean) => {
        const networkHosts = approvedNetworkHosts.get(id) ?? [];
        approvedNetworkHosts.delete(id);
        const writeRoots = approvedWriteRoots.get(id) ?? [];
        approvedWriteRoots.delete(id);
        await assertExecutionAuthorized(
          "bash",
          id,
          params as Record<string, unknown>,
          ctx,
          executionContext,
        );

        if (!executionContext.config.sandbox.enabled) {
          return bashToolFactory(ctx.cwd).execute(id, params, signal, onUpdate);
        }
        const baseConfig = executionContext.baseSandboxConfig;
        if (!executionContext.sandboxReady || !baseConfig) {
          const reason =
            sandboxState.kind === "failed" ? sandboxState.error : "sandbox is unavailable";
          throw new Error(`pi-permissions sandbox unavailable: ${reason}`);
        }

        let commandConfig =
          writeRoots.length > 0 ? withAdditionalWriteRoots(baseConfig, writeRoots) : baseConfig;
        let filteringProxy: HostFilteringProxy | undefined;
        try {
          if (networkHosts.length > 0) {
            if (!allowNetworkEscalation) {
              throw new Error(
                "pi-permissions network escalation requires an exclusive sandbox lease",
              );
            }
            const allowedDomains = [
              ...new Set([...baseConfig.network.allowedDomains, ...networkHosts]),
            ];
            const hasLocalProxy = Boolean(localProxyPorts.http || localProxyPorts.socks);
            if (hasLocalProxy) {
              filteringProxy = await filteringProxyFactory(
                allowedDomains,
                localProxyPorts,
                baseConfig.network.deniedDomains,
              );
            }
            commandConfig = filteringProxy
              ? withLocalProxy(commandConfig, filteringProxy.ports, allowedDomains)
              : withAllowedDomains(commandConfig, allowedDomains);
            await sandboxManager.reset();
            await sandboxManager.initialize(commandConfig);
          }

          const sandboxedBash = bashToolFactory(ctx.cwd, {
            operations: sandboxOperations(commandConfig, executionContext),
          });
          return await sandboxedBash.execute(id, params, signal, onUpdate);
        } finally {
          if (networkHosts.length > 0) {
            try {
              await sandboxManager.reset();
              await sandboxManager.initialize(baseConfig);
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              sandboxState = { kind: "failed", error: message };
              if (ctx.hasUI) {
                ctx.ui.notify(`pi-permissions sandbox 恢复失败：${message}`, "error");
              }
            } finally {
              await filteringProxy?.close();
            }
          }
        }
      };

      if (needsExclusiveLease) {
        return sandboxCoordinator.runExclusive(() => executeWithSnapshot(true), signal);
      }
      return sandboxCoordinator.runShared(() => executeWithSnapshot(false), signal);
    },
  });

  pi.registerTool({
    ...baseWrite,
    ...createCodexToolRendering({
      icon: "",
      runningVerb: "Writing",
      completedVerb: "Wrote",
      argument: (args) => (typeof args.path === "string" ? args.path : ""),
      collapsed: (_result, args) => {
        const content = typeof args.content === "string" ? args.content : "";
        const lineCount = countWrittenLines(content);
        return lineCount > 0 ? `+${lineCount}` : undefined;
      },
    }),
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate, ctx) {
      const activationGeneration = modeMutationGeneration;
      await activateConfig(ctx, false, undefined, undefined, activationGeneration);
      assertActivationCurrent(activationGeneration);
      const executionSnapshot = ensureExecutionSnapshot(ctx);
      if (!executionSnapshot) {
        throw new Error("pi-permissions: active permission turn snapshot is unavailable");
      }
      const executionContext = getEffectiveExecutionContext(executionSnapshot);
      if (!executionContext) {
        throw new Error("pi-permissions: call is no longer authorized; request approval again");
      }
      if (executionContext.mode === "yolo") {
        revokeApprovedCall(id);
        return createWriteTool(ctx.cwd).execute(id, params, signal, onUpdate);
      }
      return sandboxCoordinator.runShared(async () => {
        const writeRoots = approvedWriteRoots.get(id) ?? [];
        approvedWriteRoots.delete(id);
        await assertExecutionAuthorized(
          "write",
          id,
          params as Record<string, unknown>,
          ctx,
          executionContext,
        );
        if (!executionContext.config.sandbox.enabled) {
          return createWriteTool(ctx.cwd).execute(id, params, signal, onUpdate);
        }
        const tool = createWriteTool(ctx.cwd, {
          operations: sandboxFileOperations(writeRoots, signal, executionContext),
        });
        return tool.execute(id, params, signal, onUpdate);
      }, signal);
    },
  });

  pi.registerTool({
    ...baseEdit,
    ...createCodexToolRendering({
      icon: "",
      runningVerb: "Editing",
      completedVerb: "Edited",
      argument: (args) => (typeof args.path === "string" ? args.path : ""),
      collapsed: summarizeEditDiff,
      formatSummary: colorizeEditDiffSummary,
      renderExpandedResult: (result, args, theme, outputPad) => {
        const details = result.details as { diff?: unknown } | undefined;
        return createEditDiffBox(typeof details?.diff === "string" ? details.diff : "", theme, {
          outputPad,
          lang: typeof args.path === "string" ? getLanguageFromPath(args.path) : undefined,
        });
      },
    }),
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate, ctx) {
      const activationGeneration = modeMutationGeneration;
      await activateConfig(ctx, false, undefined, undefined, activationGeneration);
      assertActivationCurrent(activationGeneration);
      const executionSnapshot = ensureExecutionSnapshot(ctx);
      if (!executionSnapshot) {
        throw new Error("pi-permissions: active permission turn snapshot is unavailable");
      }
      const executionContext = getEffectiveExecutionContext(executionSnapshot);
      if (!executionContext) {
        throw new Error("pi-permissions: call is no longer authorized; request approval again");
      }
      if (executionContext.mode === "yolo") {
        revokeApprovedCall(id);
        return createEditTool(ctx.cwd).execute(id, params, signal, onUpdate);
      }
      return sandboxCoordinator.runShared(async () => {
        const writeRoots = approvedWriteRoots.get(id) ?? [];
        approvedWriteRoots.delete(id);
        await assertExecutionAuthorized(
          "edit",
          id,
          params as Record<string, unknown>,
          ctx,
          executionContext,
        );
        if (!executionContext.config.sandbox.enabled) {
          return createEditTool(ctx.cwd).execute(id, params, signal, onUpdate);
        }
        const tool = createEditTool(ctx.cwd, {
          operations: sandboxFileOperations(writeRoots, signal, executionContext),
        });
        return tool.execute(id, params, signal, onUpdate);
      }, signal);
    },
  });

  const reportConfigError = (ctx: ExtensionContext, error: unknown): ToolCallEventResult => {
    const message = error instanceof Error ? error.message : String(error);
    setDefaultStatus(ctx);
    if (ctx.hasUI) ctx.ui.notify(`pi-permissions 配置错误：${message}`, "error");
    return { block: true, reason: `pi-permissions configuration error: ${message}` };
  };

  const requestHumanApproval = async (
    event: ToolCallEvent,
    decision: Extract<DefaultDecision, { action: "prompt" }>,
    executionContext: EffectiveExecutionContext,
    ctx: ExtensionContext,
    options: {
      guardianFailure?: AutoReviewerFailureKind;
    } = {},
  ): Promise<ToolCallEventResult | undefined> => {
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `pi-permissions: ${decision.risk} operation requires interactive approval`,
      };
    }
    const runtime = ensureModeRuntime(executionContext.config);
    const humanApprovalToken = runtime.beginHumanApproval();
    if (humanApprovalToken === undefined) {
      return {
        block: true,
        reason: "pi-permissions: another approval is already active",
      };
    }
    const approvalEpoch = permissionContextEpoch;
    let transitionGrantCreated = false;

    try {
      const guardianFailure =
        options.guardianFailure === undefined
          ? ""
          : `Guardian review failed (${options.guardianFailure}); manual approval is required.\n\n`;
      const prompt = `${guardianFailure}pi-permissions · ${decision.risk}\n\n${event.toolName}: ${decision.summary}\n\n${decision.reason}${
        decision.networkHosts?.length
          ? `\n\nNetwork for this command: ${decision.networkHosts.join(", ")}`
          : ""
      }${
        decision.filesystemWriteRoots?.length
          ? `\n\nFilesystem for this command: ${decision.filesystemWriteRoots.join(", ")}`
          : ""
      }${decision.justification ? `\n\nJustification: ${decision.justification}` : ""}`;
      const choice = await ctx.ui.select(prompt, [
        DEFAULT_ALLOW_ONCE_CHOICE,
        DEFAULT_ALLOW_AND_AUTO_CHOICE,
        DEFAULT_DENY_CHOICE,
      ]);
      if (choice === DEFAULT_ALLOW_ONCE_CHOICE || choice === DEFAULT_ALLOW_AND_AUTO_CHOICE) {
        if (
          permissionContextEpoch !== approvalEpoch ||
          !getEffectiveExecutionContext(executionContext.snapshot)
        ) {
          return {
            block: true,
            reason: "pi-permissions: approval context changed before confirmation",
          };
        }
        if (choice === DEFAULT_ALLOW_AND_AUTO_CHOICE) {
          grantApprovedCall(event, decision, executionContext, ctx.cwd, "user", "user-transition");
          transitionGrantCreated = true;
          runtime.activate("auto", {
            preserveAutoTransientState: permissionTurnPhase === "active",
          });
          scheduleModeTransition();
          setDefaultStatus(ctx);
          ctx.ui.notify("pi-permissions: Auto mode 已启用", "info");
          return;
        }
        const approvalMode = executionContext.mode === "auto" ? "auto" : "default";
        grantApprovedCall(event, decision, executionContext, ctx.cwd, "user", approvalMode);
        return;
      }
      return {
        block: true,
        reason: `pi-permissions: user denied ${decision.risk} operation`,
      };
    } catch (error: unknown) {
      if (transitionGrantCreated) {
        revokeApprovedCall(event.toolCallId);
        return {
          block: true,
          reason: "pi-permissions approval failed",
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        block: true,
        reason: `pi-permissions approval failed: ${message}`,
      };
    } finally {
      runtime.endHumanApproval(humanApprovalToken);
      if (!transitionGrantCreated) setDefaultStatus(ctx);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    shortcutWarningShown = false;
    resetBranchPermissionContext("session changed");
    lifecycleEventsObserved = false;
    const generation = modeMutationGeneration;
    let candidate: LoadedPermissionsConfig;
    try {
      candidate = await loadPermissionsConfig(agentDir);
    } catch (error: unknown) {
      if (generation !== modeMutationGeneration) return;
      configFailure = error instanceof Error ? error : new Error(String(error));
      reportConfigError(ctx, error);
      return;
    }
    try {
      const restoredRuntime = new PermissionModeRuntime(candidate.config, pi.appendEntry.bind(pi));
      restoredRuntime.restore(ctx.sessionManager.getBranch(), candidate.config);
      const restoredMode = executableMode(restoredRuntime.mode);
      await activateConfig(ctx, true, restoredMode, candidate, generation);
      if (generation !== modeMutationGeneration) return;
      modeRuntime = restoredRuntime;
      setDefaultStatus(ctx);
      if ((await shiftTabAvailability(agentDir)) === "reserved" && !shortcutWarningShown) {
        if (generation !== modeMutationGeneration) return;
        shortcutWarningShown = true;
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Shift+Tab 仍由 app.thinking.cycle 占用；请迁移 ~/.pi/agent/keybindings.json 后 /reload",
            "warning",
          );
        }
      }
    } catch (error: unknown) {
      if (generation !== modeMutationGeneration) return;
      reportConfigError(ctx, error);
    }
  });

  pi.on("session_before_tree", () => {
    resetBranchPermissionContext("session tree changed");
  });

  pi.on("session_tree", (_event, ctx) => {
    resetBranchPermissionContext("session tree changed");
    return runModeMutation(async (generation) => {
      if (loaded && modeRuntime && generation === modeMutationGeneration) {
        const previousMode = executableMode(modeRuntime.mode);
        const restoredRuntime = new PermissionModeRuntime(loaded.config, pi.appendEntry.bind(pi));
        restoredRuntime.restore(ctx.sessionManager.getBranch(), loaded.config);
        const restoredMode = executableMode(restoredRuntime.mode);
        try {
          await activateConfig(ctx, false, restoredMode, loaded, generation);
        } catch (error: unknown) {
          if (generation !== modeMutationGeneration) return;
          reportConfigError(ctx, error);
          return;
        }
        if (generation !== modeMutationGeneration) return;
        modeRuntime = restoredRuntime;
        setDefaultStatus(ctx);
        if (previousMode === "yolo" && restoredMode !== "yolo" && !ctx.isIdle()) ctx.abort();
      }
    });
  });

  pi.on("session_shutdown", async () => {
    modeMutationGeneration += 1;
    cancelInFlightModeTransition();
    permissionTurnPhase = "idle";
    activeTurnId = undefined;
    activeExecutionSnapshot = undefined;
    pendingModeTransition = undefined;
    invalidatePermissionContext("session shutdown");
    await sandboxCoordinator.runExclusive(async () => {
      sandboxState = { kind: "pending" };
      await sandboxManager.reset();
    });
  });

  pi.on("input", (event) => {
    if ((event.source === "interactive" || event.source === "rpc") && event.text.length > 0) {
      trustedUserMessages.push(event.text);
    }
  });

  pi.on("agent_start", async () => {
    lifecycleEventsObserved = true;
    if (permissionTurnPhase === "active") return;
    permissionTurnId += 1;
    const startingTurnId = permissionTurnId;
    activeTurnId = startingTurnId;
    permissionTurnPhase = "active";
    const transition = inFlightModeTransition;
    if (transition) {
      const readyForNextTurn = await transition.completion;
      if (inFlightModeTransition?.id === transition.id) inFlightModeTransition = undefined;
      if (
        !readyForNextTurn ||
        permissionTurnPhase !== "active" ||
        activeTurnId !== startingTurnId
      ) {
        return;
      }
    }
    modeRuntime?.beginAgentTurn();
    captureExecutionSnapshot(startingTurnId);
  });

  pi.on("agent_end", () => {
    lifecycleEventsObserved = true;
    finishPermissionTurn("permission turn ended");
  });

  pi.on("agent_settled", () => {
    lifecycleEventsObserved = true;
    finishPermissionTurn("permission turn settled");
    if (permissionTurnPhase === "between") permissionTurnPhase = "idle";
  });

  pi.on(
    "tool_call",
    async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
      if (event.toolCallId) {
        approvedCalls.delete(event.toolCallId);
        approvedNetworkHosts.delete(event.toolCallId);
        approvedWriteRoots.delete(event.toolCallId);
      }
      let result: LoadedPermissionsConfig;
      const activationGeneration = modeMutationGeneration;
      try {
        result = await activateConfig(ctx, false, undefined, undefined, activationGeneration);
        assertActivationCurrent(activationGeneration);
      } catch (error: unknown) {
        if (isActivationSupersededError(error)) {
          return {
            block: true,
            reason:
              "pi-permissions: permission activation was superseded; retry in the active session",
          };
        }
        return reportConfigError(ctx, error);
      }

      const runtime = ensureModeRuntime(result.config);
      const executionSnapshot = ensureExecutionSnapshot(ctx);
      if (!executionSnapshot) {
        return {
          block: true,
          reason: "pi-permissions: active permission turn snapshot is unavailable",
        };
      }
      const executionContext = getEffectiveExecutionContext(executionSnapshot);
      if (!executionContext) {
        return {
          block: true,
          reason: "pi-permissions: active permission turn snapshot is unavailable",
        };
      }
      if (executionContext.mode === "yolo") return;

      const evaluationEpoch = permissionContextEpoch;
      let decision: DefaultDecision;
      try {
        decision = await riskEvaluator(
          event.toolName,
          event.input as Record<string, unknown>,
          ctx.cwd,
          executionContext.config,
          defaultProtectedWritePaths(ctx.cwd, agentDir),
        );
      } catch (error: unknown) {
        if (
          permissionContextEpoch !== evaluationEpoch ||
          !getEffectiveExecutionContext(executionContext.snapshot)
        ) {
          return {
            block: true,
            reason: "pi-permissions: permission context changed during risk evaluation",
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { block: true, reason: `pi-permissions failed closed: ${message}` };
      }

      if (
        permissionContextEpoch !== evaluationEpoch ||
        !getEffectiveExecutionContext(executionContext.snapshot)
      ) {
        return {
          block: true,
          reason: "pi-permissions: permission context changed during risk evaluation",
        };
      }
      if (decision.action === "allow") return;
      if (decision.action === "block") {
        return { block: true, reason: `pi-permissions: ${decision.reason}` };
      }
      const effectiveMode = executionContext.mode === "auto" ? "auto" : "default";
      if (effectiveMode === "auto" && runtime.autoState.paused) {
        return {
          block: true,
          reason:
            "pi-permissions: Auto review paused after repeated denials; start a new turn or use Shift+Tab to re-enter Auto",
        };
      }
      if (effectiveMode === "auto") {
        const id = event.toolCallId;
        if (!id) {
          return {
            block: true,
            reason: "pi-permissions: Auto review requires a tool-call ID",
          };
        }
        if (!runtime.beginReview(id)) {
          return { block: true, reason: "pi-permissions: duplicate Auto review" };
        }
        const reviewController = new AbortController();
        reviewControllers.set(id, reviewController);
        const reviewSignal = ctx.signal
          ? AbortSignal.any([ctx.signal, reviewController.signal])
          : reviewController.signal;
        try {
          const actionFingerprint = fingerprintValue({
            tool: event.toolName.toLowerCase(),
            input: event.input,
          });
          const configFingerprint = fingerprintConfig(executionContext.config);
          const approvalOverride = autoApprovalLedger.takeOverride({
            actionFingerprint,
            cwd: resolve(ctx.cwd),
            configFingerprint,
          });
          const request = buildAutoReviewRequest(
            event,
            decision,
            ctx.cwd,
            executionContext.config.sandbox.profile,
            trustedUserMessages,
            approvalOverride,
          );
          const auto = await reviewAutoPrompt(
            autoReviewer,
            request,
            {
              modelRegistry: ctx.modelRegistry,
              activeModel: ctx.model,
              reviewer: executionContext.config.reviewer,
              guardianSession: {
                cwd: resolve(ctx.cwd),
                configFingerprint,
              },
            },
            runtime.autoState,
            reviewSignal,
          );
          if (reviewSignal.aborted) {
            return {
              block: true,
              reason: "pi-permissions: permission context changed during Auto review",
            };
          }
          if (!getEffectiveExecutionContext(executionContext.snapshot)) {
            return {
              block: true,
              reason: "pi-permissions: permission context changed during Auto review",
            };
          }
          const guardian = auto.action === "error" ? auto.error.guardian : auto.review.guardian;
          if (guardian) {
            lastGuardianSelection = {
              guardian,
              cwd: resolve(ctx.cwd),
              configFingerprint,
            };
          }
          if (
            guardian?.source === "active-fallback" &&
            guardian.fallbackNotice === "configured-reviewer-unavailable" &&
            ctx.hasUI
          ) {
            const preferred = executionContext.config.reviewer;
            const noticeKey = fingerprintValue({
              configFingerprint,
              preferredProvider: preferred?.provider,
              preferredModel: preferred?.model,
              activeProvider: guardian.provider,
              activeModel: guardian.model,
            });
            if (!guardianFallbackNoticeKeys.has(noticeKey)) {
              guardianFallbackNoticeKeys.add(noticeKey);
              ctx.ui.notify("Guardian preferred model unavailable; using active model", "warning");
            }
          }
          if (auto.action === "approve") {
            runtime.recordAutoReview("approve");
            grantApprovedCall(
              event,
              decision,
              executionContext,
              ctx.cwd,
              "auto-review",
              effectiveMode,
            );
            return;
          }
          if (auto.action === "deny") {
            const autoState = runtime.recordAutoReview("deny");
            autoApprovalLedger.recordDenial({
              tool: event.toolName,
              input: event.input as Record<string, unknown>,
              cwd: resolve(ctx.cwd),
              configFingerprint,
              actionFingerprint,
              summary: decision.summary,
              rationale: auto.review.rationale,
            });
            if (autoState.paused) {
              if (ctx.hasUI) {
                ctx.ui.notify(
                  "Auto-review interrupted this turn after repeated denials",
                  "warning",
                );
              }
              ctx.abort();
            }
            return {
              block: true,
              reason: `pi-permissions Auto denied: ${auto.review.rationale} Do not retry through a workaround or policy circumvention. Take a materially safer approach; otherwise stop and ask the user.`,
            };
          }
          runtime.recordAutoNonDenial();
          if (ctx.hasUI) {
            return requestHumanApproval(event, decision, executionContext, ctx, {
              guardianFailure: auto.error.kind,
            });
          }
          return {
            block: true,
            reason: "pi-permissions Auto review failed closed; interactive approval is required",
          };
        } catch {
          if (reviewSignal.aborted) {
            return {
              block: true,
              reason: "pi-permissions: permission context changed during Auto review",
            };
          }
          runtime.recordAutoNonDenial();
          return {
            block: true,
            reason: "pi-permissions Auto review failed closed; the action was not run",
          };
        } finally {
          if (reviewControllers.get(id) === reviewController) {
            reviewControllers.delete(id);
            runtime.endReview(id);
          }
        }
      }
      return requestHumanApproval(event, decision, executionContext, ctx);
    },
  );

  pi.registerCommand("approve", {
    description: "Approve one exact retry of a recent Auto-review denial",
    handler: async (_args, ctx) => {
      let result: LoadedPermissionsConfig;
      const activationGeneration = modeMutationGeneration;
      try {
        result = await activateConfig(ctx, false, undefined, undefined, activationGeneration);
        assertActivationCurrent(activationGeneration);
      } catch (error: unknown) {
        if (isActivationSupersededError(error)) return;
        reportConfigError(ctx, error);
        return;
      }
      const runtime = ensureModeRuntime(result.config);
      if (runtime.mode !== "auto") {
        ctx.ui.notify("/approve is available only while Auto mode is active", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/approve requires an interactive UI", "warning");
        return;
      }
      const denials = autoApprovalLedger.listDenials().reverse();
      if (denials.length === 0) {
        ctx.ui.notify("No recent Auto-review denials", "info");
        return;
      }
      const choices = denials.map((denial, index) => {
        const summary = denial.summary.replace(/\s+/g, " ").trim().slice(0, 120);
        const rationale = denial.rationale.replace(/\s+/g, " ").trim().slice(0, 160);
        return `${index + 1}. ${denial.tool}: ${summary} — ${rationale}`;
      });
      const choice = await ctx.ui.select("Auto-review Denials", choices);
      if (choice === undefined) return;
      const selectedIndex = choices.indexOf(choice);
      if (selectedIndex < 0) return;
      const denial = denials[selectedIndex];
      if (!denial) return;
      const selected = autoApprovalLedger.approveDenial(denial.id);
      if (!selected) {
        ctx.ui.notify("That Auto-review denial is no longer available", "warning");
        return;
      }
      pi.sendMessage(
        {
          customType: "pi-permissions-auto-override",
          content: [
            AUTO_REVIEW_DENIED_ACTION_APPROVAL_DEVELOPER_PREFIX,
            `Tool: ${selected.tool}`,
            `Input: ${JSON.stringify(selected.input)}`,
            `Working directory: ${selected.cwd}`,
            `Previous denial: ${selected.rationale}`,
            "Retry this exact action once. Do not broaden or alter it; the retry still requires Auto-review.",
          ].join("\n"),
          display: true,
          details: {
            denialId: selected.id,
            actionFingerprint: selected.actionFingerprint,
          },
        },
        { triggerTurn: true },
      );
    },
  });

  const cyclePermissionMode = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.isIdle()) ensureExecutionSnapshot(ctx);
    const beganDuringActiveTurn = permissionTurnPhase === "active";
    // Register the barrier synchronously with the shortcut invocation. A queued
    // agent_start must observe it even if agent_end runs before this mutation's
    // first asynchronous continuation.
    const transitionBarrier = createModeTransitionBarrier();
    const pendingBeforeTransition = pendingModeTransition;
    const transition = beganDuringActiveTurn ? scheduleModeTransition() : undefined;
    const transitionOwnsPendingState =
      transition !== undefined && transition !== pendingBeforeTransition;

    try {
      await runModeMutation(async (generation) => {
        try {
          if ((await shiftTabAvailability(agentDir)) !== "available") {
            ctx.ui.notify(
              "Shift+Tab 仍由 app.thinking.cycle 占用；请迁移 ~/.pi/agent/keybindings.json 后 /reload",
              "warning",
            );
            settleModeTransitionBarrier(transitionBarrier, true);
            return;
          }
          if (!transition) {
            // Between turns and while idle there is no snapshot to preserve. Revoke any
            // approval context before the async activation work begins.
            invalidatePermissionContext(PERMISSION_MODE_CHANGED_REASON);
          }
          let runtime = modeRuntime;
          if (!runtime) {
            const initial = await activateConfig(ctx, false, undefined, undefined, generation);
            if (generation !== modeMutationGeneration) {
              settleModeTransitionBarrier(transitionBarrier, false);
              return;
            }
            runtime = ensureModeRuntime(initial.config);
          }
          const previousMode = executableMode(runtime.mode);
          const targetMode = nextExecutableMode(previousMode);
          const result = await activateConfig(
            ctx,
            !beganDuringActiveTurn,
            targetMode,
            undefined,
            generation,
          );
          if (generation !== modeMutationGeneration) {
            if (transition && transitionOwnsPendingState) {
              clearPendingModeTransitionIfCurrent(transition);
            }
            settleModeTransitionBarrier(transitionBarrier, false);
            return;
          }
          runtime = ensureModeRuntime(result.config);
          runtime.activate(targetMode, {
            preserveAutoTransientState: beganDuringActiveTurn,
          });
          if (
            transition &&
            transitionOwnsPendingState &&
            !isPendingModeTransitionCurrent(transition)
          ) {
            // agent_end/agent_settled (or a superseding lifecycle reset) already cleaned
            // the old turn. Do not restore its invalidation token or snapshot.
            clearPendingModeTransitionIfCurrent(transition);
          }
          setDefaultStatus(ctx);
          ctx.ui.notify(`pi-permissions: ${runtime.statusLabel} mode 已启用`, "info");
          settleModeTransitionBarrier(transitionBarrier, true);
        } catch (error: unknown) {
          if (transition && transitionOwnsPendingState) {
            clearPendingModeTransitionIfCurrent(transition);
          }
          settleModeTransitionBarrier(transitionBarrier, false);
          if (generation !== modeMutationGeneration) return;
          const message = error instanceof Error ? error.message : String(error);
          setDefaultStatus(ctx);
          ctx.ui.notify(`pi-permissions mode 切换失败：${message}`, "error");
        }
      });
    } finally {
      // runModeMutation can discard a stale generation before invoking the operation.
      settleModeTransitionBarrier(transitionBarrier, false);
    }
  };

  pi.registerShortcut("shift+tab", {
    description: "Cycle pi-permissions mode",
    handler: cyclePermissionMode,
  });

  pi.registerCommand("permissions", {
    description: "Show the active pi-permissions policy",
    handler: async (_args, ctx) =>
      runModeMutation(async (generation) => {
        let candidateLoaded = false;
        try {
          const previousMode = modeRuntime ? executableMode(modeRuntime.mode) : undefined;
          const candidate = await loadPermissionsConfig(agentDir);
          candidateLoaded = true;
          const candidateFingerprint = fingerprintConfig(candidate.config);
          const restoredRuntime =
            !modeRuntime || modeRuntime.snapshot().configFingerprint !== candidateFingerprint
              ? new PermissionModeRuntime(candidate.config, pi.appendEntry.bind(pi))
              : undefined;
          restoredRuntime?.restore(ctx.sessionManager.getBranch(), candidate.config);
          const targetMode = executableMode(
            (restoredRuntime ?? modeRuntime)?.mode ?? candidate.config.defaultMode,
          );
          const result = await activateConfig(ctx, true, targetMode, candidate, generation);
          if (generation !== modeMutationGeneration) return;
          if (restoredRuntime) modeRuntime = restoredRuntime;
          const config = result.config;
          const runtime = ensureModeRuntime(config);
          setDefaultStatus(ctx);
          if (previousMode === "yolo" && runtime.mode !== "yolo" && !ctx.isIdle()) ctx.abort();
          if (runtime.mode === "yolo") {
            ctx.ui.notify("YOLO · Full Access · sandbox off · approvals never", "info");
            return;
          }
          const sandboxSummary =
            sandboxState.kind === "ready"
              ? `${sandboxState.profile} sandbox on`
              : sandboxState.kind === "disabled"
                ? "sandbox off"
                : sandboxState.kind === "failed"
                  ? `sandbox error: ${sandboxState.error}`
                  : "sandbox pending";
          const configFingerprint = fingerprintConfig(config);
          const lastFallback =
            lastGuardianSelection?.guardian.source === "active-fallback" &&
            lastGuardianSelection.cwd === resolve(ctx.cwd) &&
            lastGuardianSelection.configFingerprint === configFingerprint &&
            lastGuardianSelection.guardian.provider === ctx.model?.provider &&
            lastGuardianSelection.guardian.model === ctx.model.id
              ? lastGuardianSelection.guardian
              : undefined;
          const reviewerSummary = lastFallback
            ? `${lastFallback.provider}/${lastFallback.model} (active fallback)`
            : config.reviewer
              ? `${config.reviewer.provider}/${config.reviewer.model}`
              : "current session model";
          const autoSummary =
            runtime.mode === "auto"
              ? runtime.autoState.paused
                ? "Auto paused"
                : "Auto active"
              : "manual approval";
          ctx.ui.notify(
            `${runtime.statusLabel} · reviewer ${reviewerSummary} · ${sandboxSummary} · ${autoSummary} · ${config.rules.length} rules · write roots: ${config.sandbox.filesystem.allowWrite.join(", ")}`,
            "info",
          );
        } catch (error: unknown) {
          if (generation !== modeMutationGeneration) return;
          if (!candidateLoaded) {
            configFailure = error instanceof Error ? error : new Error(String(error));
          }
          if (modeRuntime?.mode === "yolo" && !ctx.isIdle()) ctx.abort();
          const message = error instanceof Error ? error.message : String(error);
          setDefaultStatus(ctx);
          ctx.ui.notify(`pi-permissions 配置重载失败；继续使用上一份有效策略：${message}`, "error");
        }
      }),
  });
}
