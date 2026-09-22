import { statSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createLocalBashOperations,
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
import { matchesNetworkDomainPattern } from "./approve-for-me-engine.ts";
import { type AutoReviewer, type GuardianReviewIdentity, PiAutoReviewer } from "./auto-reviewer.ts";
import {
  ConfigError,
  effectiveNetworkAuthority,
  fingerprintConfig,
  fingerprintValue,
  type LoadedSafetyConfig,
  loadSafetyConfig,
  type SafetyConfig,
} from "./config.ts";
import {
  createAuditLink,
  createDelegationPlan,
  type DelegationEnvelope,
  intersectSandboxPolicy,
  isNetworkCovered,
  isWriteCovered,
  resolveChildEnvelope,
} from "./delegation.ts";
import {
  defaultProtectedWritePaths,
  expandSymlinkAliases,
  hasGlobSyntax,
  resolvePolicyPath,
} from "./filesystem-policy.ts";
import { discoverGitMetadataProtectionRoots } from "./git-metadata.ts";
import {
  buildGuardianMetricsRecord,
  mapActionTag,
  mapFailureReason,
  mapTerminalStatus,
} from "./guardian/metrics.ts";
import { GUARDIAN_DENIAL_WINDOW_SIZE, validateGuardianPolicy } from "./guardian-policy.ts";
import type { GuardianReviewSessionManager } from "./guardian-session.ts";
import {
  appendGuardianTranscript,
  boundGuardianTranscript,
  type GuardianTranscriptEntry,
} from "./guardian-transcript.ts";
import { PermissionModeRuntime } from "./mode-runtime.ts";
import { NetworkBoundary } from "./network-boundary.ts";
import { isExactLocalNetworkAllowed } from "./network-domain-pattern.ts";
import {
  renderExactRetryInstruction,
  renderPermissionErrorForAgent,
  renderPermissionNotice,
  renderPermissionSummary,
} from "./permission-copy.ts";
import type { ModeTransitionBarrier } from "./permission-session.ts";
import { type PermissionExecutionSnapshot, PermissionSession } from "./permission-session.ts";
import { canonicalize } from "./permissions/paths.ts";
import {
  createPiGuardianAdapter,
  type PiGuardianReviewContext,
} from "./pi-approve-for-me-adapters.ts";
import {
  type PiAction,
  type PiActionOutcome,
  type PiExecutionAttempt,
  type PiExecutionOutcome,
  PiSafetyRuntime,
  type PiTurnSnapshot,
} from "./pi-safety.ts";
import {
  guardianTranscriptEntryFromMessage,
  nextMode,
  normalizeEscalatedBashTimeout,
  requiresSandbox,
} from "./register-support.ts";
import {
  createReviewResultRenderer,
  createReviewStatusBridge,
  plainReviewResultRenderer,
  type ReviewPartialResult,
  type ReviewRenderResult,
} from "./review-renderer.ts";
import {
  evaluateHostFirstRulesOnly,
  evaluateRiskRequest,
  isSupportedPermissionRequestShape,
  type RiskDecision,
} from "./risk-policy.ts";
import { SrtSandboxManager } from "./sandbox/srt-enforcer.ts";
import {
  createSandboxedBashOperations,
  createSandboxedFileOperations,
  type SandboxedFileOperationOptions,
} from "./sandbox.ts";
import { SandboxExecutionCoordinator } from "./sandbox-coordinator.ts";
import {
  createSandboxRuntimeConfig,
  describeExecutionNetwork,
  looksLikeSandboxDenial,
  type NativeFileOperationFailure,
  type SandboxManagerLike,
  type SandboxNetworkAuthorize,
  type SandboxPolicy,
} from "./sandbox-policy.ts";
import {
  permissionedBashParameters,
  preparePermissionedBashArguments,
} from "./shell-permissions.ts";
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
  /** Builds the operations used for unrestricted/escalated leases. Default: pi's local shell backend. */
  localBashOperations?: () => BashOperations;
  sandboxCoordinator?: Pick<SandboxExecutionCoordinator, "runShared" | "runExclusive">;
  autoReviewer?: AutoReviewer;
  guardianSessionManager?: GuardianReviewSessionManager;
  guardianPolicySource?: GuardianPolicySource;
  riskEvaluator?: typeof evaluateRiskRequest;
  networkBoundary?: NetworkBoundary;
}

type ExecutablePermissionMode = PermissionMode;

interface EffectiveExecutionContext {
  snapshot: PermissionExecutionSnapshot;
  mode: ExecutablePermissionMode;
  config: SafetyConfig;
  baseSandboxConfig?: SandboxPolicy;
  sandboxReady: boolean;
}

class ActivationSupersededError extends Error {
  constructor() {
    super("pi-safety: permission activation was superseded by a newer session");
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

/** Owned tools: same-name registerTool.execute owns risk → Engine → SRT. */
const PI_OWNED_TOOL_NAMES = new Set(["bash", "write", "edit", "request_permissions"]);

/**
 * Pi host-first read-only tools: tool_call B (rules deny only). Foreign
 * MCP/custom tools are out of scope (A pass-through).
 */
const PI_HOST_FIRST_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);

export function registerExtension(pi: ExtensionAPI, options: RegisterExtensionOptions = {}): void {
  const agentDir = options.agentDir ?? getAgentDir();
  const sandboxManager: SandboxManagerLike = options.sandboxManager ?? new SrtSandboxManager();
  const networkBoundary = options.networkBoundary ?? new NetworkBoundary();
  const bashToolFactory = options.bashToolFactory ?? createBashTool;
  // Builds the operations used for unrestricted/escalated leases. Test
  // doubles replace this with a stub to avoid real spawns; production uses
  // pi's local shell backend.
  const resolveLocalBashOperations = options.localBashOperations ?? createLocalBashOperations;
  const baseBash = bashToolFactory(process.cwd());
  const baseWrite = createWriteTool(process.cwd());
  const baseEdit = createEditTool(process.cwd());
  const sandboxCoordinator = options.sandboxCoordinator ?? new SandboxExecutionCoordinator();
  const managedRiskEvaluator = options.riskEvaluator ?? evaluateRiskRequest;
  const autoReviewer =
    options.autoReviewer ?? new PiAutoReviewer(undefined, options.guardianSessionManager);
  let loaded: LoadedSafetyConfig | undefined;
  let loadedKey: string | undefined;
  let configFailure: Error | undefined;
  let activationFailure: { key: string; error: Error } | undefined;
  let modeRuntime: PermissionModeRuntime | undefined;
  let shortcutWarningShown = false;
  let guardianTranscript: GuardianTranscriptEntry[] = [];
  let guardianTranscriptEpoch = 0;
  let inputFallbackTranscript: GuardianTranscriptEntry[] = [];
  let guardianInvalidationAfterModeChange = false;
  /** Set by a mid-turn cycle; cleared when the step boundary actually applies it. */
  let pendingModeRefresh = false;
  const permissions = new PiSafetyRuntime<PiGuardianReviewContext>({
    guardian: createPiGuardianAdapter(autoReviewer),
    policy: {
      check: ({ requested, phase }) => {
        if (phase !== "runtime") return { kind: "allow" };
        if (!loaded || !modeRuntime)
          return { kind: "deny", reason: "Permission context unavailable" };
        for (const request of requested) {
          const violation =
            request.kind === "filesystem" && request.operation === "write"
              ? checkDelegationWrite(request.path, modeRuntime.mode, loaded.config)
              : request.kind === "network"
                ? checkDelegationNetwork(request.host, modeRuntime.mode, loaded.config)
                : undefined;
          if (violation) return { kind: "deny", reason: violation };
        }
        return { kind: "allow" };
      },
    },
    reviewEventSink: (event) => {
      pi.events.emit("pi-safety:review", event);
      // Best-effort local metrics sink. Never throws into the authorization path.
      if (event.status !== "reviewing" && event.metrics) {
        const record = buildGuardianMetricsRecord({
          reviewId: event.reviewId,
          terminalStatus: mapTerminalStatus(event.status),
          failureReason: mapFailureReason(
            event.metrics.failureKind as Parameters<typeof mapFailureReason>[0],
          ),
          action: mapActionTag(event.call.tool),
          ownership: event.ownership,
          sessionKind: event.metrics.sessionKind ?? "trunk_new",
          hadPriorReviewContext: event.metrics.hadPriorReviewContext ?? false,
          ...(event.metrics.riskLevel === undefined ? {} : { riskLevel: event.metrics.riskLevel }),
          ...(event.metrics.userAuthorization === undefined
            ? {}
            : { userAuthorization: event.metrics.userAuthorization }),
          ...(event.metrics.outcome === undefined ? {} : { outcome: event.metrics.outcome }),
          ...(event.metrics.guardianModel === undefined
            ? {}
            : { guardianModel: event.metrics.guardianModel }),
          ...(event.metrics.guardianReasoningEffort === undefined
            ? {}
            : { guardianReasoningEffort: event.metrics.guardianReasoningEffort }),
          ...(event.metrics.staticRisk === undefined
            ? {}
            : { staticRisk: event.metrics.staticRisk }),
          ...(event.metrics.reviewSource === undefined
            ? {}
            : { reviewSource: event.metrics.reviewSource }),
          ...(event.metrics.residualSignals === undefined
            ? {}
            : { residualSignals: event.metrics.residualSignals }),
          durationMs: event.metrics.durationMs,
          ...(event.metrics.tokenUsage === undefined
            ? {}
            : { tokenUsage: event.metrics.tokenUsage }),
        });
        void (async () => {
          try {
            const { appendFile } = await import("node:fs/promises");
            await appendFile(
              join(agentDir, "guardian-metrics.jsonl"),
              `${JSON.stringify(record)}\n`,
            );
          } catch {
            // Metrics are observational; never surface sink failures.
          }
        })();
      }
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
    | { kind: "ready"; profile: LoadedSafetyConfig["config"]["sandbox"]["profile"] }
    | { kind: "failed"; error: string } = { kind: "pending" };

  /**
   * A cached `sandboxReady` bit is a lifecycle fact, not proof that the SRT
   * process is still usable. Backends may expose a live health check; legacy
   * test adapters without one retain the existing ready-state behaviour.
   */
  const sandboxManagerHealthy = (): boolean => {
    if (sandboxState.kind !== "ready") return false;
    if (typeof sandboxManager.isHealthy !== "function") return true;
    try {
      return sandboxManager.isHealthy();
    } catch {
      return false;
    }
  };

  const escalationEligibility = (
    snapshot: Pick<
      PermissionExecutionSnapshot,
      "mode" | "config" | "sandboxReady" | "baseSandboxConfig"
    >,
    baseSandboxConfig = snapshot.baseSandboxConfig,
  ): { eligible: boolean; reason: string } => {
    if (snapshot.mode !== "auto") {
      return { eligible: false, reason: "Command escalation is unavailable outside auto mode" };
    }
    if (!snapshot.sandboxReady || baseSandboxConfig === undefined || !sandboxManagerHealthy()) {
      return {
        eligible: false,
        reason: "Sandbox executor is unavailable or poisoned",
      };
    }
    // Codex parity: only denied reads make unsandboxed execution illegal.
    // denyWrite / deniedDomains are dropped on a Codex-style bypass as well.
    if (snapshot.config.sandbox.filesystem.denyRead.length > 0) {
      return {
        eligible: false,
        reason: "Command escalation cannot preserve configured denyRead rules",
      };
    }
    if (session.activeDelegationCeiling()) {
      return {
        eligible: false,
        reason: "Command escalation is outside the active delegation envelope",
      };
    }
    return {
      eligible: true,
      reason: "Sandbox is healthy and neither denyRead nor a delegation ceiling apply",
    };
  };

  const setDefaultStatus = (ctx: Pick<ExtensionContext, "ui">): void => {
    ctx.ui.setStatus("pi-safety", modeRuntime?.statusLabel ?? "Approve for me");
    // Structured mode event for status consumers (e.g. statusline). The
    // string published via setStatus above stays as the built-in-footer
    // fallback; consumers should key off `mode`/`severity`, never the label.
    pi.events.emit("pi-safety:mode", {
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
    guardianTranscriptEpoch += 1;
    inputFallbackTranscript = [];
    guardianInvalidationAfterModeChange = false;
    session.resetTurn();
    pendingModeRefresh = false;
    invalidatePermissionContext(reason);
  };

  const ensureModeRuntime = (config: SafetyConfig): PermissionModeRuntime => {
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

  const requiresNetworkQuiescence = (network: SandboxPolicy["network"] | undefined): boolean => {
    if (!network) return false;
    const authority = effectiveNetworkAuthority(network);
    return (
      (network.access?.kind === "explicit" && network.access.transport === "direct") ||
      network.macosTls === "system" ||
      authority.localBinding
    );
  };

  const assertUnmediatedExecutionCurrent = (
    policy: SandboxPolicy,
    snapshot: PermissionExecutionSnapshot,
  ): void => {
    if (
      requiresNetworkQuiescence(policy.network) &&
      (!getEffectiveExecutionContext(snapshot) || session.activeDelegationCeiling())
    ) {
      throw new Error("Unmediated network execution is outside the current permission scope");
    }
  };

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

  /**
   * Tool names that spawn a delegated subagent turn. A call to one of these
   * is the delegation point: the parent declares the child's upper bound
   * here, enforced as a ceiling for the whole nested turn.
   */
  const DELEGATED_TOOL_NAMES = new Set(["subagent"]);

  /** Remaining delegation levels below the current (possibly nested) turn. */
  const delegationRemainingDepth = (config: SafetyConfig): number => {
    const ceiling = session.activeDelegationCeiling();
    if (ceiling?.maxDepth !== undefined) return ceiling.maxDepth;
    return config.delegation.maxDepth - (session.getTurnDepth() - 1);
  };

  const checkDelegateSpawn = (
    tool: string,
    config: SafetyConfig,
  ): { blocked: true; reason: string } | { blocked: false } => {
    if (!DELEGATED_TOOL_NAMES.has(tool)) return { blocked: false };
    if (!session.activeDelegationAllowsReDelegate()) {
      return {
        blocked: true,
        reason:
          "Re-delegation is disabled by the active delegation envelope: this subagent may not spawn its own subagents.",
      };
    }
    if (delegationRemainingDepth(config) <= 0) {
      return {
        blocked: true,
        reason: `Delegation depth limit reached (max ${config.delegation.maxDepth} nested subagent levels): refusing to spawn a deeper subagent.`,
      };
    }
    return { blocked: false };
  };

  const checkDelegationWrite = (
    absolutePath: string,
    mode: ExecutablePermissionMode,
    config: SafetyConfig,
  ): string | undefined => {
    if (mode === "yolo" || !config.delegation.enabled) return undefined;
    const ceiling = session.activeDelegationCeiling();
    if (!ceiling || isWriteCovered(absolutePath, ceiling)) return undefined;
    const roots = ceiling.writeRoots.length === 0 ? "(none)" : ceiling.writeRoots.join(", ");
    return (
      `Write to ${absolutePath} is outside the delegation envelope for this subagent ` +
      `(allowed roots: ${roots}).`
    );
  };

  const checkDelegationNetwork = (
    host: string,
    mode: ExecutablePermissionMode,
    _config: SafetyConfig,
  ): string | undefined => {
    if (mode === "yolo") return undefined;
    const ceiling = session.activeDelegationCeiling();
    if (!ceiling || isNetworkCovered(host, ceiling)) return undefined;
    const hosts = ceiling.networkHosts.length === 0 ? "(none)" : ceiling.networkHosts.join(", ");
    return (
      `Network access to ${host} is outside the delegation envelope for this subagent ` +
      `(allowed hosts: ${hosts}).`
    );
  };

  type NestedPermissionTurnResult = "opened" | "blocked" | "saturated" | "stale";

  const materializeDelegationRoots = async (
    roots: readonly string[],
    cwd: string,
  ): Promise<string[]> => {
    const materialized = new Set<string>();
    for (const root of roots) {
      if (typeof root !== "string" || root.length === 0 || hasGlobSyntax(root)) {
        throw new Error("Delegation write roots must be concrete paths");
      }
      const canonicalRoot = await canonicalize(resolvePolicyPath(root, cwd));
      for (const alias of expandSymlinkAliases(canonicalRoot)) materialized.add(resolve(alias));
    }
    return [...materialized].sort();
  };

  /**
   * Mint an isolated child turn for a nested agent: the base policy narrows
   * to parent ∩ delegation envelope and the Engine state starts fresh, so
   * parent grants and amendments never leak into the child. Reports a
   * saturated nesting level so the caller can apply the existing sharing
   * fallback.
   *
   * Enforcement scope: the envelope binds sandbox-executed capabilities
   * (bash/write/edit/request_permissions, statically and at the network
   * authorize boundary) plus delegation spawning itself. Opaque host-tool
   * side effects stay under risk-policy + Guardian review with the narrowed
   * child context — host-admission is review-only by design
   * (sandboxEnforcesAction=false) and arbitrary host inputs have no
   * statically checkable capability shape.
   */
  const mintNestedPermissionTurnOwned = async (
    ctx: ExtensionContext,
    parentSnapshot: PermissionExecutionSnapshot,
  ): Promise<NestedPermissionTurnResult> => {
    const generation = session.getGeneration();
    const parentAtStart = parentSnapshot;
    const isParentCurrent = (): boolean =>
      session.isCurrentGeneration(generation) &&
      session.getTurnPhase() === "active" &&
      session.currentExecutionSnapshot() === parentAtStart;
    const beginSnapshotlessNestedTurn = (): NestedPermissionTurnResult => {
      if (!isParentCurrent()) return "stale";
      return session.beginNestedTurn() ? "blocked" : "saturated";
    };
    const childTurnId = session.allocateTurnId();
    const delegation = parentSnapshot.config.delegation;
    const childCwd = resolve(ctx.cwd);
    let childBase = parentSnapshot.baseSandboxConfig;
    // Only the Engine can supply broad turn authority. Host grants remain
    // non-inheriting; a broad parent may be intersected into an explicit finite envelope.
    if (childBase && permissions.inspect()?.turn.networkAll) {
      childBase = structuredClone(childBase);
      childBase.network.network_access = true;
    }
    let envelope: DelegationEnvelope = {
      writeRoots: [...(childBase?.filesystem.allowWrite ?? [])],
      networkHosts: [...(childBase?.network.allowedDomains ?? [])],
      allowReDelegate: delegation.allowReDelegate,
      maxDepth: delegation.maxDepth,
    };
    let droppedWriteRoots: readonly string[] = [];
    let droppedNetworkHosts: readonly string[] = [];
    if (parentSnapshot.mode !== "yolo" && delegation.enabled && childBase) {
      try {
        const parentCeiling = session.activeDelegationCeiling();
        if (childBase.filesystem.allowWrite.some(hasGlobSyntax)) {
          throw new Error("Parent delegation write roots must be concrete paths");
        }
        const materializedConfiguredWriteRoots = await materializeDelegationRoots(
          delegation.writeRoots,
          childCwd,
        );
        const resolved = resolveChildEnvelope({
          configuredWriteRoots: materializedConfiguredWriteRoots,
          configuredNetworkHosts: delegation.networkHosts,
          allowReDelegate: delegation.allowReDelegate,
          // Keep the parent's SRT path-rule identity; realpath could turn a
          // symlink rule into a different, wider grant.
          parentBase: childBase,
          parentRemainingDepth: parentCeiling?.maxDepth ?? delegation.maxDepth,
          childCwd,
        });
        envelope = { ...resolved.envelope, maxDepth: resolved.remainingDepth };
        childBase = resolved.childBasePolicy;
        droppedWriteRoots = resolved.droppedWriteRoots;
        droppedNetworkHosts = resolved.droppedNetworkHosts;
      } catch {
        // A child with an unrepresentable or unresolvable scope keeps a
        // session-only sentinel; controlled tools then fail closed without
        // inheriting the parent's grants.
        return beginSnapshotlessNestedTurn();
      }
    }
    // Even with configured delegation enforcement disabled, an actual nested
    // Engine owns only its finite resolved envelope, never raw/helper authority.
    if (parentSnapshot.mode !== "yolo" && childBase)
      childBase = intersectSandboxPolicy(childBase, envelope);
    if (!isParentCurrent()) return "stale";
    const sessionId = stableSessionId(ctx, session.getGeneration());
    let auditedEnvelope: DelegationEnvelope;
    try {
      const plan = createDelegationPlan({
        envelope: {
          writeRoots: [...envelope.writeRoots],
          networkHosts: [...envelope.networkHosts],
          allowReDelegate: envelope.allowReDelegate,
          maxDepth: envelope.maxDepth,
        },
        parentTurnId: parentSnapshot.turnId,
        parentSessionId: sessionId,
        reason: "subagent delegation",
        maxDepth: envelope.maxDepth,
        noReDelegate: envelope.allowReDelegate !== true,
      });
      auditedEnvelope = plan.envelope;
    } catch {
      return beginSnapshotlessNestedTurn();
    }
    const audit = createAuditLink({
      parentSessionId: sessionId,
      parentTurnId: parentSnapshot.turnId,
      childTurnId,
      envelope: auditedEnvelope,
    });
    const childSnapshot: PermissionExecutionSnapshot = {
      ...parentSnapshot,
      turnId: childTurnId,
      baseSandboxConfig: childBase,
    };
    if (
      !session.beginNestedTurn({
        snapshot: childSnapshot,
        envelope: auditedEnvelope,
        audit: { ...audit, envelope: auditedEnvelope },
      })
    ) {
      return "saturated";
    }
    try {
      permissions.beginNestedTurn(
        buildTurnSnapshot(ctx, childSnapshot, {
          turnId: childTurnId,
          baseSandboxPolicy: childBase,
        }),
        ctx,
      );
    } catch {
      // Do not leave a session snapshot installed when the host Engine could
      // not open its matching nested turn. Replace it with the fail-closed
      // sentinel while the original parent identity is still current.
      session.finishNestedTurn();
      return beginSnapshotlessNestedTurn();
    }
    try {
      pi.events.emit("pi-safety:delegation", {
        parentSessionId: sessionId,
        parentTurnId: parentSnapshot.turnId,
        childTurnId,
        envelope: auditedEnvelope,
        droppedWriteRoots,
        droppedNetworkHosts,
      });
    } catch {
      // Delegation audit events are best effort; enforcement never depends on observers.
    }
    return "opened";
  };

  const mintNestedPermissionTurn = async (
    ctx: ExtensionContext,
    parent: PermissionExecutionSnapshot,
  ): Promise<NestedPermissionTurnResult> => {
    const network = parent.baseSandboxConfig?.network;
    const needsDrain = requiresNetworkQuiescence(network);
    if (parent.mode === "yolo" || !needsDrain) return mintNestedPermissionTurnOwned(ctx, parent);
    const generation = session.getGeneration();
    // A proxy callback cannot tighten a raw/helper profile already installed at
    // spawn. Hold off new execution, then wait for real backend quiescence.
    return sandboxCoordinator.runExclusive(async () => {
      try {
        if (!sandboxManager.waitForIdle)
          throw new Error("Backend cannot drain unmediated networking before delegation");
        await sandboxManager.waitForIdle(AbortSignal.timeout(15_000));
        if (
          !session.isCurrentGeneration(generation) ||
          session.currentExecutionSnapshot() !== parent
        )
          throw new Error("Delegation preparation became stale");
        if (!sandboxManagerHealthy()) throw new Error("Backend unhealthy after delegation drain");
        return await mintNestedPermissionTurnOwned(ctx, parent);
      } catch (error) {
        // Merely returning from agent_start would let the child borrow the
        // parent's snapshot. Invalidate all admission and abort instead.
        resetBranchPermissionContext("Unmediated network delegation could not drain");
        ctx.abort();
        if (ctx.hasUI)
          ctx.ui.notify(
            `Delegation blocked: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        return "blocked";
      }
    });
  };

  const finishPermissionTurn = (reason: string): number | undefined => {
    // A nested agent level pops its isolated Engine turn and restores the
    // parent untouched; only the outermost close revokes the turn's grants.
    // Engine levels pair with session levels except on the snapshot-less
    // fallback path, which never pushed an Engine turn.
    if (session.getTurnDepth() > 1) {
      const closesEngineNestedTurn = session.activeNestedTurnHasSnapshot();
      session.finishNestedTurn();
      if (closesEngineNestedTurn) permissions.closeNestedTurn(reason);
      return undefined;
    }
    const closingTurnId = session.finishNestedTurn();
    if (closingTurnId === undefined) return undefined;
    permissions.closeTurn(reason);
    if (guardianInvalidationAfterModeChange) {
      guardianInvalidationAfterModeChange = false;
      invalidatePermissionContext(PERMISSION_MODE_CHANGED_REASON);
    }
    // Ending a Pi turn revokes Engine grants and in-flight authorization, but
    // does not change the Guardian session identity. The reviewer keeps its
    // bounded reusable trunk across ordinary turns; explicit session/tree,
    // config, mode, cwd, or reviewer-identity changes invalidate it.
  };

  const deferGuardianInvalidationForModeChange = (turnWasActive: boolean): void => {
    if (!turnWasActive) return;
    // A mode mutation during an active turn cannot replace that turn's
    // execution snapshot. Invalidate the reusable Guardian trunk at the same
    // lifecycle boundary that revokes the turn's Engine grants. If the turn
    // ended while the mutation was awaiting sandbox activation, invalidate now
    // rather than allowing the stale trunk into the next turn.
    if (session.getTurnPhase() === "active") {
      guardianInvalidationAfterModeChange = true;
      return;
    }
    guardianInvalidationAfterModeChange = false;
    invalidatePermissionContext(PERMISSION_MODE_CHANGED_REASON);
  };

  const currentRawGuardianTranscript = (): GuardianTranscriptEntry[] => {
    // Switching between fallback and the real log invalidates the Delta cursor.
    if (guardianTranscript.length > 0 && inputFallbackTranscript.length > 0) {
      guardianTranscriptEpoch += 1;
      inputFallbackTranscript = [];
    }
    return guardianTranscript.length > 0 ? guardianTranscript : inputFallbackTranscript;
  };

  const currentGuardianTranscriptSnapshot = (): GuardianTranscriptEntry[] =>
    boundGuardianTranscript(currentRawGuardianTranscript());

  const stableSessionId = (
    ctx: Pick<ExtensionContext, "sessionManager">,
    generation: number,
  ): string => {
    // SAFETY: the host always supplies a sessionManager object; only the
    // optional getSessionId shape is assumed, and every use below is guarded
    // (optional chaining, typeof check, try/catch with a fallback id).
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
    return `pi-safety-session-${generation}`;
  };

  const buildTurnSnapshot = (
    ctx: ExtensionContext,
    executionSnapshot: PermissionExecutionSnapshot,
    overrides?: { turnId?: string | number; baseSandboxPolicy?: SandboxPolicy },
  ): PiTurnSnapshot => ({
    sessionId: stableSessionId(ctx, session.getGeneration()),
    turnId: overrides?.turnId ?? executionSnapshot.turnId,
    mode: executionSnapshot.mode,
    cwd: resolve(ctx.cwd),
    configFingerprint: fingerprintConfig(executionSnapshot.config),
    baseSandboxPolicy:
      overrides?.baseSandboxPolicy !== undefined
        ? overrides.baseSandboxPolicy
        : executionSnapshot.baseSandboxConfig,
    sandboxReady: executionSnapshot.sandboxReady,
    escalationEligibility: escalationEligibility(executionSnapshot, overrides?.baseSandboxPolicy),
    transcript: currentGuardianTranscriptSnapshot(),
  });

  const beginPermissionTurn = (
    ctx: ExtensionContext,
    executionSnapshot: PermissionExecutionSnapshot,
  ): void => {
    permissions.beginTurn(buildTurnSnapshot(ctx, executionSnapshot), ctx);
  };

  const configKey = (ctx: Pick<ExtensionContext, "cwd">): string => ctx.cwd;
  const isActivationCurrent = (expectedGeneration: number): boolean =>
    session.isCurrentGeneration(expectedGeneration);
  const assertActivationCurrent = (expectedGeneration: number): void => {
    if (!isActivationCurrent(expectedGeneration)) throw new ActivationSupersededError();
  };
  const loadActivationCandidate = async (
    candidateOverride: LoadedSafetyConfig | undefined,
    expectedGeneration: number,
  ): Promise<LoadedSafetyConfig> => {
    try {
      if (candidateOverride) return candidateOverride;
      return await loadSafetyConfig(agentDir);
    } catch (error: unknown) {
      assertActivationCurrent(expectedGeneration);
      configFailure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  };

  type ActivationPrior = {
    loaded: LoadedSafetyConfig | undefined;
    loadedKey: string | undefined;
    baseSandboxConfig: SandboxPolicy | undefined;
    sandboxState:
      | { kind: "pending" }
      | { kind: "disabled" }
      | { kind: "ready"; profile: LoadedSafetyConfig["config"]["sandbox"]["profile"] }
      | { kind: "failed"; error: string };
  };

  const commitActivation = (
    ctx: Pick<ExtensionContext, "cwd" | "ui" | "hasUI">,
    key: string,
    candidate: LoadedSafetyConfig,
    candidateSandbox: SandboxPolicy | undefined,
    nextSandboxState: ActivationPrior["sandboxState"],
    force: boolean,
  ): LoadedSafetyConfig => {
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
    if (candidateSandbox?.network.macosTls === "system") {
      try {
        ctx.ui.notify(
          "WARNING: configured system TLS accepts startup trustd/helper-mediated egress outside proxy destination/ticket enforcement. Explicit ungranted attempts remain strict restricted; authorized proxy attempts may enable helpers before spawn (inline mode: before future connection review). Application private checks still apply. This is not a TLS-success guarantee or a network permission grant. Guardian stays independently strict.",
          "warning",
        );
      } catch {
        /* Disclosure is observational, never another approval ledger. */
      }
    }
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
    candidate: LoadedSafetyConfig,
    candidateSandbox: SandboxPolicy | undefined,
    previous: ActivationPrior,
    force: boolean,
    expectedGeneration: number,
  ): Promise<LoadedSafetyConfig> => {
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
    candidateOverride?: LoadedSafetyConfig,
    expectedGeneration = session.getGeneration(),
  ): Promise<LoadedSafetyConfig> => {
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
    if (!requiresSandbox(effectiveMode, candidate.config)) {
      assertActivationCurrent(expectedGeneration);
      await sandboxManager.reset();
      assertActivationCurrent(expectedGeneration);
      return commitActivation(ctx, key, candidate, undefined, { kind: "disabled" }, force);
    }

    let candidateSandbox: SandboxPolicy | undefined;
    if (candidate.config.sandbox.enabled) {
      const gitMetadata = await discoverGitMetadataProtectionRoots(ctx.cwd);
      if (!gitMetadata.ok) throw new Error(gitMetadata.reason);
      candidateSandbox = createSandboxRuntimeConfig(
        candidate.config.sandbox,
        ctx.cwd,
        defaultProtectedWritePaths(ctx.cwd, agentDir),
        gitMetadata.roots,
      );
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

  const activateConfig = async (
    ctx: Pick<ExtensionContext, "cwd" | "ui" | "hasUI">,
    force = false,
    targetMode?: ExecutablePermissionMode,
    candidateOverride?: LoadedSafetyConfig,
    expectedGeneration = session.getGeneration(),
  ): Promise<LoadedSafetyConfig> => {
    // A cache read shares running executions, but still queues behind every
    // exclusive activation/reset. Recheck all facts only after acquiring it;
    // never upgrade a shared lease into a mutable activation.
    if (!force && !candidateOverride && targetMode !== "yolo") {
      const cached = await sandboxCoordinator.runShared(async () => {
        assertActivationCurrent(expectedGeneration);
        if (configFailure) throw configFailure;
        if (
          loaded &&
          loadedKey === configKey(ctx) &&
          requiresSandbox(targetMode ?? modeRuntime?.mode ?? "auto", loaded.config) &&
          sandboxState.kind === "ready"
        ) {
          if (
            loaded.config.sandbox.network.access?.kind === "explicit" &&
            !sandboxManagerHealthy()
          ) {
            const reason = "Sandbox executor is unavailable or poisoned";
            throw Object.assign(new Error(reason), { code: "enforcement-unavailable", reason });
          }
          return loaded;
        }
        return undefined;
      });
      if (cached) return cached;
    }
    return targetMode === "yolo"
      ? activateConfigUnlocked(ctx, force, targetMode, candidateOverride, expectedGeneration)
      : sandboxCoordinator.runExclusive(() =>
          activateConfigUnlocked(ctx, force, targetMode, candidateOverride, expectedGeneration),
        );
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

  function addReviewResultRenderer(
    rendering: Pick<ToolDefinition<TSchema>, "renderShell" | "renderCall" | "renderResult">,
  ): Pick<ToolDefinition<TSchema>, "renderShell" | "renderCall" | "renderResult"> {
    if (rendering.renderResult === undefined) return { ...rendering, renderResult: undefined };
    // SAFETY: the wrapper preserves the renderer's input/output contract and only
    // adds a review side-channel; this bridges generic instantiations of the host
    // ToolDefinition across SDK versions.
    const wrapped = createReviewResultRenderer(
      rendering.renderResult as unknown as ReviewRenderResult,
      "header-icon",
    );
    // SAFETY: wrapped keeps identical input/output behavior; this only satisfies
    // the host's NonNullable render type.
    const adapted = wrapped as unknown as NonNullable<typeof rendering.renderResult>;
    return { ...rendering, renderResult: adapted };
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

  // Pi 0.85.1's native createBashTool leaves timeout unset by default. The
  // escalated path is deliberately still Pi's executor, so normalize only
  // that path at ingress; ordinary sandbox/yolo calls retain their Pi/SRT
  // timeout semantics.
  const normalizeBashParams = (params: BashParams): BashParams => {
    if (!isRecord(params)) throw new Error("Bash parameters must be an object");
    // SAFETY: isRecord above establishes string-keyed input; the host Bash type omits extension fields.
    const rawParams = params as unknown as Record<string, unknown>;
    if (rawParams.sandbox_permissions !== "require_escalated") return params;
    const timeout = normalizeEscalatedBashTimeout(params.timeout);
    return timeout === params.timeout ? params : ({ ...params, timeout } as BashParams);
  };

  interface PreparedPermissionExecution {
    executionSnapshot: PermissionExecutionSnapshot;
    executionContext: EffectiveExecutionContext;
  }

  /**
   * Codex step-boundary mode apply. Desired mode is `modeRuntime.mode`;
   * applied mode is the live execution snapshot. Divergence is resolved only
   * here (turn_start) or at the preparePermissionExecution safety drain —
   * never by hot-swapping the sandbox profile mid-attempt.
   *
   * Must call activateConfig with force=false: force=true goes through
   * commitActivation's permissions.invalidate and would wipe grants, nested
   * turns, and the Auto denial circuit at the step boundary.
   */
  const applyPendingTurnModeRefresh = async (ctx: ExtensionContext): Promise<void> => {
    if (!modeRuntime || !loaded) return;
    if (session.getTurnPhase() !== "active") return;
    const snapshot = session.currentExecutionSnapshot() ?? session.getExecutionSnapshot();
    if (!snapshot) return;
    const targetMode = modeRuntime.mode;
    if (snapshot.mode === targetMode) {
      pendingModeRefresh = false;
      return;
    }

    const generation = session.getGeneration();
    if (!session.isCurrentGeneration(generation)) return;
    const config = loaded.config;

    try {
      if (requiresSandbox(targetMode, config)) {
        // Activate SRT first; fail closed before switching authorization.
        // force=false keeps the live Engine turn (grants/circuit/nested) intact.
        await activateConfig(ctx, false, targetMode, undefined, generation);
        if (!session.isCurrentGeneration(generation) || session.getTurnPhase() !== "active") {
          return;
        }
        // A second cycle may have flipped desired mode during the await.
        if (modeRuntime.mode !== targetMode) return;
        if (sandboxState.kind !== "ready") {
          throw Object.assign(new Error("Sandbox executor is unavailable or poisoned"), {
            code: "enforcement-unavailable",
            reason: "Sandbox executor is unavailable or poisoned",
          });
        }
        session.refreshExecutionSnapshotMode(targetMode, {
          sandboxReady: true,
          baseSandboxConfig,
        });
        const applied = session.currentExecutionSnapshot() ?? session.getExecutionSnapshot();
        if (applied) {
          permissions.refreshTurnMode({
            mode: targetMode,
            sandboxReady: true,
            baseSandboxPolicy: baseSandboxConfig,
            escalationEligibility: escalationEligibility(applied),
          });
        }
      } else {
        // yolo: authorization first, then tear down SRT for the applied mode.
        session.refreshExecutionSnapshotMode(targetMode, { sandboxReady: false });
        const applied = session.currentExecutionSnapshot() ?? session.getExecutionSnapshot();
        if (applied) {
          permissions.refreshTurnMode({
            mode: targetMode,
            sandboxReady: false,
            escalationEligibility: escalationEligibility(applied),
          });
        }
        await activateConfig(ctx, false, targetMode, undefined, generation);
        if (!session.isCurrentGeneration(generation) || session.getTurnPhase() !== "active") {
          return;
        }
        if (modeRuntime.mode !== targetMode) return;
      }
      // Mode actually applied at this step boundary: retire deferred Guardian trunk.
      pendingModeRefresh = false;
      if (guardianInvalidationAfterModeChange) {
        guardianInvalidationAfterModeChange = false;
        invalidatePermissionContext(PERMISSION_MODE_CHANGED_REASON);
      }
    } catch (error: unknown) {
      if (!session.isCurrentGeneration(generation)) return;
      // Auto path never switched authorization on failure. Yolo already
      // applied unrestricted authorization; keep pending so a later step
      // can still catch up if desired mode changed again.
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        renderPermissionNotice({ kind: "mode-change-failed", reason: message }),
        "error",
      );
    }
  };

  const preparePermissionExecution = async (
    ctx: ExtensionContext,
  ): Promise<PreparedPermissionExecution> => {
    // Host turns apply at turn_start. Direct tool-hook paths without lifecycle
    // events drain here; same-step tools after a host turn_start keep the
    // prior applied mode until the next step boundary.
    if (pendingModeRefresh && !session.hasObservedLifecycle()) {
      await applyPendingTurnModeRefresh(ctx);
    }
    const activationGeneration = session.getGeneration();
    const appliedMode =
      session.currentExecutionSnapshot()?.mode ??
      session.getExecutionSnapshot()?.mode ??
      modeRuntime?.mode;
    await activateConfig(ctx, false, appliedMode, undefined, activationGeneration);
    assertActivationCurrent(activationGeneration);
    const executionSnapshot = ensureExecutionSnapshot(ctx);
    if (!executionSnapshot) {
      throw new Error(ACTIVE_PERMISSION_CONTEXT_UNAVAILABLE);
    }
    // Activation can repair a stale sandboxReady bit minted before SRT came up.
    const ready =
      requiresSandbox(executionSnapshot.mode, executionSnapshot.config) &&
      sandboxState.kind === "ready";
    if (executionSnapshot.sandboxReady !== ready) {
      session.refreshExecutionSnapshotMode(executionSnapshot.mode, { sandboxReady: ready });
      permissions.refreshTurnMode({
        mode: executionSnapshot.mode,
        sandboxReady: ready,
        escalationEligibility: escalationEligibility(executionSnapshot),
      });
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
      rawTranscript: currentRawGuardianTranscript(),
      transcriptEpoch: guardianTranscriptEpoch,
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
      const permissionError = {
        code: "execution-failed" as const,
        reason,
        ...(outcome.effectsMayHaveOccurred === true
          ? { effectsMayHaveOccurred: true as const }
          : {}),
      };
      const error = new Error(renderPermissionErrorForAgent(permissionError));
      Object.assign(error, permissionError);
      throw error;
    }
    const error = new Error(renderPermissionErrorForAgent(outcome.error));
    Object.assign(error, outcome.error);
    throw error;
  };

  const createSandboxNetworkAuthorizer =
    (
      policy: SandboxPolicy,
      authorizeCapability: PiExecutionAttempt["authorizeCapability"],
      rejectCapability: PiExecutionAttempt["rejectCapability"],
      fallbackSignal?: AbortSignal,
      delegationCeiling?: DelegationEnvelope,
    ): SandboxNetworkAuthorize =>
    async ({ host, port, signal }) => {
      const activeSignal = signal ?? fallbackSignal;
      if (
        policy.network.deniedDomains.some((pattern) =>
          matchesNetworkDomainPattern(pattern, host, port),
        )
      ) {
        const decision = rejectCapability({
          capability: { kind: "network", host, port },
          reason: "Network target is denied by sandbox policy",
        });
        return {
          allowed: false,
          reason:
            decision.kind === "deny"
              ? decision.error.reason
              : "Network target is denied by sandbox policy",
        };
      }
      // Runtime delegation boundary: a connection outside the envelope is
      // rejected outright instead of entering Engine capability review,
      // whose approval would otherwise expand the lease past the ceiling.
      if (delegationCeiling && !isNetworkCovered(host, delegationCeiling, port)) {
        const reason = `Network access to ${host} is outside the delegation envelope for this subagent.`;
        const decision = rejectCapability({
          capability: { kind: "network", host, port },
          reason,
        });
        return {
          allowed: false,
          reason: decision.kind === "deny" ? decision.error.reason : reason,
        };
      }
      const exactLocalAllow = isExactLocalNetworkAllowed(policy.network.allowedDomains, host, port);
      const authority = effectiveNetworkAuthority(policy.network);
      const endpoint = await networkBoundary.resolveEndpoint(
        host,
        port,
        policy.network.trustedFakeIpRanges ?? [],
        activeSignal,
        {
          allowLocalBinding: authority.localBinding,
          allowPrivateTargets: authority.privateTargets,
          allowExactLocalAllow: exactLocalAllow,
        },
      );
      if (endpoint.kind === "deny") {
        const decision = rejectCapability({
          capability: { kind: "network", host, port },
          reason: endpoint.reason,
        });
        return {
          allowed: false,
          reason: decision.kind === "deny" ? decision.error.reason : endpoint.reason,
        };
      }
      const decision = await authorizeCapability({
        capability: { kind: "network", host, port },
        reason: "Network access requires approval",
      });
      if (decision.kind === "deny") {
        return { allowed: false, reason: decision.error.reason };
      }
      if (activeSignal?.aborted) {
        return { allowed: false, reason: "Operation aborted" };
      }
      // The Engine makes the authorization decision. The boundary contributes
      // only the address-bound endpoint that the parent guard will consume.
      return { allowed: true, endpoint: endpoint.endpoint };
    };

  /**
   * Host-first B / residual special tools: rules deny only. Never submits
   * Engine/Guardian — host-owned execution is outside sandbox enforcement.
   */
  const evaluateHostFirstToolCall = async (
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined> => {
    if (!event.toolCallId) {
      return {
        block: true,
        reason: "The host did not provide an action identifier. The action was not run.",
      };
    }

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
    if (executionSnapshot.mode === "yolo") {
      return;
    }

    // Product delegation spawn gate (not foreign tool governance).
    if (executionContext.config.delegation.enabled && DELEGATED_TOOL_NAMES.has(event.toolName)) {
      const spawn = checkDelegateSpawn(event.toolName, executionContext.config);
      if (spawn.blocked) {
        return {
          block: true,
          reason: renderPermissionErrorForAgent({
            code: "policy-denied",
            reason: spawn.reason,
          }),
        };
      }
    }

    const denial = evaluateHostFirstRulesOnly(
      event.toolName,
      structuredClone(event.input) as Record<string, unknown>,
      resolve(ctx.cwd),
      executionContext.config,
    );
    if (denial) {
      return {
        block: true,
        reason: renderPermissionErrorForAgent({
          code: "policy-denied",
          reason: denial.reason,
        }),
      };
    }
    return;
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
      return await managedRiskEvaluator(
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

  // Pi converts a completed child's non-zero or null exit code into a thrown
  // error. The exit code is a structured value at the operations seam, before
  // pi renders it into a message; capture it there instead of parsing the
  // text back out.
  //
  // A captured status (including null, which pi reports as "no exit code")
  // means the child ran far enough to report one, so what follows is the
  // command's result rather than a permission failure. The one exception is
  // the sandboxed branch, where an authoritative SRT denial is checked first
  // and wins over this classification.
  //
  // `backend` names which executor the wrapper delegated to, so test doubles
  // can route a call to the right simulated backend without string matching.
  type ExitCodeSlot = { code: number | null | undefined };

  type CapturedBashOperations = BashOperations & {
    readonly backend: "sandboxed" | "local";
  };

  const captureExitCode = (
    base: BashOperations,
    slot: ExitCodeSlot,
    backend: "sandboxed" | "local",
  ): CapturedBashOperations => ({
    backend,
    exec: async (command, cwd, options) => {
      const result = await base.exec(command, cwd, options);
      slot.code = result.exitCode;
      return result;
    },
  });

  const commandStatusSuffix = (code: number | null): string =>
    code === null ? "Command terminated without an exit code" : `Command exited with code ${code}`;

  const completedIfCommandRan = (
    status: unknown,
    presented: unknown,
    slot: ExitCodeSlot,
  ): BashResult | undefined => {
    // Only a child-reported failure status is its own result. Exit 0 never
    // reaches the catch through pi's normal path (pi returns it as success);
    // landing here with a 0 means a post-exec infrastructure error, which must
    // stay a failure.
    if (slot.code === undefined || slot.code === 0) return undefined;
    // Pi flushes the child's output *after* capturing the exit code, so a
    // non-zero status can be followed by an unrelated infrastructure failure.
    // The slot proves the child ran; this confirms the thrown error is that
    // status rather than the later failure, whose text must not be shown to
    // the model as if it were the command's output. `status` is the raw error
    // — diagnostics appended for the agent are checked around, not through.
    if (!errorMessage(status).endsWith(commandStatusSuffix(slot.code))) return undefined;
    return {
      content: [{ type: "text", text: errorMessage(presented) }],
      details: undefined,
    };
  };

  const withFailureDiagnostics = async (commandId: string, error: unknown): Promise<unknown> => {
    try {
      const diagnostics = await sandboxManager.readFailureDiagnostics?.(commandId);
      return diagnostics
        ? new Error(`${errorMessage(error)}\n${diagnostics}`, { cause: error })
        : error;
    } catch {
      return error;
    }
  };

  type RuntimeDenialOutcome = Extract<PiActionOutcome<never>, { kind: "capability-denied" }>;

  const runtimeDenialOutcome = async (
    commandId: string,
    evidence: string,
  ): Promise<RuntimeDenialOutcome | undefined> => {
    if (!looksLikeSandboxDenial(evidence)) return undefined;
    const capability = await sandboxManager.classifyDenial?.(commandId);
    // Network authorization happens before the connection through the SRT
    // callback. A post-failure network denial is not replayable because it
    // would reopen an entire command rather than authorize one connection.
    if (capability?.kind !== "filesystem") return undefined;
    const operation = capability.operation === "write" ? "writing" : "reading";
    const detail = `Sandbox enforcement denied ${operation} ${capability.path} during execution\nOriginal error: ${evidence}`;
    return { kind: "capability-denied", request: capability, detail };
  };

  const executePermissionedBash = async (
    id: string,
    params: BashParams,
    signal: AbortSignal | undefined,
    onUpdate: BashOnUpdate,
    ctx: ExtensionContext,
  ): Promise<BashResult> => {
    const normalizedParams = normalizeBashParams(params);
    const captured = permissions.captureAction({
      id,
      tool: "bash",
      input: normalizedParams,
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
    // Ceiling before review: admission-declared roots/hosts merge into the
    // execution lease, so an allow-risk verdict would otherwise carry an
    // out-of-envelope capability past the narrowed child base policy.
    if (risk?.action === "prompt") {
      for (const root of risk.filesystemWriteRoots ?? []) {
        const violation = checkDelegationWrite(
          resolvePolicyPath(root, canonicalCwd),
          executionSnapshot.mode,
          executionContext.config,
        );
        if (violation) {
          const error = new Error(
            renderPermissionErrorForAgent({ code: "policy-denied", reason: violation }),
          );
          Object.assign(error, { code: "policy-denied", reason: violation });
          throw error;
        }
      }
      for (const host of risk.networkHosts ?? []) {
        const violation = checkDelegationNetwork(
          host,
          executionSnapshot.mode,
          executionContext.config,
        );
        if (violation) {
          const error = new Error(
            renderPermissionErrorForAgent({ code: "policy-denied", reason: violation }),
          );
          Object.assign(error, { code: "policy-denied", reason: violation });
          throw error;
        }
      }
    }
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
    // SAFETY: the bridge invokes onUpdate solely with ReviewPartialResult
    // payloads, which the host update channel accepts; no other call shape
    // flows through this seam.
    const reviewBridge = createReviewStatusBridge(
      onUpdate as unknown as (result: ReviewPartialResult) => void,
      ctx.hasUI ? (message, severity) => ctx.ui.notify(message, severity) : undefined,
    );
    const action: PiAction<BashResult, PiGuardianReviewContext, BashParams> = {
      captured,
      kind: "sandbox",
      risk,
      runtimeDenialPolicy: "terminal",
      reviewContext,
      signal,
      reviewStatus: reviewBridge.binding,
      execute: async ({
        mode,
        policy,
        call,
        signal: attemptSignal,
        authorizeCapability,
        rejectCapability,
      }) => {
        // Records the child's exit code at the operations seam. `undefined`
        // means the child never reported a status (denial, abort, or a failure
        // before/at spawn); a timeout may also leave it undefined after the
        // child had already started. All of these stay a failure.
        const exitCodeSlot: ExitCodeSlot = { code: undefined };
        // Unrestricted and escalated leases share the bare local backend;
        // the sandboxed branch builds its own wrapper below.
        const localBash = () =>
          bashToolFactory(canonicalCwd, {
            operations: captureExitCode(resolveLocalBashOperations(), exitCodeSlot, "local"),
          });
        try {
          if (attemptSignal.aborted) throw new Error("aborted");
          if (mode === "unrestricted") {
            return {
              kind: "completed",
              value: await localBash().execute(
                call.id,
                call.input,
                attemptSignal,
                reviewBridge.onUpdate as BashOnUpdate,
              ),
            };
          }
          if (mode === "escalated") {
            // The Engine supplies this explicit one-shot lease only after the
            // exact command/cwd review. Re-check live backend health so a
            // poisoned SRT snapshot can never turn into a bare execution.
            if (!sandboxManagerHealthy()) {
              return {
                kind: "failed",
                error: new Error("Sandbox executor is unavailable or poisoned"),
              };
            }
            if (session.activeDelegationCeiling()) {
              return {
                kind: "failed",
                error: new Error("Command escalation is outside the active delegation envelope"),
              };
            }
            if (attemptSignal.aborted) throw new Error("aborted");
            return {
              kind: "completed",
              value: await localBash().execute(
                call.id,
                call.input,
                attemptSignal,
                reviewBridge.onUpdate as BashOnUpdate,
              ),
            };
          }
          if (mode !== "sandboxed" || !policy) {
            return {
              kind: "failed",
              error: new Error("Sandbox enforcement is unavailable for this action"),
            };
          }
          // The ceiling is read at execution time, matching the snapshot /
          // Engine attribution semantics: whichever turn level submitted this
          // action governs it. Unrestricted (yolo) leases return above, so
          // every lease reaching here is sandboxed and ceiling-bound.
          const delegationCeiling = session.activeDelegationCeiling();
          const sandboxedBash = bashToolFactory(canonicalCwd, {
            operations: captureExitCode(
              createSandboxedBashOperations(sandboxManager, policy, {
                commandId: call.id,
                networkAuthorize: createSandboxNetworkAuthorizer(
                  policy,
                  authorizeCapability,
                  rejectCapability,
                  attemptSignal,
                  delegationCeiling,
                ),
              }),
              exitCodeSlot,
              "sandboxed",
            ),
          });
          return {
            kind: "completed",
            value: await sandboxCoordinator.runShared(() => {
              assertUnmediatedExecutionCurrent(policy, executionSnapshot);
              return sandboxedBash.execute(
                call.id,
                call.input,
                attemptSignal,
                reviewBridge.onUpdate as BashOnUpdate,
              );
            }, attemptSignal),
          };
        } catch (error: unknown) {
          if (attemptSignal.aborted) return { kind: "failed", error };
          if (mode === "sandboxed") {
            const diagnosed = await withFailureDiagnostics(call.id, error);
            const denied = await runtimeDenialOutcome(call.id, errorMessage(diagnosed));
            if (denied) return denied;
            const completed = completedIfCommandRan(error, diagnosed, exitCodeSlot);
            if (completed) return { kind: "completed", value: completed };
            return { kind: "failed", error: diagnosed };
          }
          const completed = completedIfCommandRan(error, error, exitCodeSlot);
          if (completed) return { kind: "completed", value: completed };
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
    const target = resolvePolicyPath(params.path, canonicalCwd);
    // Ceiling first: an allow-risk verdict must not bypass the envelope.
    // Without this, LOW writes outside the envelope would ride the lease's
    // requested-path expansion past the narrowed child base policy.
    const envelopeViolation = checkDelegationWrite(
      target,
      executionSnapshot.mode,
      executionContext.config,
    );
    if (envelopeViolation) return { action: "block", risk: "HARD", reason: envelopeViolation };
    if (decision.action !== "prompt") return decision;
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
      options: SandboxedFileOperationOptions,
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
    // SAFETY: same bridge contract as the bash path — only ReviewPartialResult
    // payloads reach the host update channel.
    const reviewBridge = createReviewStatusBridge(
      onUpdate as unknown as (result: ReviewPartialResult) => void,
      ctx.hasUI ? (message, severity) => ctx.ui.notify(message, severity) : undefined,
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
      runtimeDenialPolicy: "review-and-retry",
      reviewContext: createPiGuardianReviewContext(
        event,
        executionContext,
        ctx,
        capturedTranscript,
        canonicalCwd,
      ),
      signal,
      reviewStatus: reviewBridge.binding,
      execute: async ({
        mode,
        policy,
        call,
        signal: attemptSignal,
      }): Promise<PiActionOutcome<R>> => {
        let failure: NativeFileOperationFailure | undefined;
        const operationOptions: SandboxedFileOperationOptions = {
          observe: (event) => {
            failure = event.kind === "failed" ? event : undefined;
          },
        };
        try {
          if (mode === "unrestricted") {
            return {
              kind: "completed",
              value: await bare(
                call.id,
                call.input,
                attemptSignal,
                reviewBridge.onUpdate as U,
                canonicalCwd,
              ),
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
            value: await sandboxCoordinator.runShared(() => {
              assertUnmediatedExecutionCurrent(policy, executionSnapshot);
              // A queued retry must still obey the live ceiling, including its new parent root.
              for (const root of policy.filesystem.allowWrite) {
                if (executionSnapshot.baseSandboxConfig?.filesystem.allowWrite.includes(root))
                  continue;
                const violation = checkDelegationWrite(
                  root,
                  executionSnapshot.mode,
                  executionContext.config,
                );
                if (violation) throw new Error(violation);
              }
              return sandboxed(
                policy,
                call.id,
                call.input,
                attemptSignal,
                reviewBridge.onUpdate as U,
                canonicalCwd,
                operationOptions,
              );
            }, attemptSignal),
          };
        } catch (error: unknown) {
          if (mode === "sandboxed" && attemptSignal.aborted && failure) {
            // The host may replace an access error with "Operation aborted".
            // Preserve already-recorded evidence, but do not query diagnostics or probe retry scope.
            return { kind: "native-action-failed", error, failure };
          }
          if (mode === "sandboxed" && !attemptSignal.aborted) {
            const originalError = await withFailureDiagnostics(call.id, error);
            if (failure) {
              let mkdirScopeSupported = process.platform === "darwin";
              if (failure.operation === "mkdir" && process.platform === "linux") {
                try {
                  mkdirScopeSupported = statSync(failure.path).isDirectory();
                } catch {
                  mkdirScopeSupported = false;
                }
              }
              return {
                kind: "native-action-failed",
                error: originalError,
                failure,
                mkdirScopeSupported,
              };
            }
            return { kind: "failed", error: originalError };
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
      (policy, callId, callParams, callSignal, callOnUpdate, cwd, operationOptions) =>
        createWriteTool(cwd, {
          operations: createSandboxedFileOperations(
            sandboxManager,
            policy,
            [],
            callSignal,
            callId,
            cwd,
            operationOptions,
          ),
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
      (policy, callId, callParams, callSignal, callOnUpdate, cwd, operationOptions) =>
        createEditTool(cwd, {
          operations: createSandboxedFileOperations(
            sandboxManager,
            policy,
            [],
            callSignal,
            callId,
            cwd,
            operationOptions,
          ),
        }).execute(callId, callParams, callSignal, callOnUpdate),
    );

  pi.registerTool({
    ...baseBash,
    ...addReviewResultRenderer(adoptHostTheme(codexBashToolSpec)),
    label: "bash",
    description: `${baseBash.description} When the active sandbox does not allow a required filesystem operation, use with_additional_permissions for the smallest exact sandbox write. For Git metadata writes such as git add, git commit, or git init, use sandbox_permissions=require_escalated instead of additional_permissions when the exact command must run outside the active sandbox, with a concrete justification; it receives one action review and is not a blind retry. Public network access is reviewed automatically at the connection boundary; use request_permissions for an explicit turn-scoped grant.`,
    promptGuidelines: [
      "When the active sandbox does not allow a required filesystem operation, use with_additional_permissions for the smallest exact sandbox write and explain why. For Git metadata writes such as git add, git commit, or git init, use sandbox_permissions=require_escalated instead of additional_permissions when the exact command must run outside the active sandbox, with a concrete justification; it is a one-shot reviewed action and cannot be combined with additional_permissions. Public network access is reviewed automatically at the connection boundary; use request_permissions for an explicit turn-scoped network grant.",
    ],
    parameters: permissionedBashParameters,
    prepareArguments: preparePermissionedBashArguments as (args: unknown) => {
      command: string;
      timeout?: number;
      sandbox_permissions?: "use_default" | "with_additional_permissions" | "require_escalated";
      additional_permissions?: { file_system: { write: string[] } };
      justification?: string;
    },
    executionMode: "sequential",
    execute: executePermissionedBash,
  });

  pi.registerTool({
    ...baseWrite,
    ...addReviewResultRenderer(adoptHostTheme(codexWriteToolSpec)),
    executionMode: "sequential",
    execute: executePermissionedWrite,
  });

  pi.registerTool({
    ...baseEdit,
    ...addReviewResultRenderer(adoptHostTheme(codexEditToolSpec)),
    executionMode: "sequential",
    execute: executePermissionedEdit,
  });

  pi.registerTool({
    name: "request_permissions",
    label: "request_permissions",
    description:
      "Request a turn-scoped filesystem or network permission. With Approve for me, eligible requests are evaluated by Auto-review. Approval changes only the requested scope for execution attempts created afterwards in the current turn and does not disable the sandbox. Network authority freezes at attempt creation after action review, not invocation submission; a still-reviewing invocation may see an intervening grant. It does not expand an existing attempt or replay an action. Protected paths and prohibited targets remain blocked.",
    promptSnippet: "Request explicit filesystem/network permissions",
    parameters: Type.Object({
      reason: Type.Optional(Type.String()),
      scope: Type.Optional(Type.Literal("turn")),
      permissions: Type.Object({
        filesystem: Type.Optional(Type.Object({ write: Type.Array(Type.String()) })),
        network: Type.Optional(
          Type.Union([
            Type.Object({ hosts: Type.Array(Type.String()) }),
            Type.Object({ network_access: Type.Literal(true) }),
          ]),
        ),
      }),
    }),
    // SAFETY: same renderer-wrapper contract as addReviewResultRenderer —
    // identical input/output behavior, assertion only bridges host generics.
    renderResult: createReviewResultRenderer(
      plainReviewResultRenderer,
      "overlay",
    ) as unknown as NonNullable<ToolDefinition<TSchema>["renderResult"]>,
    async execute(id, params, _signal, _onUpdate, ctx) {
      if (!isSupportedPermissionRequestShape(params)) {
        const reason =
          "request_permissions requires an unambiguous turn-scoped network.hosts OR network_access:true request, and/or filesystem.write";
        throw Object.assign(
          new Error(renderPermissionErrorForAgent({ code: "policy-denied", reason })),
          { code: "policy-denied", reason },
        );
      }
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
      const { executionSnapshot, executionContext } = await preparePermissionExecution(ctx);
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
        (!decision.networkAll &&
          (decision.networkHosts?.length ?? 0) === 0 &&
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
      if (decision.networkAll && session.activeDelegationCeiling()) {
        throw Object.assign(
          new Error("Whole-network authority is outside the delegation envelope"),
          { code: "policy-denied" },
        );
      }
      // A nested amendment may only request capabilities inside its
      // delegation envelope; the child Engine would otherwise accumulate
      // rights the parent never granted it.
      for (const root of decision.filesystemWriteRoots ?? []) {
        const violation = checkDelegationWrite(
          resolvePolicyPath(root, canonicalCwd),
          executionSnapshot.mode,
          executionContext.config,
        );
        if (violation) {
          const error = new Error(
            renderPermissionErrorForAgent({ code: "policy-denied", reason: violation }),
          );
          Object.assign(error, { code: "policy-denied", reason: violation });
          throw error;
        }
      }
      for (const host of decision.networkHosts ?? []) {
        const violation = checkDelegationNetwork(
          host,
          executionSnapshot.mode,
          executionContext.config,
        );
        if (violation) {
          const error = new Error(
            renderPermissionErrorForAgent({ code: "policy-denied", reason: violation }),
          );
          Object.assign(error, { code: "policy-denied", reason: violation });
          throw error;
        }
      }
      const reason = canonicalParams.reason ?? decision.reason;
      const event = {
        type: "tool_call" as const,
        toolCallId: actionId,
        toolName: "request_permissions",
        input: canonicalParams,
      } as ToolCallEvent;
      // SAFETY: same bridge contract as the bash path — only ReviewPartialResult
      // payloads reach the host update channel.
      const reviewBridge = createReviewStatusBridge(
        _onUpdate as unknown as (result: ReviewPartialResult) => void,
        ctx.hasUI ? (message, severity) => ctx.ui.notify(message, severity) : undefined,
      );
      const action: PiAction<WriteResult, PiGuardianReviewContext, typeof canonicalParams> = {
        captured,
        kind: "permission-amendment",
        risk: decision,
        permission: {
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
        reviewStatus: reviewBridge.binding,
        execute: async ({
          mode,
          policy,
          signal: attemptSignal,
        }): Promise<PiActionOutcome<WriteResult>> => {
          try {
            if (attemptSignal.aborted) return { kind: "failed", error: new Error("aborted") };
            if (mode === "unrestricted") {
              return {
                kind: "completed",
                value: {
                  content: [
                    {
                      type: "text",
                      text: "Bypass permissions is already active; no additional permission grant was recorded.",
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
                    text: `Granted turn permissions${decision.networkAll ? "; whole-network outbound authority subject to hard domain/private policy (not bind or TLS authority)" : ""}${
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
    let candidate: LoadedSafetyConfig;
    try {
      candidate = await loadSafetyConfig(agentDir);
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
        // A tree switch is an explicit context invalidation. Do not carry an
        // unrestricted YOLO execution into the newly restored branch.
        if (previousMode === "yolo" && restoredMode !== "yolo" && !ctx.isIdle()) ctx.abort();
      }
    });
  });

  pi.on("session_shutdown", async () => {
    permissions.invalidate("session shutdown");
    session.bumpGeneration();
    cancelInFlightModeTransition();
    session.resetTurn();
    guardianInvalidationAfterModeChange = false;
    invalidatePermissionContext("session shutdown");
    await sandboxCoordinator.runExclusive(async () => {
      sandboxState = { kind: "pending" };
      await sandboxManager.reset();
    });
  });

  pi.on("input", (event) => {
    if ((event.source === "interactive" || event.source === "rpc") && event.text.length > 0) {
      const appended = appendGuardianTranscript(inputFallbackTranscript, {
        role: "user",
        content: event.text,
      });
      inputFallbackTranscript = appended.entries;
      if (appended.truncated) guardianTranscriptEpoch += 1;
    }
  });

  pi.on("message_end", (event) => {
    const entry = guardianTranscriptEntryFromMessage(event.message);
    if (entry) {
      const appended = appendGuardianTranscript(guardianTranscript, entry);
      guardianTranscript = appended.entries;
      if (appended.truncated) guardianTranscriptEpoch += 1;
    }
  });

  // Nested agents run on an isolated child turn: the base policy narrows to
  // parent ∩ delegation envelope and Engine grants/amendments start fresh.
  // Saturation falls back to sharing the parent turn rather than breaking
  // the subagent.
  pi.on("agent_start", async (_event, ctx) => {
    session.markLifecycleEvent();
    if (session.getTurnPhase() === "active") {
      const nested = session.getTurnDepth() > 1;
      const parentSnapshot = nested
        ? session.currentExecutionSnapshot()
        : (session.currentExecutionSnapshot() ?? session.getExecutionSnapshot());
      if (parentSnapshot) {
        const result = await mintNestedPermissionTurn(ctx, parentSnapshot);
        if (result !== "saturated") return;
      } else if (nested) {
        // A failed nested start owns a session-only sentinel. Never fall back
        // to the outer snapshot, or a grandchild could escape the closed scope.
        session.beginNestedTurn();
        return;
      }
      session.beginNestedTurn();
      return;
    }
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
    // A prior mid-turn cycle may have left SRT on the old mode. Align before
    // minting so the fresh snapshot's sandboxReady bit is truthful.
    pendingModeRefresh = false;
    const activationGeneration = session.getGeneration();
    if (modeRuntime && session.isCurrentTurn(startingTurnId)) {
      try {
        await activateConfig(ctx, false, modeRuntime.mode, undefined, activationGeneration);
      } catch {
        // Fail closed: capture the actual sandboxState so tools refuse if SRT is down.
      }
    }
    if (
      !session.isCurrentGeneration(activationGeneration) ||
      session.getTurnPhase() !== "active" ||
      !session.isCurrentTurn(startingTurnId)
    ) {
      return;
    }
    const executionSnapshot = captureExecutionSnapshot(startingTurnId);
    if (executionSnapshot) beginPermissionTurn(ctx, executionSnapshot);
  });

  // Each LLM sampling is a step. A mid-agent cycle updates desired mode only;
  // this is where the applied snapshot and SRT actually catch up (Codex-like).
  pi.on("turn_start", async (_event, ctx) => {
    session.markLifecycleEvent();
    await applyPendingTurnModeRefresh(ctx);
  });

  pi.on("agent_end", () => {
    session.markLifecycleEvent();
    const wasActive = session.getTurnPhase() === "active";
    finishPermissionTurn("permission turn ended");
    if (wasActive) session.noteEndAwaitingSettle();
  });

  pi.on("agent_settled", () => {
    session.markLifecycleEvent();
    // The host emits end+settled per agent level. A settled paired with a
    // preceding end must not finish again; settleBetween is still safe
    // (no-op unless a turn is actually between).
    if (session.takeEndAwaitingSettle()) {
      session.settleBetween();
      return;
    }
    // Belt-and-braces: a settled without a preceding end still closes.
    if (finishPermissionTurn("permission turn settled") !== undefined) {
      session.settleBetween();
    }
  });

  pi.on(
    "tool_call",
    async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
      if (PI_OWNED_TOOL_NAMES.has(event.toolName)) {
        return;
      }
      if (
        PI_HOST_FIRST_TOOL_NAMES.has(event.toolName) ||
        DELEGATED_TOOL_NAMES.has(event.toolName)
      ) {
        return evaluateHostFirstToolCall(event, ctx);
      }
      // Foreign A: MCP / custom / other extension tools — host-native execution.
      return;
    },
  );

  pi.registerCommand("approve", {
    description: "Authorize one exact retry of a recent Auto-review denial",
    handler: async (_args, ctx) => {
      let result: LoadedSafetyConfig;
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
          customType: "pi-safety-auto-override",
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

    if (beganDuringActiveTurn) {
      // Desired-mode only. The applied snapshot and SRT stay put until the
      // next turn_start (or preparePermissionExecution safety drain).
      const generation = session.getGeneration();
      try {
        if ((await shiftTabAvailability(agentDir)) !== "available") {
          ctx.ui.notify(renderPermissionNotice({ kind: "shortcut-conflict" }), "warning");
          return;
        }
        let runtime = modeRuntime;
        if (!runtime) {
          const initial = await activateConfig(ctx, false, undefined, undefined, generation);
          if (!session.isCurrentGeneration(generation)) return;
          runtime = ensureModeRuntime(initial.config);
        }
        const targetMode = nextMode(runtime.mode);
        runtime.activate(targetMode, { preserveAutoTransientState: true });
        pendingModeRefresh = true;
        deferGuardianInvalidationForModeChange(true);
        setDefaultStatus(ctx);
      } catch (error: unknown) {
        if (!session.isCurrentGeneration(generation)) return;
        const message = error instanceof Error ? error.message : String(error);
        setDefaultStatus(ctx);
        ctx.ui.notify(
          renderPermissionNotice({ kind: "mode-change-failed", reason: message }),
          "error",
        );
      }
      return;
    }

    // Between turns / idle: no snapshot to preserve; apply immediately so the
    // next agent_start captures a consistent mode+SRT pair.
    const transitionBarrier = createModeTransitionBarrier();
    try {
      await session.runModeMutation(async (generation) => {
        try {
          if ((await shiftTabAvailability(agentDir)) !== "available") {
            ctx.ui.notify(renderPermissionNotice({ kind: "shortcut-conflict" }), "warning");
            settleModeTransitionBarrier(transitionBarrier, true);
            return;
          }
          permissions.invalidate(PERMISSION_MODE_CHANGED_REASON);
          invalidatePermissionContext(PERMISSION_MODE_CHANGED_REASON);
          let runtime = modeRuntime;
          if (!runtime) {
            const initial = await activateConfig(ctx, false, undefined, undefined, generation);
            if (!session.isCurrentGeneration(generation)) {
              settleModeTransitionBarrier(transitionBarrier, false);
              return;
            }
            runtime = ensureModeRuntime(initial.config);
          }
          const targetMode = nextMode(runtime.mode);
          const result = await activateConfig(ctx, true, targetMode, undefined, generation);
          if (!session.isCurrentGeneration(generation)) {
            settleModeTransitionBarrier(transitionBarrier, false);
            return;
          }
          runtime = ensureModeRuntime(result.config);
          runtime.activate(targetMode);
          setDefaultStatus(ctx);
          settleModeTransitionBarrier(transitionBarrier, true);
        } catch (error: unknown) {
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
      settleModeTransitionBarrier(transitionBarrier, false);
    }
  };

  pi.registerShortcut("shift+tab", {
    description: "Cycle permission mode",
    handler: cyclePermissionMode,
  });

  pi.registerCommand("permissions", {
    description:
      "Reload permission policy, or inspect live authority with /permissions status (read-only)",
    handler: async (args, ctx) => {
      if (args.trim() === "status") {
        let configured:
          | {
              fingerprint: string;
              network: SafetyConfig["sandbox"]["network"];
              source: string;
              path?: string;
            }
          | { error: string };
        try {
          const candidate = await loadSafetyConfig(agentDir);
          configured = {
            fingerprint: fingerprintConfig(candidate.config),
            network: structuredClone(candidate.config.sandbox.network),
            source: candidate.source,
            ...(candidate.sourcePath === undefined ? {} : { path: candidate.sourcePath }),
          };
        } catch (error) {
          configured = { error: error instanceof Error ? error.message : String(error) };
        }
        // Inspection never activates, mutates grants or poisons a working config.
        const authority = permissions.inspect();
        const state = {
          configured,
          activeGeneration: session.getGeneration(),
          activeConfigFingerprint: loaded ? fingerprintConfig(loaded.config) : undefined,
          activation: sandboxState,
          mode: modeRuntime?.mode ?? "unknown",
          authority,
          baselineNetwork: authority?.baseline
            ? describeExecutionNetwork(authority.baseline)
            : undefined,
          nextAttemptNetwork: authority?.effective
            ? describeExecutionNetwork(authority.effective)
            : undefined,
          backend: sandboxManager.describeState?.() ?? {
            initialized: sandboxState.kind === "ready",
            healthy: sandboxManager.isHealthy?.() ?? "unknown",
            networkSupport: "unknown",
            execution: "unknown",
            nativeEnforcement: "unknown",
          },
          note: "Call identity freezes at invocation capture; network authority freezes at execution-attempt creation after review, before the backend queue. Review evidence is a plan, not a guarantee that an invocation still awaiting review cannot see intervening turn grants. Attempt plans are not proof of spawn, native enforcement or TLS success. Pending connection approvals are AllowOnce, not future exemptions. Turn grants expire at turn end; approval does not imply execution success. System TLS accepts helper-mediated egress outside proxy destination/ticket enforcement. Guardian remains independently strict, zero-write and zero-authorizable-network.",
        };
        ctx.ui.notify(`Permission status (read-only)\n${JSON.stringify(state, null, 2)}`, "info");
        return;
      }
      return session.runModeMutation(async (generation) => {
        let candidateLoaded = false;
        try {
          const previousMode = modeRuntime ? modeRuntime.mode : undefined;
          const candidate = await loadSafetyConfig(agentDir);
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
                (entry as { customType?: unknown }).customType === "pi-safety-state",
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
          // /permissions is an explicit policy/config reload, not a
          // turn-local mode toggle; fail closed if it narrows a live YOLO run.
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
          const networkView = baseSandboxConfig
            ? describeExecutionNetwork(baseSandboxConfig)
            : undefined;
          const networkSummary = networkView
            ? `; ${networkView.requestPath}, required ${networkView.required.kind}, TLS ${networkView.effectiveTls} (configured ${networkView.configuredTls})${networkView.helperEgressRisk ? "; WARNING: startup trustd/helper egress bypasses destination/ticket enforcement" : ""}${networkView.localBindingAndInbound ? "; bind/inbound and raw loopback enabled" : ""}; backend execution/native enforcement not attested`
            : "";
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
              sandbox: sandboxSummary + networkSummary,
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
      });
    },
  });
}
