import { dirname, isAbsolute, resolve } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type {
  BashOperations,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createWriteTool,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
  codexBashToolSpec,
  codexEditToolSpec,
  codexWriteToolSpec,
  createCodexToolRendering as createPiCoreCodexToolRendering,
} from "../../pi-core/standalone.ts";
import { AutoApprovalLedger } from "./auto-approval-ledger.ts";
import { reviewAutoPrompt } from "./auto-policy.ts";
import {
  AUTO_REVIEW_DENIED_ACTION_APPROVAL_DEVELOPER_PREFIX,
  buildAutoReviewRequest,
  type GuardianPermissionContext,
} from "./auto-review-request.ts";
import {
  type AutoReviewer,
  AutoReviewerFailure,
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
import { type DefaultDecision, evaluateDefaultRequest } from "./default-mode.ts";
import { GrantLedger, type Grant } from "./grant-ledger.ts";
import { type EnforcerHost, type GuardedSpec, makeGuardedExecute } from "./enforced-tool.ts";
import { PermissionSession } from "./permission-session.ts";
import type { ModeTransitionBarrier, PendingModeTransition } from "./permission-session.ts";
import { defaultProtectedWritePaths } from "./filesystem-policy.ts";
import { type HostFilteringProxy, startHostFilteringProxy } from "./filtering-proxy.ts";
import { validateGuardianPolicy } from "./guardian-policy.ts";
import type { GuardianReviewSessionManager } from "./guardian-session.ts";
import { createSandboxedGuardianToolRuntime } from "./guardian-tools.ts";
import {
  appendGuardianTranscript,
  boundGuardianTranscript,
  type GuardianTranscriptEntry,
} from "./guardian-transcript.ts";
import { PermissionModeRuntime } from "./mode-runtime.ts";
import {
  parseCommandSegments,
  shellCommandInitializesCurrentDirectory,
} from "./permissions/risk.ts";
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

export type GuardianPolicySource = (context: {
  cwd: string;
  configFingerprint: string;
}) => string | undefined;

export type LocalProxyPortsProvider = () => LocalProxyPorts;

export interface RegisterExtensionOptions {
  agentDir?: string;
  sandboxManager?: SandboxManagerLike;
  bashToolFactory?: typeof createBashTool;
  localProxyPorts?: LocalProxyPorts;
  localProxyPortsProvider?: LocalProxyPortsProvider;
  filteringProxyFactory?: (
    approvedHosts: readonly string[],
    upstream: LocalProxyPorts,
    deniedHosts?: readonly string[],
  ) => Promise<HostFilteringProxy>;
  sandboxCoordinator?: Pick<SandboxExecutionCoordinator, "runShared" | "runExclusive">;
  autoReviewer?: AutoReviewer;
  guardianSessionManager?: GuardianReviewSessionManager;
  guardianPolicySource?: GuardianPolicySource;
  riskEvaluator?: typeof evaluateDefaultRequest;
}

type ExecutablePermissionMode = PermissionMode;

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

class ActivationSupersededError extends Error {
  constructor() {
    super("pi-permissions: permission activation was superseded by a newer session");
    this.name = "ActivationSupersededError";
  }
}

function isActivationSupersededError(error: unknown): error is ActivationSupersededError {
  return error instanceof ActivationSupersededError;
}

const PERMISSION_MODE_CHANGED_REASON = "permission mode changed";
const guardianFallbackNoticeKeys = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part) || typeof part.type !== "string") return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "image") return "[image]";
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function assistantContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part) || typeof part.type !== "string") return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "toolCall") {
        return JSON.stringify({
          toolCall: typeof part.name === "string" ? part.name : "",
          arguments: isRecord(part.arguments) ? part.arguments : {},
        });
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function guardianTranscriptEntryFromMessage(message: unknown): GuardianTranscriptEntry | undefined {
  if (!isRecord(message)) return undefined;
  if (message.role === "user") {
    const content = textContent(message.content);
    return content.length > 0 ? { role: "user", content } : undefined;
  }
  if (message.role === "assistant") {
    const content = assistantContent(message.content);
    return content.length > 0 ? { role: "assistant", content } : undefined;
  }
  if (message.role === "toolResult") {
    const content = textContent(message.content);
    return {
      role: "tool",
      toolName: typeof message.toolName === "string" ? message.toolName : "",
      content,
      isError: message.isError === true,
    };
  }
  return undefined;
}

function requiresSandbox(mode: PermissionMode, config: PermissionsConfig): boolean {
  return mode !== "yolo" && config.sandbox.enabled;
}

function nextMode(mode: PermissionMode): PermissionMode {
  return mode === "auto" ? "yolo" : "auto";
}

export function registerExtension(pi: ExtensionAPI, options: RegisterExtensionOptions = {}): void {
  const agentDir = options.agentDir ?? getAgentDir();
  const sandboxManager = options.sandboxManager ?? SandboxManager;
  const bashToolFactory = options.bashToolFactory ?? createBashTool;
  const baseBash = bashToolFactory(process.cwd());
  const baseWrite = createWriteTool(process.cwd());
  const baseEdit = createEditTool(process.cwd());
  const resolveLocalProxyPorts: LocalProxyPortsProvider =
    options.localProxyPortsProvider ?? (() => options.localProxyPorts ?? detectLocalProxyPorts());
  const filteringProxyFactory = options.filteringProxyFactory ?? startHostFilteringProxy;
  const sandboxCoordinator = options.sandboxCoordinator ?? new SandboxExecutionCoordinator();
  const riskEvaluator = options.riskEvaluator ?? evaluateDefaultRequest;
  const autoReviewer =
    options.autoReviewer ??
    new PiAutoReviewer(undefined, options.guardianSessionManager, undefined, (cwd) =>
      createSandboxedGuardianToolRuntime(cwd, sandboxManager),
    );
  let loaded: LoadedPermissionsConfig | undefined;
  let loadedKey: string | undefined;
  let configFailure: Error | undefined;
  let activationFailure: { key: string; error: Error } | undefined;
  let modeRuntime: PermissionModeRuntime | undefined;
  let shortcutWarningShown = false;
  let guardianTranscript: GuardianTranscriptEntry[] = [];
  let inputFallbackTranscript: GuardianTranscriptEntry[] = [];
  const autoApprovalLedger = new AutoApprovalLedger();
  let modeMutationTail: Promise<void> = Promise.resolve();
  let lastGuardianSelection:
    | {
        guardian: GuardianReviewIdentity;
        cwd: string;
        configFingerprint: string;
      }
    | undefined;
  const grants = new GrantLedger();
  const session = new PermissionSession();
  // Session-scoped approval memory (codex ExecpolicyAmendment/ApprovedForSession/
  // NetworkPolicyAmendment equivalents). Cleared on extension reload (a new
  // session), never persisted.
  const approvedCommandPrefixes: string[][] = [];
  const approvedNetworkHostsSession = new Set<string>();
  const sessionApprovedWriteRoots: string[] = [];
  // Turn-scoped grants from request_permissions (codex PermissionGrantScope::Turn).
  const turnApprovedWriteRoots: string[] = [];
  const turnApprovedNetworkHosts = new Set<string>();
  let permissionTurnPhase: PermissionTurnPhase = "idle";
  let permissionTurnId = 0;
  let activeTurnId: number | undefined;
  let lifecycleEventsObserved = false;
  let activeExecutionSnapshot: PermissionExecutionSnapshot | undefined;
  let baseSandboxConfig: SandboxRuntimeConfig | undefined;
  let sandboxState:
    | { kind: "pending" }
    | { kind: "disabled" }
    | { kind: "ready"; profile: LoadedPermissionsConfig["config"]["sandbox"]["profile"] }
    | { kind: "failed"; error: string } = { kind: "pending" };

  const setDefaultStatus = (ctx: Pick<ExtensionContext, "ui">): void => {
    ctx.ui.setStatus("pi-permissions", modeRuntime?.statusLabel ?? "Approve for me");
    // Structured mode event for status consumers (e.g. statusline). The
    // string published via setStatus above stays as the built-in-footer
    // fallback; consumers should key off `mode`/`severity`, never the label.
    pi.events.emit("pi-permissions:mode", {
      mode: modeRuntime?.mode ?? "auto",
      label: modeRuntime?.statusLabel ?? "Approve for me",
      severity: modeRuntime?.statusSeverity ?? "warning",
    });
  };

  const runModeMutation = <T>(
    operation: (generation: number) => Promise<T>,
  ): Promise<T | undefined> => {
    const generation = session.getGeneration();
    const execute = async (): Promise<T | undefined> => {
      if (!session.isCurrentGeneration(generation)) return undefined;
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
    session.bumpEpoch();
    for (const controller of session.reviewControllers.values()) {
      controller.abort(new Error(reason));
    }
    session.reviewControllers.clear();
    modeRuntime?.cancelReviews();
    grants.clear();
    if (preserveAutoDenials) {
      autoApprovalLedger.clearPendingOverride();
    } else {
      autoApprovalLedger.clear();
    }
    autoReviewer.invalidateSession();
  };

  const resetBranchPermissionContext = (reason: string): void => {
    session.bumpGeneration();
    cancelInFlightModeTransition();
    guardianTranscript = [];
    inputFallbackTranscript = [];
    permissionTurnPhase = "idle";
    activeTurnId = undefined;
    activeExecutionSnapshot = undefined;
    session.clearPending();
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
      mode: modeRuntime.mode,
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
    if (session.hasInFlightBarrier()) return undefined;
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

  // The pending token never defers activation: the mode switch runs immediately
  // inside runModeMutation (activateConfig + runtime.activate). The token only
  // stops the mutation's invalidatePermissionContext from tearing down the
  // turn snapshot (and its approvals) mid-switch; agent_end/agent_settled
  // clears it, letting the next turn start on the new mode.
  const scheduleModeTransition = (): PendingModeTransition | undefined => {
    return session.schedulePendingTransition({ phase: permissionTurnPhase, activeTurnId });
  };

  const clearPendingModeTransition = (turnId: number): void => {
    session.clearPendingForTurn(turnId);
  };

  const isPendingModeTransitionCurrent = (transition: PendingModeTransition): boolean =>
    session.isPendingCurrent(transition, { phase: permissionTurnPhase, activeTurnId });

  const clearPendingModeTransitionIfCurrent = (transition: PendingModeTransition): void => {
    session.clearPendingIfCurrent(transition);
  };

  const createModeTransitionBarrier = (): ModeTransitionBarrier => session.createBarrier();

  const settleModeTransitionBarrier = (
    barrier: ModeTransitionBarrier,
    readyForNextTurn: boolean,
  ): void => {
    session.settleBarrier(barrier, readyForNextTurn);
  };

  const cancelInFlightModeTransition = (): void => {
    session.cancelInFlightBarrier();
  };

  const finishPermissionTurn = (reason: string): void => {
    if (permissionTurnPhase !== "active") return;
    const closingTurnId = activeTurnId;
    activeExecutionSnapshot = undefined;
    activeTurnId = undefined;
    permissionTurnPhase = "between";
    if (closingTurnId !== undefined) clearPendingModeTransition(closingTurnId);
    turnApprovedWriteRoots.length = 0;
    turnApprovedNetworkHosts.clear();
    invalidatePermissionContext(reason, { preserveAutoDenials: true });
  };

  const grantApprovedCall = (
    event: ToolCallEvent,
    decision: Extract<DefaultDecision, { action: "prompt" }>,
    executionContext: EffectiveExecutionContext,
    cwd: string,
    authority: "user" | "auto-review",
    rememberSession = false,
  ): void => {
    if (!event.toolCallId) return;
    grants.mint({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      authority,
      configFingerprint: fingerprintConfig(executionContext.config),
      cwd: resolve(cwd),
      networkHosts: decision.networkHosts,
      writeRoots: [
        ...new Set([...oneCallWriteRoots(event, cwd), ...(decision.filesystemWriteRoots ?? [])]),
      ],
    });
    if (rememberSession) {
      // Remember user-approved commands and hosts for the rest of the session
      // (mirrors codex execpolicy amendments and network rules, exposed as the
      // "Allow and Remember" approval choice). Auto-review and one-off
      // approvals are not remembered.
      const command = (event.input as Record<string, unknown>).command;
      if (typeof command === "string") {
        for (const segment of parseCommandSegments(command)) {
          approvedCommandPrefixes.push([segment.executable, ...segment.args]);
        }
      }
      for (const host of decision.networkHosts ?? []) {
        approvedNetworkHostsSession.add(host);
      }
    }
  };

  const currentGuardianTranscriptSnapshot = (): GuardianTranscriptEntry[] =>
    boundGuardianTranscript(
      guardianTranscript.length > 0 ? guardianTranscript : inputFallbackTranscript,
    );

  const guardianPermissionContext = (
    event: ToolCallEvent,
    decision: Extract<DefaultDecision, { action: "prompt" }>,
    executionContext: EffectiveExecutionContext,
    cwd: string,
  ): GuardianPermissionContext => {
    const sandboxConfig =
      executionContext.baseSandboxConfig ??
      createSandboxRuntimeConfig(
        executionContext.config.sandbox,
        cwd,
        defaultProtectedWritePaths(cwd, agentDir),
      );
    return {
      sandboxProfile: executionContext.config.sandbox.profile,
      sandboxEnabled: executionContext.config.sandbox.enabled,
      filesystemWriteRoots: [
        ...new Set([
          ...sandboxConfig.filesystem.allowWrite,
          ...oneCallWriteRoots(event, cwd),
          ...(decision.filesystemWriteRoots ?? []),
        ]),
      ],
      filesystemDenyRead: [...sandboxConfig.filesystem.denyRead],
      filesystemDenyWrite: [...sandboxConfig.filesystem.denyWrite],
      requestedNetworkHosts: [...(decision.networkHosts ?? [])],
      allowedNetworkHosts: [...sandboxConfig.network.allowedDomains],
      deniedNetworkHosts: [...sandboxConfig.network.deniedDomains],
    };
  };

  const configKey = (ctx: Pick<ExtensionContext, "cwd">): string => ctx.cwd;
  const isActivationCurrent = (expectedGeneration: number): boolean =>
    session.isCurrentGeneration(expectedGeneration);
  const assertActivationCurrent = (expectedGeneration: number): void => {
    if (!isActivationCurrent(expectedGeneration)) throw new ActivationSupersededError();
  };
  const activateConfigUnlocked = async (
    ctx: Pick<ExtensionContext, "cwd" | "ui" | "hasUI">,
    force = false,
    targetMode?: ExecutablePermissionMode,
    candidateOverride?: LoadedPermissionsConfig,
    expectedGeneration = session.getGeneration(),
  ): Promise<LoadedPermissionsConfig> => {
    // The exclusive coordinator can delay this work until after a session/tree reset.
    // Check before every cache shortcut so an old tool call cannot borrow the new
    // session's cached policy and synthesize a compatibility snapshot.
    assertActivationCurrent(expectedGeneration);
    const key = configKey(ctx);
    if (!force && configFailure) throw configFailure;
    const cachedMode = targetMode ?? (modeRuntime ? modeRuntime.mode : undefined);
    if (!force && loaded && loadedKey === key) {
      const effectiveCachedMode = cachedMode ?? "auto";
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
    const effectiveMode = cachedMode ?? "auto";
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
    expectedGeneration = session.getGeneration(),
  ): Promise<LoadedPermissionsConfig> =>
    targetMode === "yolo"
      ? activateConfigUnlocked(ctx, force, targetMode, candidateOverride, expectedGeneration)
      : sandboxCoordinator.runExclusive(() =>
          activateConfigUnlocked(ctx, force, targetMode, candidateOverride, expectedGeneration),
        );

  const MODE_RANK: Record<PermissionMode, number> = {
    auto: 1,
    yolo: 2,
  };

  // Privilege-max mode: the runtime mode applies when it is not a downgrade
  // relative to the turn-snapshot mode; otherwise the snapshot mode keeps
  // routing until agent_end invalidates it. So upgrades (auto->yolo) take
  // effect for the next call immediately, while downgrades only land at the
  // idle boundary. One formula expresses both semantics, so review branches,
  // approval records, and execute gating all read the same value.
  const privilegeMaxMode = (
    executionContext: EffectiveExecutionContext,
  ): ExecutablePermissionMode => {
    const runtimeMode = modeRuntime?.mode ?? "auto";
    return MODE_RANK[executionContext.mode] > MODE_RANK[runtimeMode]
      ? executionContext.mode
      : runtimeMode;
  };

  const assertExecutionAuthorized = async (
    tool: string,
    id: string,
    input: Record<string, unknown>,
    ctx: Pick<ExtensionContext, "cwd">,
    executionContext: EffectiveExecutionContext,
  ): Promise<Grant | undefined> => {
    if (!getEffectiveExecutionContext(executionContext.snapshot)) {
      throw new Error("pi-permissions: call is no longer authorized; request approval again");
    }
    const activeConfig = executionContext.config;
    const executionEpoch = session.getEpoch();
    // Single-use burn happens up front, matching fail-closed semantics: any
    // execution attempt (even one that fails validation) consumes the grant,
    // so a tampered input can never be retried against a stale approval.
    const peeked = grants.peek(id);
    const approved = grants.verify(peeked, {
      tool,
      input,
      cwd: resolve(ctx.cwd),
      configFingerprint: fingerprintConfig(activeConfig),
    });
    const spent = grants.consume(id);
    const currentDecision = await evaluateDefaultRequest(
      tool,
      input,
      ctx.cwd,
      activeConfig,
      defaultProtectedWritePaths(ctx.cwd, agentDir),
      {
        commandPrefixes: approvedCommandPrefixes,
        networkHosts: approvedNetworkHostsSession,
      },
    );
    if (
      !session.epochMatches(executionEpoch) ||
      !getEffectiveExecutionContext(executionContext.snapshot)
    ) {
      throw new Error("pi-permissions: call is no longer authorized; request approval again");
    }
    if (currentDecision.action === "block" || (currentDecision.action === "prompt" && !approved)) {
      throw new Error("pi-permissions: call is no longer authorized; request approval again");
    }
    return spent;
  };

  // Readiness gating happens in the enforced-tool skeleton before these run.
  const sandboxOperations = (customConfig?: SandboxRuntimeConfig): BashOperations =>
    createSandboxedBashOperations(sandboxManager, customConfig);

  const sandboxFileOperations = (
    baseConfig: SandboxRuntimeConfig,
    writeRoots: readonly string[],
    signal?: AbortSignal,
  ) => {
    return createSandboxedFileOperations(sandboxManager, baseConfig, writeRoots, signal);
  };

  /**
   * pi-core resolves its own physical copy of @earendil-works/pi-coding-agent,
   * so Codex-rendered tools reference a nominal Theme twin (private-field
   * clash; structurally identical at runtime). Contain the mismatch at this
   * seam — do not widen it beyond the three Codex-rendered built-ins.
   */
  type CodexRenderedSpec =
    | typeof codexBashToolSpec
    | typeof codexWriteToolSpec
    | typeof codexEditToolSpec;
  function adoptHostTheme(
    spec: CodexRenderedSpec,
  ): Pick<ToolDefinition<TSchema>, "renderShell" | "renderCall" | "renderResult"> {
    // SAFETY: both packages ship identical runtime shapes; only Theme's private-field
    // declaration differs across the physical module copies, so the bridge needs one
    // double assertion per direction instead of threading casts through call sites.
    return createPiCoreCodexToolRendering(
      spec as Parameters<typeof createPiCoreCodexToolRendering>[0],
    ) as unknown as Pick<ToolDefinition<TSchema>, "renderShell" | "renderCall" | "renderResult">;
  }

  const enforcerHost: EnforcerHost<EffectiveExecutionContext> = {
    async activate(ctx) {
      const activationGeneration = session.getGeneration();
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
      return {
        privilegeMax: privilegeMaxMode(executionContext),
        sandboxEnabled: executionContext.config.sandbox.enabled,
        sandboxReady: executionContext.sandboxReady,
        baseSandboxConfig: executionContext.baseSandboxConfig,
        raw: executionContext,
      };
    },
    authorize: (tool, id, input, ctx, snap) =>
      assertExecutionAuthorized(tool, id, input, ctx, snap),
    peekGrant: (id) => grants.peek(id),
    revokeGrant: (id) => grants.revoke(id),
    coordinate: (lease, signal, run) =>
      lease === "exclusive"
        ? sandboxCoordinator.runExclusive(run, signal)
        : sandboxCoordinator.runShared(run, signal),
    sandboxUnavailableReason: () =>
      sandboxState.kind === "failed" ? sandboxState.error : "sandbox is unavailable",
  };

  // Per-tool concrete types derived from the base factories so strategy
  // bodies below stay cast-free.
  type BashInstance = ReturnType<typeof bashToolFactory>;
  type BashParams = Parameters<BashInstance["execute"]>[1];
  type BashOnUpdate = Parameters<BashInstance["execute"]>[3];
  type BashResult = Awaited<ReturnType<BashInstance["execute"]>>;
  type WriteInstance = ReturnType<typeof createWriteTool>;
  type WriteParams = Parameters<WriteInstance["execute"]>[1];
  type WriteOnUpdate = Parameters<WriteInstance["execute"]>[3];
  type WriteResult = Awaited<ReturnType<WriteInstance["execute"]>>;
  type EditInstance = ReturnType<typeof createEditTool>;
  type EditParams = Parameters<EditInstance["execute"]>[1];
  type EditOnUpdate = Parameters<EditInstance["execute"]>[3];
  type EditResult = Awaited<ReturnType<EditInstance["execute"]>>;

  const bashSpec: GuardedSpec<BashParams, BashOnUpdate, BashResult> = {
    toolName: "bash",
    leaseFor: (grant) => ((grant?.networkHosts?.length ?? 0) > 0 ? "exclusive" : "shared"),
    bare: ({ ctx, id, params, signal, onUpdate }) =>
      bashToolFactory(ctx.cwd).execute(id, params, signal, onUpdate),
    runInLease: async ({ id, params, signal, onUpdate, ctx, cwd, lease, baseConfig, grant }) => {
      const networkHosts = grant?.networkHosts ?? [];
      const writeRoots = grant?.writeRoots ?? [];

      const isBareGitInit = shellCommandInitializesCurrentDirectory(params.command);
      if (isBareGitInit) {
        // sandbox-runtime hard-denies .git/hooks writes with no config
        // switch, which makes `git init` structurally impossible inside the
        // sandbox (it must create the hooks directory). A pure, approved
        // `git init` only writes sample hooks and never executes them, so it
        // runs unsandboxed; all other git mutations stay sandboxed.
        return bashToolFactory(cwd).execute(id, params, signal, onUpdate);
      }

      let commandConfig =
        writeRoots.length > 0 ? withAdditionalWriteRoots(baseConfig, writeRoots) : baseConfig;
      let filteringProxy: HostFilteringProxy | undefined;
      try {
        if (networkHosts.length > 0) {
          if (lease !== "exclusive") {
            throw new Error(
              "pi-permissions network escalation requires an exclusive sandbox lease",
            );
          }
          const allowedDomains = [
            ...new Set([...baseConfig.network.allowedDomains, ...networkHosts]),
          ];
          const upstreamProxyPorts = resolveLocalProxyPorts();
          const hasLocalProxy = Boolean(upstreamProxyPorts.http || upstreamProxyPorts.socks);
          if (hasLocalProxy) {
            filteringProxy = await filteringProxyFactory(
              allowedDomains,
              upstreamProxyPorts,
              baseConfig.network.deniedDomains,
            );
          }
          commandConfig = filteringProxy
            ? withLocalProxy(commandConfig, filteringProxy.ports, allowedDomains)
            : withAllowedDomains(commandConfig, allowedDomains);
          await sandboxManager.reset();
          await sandboxManager.initialize(commandConfig);
        }

        const sandboxedBash = bashToolFactory(cwd, {
          operations: sandboxOperations(commandConfig),
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
    },
  };

  const writeSpec: GuardedSpec<WriteParams, WriteOnUpdate, WriteResult> = {
    toolName: "write",
    leaseFor: () => "shared",
    bare: ({ ctx, id, params, signal, onUpdate }) =>
      createWriteTool(ctx.cwd).execute(id, params, signal, onUpdate),
    runInLease: ({ id, params, signal, onUpdate, ctx, baseConfig, grant }) => {
      const writeRoots = grant?.writeRoots ?? [];
      const tool = createWriteTool(ctx.cwd, {
        operations: sandboxFileOperations(baseConfig, writeRoots, signal),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  };

  const editSpec: GuardedSpec<EditParams, EditOnUpdate, EditResult> = {
    toolName: "edit",
    leaseFor: () => "shared",
    bare: ({ ctx, id, params, signal, onUpdate }) =>
      createEditTool(ctx.cwd).execute(id, params, signal, onUpdate),
    runInLease: ({ id, params, signal, onUpdate, ctx, baseConfig, grant }) => {
      const writeRoots = grant?.writeRoots ?? [];
      const tool = createEditTool(ctx.cwd, {
        operations: sandboxFileOperations(baseConfig, writeRoots, signal),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  };

  pi.registerTool({
    ...baseBash,
    ...adoptHostTheme(codexBashToolSpec),
    label: "bash (sandboxed)",
    description: `${baseBash.description} To write outside the active sandbox, request sandbox_permissions="with_additional_permissions", list the minimum additional_permissions.file_system.write roots, and provide justification.`,
    promptGuidelines: [
      "When a command must write outside the workspace, request only the minimum additional filesystem write roots and explain why.",
    ],
    parameters: permissionedBashParameters,
    executionMode: "sequential",
    execute: makeGuardedExecute(enforcerHost, bashSpec),
  });

  pi.registerTool({
    ...baseWrite,
    ...adoptHostTheme(codexWriteToolSpec),
    executionMode: "sequential",
    execute: makeGuardedExecute(enforcerHost, writeSpec),
  });

  pi.registerTool({
    ...baseEdit,
    ...adoptHostTheme(codexEditToolSpec),
    executionMode: "sequential",
    execute: makeGuardedExecute(enforcerHost, editSpec),
  });

  pi.registerTool({
    name: "request_permissions",
    label: "request_permissions",
    description:
      "Explicitly request one-off (turn) or session-scoped filesystem write or network permissions from the user. Each request is approved or denied by the user; approved hosts/roots are honored without further prompts within the granted scope.",
    promptSnippet: "Request explicit filesystem/network permissions",
    parameters: Type.Object({
      reason: Type.Optional(Type.String()),
      permissions: Type.Object({
        filesystem: Type.Optional(Type.Object({ write: Type.Array(Type.String()) })),
        network: Type.Optional(Type.Object({ hosts: Type.Array(Type.String()) })),
      }),
      scope: Type.Optional(Type.Union([Type.Literal("turn"), Type.Literal("session")])),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (_signal?.aborted) {
        return {
          content: [{ type: "text", text: "Operation aborted" }],
          isError: true,
          details: undefined,
        };
      }
      const activationGeneration = session.getGeneration();
      await activateConfig(ctx, false, undefined, undefined, activationGeneration);
      assertActivationCurrent(activationGeneration);
      const executionSnapshot = ensureExecutionSnapshot(ctx);
      if (!executionSnapshot) {
        throw new Error("pi-permissions: request_permissions requires an active permission turn");
      }
      const executionContext = getEffectiveExecutionContext(executionSnapshot);
      if (!executionContext) {
        throw new Error("pi-permissions: request_permissions requires an active permission turn");
      }
      const scope = params.scope ?? "turn";
      const hosts = params.permissions?.network?.hosts ?? [];
      const roots = params.permissions?.filesystem?.write ?? [];
      const detail = [
        `pi-permissions · request_permissions (${scope})`,
        params.reason ? `\nReason: ${params.reason}` : "",
        roots.length > 0 ? `\nFilesystem write: ${roots.join(", ")}` : "",
        hosts.length > 0 ? `\nNetwork hosts: ${hosts.join(", ")}` : "",
      ].join("");
      const confirmed = await ctx.ui.confirm("pi-permissions", detail);
      if (!confirmed) throw new Error("User denied request_permissions");
      if (scope === "session") {
        for (const host of hosts) approvedNetworkHostsSession.add(host);
        sessionApprovedWriteRoots.push(...roots);
      } else {
        for (const host of hosts) turnApprovedNetworkHosts.add(host);
        turnApprovedWriteRoots.push(...roots);
      }
      return {
        content: [
          {
            type: "text",
            text: `Granted ${scope} permissions${
              hosts.length > 0 ? `; hosts: ${hosts.join(", ")}` : ""
            }${roots.length > 0 ? `; write roots: ${roots.join(", ")}` : ""}`,
          },
        ],
        details: undefined,
      };
    },
  });

  const reportConfigError = (ctx: ExtensionContext, error: unknown): ToolCallEventResult => {
    const message = error instanceof Error ? error.message : String(error);
    setDefaultStatus(ctx);
    if (ctx.hasUI) ctx.ui.notify(`pi-permissions 配置错误：${message}`, "error");
    return { block: true, reason: `pi-permissions configuration error: ${message}` };
  };

  pi.on("session_start", async (_event, ctx) => {
    shortcutWarningShown = false;
    resetBranchPermissionContext("session changed");
    lifecycleEventsObserved = false;
    const generation = session.getGeneration();
    let candidate: LoadedPermissionsConfig;
    try {
      candidate = await loadPermissionsConfig(agentDir);
    } catch (error: unknown) {
      if (!session.isCurrentGeneration(generation)) return;
      configFailure = error instanceof Error ? error : new Error(String(error));
      reportConfigError(ctx, error);
      return;
    }
    try {
      const restoredRuntime = new PermissionModeRuntime(candidate.config, pi.appendEntry.bind(pi));
      restoredRuntime.restore(ctx.sessionManager.getBranch(), candidate.config);
      const restoredMode = restoredRuntime.mode;
      await activateConfig(ctx, true, restoredMode, candidate, generation);
      if (!session.isCurrentGeneration(generation)) return;
      modeRuntime = restoredRuntime;
      setDefaultStatus(ctx);
      if ((await shiftTabAvailability(agentDir)) === "reserved" && !shortcutWarningShown) {
        if (!session.isCurrentGeneration(generation)) return;
        shortcutWarningShown = true;
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Shift+Tab 仍由 app.thinking.cycle 占用；请迁移 ~/.pi/agent/keybindings.json 后 /reload",
            "warning",
          );
        }
      }
    } catch (error: unknown) {
      if (!session.isCurrentGeneration(generation)) return;
      reportConfigError(ctx, error);
    }
  });

  pi.on("session_before_tree", () => {
    resetBranchPermissionContext("session tree changed");
  });

  pi.on("session_tree", (_event, ctx) => {
    resetBranchPermissionContext("session tree changed");
    return runModeMutation(async (generation) => {
      if (loaded && modeRuntime && session.isCurrentGeneration(generation)) {
        const previousMode = modeRuntime.mode;
        const restoredRuntime = new PermissionModeRuntime(loaded.config, pi.appendEntry.bind(pi));
        restoredRuntime.restore(ctx.sessionManager.getBranch(), loaded.config);
        const restoredMode = restoredRuntime.mode;
        try {
          await activateConfig(ctx, false, restoredMode, loaded, generation);
        } catch (error: unknown) {
          if (!session.isCurrentGeneration(generation)) return;
          reportConfigError(ctx, error);
          return;
        }
        if (!session.isCurrentGeneration(generation)) return;
        modeRuntime = restoredRuntime;
        setDefaultStatus(ctx);
        if (previousMode === "yolo" && restoredMode !== "yolo" && !ctx.isIdle()) ctx.abort();
      }
    });
  });

  pi.on("session_shutdown", async () => {
    session.bumpGeneration();
    cancelInFlightModeTransition();
    permissionTurnPhase = "idle";
    activeTurnId = undefined;
    activeExecutionSnapshot = undefined;
    session.clearPending();
    invalidatePermissionContext("session shutdown");
    await sandboxCoordinator.runExclusive(async () => {
      sandboxState = { kind: "pending" };
      await sandboxManager.reset();
    });
  });

  pi.on("input", (event) => {
    if ((event.source === "interactive" || event.source === "rpc") && event.text.length > 0) {
      inputFallbackTranscript = appendGuardianTranscript(inputFallbackTranscript, {
        role: "user",
        content: event.text,
      });
    }
  });

  pi.on("message_end", (event) => {
    const entry = guardianTranscriptEntryFromMessage(event.message);
    if (entry) {
      guardianTranscript = appendGuardianTranscript(guardianTranscript, entry);
    }
  });

  pi.on("agent_start", async () => {
    lifecycleEventsObserved = true;
    if (permissionTurnPhase === "active") return;
    permissionTurnId += 1;
    const startingTurnId = permissionTurnId;
    activeTurnId = startingTurnId;
    permissionTurnPhase = "active";
    const transition = session.getInFlightBarrier();
    if (transition) {
      const readyForNextTurn = await transition.completion;
      session.clearInFlightIfCurrent(transition);
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
        grants.revoke(event.toolCallId);
      }
      let result: LoadedPermissionsConfig;
      const activationGeneration = session.getGeneration();
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
      if (privilegeMaxMode(executionContext) === "yolo") return;

      const evaluationEpoch = session.getEpoch();
      let decision: DefaultDecision;
      try {
        decision = await riskEvaluator(
          event.toolName,
          event.input as Record<string, unknown>,
          ctx.cwd,
          executionContext.config,
          defaultProtectedWritePaths(ctx.cwd, agentDir),
          {
            commandPrefixes: approvedCommandPrefixes,
            networkHosts: approvedNetworkHostsSession,
          },
        );
      } catch (error: unknown) {
        if (
          !session.epochMatches(evaluationEpoch) ||
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
        !session.epochMatches(evaluationEpoch) ||
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
      // yolo short-circuited above, so every call reaching review is auto.
      if (runtime.autoState.paused) {
        return {
          block: true,
          reason:
            "pi-permissions: Auto review paused after repeated denials; start a new turn or use Shift+Tab to re-enter Auto",
        };
      }
      // Guardian review is the only remaining verdict handler: the human-popup
      // mode was retired, so every non-allow/block call goes to the configured
      // reviewer ("Approve for me").
      const runGuardianReview = async (): Promise<ToolCallEventResult | undefined> => {
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
        session.reviewControllers.set(id, reviewController);
        const reviewSignal = ctx.signal
          ? AbortSignal.any([ctx.signal, reviewController.signal])
          : reviewController.signal;
        try {
          const actionFingerprint = fingerprintValue({
            tool: event.toolName.toLowerCase(),
            input: event.input,
          });
          const configFingerprint = fingerprintConfig(executionContext.config);
          const guardianCwd = resolve(ctx.cwd);
          const suppliedGuardianPolicy = options.guardianPolicySource?.({
            cwd: guardianCwd,
            configFingerprint,
          });
          const guardianPolicy =
            suppliedGuardianPolicy === undefined
              ? undefined
              : validateGuardianPolicy(suppliedGuardianPolicy);
          const approvalOverride = autoApprovalLedger.takeOverride({
            actionFingerprint,
            cwd: guardianCwd,
            configFingerprint,
          });
          const request = buildAutoReviewRequest(
            event,
            decision,
            ctx.cwd,
            guardianPermissionContext(event, decision, executionContext, ctx.cwd),
            currentGuardianTranscriptSnapshot(),
            approvalOverride,
          );
          const auto = await reviewAutoPrompt(
            autoReviewer,
            request,
            {
              modelRegistry: ctx.modelRegistry,
              activeModel: ctx.model,
              reviewer: executionContext.config.reviewer,
              guardianPolicy,
              guardianSession: {
                cwd: guardianCwd,
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
            grantApprovedCall(event, decision, executionContext, ctx.cwd, "auto-review");
            return;
          }
          if (auto.action === "deny") {
            const autoState = runtime.recordAutoReview("deny");
            autoApprovalLedger.recordDenial({
              tool: event.toolName,
              input: event.input as Record<string, unknown>,
              cwd: guardianCwd,
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
          if (auto.action === "error" && auto.error.kind === "timeout") {
            // codex TimedOut is an explicit decision: keep failing closed (no
            // human fallback in auto mode), but say so with guidance.
            return {
              block: true,
              reason:
                "pi-permissions Auto review timed out; the action was not run. Ask the user to approve, or take a different approach.",
            };
          }
          return {
            block: true,
            reason: "pi-permissions Auto review failed closed; the action was not run",
          };
        } catch (error) {
          if (reviewSignal.aborted) {
            return {
              block: true,
              reason: "pi-permissions: permission context changed during Auto review",
            };
          }
          runtime.recordAutoNonDenial();
          if (error instanceof AutoReviewerFailure && error.kind === "timeout") {
            return {
              block: true,
              reason:
                "pi-permissions Auto review timed out; the action was not run. Ask the user to approve, or take a different approach.",
            };
          }
          return {
            block: true,
            reason: "pi-permissions Auto review failed closed; the action was not run",
          };
        } finally {
          if (session.reviewControllers.get(id) === reviewController) {
            session.reviewControllers.delete(id);
            runtime.endReview(id);
          }
        }
      };
      return runGuardianReview();
    },
  );

  pi.registerCommand("approve", {
    description: "Approve one exact retry of a recent Auto-review denial",
    handler: async (_args, ctx) => {
      let result: LoadedPermissionsConfig;
      const activationGeneration = session.getGeneration();
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
    const pendingBeforeTransition = session.getPendingTransition();
    const modeBeforeCycle = modeRuntime ? modeRuntime.mode : "auto";
    // The switch itself runs immediately either way. For upgrades
    // (default->auto, *->yolo) that is the whole story: privilegeMaxMode routes
    // the next call to the new review branch while the turn snapshot (and its
    // already-granted approvals) stay intact. For downgrades (->default) the
    // pending token keeps that snapshot valid, so privilegeMaxMode keeps
    // routing on the old mode until agent_end invalidates it — no mid-turn
    // sandbox teardown race.
    const isUpgrade = MODE_RANK[nextMode(modeBeforeCycle)] > MODE_RANK[modeBeforeCycle];
    const transition = beganDuringActiveTurn && !isUpgrade ? scheduleModeTransition() : undefined;
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
          if (!transition && !beganDuringActiveTurn) {
            // Between turns and while idle there is no snapshot to preserve. Revoke any
            // approval context before the async activation work begins. Immediate
            // upgrades during an active turn keep the snapshot and its approvals.
            invalidatePermissionContext(PERMISSION_MODE_CHANGED_REASON);
          }
          let runtime = modeRuntime;
          if (!runtime) {
            const initial = await activateConfig(ctx, false, undefined, undefined, generation);
            if (!session.isCurrentGeneration(generation)) {
              settleModeTransitionBarrier(transitionBarrier, false);
              return;
            }
            runtime = ensureModeRuntime(initial.config);
          }
          // Recompute from the latest runtime state: runModeMutation serializes
          // mutations, so a rapid double Shift+Tab lands on the correct final
          // mode (default -> auto -> yolo) instead of both reading the same
          // starting mode.
          const previousMode = runtime.mode;
          const targetMode = nextMode(previousMode);
          const result = await activateConfig(
            ctx,
            !beganDuringActiveTurn,
            targetMode,
            undefined,
            generation,
          );
          if (!session.isCurrentGeneration(generation)) {
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
          settleModeTransitionBarrier(transitionBarrier, true);
        } catch (error: unknown) {
          if (transition && transitionOwnsPendingState) {
            clearPendingModeTransitionIfCurrent(transition);
          }
          settleModeTransitionBarrier(transitionBarrier, false);
          if (!session.isCurrentGeneration(generation)) return;
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
          const previousMode = modeRuntime ? modeRuntime.mode : undefined;
          const candidate = await loadPermissionsConfig(agentDir);
          candidateLoaded = true;
          const candidateFingerprint = fingerprintConfig(candidate.config);
          // Reload persisted session state: a recorded state entry wins over
          // the in-memory runtime even when the config itself is unchanged
          // (e.g. a downgrade recorded by another lifecycle surface must beat
          // a working YOLO turn).
          const hasRecordedState = ctx.sessionManager
            .getBranch()
            .some(
              (entry) =>
                typeof entry === "object" &&
                entry !== null &&
                (entry as { customType?: unknown }).customType === "pi-permissions-state",
            );
          const restoredRuntime =
            !modeRuntime ||
            hasRecordedState ||
            modeRuntime.snapshot().configFingerprint !== candidateFingerprint
              ? new PermissionModeRuntime(candidate.config, pi.appendEntry.bind(pi))
              : undefined;
          restoredRuntime?.restore(ctx.sessionManager.getBranch(), candidate.config);
          const targetMode = (restoredRuntime ?? modeRuntime)?.mode ?? "auto";
          const result = await activateConfig(ctx, true, targetMode, candidate, generation);
          if (!session.isCurrentGeneration(generation)) return;
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
          if (!session.isCurrentGeneration(generation)) return;
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
