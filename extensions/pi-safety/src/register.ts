import { statSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createLocalBashOperations,
  createWriteTool,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  codexBashToolSpec,
  codexEditToolSpec,
  codexWriteToolSpec,
  createCodexToolRendering as createPiCoreCodexToolRendering,
} from "../../../packages/shared-tool-presentation/src/index.ts";
import { type AutoReviewer, type GuardianReviewIdentity, PiAutoReviewer } from "./auto-reviewer.ts";
import {
  bashFailureText,
  captureExitCode,
  commandExitCode,
  completedBashFailure,
  completedBashFromResult,
  completedIfCommandRan,
  type ExitCodeSlot,
  type RuntimeDenialOutcome,
  returnedBashFailure,
  runtimeDenialFromEvidence,
} from "./bash-outcome.ts";
import {
  fingerprintConfig,
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
  resolveChildEnvelope,
} from "./delegation.ts";
import {
  checkDelegateSpawn,
  checkDelegationNetwork,
  checkDelegationWrite,
  checkRequestedCapabilities,
  type DelegationScope,
} from "./delegation-policy.ts";
import {
  defaultProtectedWritePaths,
  expandSymlinkAliases,
  resolvePolicyPath,
} from "./filesystem-policy.ts";
import { discoverGitMetadataProtectionRoots } from "./git-metadata.ts";
import { guardianMetricsRecordFromEvent } from "./guardian/metrics.ts";
import { GUARDIAN_DENIAL_WINDOW_SIZE, validateGuardianPolicy } from "./guardian-policy.ts";
import type { GuardianReviewSessionManager } from "./guardian-session.ts";
import {
  appendGuardianTranscript,
  boundGuardianTranscript,
  type GuardianTranscriptEntry,
} from "./guardian-transcript.ts";
import { PermissionModeRuntime } from "./mode-runtime.ts";
import { NetworkBoundary } from "./network-boundary.ts";
import {
  isExactLocalNetworkAllowed,
  matchesNetworkDomainPattern,
} from "./network-domain-pattern.ts";
import {
  permissionModeLabel,
  renderExactRetryInstruction,
  renderPermissionErrorForAgent,
  renderPermissionNotice,
  renderPermissionSummary,
} from "./permission-copy.ts";
import type { ModeTransitionBarrier } from "./permission-session.ts";
import { type PermissionExecutionSnapshot, PermissionSession } from "./permission-session.ts";
import { canonicalize } from "./permissions/paths.ts";
import { createPiGuardianAdapter, type PiGuardianReviewContext } from "./pi-guardian-adapters.ts";
import {
  type PiAction,
  type PiActionOutcome,
  type PiExecutionAttempt,
  type PiExecutionOutcome,
  PiSafetyRuntime,
  type PiTurnSnapshot,
} from "./pi-safety.ts";
import {
  ConfigError,
  effectiveNetworkAuthority,
  fingerprintValue,
  hasGlobSyntax,
} from "./policy-primitives.ts";
import { registerRequestPermissionsTool } from "./register-request-permissions.ts";
import {
  ACTIVE_PERMISSION_CONTEXT_UNAVAILABLE,
  ActivationSupersededError,
  abortLiveTurn,
  configKey,
  DELEGATED_TOOL_NAMES,
  flushTurnTrace,
  guardianTranscriptEntryFromMessage,
  isActivationSupersededError,
  nextMode,
  PERMISSION_MODE_CHANGED_REASON,
  PI_HOST_FIRST_TOOL_NAMES,
  PI_OWNED_TOOL_NAMES,
  policyDeniedError,
  requiresNetworkQuiescence,
  requiresSandbox,
  stableSessionId,
  type TurnTraceSegments,
  traceSpan,
  turnTraceEnabled,
} from "./register-support.ts";
import {
  permissionedBashDescriptionSuffix,
  permissionedBashPromptGuidelines,
} from "./register-tool-copy.ts";
import {
  createReviewResultRenderer,
  createReviewStatusBridge,
  type ReviewPartialResult,
  type ReviewRenderResult,
} from "./review-renderer.ts";
import { evaluateDenyRulesOnly, evaluateRiskRequest, type RiskDecision } from "./risk-policy.ts";
import { SRT_DRAIN_TIMEOUT_MS } from "./sandbox/srt-coordinator.ts";
import { SrtSandboxManager } from "./sandbox/srt-enforcer.ts";
import {
  createSandboxedBashOperations,
  createSandboxedFileOperations,
  type SandboxedFileOperationOptions,
} from "./sandbox.ts";
import { SandboxLifecycleLease } from "./sandbox-lifecycle-lease.ts";
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
import type { PermissionMode } from "./state.ts";
import {
  activateTreeSitterShellParser,
  treeSitterShellFailure,
} from "./tree-sitter/shell-backend.ts";
import { errorMessage } from "./unknown-value.ts";

type GuardianPolicySource = (context: {
  cwd: string;
  configFingerprint: string;
}) => string | undefined;

export interface RegisterExtensionOptions {
  agentDir?: string;
  sandboxManager?: SandboxManagerLike;
  bashToolFactory?: typeof createBashTool;
  /** Builds the operations used for unrestricted leases. Default: pi's local shell backend. */
  localBashOperations?: () => BashOperations;
  sandboxLifecycleLease?: Pick<SandboxLifecycleLease, "runShared" | "runExclusive">;
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

const guardianFallbackNoticeKeys = new Set<string>();

/**
 * Guardian review evidence: the transcript handed to the reviewer, and the
 * Delta-cursor epoch that tells it when a cached cursor is no longer valid.
 *
 * The fallback transcript exists because interactive input arrives before any
 * assistant message. Reading while both are populated is deliberately a write:
 * the fallback is displaced and the epoch advances, because a consumer that
 * switched between the two logs cannot keep a Delta cursor across the switch.
 * Owning all four facts in one place keeps that write from being reordered
 * against the appends.
 */
function createGuardianEvidence() {
  let transcript: GuardianTranscriptEntry[] = [];
  let cursorEpoch = 0;
  let inputFallback: GuardianTranscriptEntry[] = [];
  let invalidationAfterModeChange = false;
  return {
    reset(): void {
      transcript = [];
      cursorEpoch += 1;
      inputFallback = [];
      invalidationAfterModeChange = false;
    },
    appendInput(text: string): void {
      const appended = appendGuardianTranscript(inputFallback, { role: "user", content: text });
      inputFallback = appended.entries;
      if (appended.truncated) cursorEpoch += 1;
    },
    appendMessage(entry: GuardianTranscriptEntry): void {
      const appended = appendGuardianTranscript(transcript, entry);
      transcript = appended.entries;
      if (appended.truncated) cursorEpoch += 1;
    },
    currentRaw(): GuardianTranscriptEntry[] {
      if (transcript.length > 0 && inputFallback.length > 0) {
        cursorEpoch += 1;
        inputFallback = [];
      }
      return transcript.length > 0 ? transcript : inputFallback;
    },
    get epoch(): number {
      return cursorEpoch;
    },
    markInvalidationAfterModeChange(): void {
      invalidationAfterModeChange = true;
    },
    clearInvalidationAfterModeChange(): void {
      invalidationAfterModeChange = false;
    },
    consumeInvalidationAfterModeChange(): boolean {
      const pending = invalidationAfterModeChange;
      invalidationAfterModeChange = false;
      return pending;
    },
  };
}

export function registerExtension(pi: ExtensionAPI, options: RegisterExtensionOptions = {}): void {
  const agentDir = options.agentDir ?? getAgentDir();
  // Guide lifecycle contract (extensions.md:58-60) forbids load-time
  // processes/sockets/watchers/timers, not object allocation: every
  // constructor below is pure field assignment. The only process-lifetime
  // resource (SandboxConnectGuard listener) is a module singleton that
  // starts in activate(), driven by session_start/activateConfig — so the
  // contract is satisfied without deferring `new`. Lazy ensureX() would be
  // strictly worse: /permissions, /approve and shift+tab legally touch the
  // managers before any session_start.
  const sandboxManager: SandboxManagerLike = options.sandboxManager ?? new SrtSandboxManager();
  const networkBoundary = options.networkBoundary ?? new NetworkBoundary();
  const bashToolFactory = options.bashToolFactory ?? createBashTool;
  // Builds the operations used for unrestricted leases. Test
  // doubles replace this with a stub to avoid real spawns; production uses
  // pi's local shell backend.
  const resolveLocalBashOperations = options.localBashOperations ?? createLocalBashOperations;
  const baseBash = bashToolFactory(process.cwd());
  const baseWrite = createWriteTool(process.cwd());
  const baseEdit = createEditTool(process.cwd());
  const sandboxLifecycleLease = options.sandboxLifecycleLease ?? new SandboxLifecycleLease();
  const managedRiskEvaluator = options.riskEvaluator ?? evaluateRiskRequest;
  const autoReviewer =
    options.autoReviewer ?? new PiAutoReviewer(undefined, options.guardianSessionManager);
  // Cluster A (activation): written by commitActivation/activateWithSandbox/
  // activateConfigUnlocked, read by every tool's prepare + snapshot. The
  // sandbox pair below is the split bottleneck: activation writes, per-tool
  // reads (prepare, snapshot, sandbox health) — never separate them.
  let loaded: LoadedSafetyConfig | undefined;
  let loadedKey: string | undefined;
  let configFailure: Error | undefined;
  let activationFailure: { key: string; error: Error } | undefined;
  let modeRuntime: PermissionModeRuntime | undefined;
  // Cluster C (review evidence): Guardian transcript dual-track + activation
  // notice. shellParserFailureReported is activation/startup, not review.
  /** One Shell AST parser activation failure notice per registration. */
  let shellParserFailureReported = false;
  const evidence = createGuardianEvidence();
  // Cluster B (turn enforcement): cycle writes intent, turn_start/prepare/
  // agent_start apply it. pendingModeRefresh is the flag, pendingMode the
  // value; they clear together everywhere EXCEPT agent_start align (which
  // clears the flag only — the stale value is masked by the flag at read).
  /** Set by a mid-turn cycle; cleared when the step boundary actually applies it. */
  let pendingModeRefresh = false;
  /**
   * The desired mode a mid-turn cycle asked for while enforcement stays on the
   * old snapshot. Shown in the TUI immediately (with a pending marker) so the
   * display tracks intent; enforcement still flips only at the step boundary.
   * Cleared together with `pendingModeRefresh` (see exception above).
   */
  let pendingMode: PermissionMode | undefined;
  /** Report one activation failure per registration, on whichever ctx learns of it first. */
  const reportShellParserActivationFailure = (ctx: ExtensionContext): void => {
    if (shellParserFailureReported) return;
    shellParserFailureReported = true;
    const failure = treeSitterShellFailure();
    const notice = renderPermissionNotice({
      kind: "shell-parser-activation-failed",
      reason: failure ? `${failure.name}: ${failure.message}` : "unknown failure",
    });
    if (ctx.hasUI) ctx.ui.notify(notice, "error");
  };
  const permissions = new PiSafetyRuntime<PiGuardianReviewContext>({
    guardian: createPiGuardianAdapter(autoReviewer),
    policy: {
      check: ({ requested, phase }) => {
        if (phase !== "runtime") return { kind: "allow" };
        if (!loaded || !modeRuntime)
          return { kind: "deny", reason: "Permission context unavailable" };
        const violation = checkRequestedCapabilities(
          requested,
          modeRuntime.mode,
          loaded.config,
          delegationScope(),
        );
        return violation ? { kind: "deny", reason: violation } : { kind: "allow" };
      },
    },
    reviewEventSink: (event) => {
      pi.events.emit("pi-safety:review", event);
      // Best-effort local metrics sink. Never throws into the authorization path.
      const record = guardianMetricsRecordFromEvent(event);
      if (record) {
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

  const setDefaultStatus = (ctx: Pick<ExtensionContext, "ui" | "hasUI">): void => {
    // Display leads with intent, enforcement stays truthful: `mode` and
    // `severity` always describe the applied snapshot (what is live), while
    // the label names the desired mode with a pending marker until the step
    // boundary applies it. A bare desired label would claim protection (or
    // bypass) that isn't live yet; a bare applied label hides the user's own
    // keypress until the next turn.
    const appliedMode =
      session.currentExecutionSnapshot()?.mode ??
      session.getExecutionSnapshot()?.mode ??
      modeRuntime?.mode ??
      "auto";
    const pending =
      pendingModeRefresh && pendingMode !== undefined && pendingMode !== appliedMode
        ? pendingMode
        : undefined;
    const label = pending
      ? `${permissionModeLabel(pending)} (pending)`
      : permissionModeLabel(appliedMode);
    // Parity with PermissionModeRuntime.statusSeverity: warning marks
    // guardian-reviewed execution, error marks unreviewed execution.
    const severity = appliedMode === "auto" ? "warning" : "error";
    // setStatus is a UI affordance; the structured event below is the
    // mode channel and must fire in every host mode.
    if (ctx.hasUI) ctx.ui.setStatus("pi-safety", label);
    // Structured mode event for status consumers (e.g. statusline). The
    // string published via setStatus above stays as the built-in-footer
    // fallback; consumers should key off `mode`/`severity`, never the label.
    // `pending` carries the not-yet-applied desired mode, if any.
    pi.events.emit("pi-safety:mode", {
      mode: appliedMode,
      label,
      severity,
      ...(pending ? { pending } : {}),
    });
  };

  const invalidatePermissionContext = (_reason: string): void => {
    autoReviewer.invalidateSession();
  };

  const invalidatePermissions = (reason: string): void => {
    permissions.invalidate(reason);
  };

  const resetBranchPermissionContext = (reason: string): void => {
    invalidatePermissions(reason);
    session.bumpGeneration();
    cancelInFlightModeTransition();
    evidence.reset();
    session.resetTurn();
    pendingModeRefresh = false;
    pendingMode = undefined;
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

  // The three live facts the delegation rules need. The rules themselves are in
  // `delegation-policy.ts`; this is the only place that knows how to read them,
  // so a change to what "the current scope" means has exactly one home.
  const delegationScope = (): DelegationScope => ({
    ceiling: session.activeDelegationCeiling(),
    turnDepth: session.getTurnDepth(),
    allowsReDelegate: session.activeDelegationAllowsReDelegate(),
  });

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
    return sandboxLifecycleLease.runExclusive(async () => {
      try {
        if (!sandboxManager.waitForIdle)
          throw new Error("Backend cannot drain unmediated networking before delegation");
        await sandboxManager.waitForIdle(AbortSignal.timeout(SRT_DRAIN_TIMEOUT_MS));
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
    if (evidence.consumeInvalidationAfterModeChange()) {
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
      evidence.markInvalidationAfterModeChange();
      return;
    }
    evidence.clearInvalidationAfterModeChange();
    invalidatePermissionContext(PERMISSION_MODE_CHANGED_REASON);
  };

  const currentRawGuardianTranscript = (): GuardianTranscriptEntry[] => evidence.currentRaw();

  const currentGuardianTranscriptSnapshot = (): GuardianTranscriptEntry[] =>
    boundGuardianTranscript(currentRawGuardianTranscript());

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
    transcript: currentGuardianTranscriptSnapshot(),
  });

  const beginPermissionTurn = (
    ctx: ExtensionContext,
    executionSnapshot: PermissionExecutionSnapshot,
  ): void => {
    permissions.beginTurn(buildTurnSnapshot(ctx, executionSnapshot), ctx);
  };

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
      invalidatePermissions("permission context changed");
      invalidatePermissionContext("permission context changed");
    }
    loaded = candidate;
    loadedKey = key;
    baseSandboxConfig = candidateSandbox;
    sandboxState = nextSandboxState;
    setDefaultStatus(ctx);
    if (candidateSandbox?.network.macosTls === "system" && ctx.hasUI) {
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
      const cached = await sandboxLifecycleLease.runShared(async () => {
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
      : sandboxLifecycleLease.runExclusive(() =>
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
   * commitActivation's invalidatePermissions and would wipe grants,
   * nested turns, and the Auto denial circuit at the step boundary.
   */
  const applyPendingTurnModeRefresh = async (ctx: ExtensionContext): Promise<void> => {
    if (!modeRuntime || !loaded) return;
    if (session.getTurnPhase() !== "active") return;
    const snapshot = session.currentExecutionSnapshot() ?? session.getExecutionSnapshot();
    if (!snapshot) return;
    const targetMode = modeRuntime.mode;
    if (snapshot.mode === targetMode) {
      pendingModeRefresh = false;
      pendingMode = undefined;
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
      pendingMode = undefined;
      if (evidence.consumeInvalidationAfterModeChange()) {
        invalidatePermissionContext(PERMISSION_MODE_CHANGED_REASON);
      }
      // The applied mode may just have changed (this path only runs when the
      // snapshot diverged from desired): publish it so the footer and badge
      // track enforcement rather than the desired mode set mid-turn.
      setDefaultStatus(ctx);
    } catch (error: unknown) {
      if (!session.isCurrentGeneration(generation)) return;
      // Auto path never switched authorization on failure. Yolo already
      // applied unrestricted authorization; keep pending so a later step
      // can still catch up if desired mode changed again.
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) {
        ctx.ui.notify(
          renderPermissionNotice({ kind: "mode-change-failed", reason: message }),
          "error",
        );
      }
    }
  };

  const preparePermissionExecution = async (
    ctx: ExtensionContext,
  ): Promise<PreparedPermissionExecution> => {
    // Sole-interpreter ready barrier: always on, memoized. A failure leaves every
    // bash command failing closed to review; it cannot block a request.
    if (!shellParserFailureReported && !(await activateTreeSitterShellParser())) {
      reportShellParserActivationFailure(ctx);
    }
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
      transcriptEpoch: evidence.epoch,
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
                  preferredModel: preferred?.model ?? "configured reviewer",
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

    // Yolo drops friction, not intent: a configured deny rule is the
    // user's explicit persistent intent, so it wins in every mode. The
    // yolo bypass below still skips the spawn gate and every later check.
    const denial = evaluateDenyRulesOnly(
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
    if (executionSnapshot.mode === "yolo") {
      return;
    }

    // Product delegation spawn gate (not foreign tool governance).
    if (executionContext.config.delegation.enabled && DELEGATED_TOOL_NAMES.has(event.toolName)) {
      const spawn = checkDelegateSpawn(executionContext.config, delegationScope());
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

  /** SRT failure diagnostics the backend recorded for a command, if any. */
  const failureDiagnosticsText = async (commandId: string): Promise<string | undefined> => {
    try {
      return await sandboxManager.readFailureDiagnostics?.(commandId);
    } catch {
      return undefined;
    }
  };

  const withFailureDiagnostics = async (commandId: string, error: unknown): Promise<unknown> => {
    const diagnostics = await failureDiagnosticsText(commandId);
    return diagnostics
      ? new Error(`${errorMessage(error)}\n${diagnostics}`, { cause: error })
      : error;
  };

  const runtimeDenialOutcome = async (
    commandId: string,
    evidence: string,
  ): Promise<RuntimeDenialOutcome | undefined> => {
    const capability = looksLikeSandboxDenial(evidence)
      ? await sandboxManager.classifyDenial?.(commandId)
      : undefined;
    return runtimeDenialFromEvidence(evidence, capability);
  };

  /**
   * The sandboxed failure pipeline, shared by thrown and returned
   * failures (Pi 1.x returns a failed command instead of throwing
   * it): append the backend's failure diagnostics to the evidence —
   * labelled observations, never authorization evidence — then let
   * an authoritative runtime denial win over command-status
   * classification. Returns the diagnosed evidence for the caller
   * to complete as the command's own result.
   */
  const diagnoseSandboxedFailure = async (
    commandId: string,
    evidence: string,
  ): Promise<{ text: string; denial: RuntimeDenialOutcome | undefined }> => {
    const diagnostics = await failureDiagnosticsText(commandId);
    const text = diagnostics ? `${evidence}\n${diagnostics}` : evidence;
    const denial = await runtimeDenialOutcome(commandId, text);
    return { text, denial };
  };

  const executePermissionedBash = async (
    id: string,
    params: BashParams,
    signal: AbortSignal | undefined,
    onUpdate: BashOnUpdate,
    ctx: ExtensionContext,
  ): Promise<BashResult> => {
    const tracing = turnTraceEnabled();
    const segments: TurnTraceSegments = {};
    const captured = await traceSpan(tracing, segments, "capture", async () =>
      permissions.captureAction({
        id,
        tool: "bash",
        input: params,
        cwd: resolve(ctx.cwd),
      }),
    );
    const { call } = captured;
    const actionId = call.id;
    const canonicalCwd = call.cwd;
    const canonicalParams = call.input;
    const capturedTranscript = currentGuardianTranscriptSnapshot();
    const { executionSnapshot, executionContext } = await traceSpan(
      tracing,
      segments,
      "prepare",
      () => preparePermissionExecution(ctx),
    );
    // SAFETY: the bridge invokes onUpdate solely with ReviewPartialResult
    // payloads, which the host update channel accepts; no other call shape
    // flows through this seam.
    const reviewBridge = createReviewStatusBridge(
      onUpdate as unknown as (result: ReviewPartialResult) => void,
      ctx.hasUI ? (message, severity) => ctx.ui.notify(message, severity) : undefined,
    );
    // Yolo skips static risk; the Engine's unrestricted lease carries the
    // bare execution with no review (runReview auto-approves, lease and
    // capability checks pass through).
    const risk =
      executionSnapshot.mode === "yolo"
        ? undefined
        : await traceSpan(tracing, segments, "risk", () =>
            evaluateManagedRisk(
              "bash",
              canonicalParams as Record<string, unknown>,
              ctx,
              executionContext,
              canonicalCwd,
            ),
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
          delegationScope(),
        );
        if (violation) {
          throw policyDeniedError(violation);
        }
      }
      for (const host of risk.networkHosts ?? []) {
        const violation = checkDelegationNetwork(host, executionSnapshot.mode, delegationScope());
        if (violation) {
          throw policyDeniedError(violation);
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
        const executeSpanStart = tracing ? performance.now() : 0;
        // Records the child's exit code at the operations seam for the
        // thrown-status path (Pi 1.x signal terminations; every status
        // under Pi 0.86). `undefined` means the child never reported a
        // status (denial, abort, or a failure before/at spawn); a timeout
        // may also leave it undefined after the child had already started.
        // All of these stay a failure. A Pi 1.x non-zero exit never
        // reaches the catch — it is returned and recognized on the result
        // channel below.
        const exitCodeSlot: ExitCodeSlot = { code: undefined };
        // Unrestricted leases use the bare local backend;
        // the sandboxed branch builds its own wrapper below.
        const localBash = () =>
          bashToolFactory(canonicalCwd, {
            operations: captureExitCode(resolveLocalBashOperations(), exitCodeSlot, "local"),
          });
        try {
          if (attemptSignal.aborted) throw new Error("aborted");
          if (mode === "unrestricted") {
            const value = await localBash().execute(
              call.id,
              call.input,
              attemptSignal,
              reviewBridge.onUpdate as BashOnUpdate,
            );
            // A Pi 1.x returned failure is the command's own result.
            return {
              kind: "completed",
              value: completedBashFromResult(value) ?? value,
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
          const value = await sandboxLifecycleLease.runShared(() => {
            assertUnmediatedExecutionCurrent(policy, executionSnapshot);
            return sandboxedBash.execute(
              call.id,
              call.input,
              attemptSignal,
              reviewBridge.onUpdate as BashOnUpdate,
            );
          }, attemptSignal);
          // Pi 1.x returns a failed command as an error result instead
          // of throwing it, so the sandboxed failure pipeline must also
          // run on the returned path. An authoritative runtime denial
          // still wins over the command's own status.
          const failure = returnedBashFailure(value);
          if (!failure) return { kind: "completed", value };
          const { text, denial } = await diagnoseSandboxedFailure(
            call.id,
            bashFailureText(failure),
          );
          if (denial) return denial;
          return { kind: "completed", value: completedBashFailure(failure, text) };
        } catch (error: unknown) {
          if (attemptSignal.aborted) return { kind: "failed", error };
          if (mode === "sandboxed") {
            const { text, denial } = await diagnoseSandboxedFailure(call.id, errorMessage(error));
            if (denial) return denial;
            // Diagnostics are appended for the agent, so a diagnosed
            // error is rebuilt around the original; with no diagnostics
            // the original error object itself is preserved.
            const diagnosed =
              text === errorMessage(error) ? error : new Error(text, { cause: error });
            const completed = completedIfCommandRan(error, diagnosed, exitCodeSlot);
            if (completed) return { kind: "completed", value: completed };
            return { kind: "failed", error: diagnosed };
          }
          const completed = completedIfCommandRan(error, error, exitCodeSlot);
          if (completed) return { kind: "completed", value: completed };
          return { kind: "failed", error };
        } finally {
          if (tracing) {
            segments.execute = (segments.execute ?? 0) + (performance.now() - executeSpanStart);
            // extension_ms sums only the measured extension-side spans; the
            // LLM review wait lives in guardian-metrics.jsonl, never here.
            void flushTurnTrace(actionId, "bash", executionSnapshot.mode, segments, agentDir);
          }
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
      delegationScope(),
    );
    if (envelopeViolation) {
      return {
        action: "block",
        risk: "Forbidden",
        reason: envelopeViolation,
        recoverable: "no",
      };
    }
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
            value: await sandboxLifecycleLease.runShared(() => {
              assertUnmediatedExecutionCurrent(policy, executionSnapshot);
              // A queued retry must still obey the live ceiling, including its new parent root.
              for (const root of policy.filesystem.allowWrite) {
                if (executionSnapshot.baseSandboxConfig?.filesystem.allowWrite.includes(root))
                  continue;
                const violation = checkDelegationWrite(
                  root,
                  executionSnapshot.mode,
                  executionContext.config,
                  delegationScope(),
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
    description: `${baseBash.description} ${permissionedBashDescriptionSuffix}`,
    promptGuidelines: [...permissionedBashPromptGuidelines],
    parameters: permissionedBashParameters,
    prepareArguments: preparePermissionedBashArguments as (args: unknown) => {
      command: string;
      timeout?: number;
      sandbox_permissions?: "use_default" | "with_additional_permissions";
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
    // Declarative only (host surfaces via getAllTools); enforcement never
    // reads this. Write always overwrites, so destructive is accurate.
    annotations: { destructiveHint: true },
    execute: executePermissionedWrite,
  });

  pi.registerTool({
    ...baseEdit,
    ...addReviewResultRenderer(adoptHostTheme(codexEditToolSpec)),
    executionMode: "sequential",
    // Same contract as write above.
    annotations: { destructiveHint: true },
    execute: executePermissionedEdit,
  });

  registerRequestPermissionsTool(pi, {
    executePermissionAction,
    preparePermissionExecution,
    evaluateManagedRisk,
    createPiGuardianReviewContext,
    delegationScope,
    currentGuardianTranscriptSnapshot,
    session,
    permissions,
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
    resetBranchPermissionContext("session changed");
    session.clearLifecycleEvents();
    const generation = session.getGeneration();
    // Prewarm the Shell AST bridge off the request path. The first command's
    // barrier awaits the same memoized activation, so this only moves the
    // one-time grammar load earlier. Fire-and-forget by design: the barrier in
    // preparePermissionExecution remains the single enforcement point.
    void (async () => {
      try {
        if (!(await activateTreeSitterShellParser())) {
          if (session.isCurrentGeneration(generation)) {
            reportShellParserActivationFailure(ctx);
          }
        }
      } catch {
        // The bridge never throws by contract; a detached prewarm must still not
        // surface as an unhandled rejection if that ever changes.
      }
    })();
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
        if (previousMode === "yolo" && restoredMode !== "yolo") abortLiveTurn(ctx);
      }
    });
  });

  // Guide contract (extensions.md:262-263): shutdown cleanup must be
  // idempotent because cancel/reload/replacement/exit paths converge here.
  // The host emits at most once per runner, but a settled flag costs one
  // boolean and stops relying on that; it is deliberately not shared with
  // the tree handlers — a tree switch is invalidation + restore, not
  // teardown, and must leave SRT usable for the restored branch.
  let shutdownSettled = false;
  pi.on("session_shutdown", async () => {
    if (shutdownSettled) return;
    shutdownSettled = true;
    invalidatePermissions("session shutdown");
    session.bumpGeneration();
    cancelInFlightModeTransition();
    session.resetTurn();
    evidence.clearInvalidationAfterModeChange();
    invalidatePermissionContext("session shutdown");
    await sandboxLifecycleLease.runExclusive(async () => {
      sandboxState = { kind: "pending" };
      try {
        await sandboxManager.reset();
      } catch {
        // Fail closed: sandboxState stays pending so any racing activation
        // refuses. Swallowing here does not clear the SRT poison latch; the
        // host already reports handler errors via its own listener.
      }
    });
  });

  pi.on("input", (event) => {
    if ((event.source === "interactive" || event.source === "rpc") && event.text.length > 0) {
      evidence.appendInput(event.text);
    }
  });

  pi.on("message_end", (event) => {
    const entry = guardianTranscriptEntryFromMessage(event.message);
    if (entry) {
      evidence.appendMessage(entry);
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

  // A completed command that reported a non-zero or missing status is a
  // failure the model must see. Pi 1.x's bash tool marks such returned
  // results itself (`isError: true`, honored by the agent loop, which
  // keeps `details` and `structuredContent`), and the bash adapter marks
  // every outcome it builds — so this hook is the safety net for executors
  // that return a failed command without the flag: Pi 0.86 hardcodes every
  // returned result to `isError: false`. It only ever flips the flag;
  // content stays the command's own output, never permission copy, and a
  // result that already is an error is left untouched so the host keeps
  // its details and structured content.
  pi.on("tool_result", (event: ToolResultEvent): ToolResultEventResult | undefined => {
    if (event.toolName !== "bash" || event.isError) return undefined;
    const exitCode = commandExitCode(event.details);
    return exitCode === undefined || exitCode === 0 ? undefined : { isError: true };
  });

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
        if (ctx.hasUI) {
          ctx.ui.notify(renderPermissionNotice({ kind: "approve-requires-mode" }), "warning");
        }
        return;
      }
      if (!ctx.hasUI) {
        // Host contract (runner.js): without a UI, ctx.ui is noOpUIContext,
        // never undefined — this notify is a safe no-op documenting the
        // requirement for log/telemetry consumers.
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
      // No shortcut-availability check here: the host arbitrates shift+tab
      // at dispatch (a reserved built-in binding skips this handler
      // entirely), so by the time this runs the key is ours. The known
      // collision is app.thinking.cycle, which the host reports under
      // [Extension issues] at startup/reload.
      const generation = session.getGeneration();
      try {
        let runtime = modeRuntime;
        if (!runtime) {
          const initial = await activateConfig(ctx, false, undefined, undefined, generation);
          if (!session.isCurrentGeneration(generation)) return;
          runtime = ensureModeRuntime(initial.config);
        }
        const targetMode = nextMode(runtime.mode);
        runtime.activate(targetMode, { preserveAutoTransientState: true });
        pendingModeRefresh = true;
        pendingMode = targetMode;
        deferGuardianInvalidationForModeChange(true);
        setDefaultStatus(ctx);
      } catch (error: unknown) {
        if (!session.isCurrentGeneration(generation)) return;
        const message = error instanceof Error ? error.message : String(error);
        setDefaultStatus(ctx);
        if (ctx.hasUI) {
          ctx.ui.notify(
            renderPermissionNotice({ kind: "mode-change-failed", reason: message }),
            "error",
          );
        }
      }
      return;
    }

    // Between turns / idle: no snapshot to preserve; apply immediately so the
    // next agent_start captures a consistent mode+SRT pair.
    const transitionBarrier = createModeTransitionBarrier();
    try {
      await session.runModeMutation(async (generation) => {
        try {
          invalidatePermissions(PERMISSION_MODE_CHANGED_REASON);
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
          if (ctx.hasUI) {
            ctx.ui.notify(
              renderPermissionNotice({ kind: "mode-change-failed", reason: message }),
              "error",
            );
          }
        }
      });
    } finally {
      settleModeTransitionBarrier(transitionBarrier, false);
    }
  };

  // Unconditional registration: the host arbitrates shift+tab at dispatch
  // (ExtensionRunner.getShortcuts skips this entry when a reserved built-in
  // such as app.thinking.cycle binds the same key) and surfaces the conflict
  // under [Extension issues]. No keybindings.json read here.
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
        if (ctx.hasUI) {
          ctx.ui.notify(`Permission status (read-only)\n${JSON.stringify(state, null, 2)}`, "info");
        }
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
          if (previousMode === "yolo" && runtime.mode !== "yolo") abortLiveTurn(ctx);
          if (runtime.mode === "yolo") {
            if (ctx.hasUI) {
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
            }
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
          if (ctx.hasUI) {
            ctx.ui.notify(
              renderPermissionSummary({
                mode: runtime.mode,
                sandbox: sandboxSummary + networkSummary,
                reviewer: activeReviewer
                  ? {
                      kind: "active",
                      reference: `${activeReviewer.provider}/${activeReviewer.model}`,
                    }
                  : config.reviewer
                    ? { kind: "preference", reference: config.reviewer.model }
                    : undefined,
                autoReviewAvailable: !runtime.autoState.paused,
                ruleCount: config.rules.length,
                writeRoots: config.sandbox.filesystem.allowWrite,
              }),
              "info",
            );
          }
        } catch (error: unknown) {
          if (!session.isCurrentGeneration(generation)) return;
          if (!candidateLoaded) {
            configFailure = error instanceof Error ? error : new Error(String(error));
          }
          if (modeRuntime?.mode === "yolo") abortLiveTurn(ctx);
          reportPermissionSetupError(ctx, error);
        }
      });
    },
  });
}
