import { resolve } from "node:path";

import type {
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
import { type TSchema, Type } from "typebox";
import {
  codexBashToolSpec,
  codexEditToolSpec,
  codexWriteToolSpec,
  createCodexToolRendering as createPiCoreCodexToolRendering,
} from "../../pi-core/standalone.ts";
import { type AutoReviewer, type GuardianReviewIdentity, PiAutoReviewer } from "./auto-reviewer.ts";
import {
  ConfigError,
  fingerprintConfig,
  fingerprintValue,
  type LoadedPermissionsConfig,
  loadPermissionsConfig,
  type PermissionsConfig,
} from "./config.ts";
import { defaultProtectedWritePaths, resolvePolicyPath } from "./filesystem-policy.ts";
import { inspectRepositoryGitMetadata } from "./git-metadata.ts";
import { GUARDIAN_DENIAL_WINDOW_SIZE, validateGuardianPolicy } from "./guardian-policy.ts";
import type { GuardianReviewSessionManager } from "./guardian-session.ts";
import { createSandboxedGuardianToolRuntime } from "./guardian-tools.ts";
import {
  appendGuardianTranscript,
  boundGuardianTranscript,
  type GuardianTranscriptEntry,
} from "./guardian-transcript.ts";
import { PermissionModeRuntime } from "./mode-runtime.ts";
import {
  renderExactRetryInstruction,
  renderPermissionErrorForAgent,
  renderPermissionNotice,
  renderPermissionSummary,
} from "./permission-copy.ts";
import type { ModeTransitionBarrier, PendingModeTransition } from "./permission-session.ts";
import { type PermissionExecutionSnapshot, PermissionSession } from "./permission-session.ts";
import {
  createPiGuardianAdapter,
  type PiGuardianReviewContext,
  toolCallEventMetadata,
} from "./pi-approve-for-me-adapters.ts";
import {
  type PiAction,
  type PiActionOutcome,
  type PiExecutionOutcome,
  PiPermissionsRuntime,
  type PiTurnSnapshot,
} from "./pi-permissions.ts";
import { evaluateRiskRequest, type RiskDecision } from "./risk-policy.ts";
import { SrtSandboxManager } from "./sandbox/srt-enforcer.ts";
import {
  createSandboxedBashOperations,
  createSandboxedFileOperations,
  createSandboxRuntimeConfig,
  looksLikeSandboxDenial,
  type SandboxManagerLike,
  type SandboxPolicy,
} from "./sandbox.ts";
import { SandboxExecutionCoordinator } from "./sandbox-coordinator.ts";
import { permissionedBashParameters } from "./shell-permissions.ts";
import { shiftTabAvailability } from "./shortcut-config.ts";
import type { PermissionMode } from "./state.ts";
import { errorMessage, isRecord } from "./unknown-value.ts";

export type GuardianPolicySource = (context: {
  cwd: string;
  configFingerprint: string;
}) => string | undefined;

export interface RegisterExtensionOptions {
  agentDir?: string;
  sandboxManager?: SandboxManagerLike;
  bashToolFactory?: typeof createBashTool;
  sandboxCoordinator?: Pick<SandboxExecutionCoordinator, "runShared" | "runExclusive">;
  autoReviewer?: AutoReviewer;
  guardianSessionManager?: GuardianReviewSessionManager;
  guardianPolicySource?: GuardianPolicySource;
  riskEvaluator?: typeof evaluateRiskRequest;
}

type ExecutablePermissionMode = PermissionMode;

interface EffectiveExecutionContext {
  snapshot: PermissionExecutionSnapshot;
  mode: ExecutablePermissionMode;
  config: PermissionsConfig;
  baseSandboxConfig?: SandboxPolicy;
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
const ACTIVE_PERMISSION_CONTEXT_UNAVAILABLE =
  "The active permission context is unavailable. Retry in the current task.";
const guardianFallbackNoticeKeys = new Set<string>();

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
  const sandboxManager = options.sandboxManager ?? new SrtSandboxManager();
  const bashToolFactory = options.bashToolFactory ?? createBashTool;
  const baseBash = bashToolFactory(process.cwd());
  const baseWrite = createWriteTool(process.cwd());
  const baseEdit = createEditTool(process.cwd());
  const sandboxCoordinator = options.sandboxCoordinator ?? new SandboxExecutionCoordinator();
  const riskEvaluator = options.riskEvaluator ?? evaluateRiskRequest;
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
  const permissions = new PiPermissionsRuntime<PiGuardianReviewContext>({
    guardian: createPiGuardianAdapter(autoReviewer),
    reviewEventSink: (event) => {
      pi.events.emit("pi-permissions:review", event);
    },
    onAutoStateChange: (state, ctx, newlyPaused) => {
      modeRuntime?.applyAutoState(state);
      if (!newlyPaused || !ctx) return;
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(
            renderPermissionNotice({
              kind: "review-circuit-interrupted",
              consecutiveDenials: state.consecutiveDenials,
              recentDenials: state.recentDenials,
              windowSize: GUARDIAN_DENIAL_WINDOW_SIZE,
            }),
            "warning",
          );
        } catch {
          // The circuit is an authorization control; UI reporting is best effort.
        }
      }
      ctx.abort();
    },
  });
  let lastGuardianSelection:
    | {
        guardian: GuardianReviewIdentity;
        cwd: string;
        configFingerprint: string;
      }
    | undefined;
  const session = new PermissionSession();
  let baseSandboxConfig: SandboxPolicy | undefined;
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

  const invalidatePermissionContext = (_reason: string): void => {
    autoReviewer.invalidateSession();
  };

  const resetBranchPermissionContext = (reason: string): void => {
    permissions.invalidate(reason);
    session.bumpGeneration();
    cancelInFlightModeTransition();
    guardianTranscript = [];
    inputFallbackTranscript = [];
    session.resetTurn();
    session.clearPending();
    invalidatePermissionContext(reason);
  };

  const ensureModeRuntime = (config: PermissionsConfig): PermissionModeRuntime => {
    modeRuntime ??= new PermissionModeRuntime(config, pi.appendEntry.bind(pi));
    return modeRuntime;
  };

  const captureExecutionSnapshot = (turnId: number): PermissionExecutionSnapshot | undefined => {
    const existing = session.getExecutionSnapshot();
    if (existing) return existing;
    if (!loaded || !modeRuntime) return undefined;
    const snapshot: PermissionExecutionSnapshot = {
      turnId,
      mode: modeRuntime.mode,
      config: loaded.config,
      baseSandboxConfig,
      sandboxReady: sandboxState.kind === "ready",
    };
    session.setExecutionSnapshot(snapshot);
    return snapshot;
  };

  const ensureExecutionSnapshot = (
    _ctx: Pick<ExtensionContext, "isIdle">,
  ): PermissionExecutionSnapshot | undefined => {
    const current = session.currentExecutionSnapshot();
    if (current) return current;
    if (session.hasInFlightBarrier()) return undefined;
    if (session.getTurnPhase() === "between" || session.hasObservedLifecycle()) return undefined;

    // Direct tool-hook invocations without lifecycle events are themselves proof of active work.
    const turnId = session.allocateTurnId();
    session.beginTurn(turnId);
    return captureExecutionSnapshot(turnId);
  };

  const isCurrentExecutionSnapshot = (snapshot: PermissionExecutionSnapshot): boolean =>
    session.currentExecutionSnapshot() === snapshot;

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
  // inside runModeMutation (activateConfig + runtime.activate). During an
  // active turn it prevents the mutation from invalidating the current
  // execution snapshot; agent_end/agent_settled clears it so the next turn
  // captures the new mode.
  const scheduleModeTransition = (): PendingModeTransition | undefined => {
    return session.schedulePendingTransition();
  };

  const clearPendingModeTransition = (turnId: number): void => {
    session.clearPendingForTurn(turnId);
  };

  const isPendingModeTransitionCurrent = (transition: PendingModeTransition): boolean =>
    session.isPendingCurrent(transition);

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
    const closingTurnId = session.finishTurn();
    permissions.closeTurn(reason);
    if (closingTurnId === undefined) return;
    if (closingTurnId !== undefined) clearPendingModeTransition(closingTurnId);
    invalidatePermissionContext(reason);
  };

  const currentGuardianTranscriptSnapshot = (): GuardianTranscriptEntry[] =>
    boundGuardianTranscript(
      guardianTranscript.length > 0 ? guardianTranscript : inputFallbackTranscript,
    );

  const stableSessionId = (
    ctx: Pick<ExtensionContext, "sessionManager">,
    generation: number,
  ): string => {
    const sessionManager = ctx.sessionManager as unknown as
      | { getSessionId?: () => unknown }
      | undefined;
    if (typeof sessionManager?.getSessionId === "function") {
      try {
        const sessionId = sessionManager.getSessionId();
        if (typeof sessionId === "string" && sessionId.trim().length > 0) return sessionId;
      } catch {
        // Compatibility test doubles may expose a throwing session manager.
      }
    }
    return `pi-permissions-session-${generation}`;
  };

  const beginPermissionTurn = (
    ctx: ExtensionContext,
    executionSnapshot: PermissionExecutionSnapshot,
  ): void => {
    const snapshot: PiTurnSnapshot = {
      sessionId: stableSessionId(ctx, session.getGeneration()),
      turnId: executionSnapshot.turnId,
      mode: executionSnapshot.mode,
      cwd: resolve(ctx.cwd),
      configFingerprint: fingerprintConfig(executionSnapshot.config),
      baseSandboxPolicy: executionSnapshot.baseSandboxConfig,
      sandboxReady: executionSnapshot.sandboxReady,
      transcript: currentGuardianTranscriptSnapshot(),
    };
    permissions.beginTurn(snapshot, ctx);
  };

  const configKey = (ctx: Pick<ExtensionContext, "cwd">): string => ctx.cwd;
  const isActivationCurrent = (expectedGeneration: number): boolean =>
    session.isCurrentGeneration(expectedGeneration);
  const assertActivationCurrent = (expectedGeneration: number): void => {
    if (!isActivationCurrent(expectedGeneration)) throw new ActivationSupersededError();
  };
  const loadActivationCandidate = async (
    candidateOverride: LoadedPermissionsConfig | undefined,
    expectedGeneration: number,
  ): Promise<LoadedPermissionsConfig> => {
    try {
      if (candidateOverride) return candidateOverride;
      return await loadPermissionsConfig(agentDir);
    } catch (error: unknown) {
      assertActivationCurrent(expectedGeneration);
      configFailure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  };

  type ActivationPrior = {
    loaded: LoadedPermissionsConfig | undefined;
    loadedKey: string | undefined;
    baseSandboxConfig: SandboxPolicy | undefined;
    sandboxState:
      | { kind: "pending" }
      | { kind: "disabled" }
      | { kind: "ready"; profile: LoadedPermissionsConfig["config"]["sandbox"]["profile"] }
      | { kind: "failed"; error: string };
  };

  const commitActivation = (
    ctx: Pick<ExtensionContext, "cwd" | "ui" | "hasUI">,
    key: string,
    candidate: LoadedPermissionsConfig,
    candidateSandbox: SandboxPolicy | undefined,
    nextSandboxState: ActivationPrior["sandboxState"],
    force: boolean,
  ): LoadedPermissionsConfig => {
    activationFailure = undefined;
    configFailure = undefined;
    if (force) {
      permissions.invalidate("permission context changed");
      invalidatePermissionContext("permission context changed");
    }
    loaded = candidate;
    loadedKey = key;
    baseSandboxConfig = candidateSandbox;
    sandboxState = nextSandboxState;
    setDefaultStatus(ctx);
    return candidate;
  };

  // Install the candidate sandbox for the new generation, rolling back to the
  // previous activation when initialization fails. Every staleness check sits
  // exactly where an await could have been superseded by a lifecycle reset; a
  // rollback still runs for obsolete generations because leaving the sandbox
  // manager torn down would poison the newer generation.
  const activateWithSandbox = async (
    ctx: Pick<ExtensionContext, "cwd" | "ui" | "hasUI">,
    key: string,
    candidate: LoadedPermissionsConfig,
    candidateSandbox: SandboxPolicy | undefined,
    previous: ActivationPrior,
    force: boolean,
    expectedGeneration: number,
  ): Promise<LoadedPermissionsConfig> => {
    try {
      if (candidateSandbox && sandboxManager.activate) {
        await sandboxManager.activate(candidateSandbox);
      } else {
        await sandboxManager.reset();
      }
      // reset() yields control to lifecycle handlers. A reset/session transition
      // that wins during that await must not let this old activation bring up a
      // sandbox for its obsolete configuration.
      assertActivationCurrent(expectedGeneration);
      if (candidateSandbox && !sandboxManager.activate) {
        await sandboxManager.initialize(candidateSandbox);
      }
    } catch (error: unknown) {
      assertActivationCurrent(expectedGeneration);
      try {
        if (previous.sandboxState.kind === "ready" && previous.baseSandboxConfig) {
          if (sandboxManager.activate) {
            await sandboxManager.activate(previous.baseSandboxConfig);
          } else {
            await sandboxManager.reset();
            await sandboxManager.initialize(previous.baseSandboxConfig);
          }
          assertActivationCurrent(expectedGeneration);
          sandboxState = previous.sandboxState;
        } else if (previous.sandboxState.kind === "disabled") {
          await sandboxManager.reset();
          sandboxState = previous.sandboxState;
        } else {
          await sandboxManager.reset();
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
          error: new Error(message),
        };
      }
      throw error;
    }
    return commitActivation(
      ctx,
      key,
      candidate,
      candidateSandbox,
      candidateSandbox
        ? { kind: "ready", profile: candidate.config.sandbox.profile }
        : { kind: "disabled" },
      force,
    );
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
        if (!requiresSandbox(effectiveCachedMode, loaded.config) && sandboxState.kind === "ready") {
          await sandboxManager.reset();
          assertActivationCurrent(expectedGeneration);
          sandboxState = { kind: "disabled" };
          baseSandboxConfig = undefined;
        }
        return loaded;
      }
    }
    if (!force && activationFailure?.key === key && cachedMode !== "yolo") {
      throw activationFailure.error;
    }

    const candidate = await loadActivationCandidate(candidateOverride, expectedGeneration);
    // A session/tree reset can supersede the activation while its candidate config
    // is loading. Do not let that obsolete activation reset or initialize the
    // shared sandbox runtime for the new generation.
    assertActivationCurrent(expectedGeneration);
    const effectiveMode = cachedMode ?? "auto";
    const previous: ActivationPrior = {
      loaded,
      loadedKey,
      baseSandboxConfig,
      sandboxState,
    };
    let candidateSandbox: SandboxPolicy | undefined;
    if (candidate.config.sandbox.enabled) {
      const gitMetadata = await inspectRepositoryGitMetadata(ctx.cwd);
      candidateSandbox = createSandboxRuntimeConfig(
        candidate.config.sandbox,
        ctx.cwd,
        defaultProtectedWritePaths(ctx.cwd, agentDir),
        gitMetadata.ok ? gitMetadata.writeRoots : [],
      );
    }

    if (!requiresSandbox(effectiveMode, candidate.config)) {
      assertActivationCurrent(expectedGeneration);
      await sandboxManager.reset();
      assertActivationCurrent(expectedGeneration);
      return commitActivation(ctx, key, candidate, undefined, { kind: "disabled" }, force);
    }

    return activateWithSandbox(
      ctx,
      key,
      candidate,
      candidateSandbox,
      previous,
      force,
      expectedGeneration,
    );
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

  interface PreparedPermissionExecution {
    executionSnapshot: PermissionExecutionSnapshot;
    executionContext: EffectiveExecutionContext;
  }

  const preparePermissionExecution = async (
    ctx: ExtensionContext,
  ): Promise<PreparedPermissionExecution> => {
    const activationGeneration = session.getGeneration();
    await activateConfig(ctx, false, undefined, undefined, activationGeneration);
    assertActivationCurrent(activationGeneration);
    const executionSnapshot = ensureExecutionSnapshot(ctx);
    if (!executionSnapshot) {
      throw new Error(ACTIVE_PERMISSION_CONTEXT_UNAVAILABLE);
    }
    const executionContext = getEffectiveExecutionContext(executionSnapshot);
    if (!executionContext) {
      throw new Error(ACTIVE_PERMISSION_CONTEXT_UNAVAILABLE);
    }
    if (!permissions.hasActiveTurn()) beginPermissionTurn(ctx, executionSnapshot);
    if (!permissions.hasActiveTurn()) throw new Error(ACTIVE_PERMISSION_CONTEXT_UNAVAILABLE);
    return { executionSnapshot, executionContext };
  };

  const createPiGuardianReviewContext = (
    event: ToolCallEvent,
    executionContext: EffectiveExecutionContext,
    ctx: ExtensionContext,
    transcript = currentGuardianTranscriptSnapshot(),
    canonicalCwd = resolve(ctx.cwd),
  ): PiGuardianReviewContext => {
    const configFingerprint = fingerprintConfig(executionContext.config);
    const guardianCwd = canonicalCwd;
    const suppliedGuardianPolicy = options.guardianPolicySource?.({
      cwd: guardianCwd,
      configFingerprint,
    });
    const guardianPolicy =
      suppliedGuardianPolicy === undefined
        ? undefined
        : validateGuardianPolicy(suppliedGuardianPolicy);
    return {
      event,
      transcript,
      autoReviewerContext: {
        modelRegistry: ctx.modelRegistry,
        activeModel: ctx.model,
        reviewer: executionContext.config.reviewer,
        guardianPolicy,
        guardianSession: {
          sessionId: stableSessionId(ctx, session.getGeneration()),
          cwd: guardianCwd,
          configFingerprint,
        },
      },
      sandboxProfile: executionContext.config.sandbox.profile,
      sandboxEnabled: executionContext.config.sandbox.enabled,
      baseSandboxPolicy: executionContext.baseSandboxConfig,
      onResult: (result) => {
        const guardian = result.guardian;
        if (guardian) {
          lastGuardianSelection = {
            guardian,
            cwd: guardianCwd,
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
            try {
              ctx.ui.notify(
                renderPermissionNotice({
                  kind: "reviewer-fallback",
                  preferredProvider: preferred?.provider ?? "configured",
                  preferredModel: preferred?.model ?? "reviewer",
                  activeProvider: guardian.provider,
                  activeModel: guardian.model,
                }),
                "warning",
              );
            } catch {
              // Reviewer fallback reporting is observational.
            }
          }
        }
      },
    };
  };

  const executePermissionAction = async <T, Input = unknown>(
    action: PiAction<T, PiGuardianReviewContext, Input>,
  ): Promise<T> => {
    const outcome: PiExecutionOutcome<T> = await permissions.submit(action);
    if (outcome.kind === "completed") return outcome.value;
    if (outcome.kind === "failed") {
      const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      const error = new Error(renderPermissionErrorForAgent({ code: "execution-failed", reason }));
      Object.assign(error, { code: "execution-failed", reason });
      throw error;
    }
    const error = new Error(renderPermissionErrorForAgent(outcome.error));
    Object.assign(error, outcome.error);
    throw error;
  };

  const authorizeHostTool = async (
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined> => {
    if (!event.toolCallId) {
      return {
        block: true,
        reason: "The host did not provide an action identifier. The action was not run.",
      };
    }

    // Capture the host action before any asynchronous preparation or risk
    // evaluation. Every later observer receives this immutable-at-ingress
    // value instead of a mutable object owned by the host.
    const actionSignal = ctx.signal;
    const captured = permissions.captureAction({
      id: event.toolCallId,
      tool: event.toolName,
      input: event.input,
      cwd: resolve(ctx.cwd),
      metadata: toolCallEventMetadata(event),
    });
    const { call } = captured;
    const actionId = call.id;
    const actionTool = call.tool;
    const canonicalCwd = call.cwd;
    const canonicalInput = call.input;
    const canonicalEvent: ToolCallEvent = {
      ...(isRecord(call.metadata) ? call.metadata : {}),
      type: "tool_call",
      toolCallId: actionId,
      toolName: actionTool,
      input: canonicalInput,
    } as ToolCallEvent;
    const capturedTranscript = currentGuardianTranscriptSnapshot();

    let prepared: PreparedPermissionExecution;
    try {
      prepared = await preparePermissionExecution(ctx);
    } catch (error: unknown) {
      if (isActivationSupersededError(error)) {
        return {
          block: true,
          reason: renderPermissionErrorForAgent({
            code: "stale-invocation",
            reason: "Permission activation was superseded by a newer task context",
          }),
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message === ACTIVE_PERMISSION_CONTEXT_UNAVAILABLE) {
        return { block: true, reason: message };
      }
      return reportPermissionSetupError(ctx, error);
    }

    const { executionSnapshot, executionContext } = prepared;
    let risk: RiskDecision | undefined;
    if (executionSnapshot.mode !== "yolo") {
      try {
        risk = await riskEvaluator(
          actionTool,
          structuredClone(canonicalInput) as Record<string, unknown>,
          canonicalCwd,
          executionContext.config,
          defaultProtectedWritePaths(canonicalCwd, agentDir),
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          block: true,
          reason: renderPermissionErrorForAgent({ code: "policy-error", reason: message }),
        };
      }
    }

    const action: PiAction<undefined, PiGuardianReviewContext> = {
      captured,
      kind: "host",
      risk,
      reviewContext: createPiGuardianReviewContext(
        canonicalEvent,
        executionContext,
        ctx,
        capturedTranscript,
        canonicalCwd,
      ),
      signal: actionSignal,
      execute: async (): Promise<PiActionOutcome<undefined>> => ({
        kind: "completed",
        value: undefined,
      }),
    };
    const outcome = await permissions.submit(action);
    if (outcome.kind === "completed") return;
    if (outcome.kind === "failed") {
      const message =
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      return {
        block: true,
        reason: renderPermissionErrorForAgent({ code: "execution-failed", reason: message }),
      };
    }
    return { block: true, reason: renderPermissionErrorForAgent(outcome.error) };
  };

  const evaluateManagedRisk = async (
    tool: string,
    input: Record<string, unknown>,
    ctx: ExtensionContext,
    executionContext: EffectiveExecutionContext,
    cwd = ctx.cwd,
  ): Promise<RiskDecision> => {
    try {
      const riskInput = structuredClone(input);
      return await riskEvaluator(
        tool,
        riskInput,
        cwd,
        executionContext.config,
        defaultProtectedWritePaths(cwd, agentDir),
      );
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      const presented = new Error(renderPermissionErrorForAgent({ code: "policy-error", reason }));
      Object.assign(presented, { code: "policy-error", reason });
      throw presented;
    }
  };

  type RuntimeDenialOutcome = Extract<PiActionOutcome<never>, { kind: "capability-denied" }>;

  const runtimeDenialOutcome = async (
    commandId: string,
    evidence: string,
  ): Promise<RuntimeDenialOutcome | undefined> => {
    if (!looksLikeSandboxDenial(evidence)) return undefined;
    const capability = await sandboxManager.classifyDenial?.(commandId);
    if (!capability) return undefined;
    const detail =
      capability.kind === "network"
        ? `Sandbox enforcement denied network access to ${capability.host} during execution`
        : `Sandbox enforcement denied writing ${capability.path} during execution`;
    return { kind: "capability-denied", request: capability, retryability: "safe", detail };
  };

  const executePermissionedBash = async (
    id: string,
    params: BashParams,
    signal: AbortSignal | undefined,
    onUpdate: BashOnUpdate,
    ctx: ExtensionContext,
  ): Promise<BashResult> => {
    const captured = permissions.captureAction({
      id,
      tool: "bash",
      input: params,
      cwd: resolve(ctx.cwd),
    });
    const { call } = captured;
    const actionId = call.id;
    const canonicalCwd = call.cwd;
    const canonicalParams = call.input;
    const capturedTranscript = currentGuardianTranscriptSnapshot();
    const { executionSnapshot, executionContext } = await preparePermissionExecution(ctx);

    const risk =
      executionSnapshot.mode === "yolo"
        ? undefined
        : await evaluateManagedRisk(
            "bash",
            canonicalParams as Record<string, unknown>,
            ctx,
            executionContext,
            canonicalCwd,
          );
    const event: ToolCallEvent = {
      type: "tool_call",
      toolCallId: actionId,
      toolName: "bash",
      input: canonicalParams,
    };
    const reviewContext = createPiGuardianReviewContext(
      event,
      executionContext,
      ctx,
      capturedTranscript,
      canonicalCwd,
    );
    const action: PiAction<BashResult, PiGuardianReviewContext, BashParams> = {
      captured,
      kind: "sandbox",
      risk,
      reviewContext,
      signal,
      execute: async ({
        mode,
        policy,
        plan,
        call,
        ordinal,
      }): Promise<PiActionOutcome<BashResult>> => {
        try {
          if (mode === "unrestricted") {
            return {
              kind: "completed",
              value: await bashToolFactory(canonicalCwd).execute(
                call.id,
                call.input,
                signal,
                onUpdate,
              ),
            };
          }
          if (mode !== "sandboxed" || !policy) {
            return {
              kind: "failed",
              error: new Error("Sandbox enforcement is unavailable for this action"),
            };
          }
          const sandboxedBash = bashToolFactory(canonicalCwd, {
            operations: createSandboxedBashOperations(sandboxManager, policy, {
              ...(plan?.kind === "git-init" ? { gitInitPlan: plan } : {}),
              commandId: call.id,
            }),
          });
          return {
            kind: "completed",
            value: await sandboxCoordinator.runShared(
              () => sandboxedBash.execute(call.id, call.input, signal, onUpdate),
              signal,
            ),
          };
        } catch (error: unknown) {
          if (ordinal === 0 && mode === "sandboxed" && !signal?.aborted) {
            const denied = await runtimeDenialOutcome(call.id, errorMessage(error));
            if (denied) return denied;
          }
          return { kind: "failed", error };
        }
      },
    };
    return executePermissionAction(action);
  };

  type FileMutationParams = WriteParams | EditParams;

  const riskForFileMutation = async (
    tool: "write" | "edit",
    params: FileMutationParams,
    executionSnapshot: PermissionExecutionSnapshot,
    executionContext: EffectiveExecutionContext,
    ctx: ExtensionContext,
    canonicalCwd: string,
  ): Promise<RiskDecision | undefined> => {
    if (executionSnapshot.mode === "yolo") return undefined;
    const decision = await evaluateManagedRisk(
      tool,
      params as Record<string, unknown>,
      ctx,
      executionContext,
      canonicalCwd,
    );
    if (decision.action !== "prompt") return decision;
    const target = resolvePolicyPath(params.path, canonicalCwd);
    const requested = decision.filesystemWriteRoots ?? [];
    if (requested.some((path) => resolvePolicyPath(path, canonicalCwd) === target)) {
      return decision;
    }
    return {
      ...decision,
      filesystemWriteRoots: [...requested, target],
    };
  };

  type FileMutationExecutor<P, U, R> = (
    id: string,
    params: P,
    signal: AbortSignal | undefined,
    onUpdate: U,
    cwd: string,
  ) => Promise<R>;

  const executePermissionedFileMutation = async <P extends FileMutationParams, U, R>(
    tool: "write" | "edit",
    id: string,
    params: P,
    signal: AbortSignal | undefined,
    onUpdate: U,
    ctx: ExtensionContext,
    bare: FileMutationExecutor<P, U, R>,
    sandboxed: (
      policy: SandboxPolicy,
      id: string,
      params: P,
      signal: AbortSignal | undefined,
      onUpdate: U,
      cwd: string,
    ) => Promise<R>,
  ): Promise<R> => {
    const captured = permissions.captureAction({
      id,
      tool,
      input: params,
      cwd: resolve(ctx.cwd),
    });
    const { call } = captured;
    const actionId = call.id;
    const actionTool = call.tool as "write" | "edit";
    const canonicalCwd = call.cwd;
    const canonicalParams = call.input;
    const capturedTranscript = currentGuardianTranscriptSnapshot();
    const { executionSnapshot, executionContext } = await preparePermissionExecution(ctx);
    const risk = await riskForFileMutation(
      actionTool,
      canonicalParams,
      executionSnapshot,
      executionContext,
      ctx,
      canonicalCwd,
    );
    const event = {
      type: "tool_call" as const,
      toolCallId: actionId,
      toolName: actionTool,
      input: canonicalParams,
    } as ToolCallEvent;
    const action: PiAction<R, PiGuardianReviewContext, P> = {
      captured,
      kind: "sandbox",
      risk,
      reviewContext: createPiGuardianReviewContext(
        event,
        executionContext,
        ctx,
        capturedTranscript,
        canonicalCwd,
      ),
      signal,
      execute: async ({ mode, policy, call, ordinal }): Promise<PiActionOutcome<R>> => {
        try {
          if (mode === "unrestricted") {
            return {
              kind: "completed",
              value: await bare(call.id, call.input, signal, onUpdate, canonicalCwd),
            };
          }
          if (mode !== "sandboxed" || !policy) {
            return {
              kind: "failed",
              error: new Error("Sandbox enforcement is unavailable for this action"),
            };
          }
          return {
            kind: "completed",
            value: await sandboxCoordinator.runShared(
              () => sandboxed(policy, call.id, call.input, signal, onUpdate, canonicalCwd),
              signal,
            ),
          };
        } catch (error: unknown) {
          if (ordinal === 0 && mode === "sandboxed" && !signal?.aborted) {
            const denied = await runtimeDenialOutcome(call.id, errorMessage(error));
            if (denied) return denied;
          }
          return { kind: "failed", error };
        }
      },
    };
    return executePermissionAction(action);
  };

  const executePermissionedWrite = (
    id: string,
    params: WriteParams,
    signal: AbortSignal | undefined,
    onUpdate: WriteOnUpdate,
    ctx: ExtensionContext,
  ): Promise<WriteResult> =>
    executePermissionedFileMutation(
      "write",
      id,
      params,
      signal,
      onUpdate,
      ctx,
      (callId, callParams, callSignal, callOnUpdate, cwd) =>
        createWriteTool(cwd).execute(callId, callParams, callSignal, callOnUpdate),
      (policy, callId, callParams, callSignal, callOnUpdate, cwd) =>
        createWriteTool(cwd, {
          operations: createSandboxedFileOperations(sandboxManager, policy, [], callSignal, callId),
        }).execute(callId, callParams, callSignal, callOnUpdate),
    );

  const executePermissionedEdit = (
    id: string,
    params: EditParams,
    signal: AbortSignal | undefined,
    onUpdate: EditOnUpdate,
    ctx: ExtensionContext,
  ): Promise<EditResult> =>
    executePermissionedFileMutation(
      "edit",
      id,
      params,
      signal,
      onUpdate,
      ctx,
      (callId, callParams, callSignal, callOnUpdate, cwd) =>
        createEditTool(cwd).execute(callId, callParams, callSignal, callOnUpdate),
      (policy, callId, callParams, callSignal, callOnUpdate, cwd) =>
        createEditTool(cwd, {
          operations: createSandboxedFileOperations(sandboxManager, policy, [], callSignal, callId),
        }).execute(callId, callParams, callSignal, callOnUpdate),
    );

  pi.registerTool({
    ...baseBash,
    ...adoptHostTheme(codexBashToolSpec),
    label: "bash",
    description: `${baseBash.description} When the active sandbox does not allow a required filesystem or network operation, request only the smallest exact permission needed and provide a concrete justification.`,
    promptGuidelines: [
      "When the active sandbox does not allow a required operation, request only the smallest exact permission needed and explain why.",
    ],
    parameters: permissionedBashParameters,
    executionMode: "sequential",
    execute: executePermissionedBash,
  });

  pi.registerTool({
    ...baseWrite,
    ...adoptHostTheme(codexWriteToolSpec),
    executionMode: "sequential",
    execute: executePermissionedWrite,
  });

  pi.registerTool({
    ...baseEdit,
    ...adoptHostTheme(codexEditToolSpec),
    executionMode: "sequential",
    execute: executePermissionedEdit,
  });

  pi.registerTool({
    name: "request_permissions",
    label: "request_permissions",
    description:
      "Request a scoped filesystem or network permission. With Approve for me, eligible requests are evaluated by Auto-review. Approval changes only the requested scope and does not disable the sandbox. Protected paths and prohibited targets remain blocked.",
    promptSnippet: "Request explicit filesystem/network permissions",
    parameters: Type.Object({
      reason: Type.Optional(Type.String()),
      permissions: Type.Object({
        filesystem: Type.Optional(Type.Object({ write: Type.Array(Type.String()) })),
        network: Type.Optional(Type.Object({ hosts: Type.Array(Type.String()) })),
      }),
      scope: Type.Optional(Type.Union([Type.Literal("turn"), Type.Literal("session")])),
    }),
    async execute(id, params, _signal, _onUpdate, ctx) {
      const actionSignal = _signal;
      const captured = permissions.captureAction({
        id,
        tool: "request_permissions",
        input: params,
        cwd: resolve(ctx.cwd),
      });
      const { call } = captured;
      const actionId = call.id;
      const canonicalCwd = call.cwd;
      const canonicalParams = call.input;
      const capturedTranscript = currentGuardianTranscriptSnapshot();
      const { executionContext } = await preparePermissionExecution(ctx);
      const decision = await evaluateManagedRisk(
        "request_permissions",
        canonicalParams as Record<string, unknown>,
        ctx,
        executionContext,
        canonicalCwd,
      );
      if (decision.action === "block") {
        const error = new Error(
          renderPermissionErrorForAgent({ code: "policy-denied", reason: decision.reason }),
        );
        Object.assign(error, { code: "policy-denied", reason: decision.reason });
        throw error;
      }
      if (
        decision.action !== "prompt" ||
        ((decision.networkHosts?.length ?? 0) === 0 &&
          (decision.filesystemWriteRoots?.length ?? 0) === 0)
      ) {
        const error = new Error(
          renderPermissionErrorForAgent({
            code: "policy-denied",
            reason: "request_permissions requires a non-empty capability request",
          }),
        );
        Object.assign(error, {
          code: "policy-denied",
          reason: "request_permissions requires a non-empty capability request",
        });
        throw error;
      }
      const scope = canonicalParams.scope === "session" ? "session" : "turn";
      const reason = canonicalParams.reason ?? decision.reason;
      const event = {
        type: "tool_call" as const,
        toolCallId: actionId,
        toolName: "request_permissions",
        input: canonicalParams,
      } as ToolCallEvent;
      const action: PiAction<WriteResult, PiGuardianReviewContext, typeof canonicalParams> = {
        captured,
        kind: "permission-amendment",
        risk: decision,
        permission: {
          scope,
          reason,
        },
        reviewContext: createPiGuardianReviewContext(
          event,
          executionContext,
          ctx,
          capturedTranscript,
          canonicalCwd,
        ),
        signal: actionSignal,
        execute: async ({ mode, policy }): Promise<PiActionOutcome<WriteResult>> => {
          try {
            if (mode === "unrestricted") {
              return {
                kind: "completed",
                value: {
                  content: [
                    {
                      type: "text",
                      text: "Full access is already active; no additional permission grant was recorded.",
                    },
                  ],
                  details: undefined,
                },
              };
            }
            if (mode !== "sandboxed" || !policy) {
              return {
                kind: "failed",
                error: new Error("Sandbox enforcement is unavailable for this action"),
              };
            }
            const grantedHosts = [...(decision.networkHosts ?? [])];
            const grantedRoots = [...(decision.filesystemWriteRoots ?? [])];
            return {
              kind: "completed",
              value: {
                content: [
                  {
                    type: "text",
                    text: `Granted ${scope} permissions${
                      grantedHosts.length > 0 ? `; hosts: ${grantedHosts.join(", ")}` : ""
                    }${grantedRoots.length > 0 ? `; write roots: ${grantedRoots.join(", ")}` : ""}`,
                  },
                ],
                details: undefined,
              },
            };
          } catch (error: unknown) {
            return { kind: "failed", error };
          }
        },
      };
      return executePermissionAction(action);
    },
  });

  const reportPermissionSetupError = (
    ctx: ExtensionContext,
    error: unknown,
  ): ToolCallEventResult => {
    const message = error instanceof Error ? error.message : String(error);
    const notice =
      error instanceof ConfigError
        ? renderPermissionNotice({ kind: "configuration-invalid", reason: message })
        : renderPermissionNotice({
            kind: "sandbox-activation-failed",
            reason: message,
            recovery: sandboxState.kind === "failed" ? "unavailable" : "restored",
          });
    setDefaultStatus(ctx);
    if (ctx.hasUI) ctx.ui.notify(notice, "error");
    return { block: true, reason: notice };
  };

  pi.on("session_start", async (_event, ctx) => {
    shortcutWarningShown = false;
    resetBranchPermissionContext("session changed");
    session.clearLifecycleEvents();
    const generation = session.getGeneration();
    let candidate: LoadedPermissionsConfig;
    try {
      candidate = await loadPermissionsConfig(agentDir);
    } catch (error: unknown) {
      if (!session.isCurrentGeneration(generation)) return;
      configFailure = error instanceof Error ? error : new Error(String(error));
      reportPermissionSetupError(ctx, error);
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
          ctx.ui.notify(renderPermissionNotice({ kind: "shortcut-conflict" }), "warning");
        }
      }
    } catch (error: unknown) {
      if (!session.isCurrentGeneration(generation)) return;
      reportPermissionSetupError(ctx, error);
    }
  });

  pi.on("session_before_tree", () => {
    resetBranchPermissionContext("session tree changed");
  });

  pi.on("session_tree", (_event, ctx) => {
    resetBranchPermissionContext("session tree changed");
    return session.runModeMutation(async (generation) => {
      if (loaded && modeRuntime && session.isCurrentGeneration(generation)) {
        const previousMode = modeRuntime.mode;
        const restoredRuntime = new PermissionModeRuntime(loaded.config, pi.appendEntry.bind(pi));
        restoredRuntime.restore(ctx.sessionManager.getBranch(), loaded.config);
        const restoredMode = restoredRuntime.mode;
        try {
          await activateConfig(ctx, false, restoredMode, loaded, generation);
        } catch (error: unknown) {
          if (!session.isCurrentGeneration(generation)) return;
          reportPermissionSetupError(ctx, error);
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
    permissions.invalidate("session shutdown");
    session.bumpGeneration();
    cancelInFlightModeTransition();
    session.resetTurn();
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

  pi.on("agent_start", async (_event, ctx) => {
    session.markLifecycleEvent();
    if (session.getTurnPhase() === "active") return;
    const startingTurnId = session.allocateTurnId();
    session.beginTurn(startingTurnId);
    const transition = session.getInFlightBarrier();
    if (transition) {
      const readyForNextTurn = await transition.completion;
      session.clearInFlightIfCurrent(transition);
      if (
        !readyForNextTurn ||
        session.getTurnPhase() !== "active" ||
        !session.isCurrentTurn(startingTurnId)
      ) {
        return;
      }
    }
    modeRuntime?.beginAgentTurn();
    const executionSnapshot = captureExecutionSnapshot(startingTurnId);
    if (executionSnapshot) beginPermissionTurn(ctx, executionSnapshot);
  });

  pi.on("agent_end", () => {
    session.markLifecycleEvent();
    finishPermissionTurn("permission turn ended");
  });

  pi.on("agent_settled", () => {
    session.markLifecycleEvent();
    finishPermissionTurn("permission turn settled");
    session.settleBetween();
  });

  pi.on(
    "tool_call",
    async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
      if (
        event.toolName === "bash" ||
        event.toolName === "write" ||
        event.toolName === "edit" ||
        event.toolName === "request_permissions"
      ) {
        return;
      }
      return authorizeHostTool(event, ctx);
    },
  );

  pi.registerCommand("approve", {
    description: "Authorize one exact retry of a recent Auto-review denial",
    handler: async (_args, ctx) => {
      let result: LoadedPermissionsConfig;
      const activationGeneration = session.getGeneration();
      try {
        result = await activateConfig(ctx, false, undefined, undefined, activationGeneration);
        assertActivationCurrent(activationGeneration);
      } catch (error: unknown) {
        if (isActivationSupersededError(error)) return;
        reportPermissionSetupError(ctx, error);
        return;
      }
      const runtime = ensureModeRuntime(result.config);
      if (runtime.mode !== "auto") {
        ctx.ui.notify(renderPermissionNotice({ kind: "approve-requires-mode" }), "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(renderPermissionNotice({ kind: "approve-requires-ui" }), "warning");
        return;
      }
      const recovery = await permissions.recoverDeniedAction(ctx.ui);
      if (recovery.kind === "empty") {
        ctx.ui.notify(renderPermissionNotice({ kind: "approve-empty" }), "info");
        return;
      }
      if (recovery.kind !== "armed") {
        if (recovery.kind === "stale") {
          ctx.ui.notify(renderPermissionNotice({ kind: "approve-stale" }), "warning");
        }
        return;
      }
      pi.sendMessage(
        {
          customType: "pi-permissions-auto-override",
          content: renderExactRetryInstruction(recovery.dispatch),
          display: true,
          details: {
            denialId: recovery.dispatch.denialId,
          },
        },
        { triggerTurn: true },
      );
    },
  });

  const cyclePermissionMode = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.isIdle()) ensureExecutionSnapshot(ctx);
    const beganDuringActiveTurn = session.getTurnPhase() === "active";
    // Register the barrier synchronously with the shortcut invocation. A queued
    // agent_start must observe it even if agent_end runs before this mutation's
    // first asynchronous continuation.
    const transitionBarrier = createModeTransitionBarrier();
    const pendingBeforeTransition = session.getPendingTransition();
    const modeBeforeCycle = modeRuntime ? modeRuntime.mode : "auto";
    // The switch itself runs immediately. An active turn keeps its captured
    // execution snapshot; a pending token prevents a downgrade's async
    // activation from tearing that snapshot down mid-turn. The lifecycle
    // boundary clears the token, and the next turn captures the new mode.
    const isUpgrade = MODE_RANK[nextMode(modeBeforeCycle)] > MODE_RANK[modeBeforeCycle];
    const transition = beganDuringActiveTurn && !isUpgrade ? scheduleModeTransition() : undefined;
    const transitionOwnsPendingState =
      transition !== undefined && transition !== pendingBeforeTransition;

    try {
      await session.runModeMutation(async (generation) => {
        try {
          if ((await shiftTabAvailability(agentDir)) !== "available") {
            ctx.ui.notify(renderPermissionNotice({ kind: "shortcut-conflict" }), "warning");
            settleModeTransitionBarrier(transitionBarrier, true);
            return;
          }
          if (!transition && !beganDuringActiveTurn) {
            // Between turns and while idle there is no snapshot to preserve.
            // Invalidate the current permission/reviewer context before activation;
            // active-turn transitions leave the snapshot untouched.
            permissions.invalidate(PERMISSION_MODE_CHANGED_REASON);
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
          // two-state mode (auto -> yolo -> auto) instead of both reading the
          // same starting mode.
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
          if (beganDuringActiveTurn && previousMode === "yolo" && targetMode === "auto") {
            // A downgrade must not leave the active turn's captured YOLO
            // snapshot unrestricted. Abort it so the next turn captures Auto.
            ctx.abort();
          }
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
          ctx.ui.notify(
            renderPermissionNotice({ kind: "mode-change-failed", reason: message }),
            "error",
          );
        }
      });
    } finally {
      // runModeMutation can discard a stale generation before invoking the operation.
      settleModeTransitionBarrier(transitionBarrier, false);
    }
  };

  pi.registerShortcut("shift+tab", {
    description: "Cycle permission mode",
    handler: cyclePermissionMode,
  });

  pi.registerCommand("permissions", {
    description: "Show the active permission policy",
    handler: async (_args, ctx) =>
      session.runModeMutation(async (generation) => {
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
            ctx.ui.notify(
              renderPermissionSummary({
                mode: runtime.mode,
                sandbox: "sandbox off",
                autoReviewAvailable: false,
                ruleCount: config.rules.length,
                writeRoots: config.sandbox.filesystem.allowWrite,
              }),
              "info",
            );
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
          const activeReviewer =
            lastGuardianSelection !== undefined &&
            lastGuardianSelection.cwd === resolve(ctx.cwd) &&
            lastGuardianSelection.configFingerprint === configFingerprint
              ? lastGuardianSelection.guardian
              : undefined;
          ctx.ui.notify(
            renderPermissionSummary({
              mode: runtime.mode,
              sandbox: sandboxSummary,
              reviewer: activeReviewer
                ? {
                    kind: "active",
                    provider: activeReviewer.provider,
                    model: activeReviewer.model,
                  }
                : config.reviewer
                  ? {
                      kind: "preference",
                      provider: config.reviewer.provider,
                      model: config.reviewer.model,
                    }
                  : undefined,
              autoReviewAvailable: !runtime.autoState.paused,
              ruleCount: config.rules.length,
              writeRoots: config.sandbox.filesystem.allowWrite,
            }),
            "info",
          );
        } catch (error: unknown) {
          if (!session.isCurrentGeneration(generation)) return;
          if (!candidateLoaded) {
            configFailure = error instanceof Error ? error : new Error(String(error));
          }
          if (modeRuntime?.mode === "yolo" && !ctx.isIdle()) ctx.abort();
          reportPermissionSetupError(ctx, error);
        }
      }),
  });
}
