import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import {
  createDenialCircuit,
  type DenialCircuit,
  type DenialCircuitPolicy,
} from "./denial-circuit.ts";
import {
  cloneInvocation,
  cloneInvocationCall,
  cloneLease,
  clonePolicy,
  cloneSnapshot,
} from "./engine-clone.ts";
import { callFingerprint, invocationFingerprint } from "./engine-fingerprint.ts";
import type {
  AdmissionPlan,
  AdmissionRisk,
  ApproveForMeMode,
  BlockRecoverability,
  CapabilityAuthorizationDecision,
  CapabilityAuthorizationInput,
  CapabilityLease,
  CapabilityRejectionInput,
  CapabilityRequest,
  CapabilityRequestInput,
  Engine,
  ExecutionOutcome,
  GuardianDecisionMetrics,
  GuardianReviewInput,
  Invocation,
  InvocationCall,
  InvocationOwnership,
  NativeActionFailure,
  PermissionError,
  PermissionStateView,
  ReviewEvent,
  RuntimeOutcome,
  TurnHandle,
  TurnSnapshot,
} from "./engine-types.ts";
import {
  isExactLocalNetworkAllowed,
  matchesNetworkDomainPattern,
} from "./network-domain-pattern.ts";
import { isPublicNetworkHost, isValidNetworkPort, normalizeNetworkHost } from "./network-host.ts";
import { normalizeResidualSignals, type ResidualSignal } from "./permissions/residual.ts";
import {
  effectiveNetworkAuthority,
  fingerprintValue,
  hasGlobSyntax,
  isPathWithin,
} from "./policy-primitives.ts";
import { MAX_JUSTIFICATION_LENGTH, MAX_PATH_LENGTH } from "./request-limits.ts";
import { projectExecutionNetwork, type SandboxPolicy } from "./sandbox-policy.ts";
import { errorMessage, isRecord } from "./unknown-value.ts";

// Keep the historical Engine export for host adapters and third-party callers.
export { matchesNetworkDomainPattern } from "./network-domain-pattern.ts";

export type GuardianDecision =
  | { kind: "approve"; rationale: string; metrics?: GuardianDecisionMetrics }
  | { kind: "deny"; rationale: string; metrics?: GuardianDecisionMetrics }
  | { kind: "timed-out"; metrics?: GuardianDecisionMetrics }
  | { kind: "cancelled"; metrics?: GuardianDecisionMetrics }
  | { kind: "failed"; reason: string; metrics?: GuardianDecisionMetrics };

/** True external decision Adapter. It cannot mint or shape capabilities. */
export interface GuardianAdapter<ReviewContext = undefined> {
  review(
    input: GuardianReviewInput<ReviewContext>,
    signal?: AbortSignal,
  ): Promise<GuardianDecision>;
}

interface PermissionPolicyCheck {
  call: InvocationCall;
  ownership: InvocationOwnership;
  requested: readonly CapabilityRequest[];
  phase: "preview" | "runtime" | "permission-amendment";
}

type PermissionPolicyDecision = { kind: "allow" } | { kind: "deny"; reason: string };

type PolicyCheckResult = PermissionPolicyDecision | { kind: "error"; reason: string };

/** Explicit hard policy is separate from static risk classification. */
export interface PermissionPolicy {
  check(input: PermissionPolicyCheck): PermissionPolicyDecision | Promise<PermissionPolicyDecision>;
}

export interface AutoState {
  readonly consecutiveDenials: number;
  readonly recentDenials: number;
  readonly paused: boolean;
}

interface EngineOptions<ReviewContext = undefined> {
  guardian?: GuardianAdapter<ReviewContext>;
  policy?: PermissionPolicy;
  onAutoStateChange?: (state: AutoState) => void;
  onReviewEvent?: (event: ReviewEvent) => void;
  maxConsecutiveDenials?: number;
  denialWindowSize?: number;
  maxWindowDenials?: number;
}

interface TurnState {
  readonly generation: number;
  readonly snapshot: TurnSnapshot;
  readonly turnNetworkHosts: Set<string>;
  turnNetworkAll: boolean;
  readonly turnWriteRoots: string[];
  readonly grants: Map<string, GrantRecord>;
  readonly approvals: Map<string, ApprovalCacheEntry>;
  closed: boolean;
}

interface GrantRecord {
  readonly callFingerprint: string;
  readonly requested: readonly CapabilityRequest[];
}

/**
 * A Guardian approval remembered for the rest of this turn only. The key is
 * the call identity without call id (same command re-issued); the entry pins
 * the approved scope and the policy it was approved under, so any drift
 * misses instead of authorizing. Dies with the TurnState — never persisted,
 * never inherited by nested turns (those get a fresh Engine), never read
 * outside `auto` mode or for a non-`preview` review source.
 */
interface ApprovalCacheEntry {
  readonly requestedFingerprint: string;
  readonly basePolicyFingerprint: string;
  /**
   * Capability-grant review and action-exercise review are different
   * questions even for the same command and scope: an approved scope must
   * never satisfy a pending action review. Partitioned, never merged.
   */
  readonly reviewKind: string;
  /**
   * What the Guardian actually decided on: risk tier, reason, summary, and
   * residual signals. A realpath flip or a reclassification that leaves the
   * command and scope identical still misses. The live host transcript is
   * deliberately NOT here — the Engine never sees it (the adapter builds
   * reviewContext from host state), so transcript growth cannot be keyed
   * engine-side; the first verdict is reused within the turn.
   */
  readonly evidenceFingerprint: string;
}

interface ApprovalCacheEvidence {
  readonly risk: AdmissionRisk | undefined;
  readonly reason: string | undefined;
  readonly summary: string | undefined;
  readonly residuals: readonly ResidualSignal[] | undefined;
}

interface ReviewRequest {
  readonly source: GuardianReviewInput["source"];
  readonly requested: readonly CapabilityRequest[];
  readonly risk?: AdmissionRisk;
  readonly reason?: string;
  readonly summary?: string;
  /** Override the derived post-review lease for a retry of an existing attempt. */
  readonly effective?: CapabilityLease;
  readonly justification?: string;
  readonly residuals?: readonly ResidualSignal[];
}

interface RuntimeAttemptContext {
  /** The exact capability requests used by the first execution attempt. */
  readonly requested: readonly CapabilityRequest[];
  /** The original admission scope used to construct the first attempt. */
  readonly admissionRequested: readonly CapabilityRequest[];
  /** The immutable effective lease observed by that attempt. */
  readonly lease: CapabilityLease;
}

interface InFlightAttempt<ReviewContext> {
  readonly call: InvocationCall;
  readonly ownership: InvocationOwnership;
  readonly reviewContext: ReviewContext;
  readonly baseline: CapabilityLease;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  terminalError?: PermissionError;
}

type ResolvedAdmission =
  | { kind: "allow"; requested: CapabilityRequest[] }
  | {
      kind: "review";
      requested: CapabilityRequest[];
      review: "capability" | "action";
      risk: AdmissionRisk;
      reason: string;
      summary?: string;
      justification?: string;
      residuals?: ResidualSignal[];
    }
  | { kind: "deny"; reason: string; recoverable?: BlockRecoverability };

function nativeFailureEvidence(outcome: NativeActionFailure): string {
  const failure = outcome.failure;
  return `${errorMessage(outcome.error)}${isRecord(failure) && typeof failure.error === "string" ? `\nHelper failure: ${failure.error}` : ""}\nEffects warning: preparation may have partial directory effects; any content-write attempt may have truncated the file.`;
}

function withExecutionEffects(error: PermissionError): PermissionError {
  return error.effectsMayHaveOccurred === true ? error : { ...error, effectsMayHaveOccurred: true };
}

function pathMatches(pattern: string, path: string): boolean {
  // A glob is a potentially matching deny rule. The Engine never tries to
  // interpret it as an allow; callers must let the real enforcer decide.
  if (hasGlobSyntax(pattern)) return true;
  return isPathWithin(path, pattern);
}

function exactLocalNetworkAllow(
  policy: SandboxPolicy | undefined,
  host: string,
  port: number | undefined,
): boolean {
  return (
    policy !== undefined && isExactLocalNetworkAllowed(policy.network.allowedDomains, host, port)
  );
}

function localNetworkAllowed(
  policy: SandboxPolicy | undefined,
  host: string,
  port: number | undefined,
): boolean {
  if (!policy) return false;
  const authority = effectiveNetworkAuthority(policy.network);
  return authority.privateTargets || exactLocalNetworkAllow(policy, host, port);
}

/** Shared private/special-use gate for every Engine network request path. */
function privateNetworkBlocked(
  policy: SandboxPolicy | undefined,
  request: CapabilityRequest,
): boolean {
  return (
    request.kind === "network" &&
    !isPublicNetworkHost(request.host) &&
    !localNetworkAllowed(policy, request.host, request.port)
  );
}

function normalizeCapabilityRequest(
  raw: unknown,
  cwd: string,
  options: { allowPrivateNetwork?: boolean } = {},
): CapabilityRequest | undefined {
  if (!isRecord(raw) || typeof raw.kind !== "string") return undefined;
  if (raw.kind === "filesystem") {
    if (raw.operation !== "read" && raw.operation !== "write") return undefined;
    if (typeof raw.path !== "string" || raw.path.length === 0 || raw.path.includes("\0"))
      return undefined;
    if (hasGlobSyntax(raw.path) || raw.path.length > MAX_PATH_LENGTH) return undefined;
    return { kind: "filesystem", operation: raw.operation, path: resolve(cwd, raw.path) };
  }
  if (raw.kind === "network-all")
    return Object.keys(raw).length === 1 ? { kind: "network-all" } : undefined;
  if (raw.kind === "network") {
    if (typeof raw.host !== "string") return undefined;
    const host = normalizeNetworkHost(raw.host);
    if (!host || (!options.allowPrivateNetwork && !isPublicNetworkHost(host))) return undefined;
    const port = raw.port;
    if (port !== undefined && (typeof port !== "number" || !isValidNetworkPort(port))) {
      return undefined;
    }
    const protocol = raw.protocol;
    if (protocol !== undefined && typeof protocol !== "string") return undefined;
    return {
      kind: "network",
      host,
      ...(port === undefined ? {} : { port }),
      ...(protocol === undefined ? {} : { protocol }),
    };
  }
  if (raw.kind === "credential") {
    return typeof raw.name === "string" && raw.name.trim().length > 0
      ? { kind: "credential", name: raw.name.trim() }
      : undefined;
  }
  if (raw.kind === "process") {
    if (typeof raw.executable !== "string" || raw.executable.trim().length === 0) return undefined;
    const argv = raw.argv;
    if (
      argv !== undefined &&
      (!Array.isArray(argv) || !argv.every((entry) => typeof entry === "string"))
    ) {
      return undefined;
    }
    return {
      kind: "process",
      executable: raw.executable,
      ...(argv === undefined ? {} : { argv: [...argv] }),
    };
  }
  if (raw.kind === "external-tool") {
    return typeof raw.provider === "string" &&
      raw.provider.trim().length > 0 &&
      typeof raw.name === "string" &&
      raw.name.trim().length > 0
      ? { kind: "external-tool", provider: raw.provider.trim(), name: raw.name.trim() }
      : undefined;
  }
  return undefined;
}

function normalizeRequests(
  raw: readonly CapabilityRequestInput[] | undefined,
  cwd: string,
): { ok: true; requests: CapabilityRequest[] } | { ok: false } {
  if (raw === undefined) return { ok: true, requests: [] };
  const requests: CapabilityRequest[] = [];
  for (const item of raw) {
    const request = normalizeCapabilityRequest(item, cwd, { allowPrivateNetwork: true });
    if (!request) return { ok: false };
    const fingerprint = fingerprintValue(request);
    if (!requests.some((existing) => fingerprintValue(existing) === fingerprint)) {
      requests.push(request);
    }
  }
  return { ok: true, requests };
}

function normalizeAdmission(
  raw: AdmissionPlan | undefined,
  cwd: string,
): { ok: true; admission: ResolvedAdmission } | { ok: false } {
  if (!isRecord(raw) || typeof raw.kind !== "string") return { ok: false };
  if (raw.kind === "deny") {
    if (typeof raw.reason !== "string" || raw.reason.trim().length === 0) return { ok: false };
    // `recoverable` is producer-side classification, not request data: it must
    // survive normalization or the renderer falls back to sniffing the reason.
    const recoverable = raw.recoverable;
    if (recoverable !== undefined && recoverable !== "fix-arguments" && recoverable !== "no") {
      return { ok: false };
    }
    return {
      ok: true,
      admission: {
        kind: "deny",
        reason: raw.reason,
        ...(recoverable === undefined ? {} : { recoverable }),
      },
    };
  }
  if (raw.kind !== "allow" && raw.kind !== "review") return { ok: false };
  const rawRequested = raw.requested;
  if (rawRequested !== undefined && !Array.isArray(rawRequested)) return { ok: false };
  const normalized = normalizeRequests(
    rawRequested === undefined ? undefined : (rawRequested as readonly CapabilityRequestInput[]),
    cwd,
  );
  if (!normalized.ok) return { ok: false };
  if (raw.kind === "allow") {
    if ("executionMode" in raw || "justification" in raw) return { ok: false };
    return {
      ok: true,
      admission: {
        kind: "allow",
        requested: normalized.requests,
      },
    };
  }
  if (
    (raw.review !== "capability" && raw.review !== "action") ||
    (raw.risk !== "Skip" && raw.risk !== "NeedsApproval" && raw.risk !== "Forbidden") ||
    typeof raw.reason !== "string" ||
    raw.reason.trim().length === 0 ||
    (raw.summary !== undefined && typeof raw.summary !== "string")
  ) {
    return { ok: false };
  }
  if (
    raw.justification !== undefined &&
    (typeof raw.justification !== "string" ||
      raw.justification.trim().length === 0 ||
      raw.justification.length > MAX_JUSTIFICATION_LENGTH)
  ) {
    return { ok: false };
  }
  const residuals = normalizeResidualSignals(raw.residuals);
  if (residuals === false) return { ok: false };
  return {
    ok: true,
    admission: {
      kind: "review",
      requested: normalized.requests,
      review: raw.review,
      risk: raw.risk,
      reason: raw.reason,
      ...(raw.summary === undefined ? {} : { summary: raw.summary }),
      ...(raw.justification === undefined ? {} : { justification: raw.justification.trim() }),
      ...(residuals === undefined ? {} : { residuals }),
    },
  };
}

function requestCovered(lease: CapabilityLease, request: CapabilityRequest): boolean {
  if (lease.mode === "unrestricted") return true;
  const policy = lease.policy;
  if (!policy) return false;
  if (request.kind === "filesystem") {
    const denied =
      request.operation === "read" ? policy.filesystem.denyRead : policy.filesystem.denyWrite;
    if (denied.some((pattern) => pathMatches(pattern, request.path))) return false;
    if (request.operation === "read") return true;
    return policy.filesystem.allowWrite.some((root) => isPathWithin(request.path, root));
  }
  if (request.kind === "network-all")
    return (
      effectiveNetworkAuthority(policy.network).wholeNetwork &&
      !networkPolicyDenies(policy, request)
    );
  if (request.kind === "network") {
    if (networkPolicyDenies(policy, request)) return false;
    return (
      effectiveNetworkAuthority(policy.network).wholeNetwork ||
      policy.network.allowedDomains.some((pattern) =>
        matchesNetworkDomainPattern(pattern, request.host, request.port),
      )
    );
  }
  return false;
}

function networkPolicyDenies(policy: SandboxPolicy, request: CapabilityRequest): boolean {
  if (request.kind === "network-all")
    return policy.network.deniedDomains.includes("*") || policy.network.delegated === true;
  return (
    request.kind === "network" &&
    policy.network.deniedDomains.some((pattern) =>
      matchesNetworkDomainPattern(pattern, request.host, request.port),
    )
  );
}

function sandboxCanEnforce(request: CapabilityRequest): boolean {
  // SandboxPolicy grants network hosts only. A port or protocol constraint
  // would be silently widened if it were represented as a host-only rule.
  return (
    request.kind !== "network" || (request.port === undefined && request.protocol === undefined)
  );
}

function runtimeCapabilitySupported(
  ownership: InvocationOwnership,
  request: CapabilityRequest,
): boolean {
  if (ownership === "host-admission") return request.kind === "external-tool";
  return (
    (request.kind === "filesystem" || request.kind === "network") && sandboxCanEnforce(request)
  );
}

function requestKey(request: CapabilityRequest): string {
  return fingerprintValue(request);
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value);
}

function leaseWithRequests(
  state: TurnState,
  ownership: InvocationOwnership,
  requested: readonly CapabilityRequest[],
): CapabilityLease {
  if (state.snapshot.mode === "yolo") return { mode: "unrestricted" };
  if (ownership === "host-admission") return { mode: "host-admitted" };
  const policy = clonePolicy(state.snapshot.baseSandboxPolicy);
  if (!policy) return { mode: "sandboxed" };
  if (state.turnNetworkAll || requested.some((item) => item.kind === "network-all")) {
    policy.network.network_access = true;
    // System TLS cannot host local binding; keep the lease valid under the
    // expanded authority by pinning bind closed for this attempt.
    if (policy.network.macosTls === "system") policy.network.allowLocalBinding = false;
  }
  const turnHosts = [...state.turnNetworkHosts];
  const turnRoots = [...state.turnWriteRoots];
  const extraHosts = [...turnHosts];
  const extraRoots = [...turnRoots];
  for (const request of requested) {
    if (request.kind === "network") extraHosts.push(request.host);
    if (request.kind === "filesystem" && request.operation === "write") {
      extraRoots.push(request.path);
    }
  }
  appendUnique(policy.network.allowedDomains, extraHosts);
  appendUnique(policy.filesystem.allowWrite, extraRoots);
  // Keep ownership in the call, not in the lease. The Adapter sees the same
  // immutable policy shape for sandbox-owned and permission-amendment calls.
  return { mode: "sandboxed", policy };
}

function leaseWithAdditionalRequests(
  lease: CapabilityLease,
  requested: readonly CapabilityRequest[],
): CapabilityLease {
  const next = cloneLease(lease);
  if (next.mode !== "sandboxed" || next.policy === undefined) return next;
  if (requested.some((item) => item.kind === "network-all")) {
    next.policy.network.network_access = true;
    if (next.policy.network.macosTls === "system") next.policy.network.allowLocalBinding = false;
  }
  const extraHosts: string[] = [];
  const extraRoots: string[] = [];
  for (const request of requested) {
    if (request.kind === "network") extraHosts.push(request.host);
    if (request.kind === "filesystem" && request.operation === "write") {
      extraRoots.push(request.path);
    }
  }
  appendUnique(next.policy.network.allowedDomains, extraHosts);
  appendUnique(next.policy.filesystem.allowWrite, extraRoots);
  return next;
}

export function createEngine<ReviewContext = undefined>(
  options: EngineOptions<ReviewContext> = {},
): Engine<ReviewContext> {
  let generation = 0;
  let active: TurnState | undefined;
  let sessionKey: string | undefined;
  let configKey: string | undefined;
  // The circuit's counters and its gate are one fact, so the Engine holds the
  // module, never the pieces. Resets replace the instance instead of clearing
  // fields: that is the state's lifetime seam.
  const circuitPolicy: Partial<DenialCircuitPolicy> = {
    maxConsecutiveDenials: options.maxConsecutiveDenials,
    denialWindowSize: options.denialWindowSize,
    maxWindowDenials: options.maxWindowDenials,
  };
  let circuit: DenialCircuit = createDenialCircuit(circuitPolicy);
  let reviewSequence = 0;
  const reviewControllers = new Set<AbortController>();
  const inFlightCallIds = new Set<string>();
  const inFlightAttempts = new Map<string, InFlightAttempt<ReviewContext>>();

  const recordDenialStats = (): void => {
    circuit.recordDenial();
    emitAutoStateChange();
  };

  const emitAutoStateChange = (): void => {
    const readout = circuit.readout();
    options.onAutoStateChange?.({
      consecutiveDenials: readout.consecutiveDenials,
      recentDenials: readout.recentDenials,
      paused: circuit.open(),
    });
  };

  const emitReviewEvent = (event: ReviewEvent | (() => ReviewEvent)): void => {
    if (!options.onReviewEvent) return;
    try {
      options.onReviewEvent(typeof event === "function" ? event() : event);
    } catch {
      // Review lifecycle reporting is observational. A broken presenter or
      // event subscriber must never alter authorization or execution.
    }
  };

  const recordNonDenial = (): void => {
    circuit.recordSuccess();
    emitAutoStateChange();
  };

  /**
   * The deny half of a review outcome: it feeds the deny circuit and nothing
   * else. There is no retry handle and no denial ledger — a denial is terminal
   * for the invocation that produced it, so there is nothing to arm.
   */
  const recordDenial = (): void => {
    recordDenialStats();
  };

  const isCurrent = (state: TurnState): boolean =>
    active === state && !state.closed && state.generation === generation;

  const abortReviews = (reason: string): void => {
    for (const controller of reviewControllers) controller.abort(new Error(reason));
    reviewControllers.clear();
  };

  const abortAttempts = (reason: string): void => {
    const error = withExecutionEffects({
      code: "stale-invocation",
      reason: "Permission context changed",
    });
    for (const attempt of inFlightAttempts.values()) {
      attempt.terminalError ??= error;
      attempt.controller.abort(new Error(reason));
    }
  };

  const closeState = (state: TurnState, reason: string): void => {
    if (state.closed) return;
    const wasActive = active === state;
    state.closed = true;
    state.grants.clear();
    state.approvals.clear();
    if (wasActive) abortAttempts(reason);
    inFlightAttempts.clear();
    state.turnNetworkHosts.clear();
    state.turnNetworkAll = false;
    state.turnWriteRoots.length = 0;
    if (wasActive) {
      abortReviews(reason);
      active = undefined;
    }
  };

  const blocked = <T>(error: PermissionError): ExecutionOutcome<T> => ({
    kind: "blocked",
    error,
  });

  const policyCheck = async (request: PermissionPolicyCheck): Promise<PolicyCheckResult> => {
    if (!options.policy) return { kind: "allow" };
    try {
      const decision = await options.policy.check({
        call: cloneInvocationCall(request.call),
        ownership: request.ownership,
        requested: request.requested.map((item) => structuredClone(item)),
        phase: request.phase,
      });
      if (decision.kind === "allow") return decision;
      if (decision.kind === "deny" && typeof decision.reason === "string") return decision;
      return { kind: "error", reason: "Permission policy returned an invalid decision" };
    } catch (error) {
      return { kind: "error", reason: `Permission policy failed: ${errorMessage(error)}` };
    }
  };

  const runReview = async (
    state: TurnState,
    request: Invocation<unknown, ReviewContext>,
    baseline: CapabilityLease,
    review: ReviewRequest,
  ): Promise<GuardianDecision | PermissionError> => {
    if (state.snapshot.mode === "yolo") {
      return { kind: "approve", rationale: "yolo is active" };
    }
    if (circuit.open()) return { code: "circuit-open", reason: "Auto-review circuit is open" };
    const reviewId = `review-${++reviewSequence}`;
    const displaySummary = review.summary?.trim() || undefined;
    const reviewStartTs = Date.now();
    const ownership = request.ownership;
    emitReviewEvent(() => ({
      status: "reviewing",
      reviewId,
      call: cloneInvocationCall(request.call),
      ownership,
      ...(displaySummary === undefined ? {} : { displaySummary }),
    }));
    const guardian = options.guardian;
    if (!guardian) {
      const reason = "The configured reviewer is unavailable";
      emitReviewEvent(() => ({
        status: "failed",
        reviewId,
        call: cloneInvocationCall(request.call),
        ownership,
        reason,
        metrics: { durationMs: Date.now() - reviewStartTs },
        ...(displaySummary === undefined ? {} : { displaySummary }),
      }));
      return { code: "review-unavailable", reason };
    }
    const controller = new AbortController();
    reviewControllers.add(controller);
    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal])
      : controller.signal;
    try {
      if (signal.aborted) {
        emitReviewEvent(() => ({
          status: "aborted",
          reviewId,
          call: cloneInvocationCall(request.call),
          ownership,
          metrics: { durationMs: Date.now() - reviewStartTs },
          ...(displaySummary === undefined ? {} : { displaySummary }),
        }));
        return { code: "aborted", reason: "Operation aborted" };
      }
      const decision = await guardian.review(
        {
          call: cloneInvocationCall(request.call),
          ownership: request.ownership,
          requested: review.requested.map((item) => structuredClone(item)),
          source: review.source,
          authority: {
            generation: state.generation,
            turnId: state.snapshot.turnId,
            configFingerprint: state.snapshot.configFingerprint,
            turn: {
              networkAll: state.turnNetworkAll,
              networkHosts: [...state.turnNetworkHosts],
              writeRoots: [...state.turnWriteRoots],
              expires: "turn-end",
            },
          },
          risk: review.risk,
          baseline: cloneLease(baseline),
          effective:
            review.effective === undefined
              ? leaseWithRequests(state, request.ownership, review.requested)
              : cloneLease(review.effective),
          reason: review.reason,
          summary: review.summary,
          ...(review.justification === undefined ? {} : { justification: review.justification }),
          ...(review.residuals === undefined || review.residuals.length === 0
            ? {}
            : { residuals: review.residuals }),
          context: request.reviewContext,
        },
        signal,
      );
      if (!isCurrent(state)) {
        emitReviewEvent(() => ({
          status: "aborted",
          reviewId,
          call: cloneInvocationCall(request.call),
          ownership,
          metrics: { durationMs: Date.now() - reviewStartTs },
          ...(displaySummary === undefined ? {} : { displaySummary }),
        }));
        return { code: "stale-invocation", reason: "Permission context changed" };
      }
      if (signal.aborted) {
        emitReviewEvent(() => ({
          status: "aborted",
          reviewId,
          call: cloneInvocationCall(request.call),
          ownership,
          metrics: { durationMs: Date.now() - reviewStartTs },
          ...(displaySummary === undefined ? {} : { displaySummary }),
        }));
        return { code: "aborted", reason: "Operation aborted" };
      }
      if (decision.kind === "cancelled") {
        emitReviewEvent(() => ({
          status: "aborted",
          reviewId,
          call: cloneInvocationCall(request.call),
          ownership,
          metrics: {
            durationMs: Date.now() - reviewStartTs,
            ...(decision.metrics ?? {}),
          },
        }));
        return { code: "aborted", reason: "Operation aborted" };
      }
      if (decision.kind === "timed-out") {
        recordNonDenial();
        emitReviewEvent(() => ({
          status: "timed-out",
          reviewId,
          call: cloneInvocationCall(request.call),
          ownership,
          metrics: {
            durationMs: Date.now() - reviewStartTs,
            ...(decision.metrics ?? {}),
          },
          ...(displaySummary === undefined ? {} : { displaySummary }),
        }));
        return { code: "review-timeout", reason: "Automatic approval review timed out" };
      }
      if (decision.kind === "failed") {
        recordNonDenial();
        emitReviewEvent(() => ({
          status: "failed",
          reviewId,
          call: cloneInvocationCall(request.call),
          ownership,
          reason: decision.reason,
          metrics: {
            durationMs: Date.now() - reviewStartTs,
            ...(decision.metrics ?? {}),
          },
          ...(displaySummary === undefined ? {} : { displaySummary }),
        }));
        return { code: "review-unavailable", reason: decision.reason };
      }
      if (decision.kind !== "approve" && decision.kind !== "deny") {
        recordNonDenial();
        const reason = "The reviewer returned an invalid decision";
        emitReviewEvent(() => ({
          status: "failed",
          reviewId,
          call: cloneInvocationCall(request.call),
          ownership,
          reason,
          metrics: { durationMs: Date.now() - reviewStartTs },
          ...(displaySummary === undefined ? {} : { displaySummary }),
        }));
        return { code: "review-unavailable", reason };
      }
      if (decision.kind === "approve") recordNonDenial();
      emitReviewEvent(() => ({
        status: decision.kind === "approve" ? "approved" : "denied",
        reviewId,
        call: cloneInvocationCall(request.call),
        ownership,
        rationale: decision.rationale,
        metrics: {
          durationMs: Date.now() - reviewStartTs,
          ...(decision.metrics ?? {}),
        },
        ...(displaySummary === undefined ? {} : { displaySummary }),
      }));
      return decision;
    } catch (error) {
      if (!isCurrent(state)) {
        emitReviewEvent(() => ({
          status: "aborted",
          reviewId,
          call: cloneInvocationCall(request.call),
          ownership,
          metrics: { durationMs: Date.now() - reviewStartTs },
          ...(displaySummary === undefined ? {} : { displaySummary }),
        }));
        return { code: "stale-invocation", reason: "Permission context changed" };
      }
      if (request.signal?.aborted) {
        emitReviewEvent(() => ({
          status: "aborted",
          reviewId,
          call: cloneInvocationCall(request.call),
          ownership,
          metrics: { durationMs: Date.now() - reviewStartTs },
          ...(displaySummary === undefined ? {} : { displaySummary }),
        }));
        return { code: "aborted", reason: "Operation aborted" };
      }
      if (controller.signal.aborted) {
        emitReviewEvent(() => ({
          status: "aborted",
          reviewId,
          call: cloneInvocationCall(request.call),
          ownership,
          metrics: { durationMs: Date.now() - reviewStartTs },
          ...(displaySummary === undefined ? {} : { displaySummary }),
        }));
        return { code: "stale-invocation", reason: "Permission context changed" };
      }
      recordNonDenial();
      const reason = errorMessage(error);
      emitReviewEvent(() => ({
        status: "failed",
        reviewId,
        call: cloneInvocationCall(request.call),
        ownership,
        reason,
        metrics: { durationMs: Date.now() - reviewStartTs },
        ...(displaySummary === undefined ? {} : { displaySummary }),
      }));
      return {
        code: "review-unavailable",
        reason,
      };
    } finally {
      reviewControllers.delete(controller);
    }
  };

  const consumeGrant = (
    state: TurnState,
    request: Invocation<unknown, ReviewContext>,
    requested: readonly CapabilityRequest[],
  ): GrantRecord | undefined => {
    const fingerprint = callFingerprint(state.snapshot, request.call, request.ownership);
    const grant = state.grants.get(request.call.id);
    if (!grant || grant.callFingerprint !== fingerprint) return undefined;
    // Delete before the Adapter is entered: this is the atomic one-shot spend.
    state.grants.delete(request.call.id);
    if (
      grant.requested.some(
        (entry) => !requested.some((candidate) => requestKey(candidate) === requestKey(entry)),
      )
    ) {
      return undefined;
    }
    return grant;
  };

  /**
   * Turn-scoped approval cache. A Guardian approve + completed execution
   * remembers the exact call identity (without call id) so the identical
   * action skips re-review later in the SAME turn. Every drift — scope,
   * policy, mode, generation, ownership, source — misses instead of
   * authorizing. Enforcement (policyCheck, grant spend, live ceilings at
   * execution) still runs on hits; only the Guardian round-trip is skipped.
   */
  const readApprovalCache = (
    state: TurnState,
    request: Invocation<unknown, ReviewContext>,
    source: ReviewRequest["source"],
    requested: readonly CapabilityRequest[],
    reviewKind: string,
    evidence: ApprovalCacheEvidence,
  ): { kind: "approve"; rationale: string } | undefined => {
    if (source !== "preview") return undefined;
    if (request.ownership !== "sandbox-owned") return undefined;
    if (state.snapshot.mode !== "auto") return undefined;
    if (circuit.open()) return undefined;
    if (!isCurrent(state)) return undefined;
    // Fingerprinting must never throw out of the execution path: an
    // unhashable input misses instead of rejecting the invocation.
    let key: string;
    let requestedFingerprint: string;
    let basePolicyFingerprint: string;
    let evidenceFingerprint: string;
    try {
      key = invocationFingerprint(state.snapshot, request.call, request.ownership, false);
      requestedFingerprint = fingerprintValue(requested);
      basePolicyFingerprint = fingerprintValue(state.snapshot.baseSandboxPolicy ?? null);
      evidenceFingerprint = fingerprintValue(evidence);
    } catch {
      return undefined;
    }
    const entry = state.approvals.get(key);
    if (entry === undefined) return undefined;
    if (entry.reviewKind !== reviewKind) return undefined;
    if (entry.requestedFingerprint !== requestedFingerprint) return undefined;
    if (entry.basePolicyFingerprint !== basePolicyFingerprint) return undefined;
    if (entry.evidenceFingerprint !== evidenceFingerprint) return undefined;
    return { kind: "approve", rationale: "Approved earlier in this turn for the identical action" };
  };

  const writeApprovalCache = (
    state: TurnState,
    request: Invocation<unknown, ReviewContext>,
    source: ReviewRequest["source"],
    requested: readonly CapabilityRequest[],
    reviewKind: string,
    evidence: ApprovalCacheEvidence,
  ): void => {
    if (source !== "preview") return;
    if (request.ownership !== "sandbox-owned") return;
    if (state.snapshot.mode !== "auto") return;
    if (!isCurrent(state)) return;
    let key: string;
    let entry: ApprovalCacheEntry;
    try {
      key = invocationFingerprint(state.snapshot, request.call, request.ownership, false);
      entry = {
        requestedFingerprint: fingerprintValue(requested),
        basePolicyFingerprint: fingerprintValue(state.snapshot.baseSandboxPolicy ?? null),
        reviewKind,
        evidenceFingerprint: fingerprintValue(evidence),
      };
    } catch {
      return;
    }
    state.approvals.set(key, entry);
  };

  const denyAttempt = (
    attempt: InFlightAttempt<ReviewContext>,
    error: PermissionError,
  ): CapabilityAuthorizationDecision => {
    attempt.terminalError ??= withExecutionEffects(error);
    attempt.controller.abort(new Error(attempt.terminalError.reason));
    return { kind: "deny", error: attempt.terminalError };
  };

  const rejectInlineCapability = (
    state: TurnState,
    callId: string,
    input: CapabilityRejectionInput,
  ): CapabilityAuthorizationDecision => {
    if (!isCurrent(state)) {
      return {
        kind: "deny",
        error: { code: "stale-invocation", reason: "Permission context changed" },
      };
    }
    const attempt = inFlightAttempts.get(callId);
    if (!attempt) {
      return {
        kind: "deny",
        error: {
          code: "stale-invocation",
          reason: "Capability rejection does not match the active execution attempt",
        },
      };
    }
    if (attempt.signal.aborted) {
      return {
        kind: "deny",
        error:
          attempt.terminalError ??
          withExecutionEffects({
            code: "aborted",
            reason: "Operation aborted",
          }),
      };
    }
    const normalized = normalizeCapabilityRequest(input.capability, attempt.call.cwd, {
      allowPrivateNetwork: true,
    });
    if (!normalized) {
      return denyAttempt(attempt, {
        code: "policy-denied",
        reason: "Capability boundary reported an invalid request",
      });
    }
    return denyAttempt(attempt, {
      code: "policy-denied",
      reason: input.reason.trim() || "Capability boundary denied the request",
      request: normalized,
    });
  };

  const executeAttempt = async <T>(
    state: TurnState,
    request: Invocation<T, ReviewContext>,
    requested: readonly CapabilityRequest[],
    grant?: GrantRecord,
    leaseOverride?: CapabilityLease,
  ): Promise<RuntimeOutcome<T> | ExecutionOutcome<T>> => {
    if (!isCurrent(state))
      return blocked({ code: "stale-invocation", reason: "Permission context changed" });
    if (request.signal?.aborted) return blocked({ code: "aborted", reason: "Operation aborted" });
    const lease =
      leaseOverride ??
      leaseWithRequests(state, request.ownership, [...requested, ...(grant?.requested ?? [])]);
    if (lease.policy) {
      const network = lease.policy.network;
      network.execution = projectExecutionNetwork(lease.policy);
      if (network.access) Object.freeze(network.access);
      Object.freeze(network.allowedDomains);
      Object.freeze(network.deniedDomains);
      if (network.trustedFakeIpRanges) Object.freeze(network.trustedFakeIpRanges);
      Object.freeze(network);
    }
    const attemptCall = cloneInvocationCall(request.call);
    const controller = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal])
      : controller.signal;
    const inFlightAttempt: InFlightAttempt<ReviewContext> = {
      call: attemptCall,
      ownership: request.ownership,
      reviewContext: request.reviewContext,
      baseline: cloneLease(lease),
      controller,
      signal,
    };
    inFlightAttempts.set(attemptCall.id, inFlightAttempt);
    try {
      const result = await request.executor({
        call: attemptCall,
        lease,
        signal,
        authorizeCapability: (input) => authorizeInlineCapability(state, attemptCall.id, input),
        rejectCapability: (input) => rejectInlineCapability(state, attemptCall.id, input),
      });
      const failureEvidence =
        result.kind === "native-action-failed"
          ? `\nOriginal action failure: ${nativeFailureEvidence(result)}`
          : "";
      if (inFlightAttempt.terminalError)
        return blocked({
          ...inFlightAttempt.terminalError,
          reason: inFlightAttempt.terminalError.reason + failureEvidence,
        });
      if (!isCurrent(state)) {
        return blocked(
          withExecutionEffects({
            code: "stale-invocation",
            reason: `Permission context changed${failureEvidence}`,
          }),
        );
      }
      if (signal.aborted) {
        return blocked(
          withExecutionEffects({ code: "aborted", reason: `Operation aborted${failureEvidence}` }),
        );
      }
      if (result.kind === "failed") {
        return { kind: "failed", error: result.error, effectsMayHaveOccurred: true };
      }
      return result;
    } catch (error) {
      if (inFlightAttempt.terminalError) return blocked(inFlightAttempt.terminalError);
      if (request.signal?.aborted)
        return blocked(withExecutionEffects({ code: "aborted", reason: "Operation aborted" }));
      if (!isCurrent(state))
        return blocked(
          withExecutionEffects({ code: "stale-invocation", reason: "Permission context changed" }),
        );
      if (signal.aborted)
        return blocked(withExecutionEffects({ code: "aborted", reason: "Operation aborted" }));
      return { kind: "failed", error, effectsMayHaveOccurred: true };
    } finally {
      if (inFlightAttempts.get(attemptCall.id) === inFlightAttempt) {
        inFlightAttempts.delete(attemptCall.id);
      }
    }
  };

  const executeUnrestricted = async <T>(
    state: TurnState,
    request: Invocation<T, ReviewContext>,
  ): Promise<ExecutionOutcome<T>> => {
    const outcome = await executeAttempt(state, request, []);
    if (outcome.kind === "blocked") return outcome;
    if (outcome.kind === "failed") return outcome;
    if (outcome.kind === "completed") return outcome;
    if (outcome.kind === "native-action-failed")
      return { kind: "failed", error: outcome.error, effectsMayHaveOccurred: true };
    const normalized = normalizeCapabilityRequest(outcome.request, request.call.cwd);
    return blocked(
      withExecutionEffects({
        code: "runtime-denied",
        reason: outcome.detail ?? "Unrestricted execution reported a capability denial",
        ...(normalized === undefined ? {} : { request: normalized }),
      }),
    );
  };

  const handleNativeActionFailure = async <T>(
    state: TurnState,
    request: Invocation<T, ReviewContext>,
    outcome: NativeActionFailure,
    attempt: RuntimeAttemptContext,
    allowRetry: boolean,
  ): Promise<ExecutionOutcome<T>> => {
    const failure = outcome.failure;
    const evidence = nativeFailureEvidence(outcome);
    const terminal = (
      reason: string,
      code: PermissionError["code"] = "runtime-denied",
      retryAttempted = false,
    ): ExecutionOutcome<T> =>
      blocked(
        withExecutionEffects({
          code,
          reason: `${reason}\nOriginal action failure: ${evidence}`,
          ...(retryAttempted ? { retryAttempted: true as const } : {}),
        }),
      );
    const input = request.call.input;
    if (
      !allowRetry ||
      request.runtimeDenialPolicy !== "review-and-retry" ||
      request.ownership !== "sandbox-owned" ||
      attempt.lease.mode !== "sandboxed" ||
      !isRecord(failure) ||
      failure.contentWriteStarted !== false ||
      !Number.isInteger(failure.exitCode) ||
      failure.exitCode === 0 ||
      typeof failure.error !== "string" ||
      // The fixed Node helper emits error.message with an errno prefix.
      // Permission words later in that message can be part of the filename.
      !/^(?:EACCES|EPERM|EROFS): /.test(failure.error) ||
      failure.cwd !== request.call.cwd ||
      !isRecord(input) ||
      typeof input.path !== "string"
    ) {
      return terminal(
        "Native recovery requires eligible preparation-stage access failure evidence; no replay",
      );
    }
    const target = normalizeCapabilityRequest(
      { kind: "filesystem", operation: "write", path: input.path },
      request.call.cwd,
    );
    if (target?.kind !== "filesystem") return terminal("Invalid original file identity");
    const mkdir = request.call.tool === "write" && failure.operation === "mkdir";
    const edit =
      request.call.tool === "edit" &&
      (failure.operation === "access" || failure.operation === "read");
    if ((!mkdir && !edit) || failure.path !== (mkdir ? dirname(target.path) : target.path))
      return terminal("Failed operation does not match the frozen native action");
    const root = mkdir ? dirname(target.path) : target.path;
    if (
      root === dirname(root) ||
      isPathWithin(homedir(), root) ||
      basename(root) === "Library" ||
      hasGlobSyntax(root)
    )
      return terminal("Refusing a broad or unrepresentable native recovery root");
    if (mkdir && outcome.mkdirScopeSupported !== true)
      return terminal(
        "Immediate-parent write root is not representable by this backend; no ancestor widening",
      );
    const delta: CapabilityRequest = { kind: "filesystem", operation: "write", path: root };
    if (requestCovered(attempt.lease, delta))
      return terminal(
        "Proposed root is already covered by the execution lease; refusing a blind retry",
        "enforcement-unavailable",
      );
    const effective = leaseWithAdditionalRequests(attempt.lease, [delta]);
    if (
      !requestCovered(effective, delta) ||
      !requestCovered(effective, target) ||
      (edit && !requestCovered(effective, { ...target, operation: "read" }))
    )
      return terminal("Native recovery cannot bypass denyWrite or denyRead", "policy-denied");
    const check = async (): Promise<ExecutionOutcome<T> | undefined> => {
      const decision = await policyCheck({
        call: request.call,
        ownership: request.ownership,
        requested: [target, delta],
        phase: "runtime",
      });
      if (!isCurrent(state)) return terminal("Permission context changed", "stale-invocation");
      if (request.signal?.aborted) return terminal("Operation aborted", "aborted");
      if (decision.kind !== "allow")
        return terminal(
          decision.reason,
          decision.kind === "deny" ? "policy-denied" : "policy-error",
        );
      return undefined;
    };
    const ineligible = await check();
    if (ineligible) return ineligible;
    const decision = await runReview(
      state,
      request as Invocation<unknown, ReviewContext>,
      attempt.lease,
      {
        source: "inline",
        requested: [delta],
        effective,
        risk: "NeedsApproval",
        summary: `${request.call.tool} native preparation recovery`,
        residuals: ["native_recovery", "write_root_uncovered", "risk_not_skip"],
        reason: `Review re-entering the original complete ${request.call.tool} action once, not a proven sandbox denial. Observed ${failure.operation} access failure before any content write. Additional write root: ${JSON.stringify(root)}${mkdir ? " (immediate-parent subtree scope, not mkdir-only)" : " (original file write root)"}. Re-entry rereads current content and repeats native preparation; partial directory effects may already exist.\n${evidence}`,
      },
    );
    if ("code" in decision) return terminal(decision.reason, decision.code);
    // No capability-only handle: it would lose this failed-action/effects context.
    if (decision.kind === "deny") {
      recordDenialStats();
      return terminal(decision.rationale, "review-denied");
    }
    const changed = await check();
    if (changed) return changed;
    const retry = await executeAttempt(
      state,
      request,
      [...attempt.requested, delta],
      undefined,
      effective,
    );
    if (retry.kind === "completed") return retry;
    if (retry.kind === "blocked") return terminal(retry.error.reason, retry.error.code, true);
    const retryError =
      retry.kind === "capability-denied"
        ? (retry.detail ?? "Capability denied")
        : errorMessage(retry.error);
    return terminal(
      `Native second attempt failed; no further replay: ${retryError}`,
      "runtime-denied",
      true,
    );
  };

  const handleRuntimeOutcome = async <T>(
    state: TurnState,
    request: Invocation<T, ReviewContext>,
    outcome: RuntimeOutcome<T>,
    attempt: RuntimeAttemptContext,
    allowRetry = true,
  ): Promise<ExecutionOutcome<T>> => {
    if (outcome.kind === "completed") return outcome;
    if (outcome.kind === "failed") return outcome;
    if (outcome.kind === "native-action-failed")
      return handleNativeActionFailure(state, request, outcome, attempt, allowRetry);
    const normalized = normalizeCapabilityRequest(outcome.request, request.call.cwd);
    if (!normalized) {
      return blocked(
        withExecutionEffects({
          code: "runtime-denied",
          reason: "Runtime denial did not contain a valid capability request",
        }),
      );
    }
    if (normalized.kind === "network") {
      return blocked(
        withExecutionEffects({
          code: "runtime-denied",
          reason: "Network authorization must happen before the connection attempt",
          request: normalized,
        }),
      );
    }
    if (!runtimeCapabilitySupported(request.ownership, normalized)) {
      return blocked(
        withExecutionEffects({
          code: "enforcement-unavailable",
          reason: "The execution adapter cannot enforce this runtime capability",
          request: normalized,
        }),
      );
    }
    const runtimePolicy = await policyCheck({
      call: request.call,
      ownership: request.ownership,
      requested: [normalized],
      phase: "runtime",
    });
    if (!isCurrent(state))
      return blocked(
        withExecutionEffects({ code: "stale-invocation", reason: "Permission context changed" }),
      );
    if (request.signal?.aborted)
      return blocked(withExecutionEffects({ code: "aborted", reason: "Operation aborted" }));
    if (runtimePolicy.kind === "error")
      return blocked(
        withExecutionEffects({
          code: "policy-error",
          reason: runtimePolicy.reason,
          request: normalized,
        }),
      );
    if (runtimePolicy.kind === "deny")
      return blocked(
        withExecutionEffects({
          code: "policy-denied",
          reason: runtimePolicy.reason,
          request: normalized,
        }),
      );

    // A typed capability denial alone cannot prove a safe native replay stage.
    return blocked(
      withExecutionEffects({
        code: "runtime-denied",
        reason: outcome.detail ?? "Sandbox enforcement denied a capability during execution",
        request: normalized,
        ...(allowRetry ? {} : { retryAttempted: true as const }),
      }),
    );
  };

  const executeInvocationOwned = async <T>(
    state: TurnState,
    request: Invocation<T, ReviewContext>,
  ): Promise<ExecutionOutcome<T>> => {
    if (request.signal?.aborted) return blocked({ code: "aborted", reason: "Operation aborted" });
    if (!isCurrent(state))
      return blocked({ code: "stale-invocation", reason: "Permission context changed" });
    if (resolve(request.call.cwd) !== state.snapshot.cwd) {
      return blocked({
        code: "stale-invocation",
        reason: "Invocation cwd does not match the turn snapshot",
      });
    }
    if (request.ownership === "permission-amendment" && !request.intent) {
      return blocked({ code: "policy-denied", reason: "Permission amendment intent is required" });
    }
    if (request.intent && request.ownership !== "permission-amendment") {
      return blocked({
        code: "policy-denied",
        reason: "Only permission-amendment calls may alter the permission world",
      });
    }
    if (state.snapshot.mode === "yolo") return executeUnrestricted(state, request);
    if (
      (request.ownership === "sandbox-owned" || request.ownership === "permission-amendment") &&
      state.snapshot.mode === "auto" &&
      (state.snapshot.sandboxReady === false || state.snapshot.baseSandboxPolicy === undefined)
    ) {
      return blocked({
        code: "enforcement-unavailable",
        reason: "Sandbox enforcement is unavailable",
      });
    }
    if (request.ownership !== "permission-amendment" && request.admission === undefined) {
      return blocked({ code: "policy-denied", reason: "Admission plan is required" });
    }
    const admissionResult =
      request.ownership === "permission-amendment" && request.admission === undefined
        ? { ok: true as const, admission: { kind: "allow" as const, requested: [] } }
        : normalizeAdmission(request.admission, request.call.cwd);
    if (!admissionResult.ok) {
      return blocked({ code: "policy-denied", reason: "Admission plan is invalid" });
    }
    const admission = admissionResult.admission;
    if (admission.kind === "deny") {
      return blocked({
        code: "policy-denied",
        reason: admission.reason,
        ...(admission.recoverable === undefined ? {} : { recoverable: admission.recoverable }),
      });
    }
    if (request.ownership === "host-admission" && admission.requested.length === 0) {
      return blocked({
        code: "enforcement-unavailable",
        reason: "Host admission requires an exact capability request",
      });
    }
    if (
      admission.requested.some((item) =>
        privateNetworkBlocked(state.snapshot.baseSandboxPolicy, item),
      )
    ) {
      return blocked({
        code: "policy-denied",
        reason: "Private or special-use network target is blocked",
      });
    }
    if (
      admission.requested.some(
        (item) =>
          (item.kind === "network" || item.kind === "network-all") &&
          state.snapshot.baseSandboxPolicy !== undefined &&
          networkPolicyDenies(state.snapshot.baseSandboxPolicy, item),
      )
    ) {
      return blocked({
        code: "policy-denied",
        reason: "Network target is denied by sandbox policy",
      });
    }
    if (
      state.snapshot.mode === "auto" &&
      request.ownership === "sandbox-owned" &&
      admission.requested.some(
        (item) =>
          item.kind === "process" ||
          item.kind === "credential" ||
          item.kind === "external-tool" ||
          !sandboxCanEnforce(item),
      )
    ) {
      return blocked({
        code: "enforcement-unavailable",
        reason: "The sandbox adapter cannot enforce this capability preview",
      });
    }
    if (
      state.snapshot.mode === "auto" &&
      request.ownership === "host-admission" &&
      admission.requested.some((item) => item.kind !== "external-tool")
    ) {
      return blocked({
        code: "enforcement-unavailable",
        reason: "Host admission accepts only exact external-tool previews",
      });
    }
    if (
      admission.requested.some((item) => item.kind === "network-all") &&
      request.ownership !== "permission-amendment"
    ) {
      return blocked({
        code: "policy-denied",
        reason: "Whole-network authority requires an explicit permission amendment",
      });
    }
    const networkPolicy = state.snapshot.baseSandboxPolicy?.network;
    if (
      networkPolicy?.access?.kind === "explicit" &&
      networkPolicy.access.transport === "direct" &&
      admission.requested.some((item) => item.kind === "network")
    ) {
      return blocked({
        code: "policy-denied",
        reason: "Direct requires a whole-network amendment; host-only requests cannot be widened",
      });
    }
    const baseline = leaseWithRequests(state, request.ownership, []);
    try {
      const proposed = leaseWithRequests(state, request.ownership, admission.requested);
      if (proposed.policy) projectExecutionNetwork(proposed.policy);
    } catch (error) {
      return blocked({
        code: "policy-denied",
        reason: `Network policy conflict: ${errorMessage(error)}`,
      });
    }
    const hardPreview = await policyCheck({
      call: request.call,
      ownership: request.ownership,
      requested: admission.requested,
      phase: request.intent ? "permission-amendment" : "preview",
    });
    if (hardPreview.kind === "error")
      return blocked({ code: "policy-error", reason: hardPreview.reason });
    if (hardPreview.kind === "deny")
      return blocked({ code: "policy-denied", reason: hardPreview.reason });

    if (request.intent) {
      const amendment = normalizeRequests(request.intent.requested, request.call.cwd);
      if (!amendment.ok || amendment.requests.length === 0) {
        return blocked({
          code: "policy-denied",
          reason: "Permission amendment is invalid or empty",
        });
      }
      if (
        amendment.requests.some((item) =>
          privateNetworkBlocked(state.snapshot.baseSandboxPolicy, item),
        )
      ) {
        return blocked({
          code: "policy-denied",
          reason: "Private or special-use network target is blocked",
        });
      }
      if (
        networkPolicy?.access?.kind === "explicit" &&
        networkPolicy.access.transport === "direct" &&
        amendment.requests.some((item) => item.kind === "network")
      ) {
        return blocked({
          code: "policy-denied",
          reason: "Direct requires a whole-network amendment; host-only requests cannot be widened",
        });
      }
      if (
        amendment.requests.some(
          (item) =>
            item.kind !== "filesystem" && item.kind !== "network" && item.kind !== "network-all",
        )
      ) {
        return blocked({
          code: "enforcement-unavailable",
          reason: "Permission amendments support only filesystem and network capabilities",
        });
      }
      if (
        amendment.requests.some(
          (item) =>
            (item.kind === "network" || item.kind === "network-all") &&
            state.snapshot.baseSandboxPolicy !== undefined &&
            networkPolicyDenies(state.snapshot.baseSandboxPolicy, item),
        )
      ) {
        return blocked({
          code: "policy-denied",
          reason: "Network target is denied by sandbox policy",
        });
      }
      if (
        request.ownership === "permission-amendment" &&
        amendment.requests.some((item) => !sandboxCanEnforce(item))
      ) {
        return blocked({
          code: "enforcement-unavailable",
          reason: "The sandbox adapter cannot enforce network port or protocol constraints",
        });
      }
      const policy = await policyCheck({
        call: request.call,
        ownership: request.ownership,
        requested: amendment.requests,
        phase: "permission-amendment",
      });
      if (policy.kind === "error") return blocked({ code: "policy-error", reason: policy.reason });
      if (policy.kind === "deny") return blocked({ code: "policy-denied", reason: policy.reason });
      try {
        const proposed = leaseWithRequests(state, request.ownership, amendment.requests);
        if (proposed.policy) projectExecutionNetwork(proposed.policy);
      } catch (error) {
        return blocked({
          code: "policy-denied",
          reason: `Network policy conflict: ${errorMessage(error)}`,
        });
      }
      const amendmentRequests = amendment.requests;
      const amendmentReason = request.intent.reason;
      const amendmentSummary: string | undefined = amendment.requests.some(
        (item) => item.kind === "network-all",
      )
        ? "Whole-network outbound authority for this turn, subject to hard domain/private/delegation policy"
        : undefined;
      const decision = await runReview(
        state,
        request as Invocation<unknown, ReviewContext>,
        baseline,
        {
          source: "permission-amendment",
          requested: amendmentRequests,
          risk: "NeedsApproval",
          reason: amendmentReason,
          summary: amendmentSummary,
          residuals: ["permission_amendment"],
        },
      );
      if ("code" in decision) return blocked(decision);
      if (decision.kind === "deny") {
        recordDenial();
        return blocked({ code: "review-denied", reason: decision.rationale });
      }
      const amended = await executeAttempt(state, request, amendmentRequests);
      if ("kind" in amended && (amended.kind === "blocked" || amended.kind === "failed"))
        return amended;
      if (amended.kind === "completed") {
        for (const item of amendmentRequests) {
          if (item.kind === "network-all") state.turnNetworkAll = true;
          if (item.kind === "network") state.turnNetworkHosts.add(item.host);
          if (item.kind === "filesystem" && item.operation === "write") {
            appendUnique(state.turnWriteRoots, [item.path]);
          }
        }
        // Turn-lease widening voids remembered approvals: later executions run
        // under a wider lease than the cached verdict was approved under.
        state.approvals.clear();
        return amended;
      }
      if (amended.kind === "capability-denied") {
        const normalized = normalizeCapabilityRequest(amended.request, request.call.cwd);
        if (
          normalized !== undefined &&
          !runtimeCapabilitySupported(request.ownership, normalized)
        ) {
          return blocked(
            withExecutionEffects({
              code: "enforcement-unavailable",
              reason: "The execution adapter cannot enforce this runtime capability",
              request: normalized,
            }),
          );
        }
        return blocked(
          withExecutionEffects({
            code: "runtime-denied",
            reason: amended.detail ?? "Permission amendment acknowledgement was denied",
            ...(normalized === undefined ? {} : { request: normalized }),
          }),
        );
      }
      return blocked(
        withExecutionEffects({
          code: "runtime-denied",
          reason: "Permission amendment acknowledgement failed",
        }),
      );
    }

    const leaseRequested = admission.requested;
    const reviewRequested =
      admission.kind === "review" && admission.review === "action"
        ? admission.requested
        : admission.kind === "review"
          ? admission.requested.filter((item) => !requestCovered(baseline, item))
          : [];
    const reviewSource: ReviewRequest["source"] = "preview";
    const forcedManualReview = admission.kind === "review" && admission.review === "action";
    const reviewReason = admission.kind === "review" ? admission.reason : undefined;
    const reviewSummary = admission.kind === "review" ? admission.summary : undefined;
    const reviewRisk = admission.kind === "review" ? admission.risk : undefined;
    if (reviewRequested.length > 0 || forcedManualReview) {
      const policy = await policyCheck({
        call: request.call,
        ownership: request.ownership,
        requested: reviewRequested,
        phase: "preview",
      });
      if (policy.kind === "error") return blocked({ code: "policy-error", reason: policy.reason });
      if (policy.kind === "deny") return blocked({ code: "policy-denied", reason: policy.reason });
      // Turn-scoped approval cache: an identical action approved earlier in
      // this turn skips the Guardian round-trip. Hard gates above (admission,
      // policyCheck) and enforcement below (grant spend, live ceilings at
      // execution) still run; deny/timeout/failed never write entries.
      const cachedApproval = readApprovalCache(
        state,
        request as Invocation<unknown, ReviewContext>,
        reviewSource,
        reviewRequested,
        admission.kind === "review" ? admission.review : "none",
        {
          risk: reviewRisk,
          reason: reviewReason,
          summary: reviewSummary,
          residuals: admission.kind === "review" ? admission.residuals : undefined,
        },
      );
      const decision =
        cachedApproval ??
        (await runReview(state, request as Invocation<unknown, ReviewContext>, baseline, {
          source: reviewSource,
          requested: reviewRequested,
          risk: reviewRisk,
          reason: reviewReason,
          summary: reviewSummary,
          justification: admission.kind === "review" ? admission.justification : undefined,
          residuals:
            admission.kind === "review" &&
            admission.residuals !== undefined &&
            admission.residuals.length > 0
              ? admission.residuals
              : undefined,
        }));
      if ("code" in decision) return blocked(decision);
      if (decision.kind === "deny") {
        recordDenial();
        return blocked({ code: "review-denied", reason: decision.rationale });
      }
      const grant: GrantRecord = {
        callFingerprint: callFingerprint(state.snapshot, request.call, request.ownership),
        requested: reviewRequested,
      };
      state.grants.set(request.call.id, grant);
      const spent = consumeGrant(
        state,
        request as Invocation<unknown, ReviewContext>,
        leaseRequested,
      );
      if (!spent)
        return blocked({
          code: "stale-invocation",
          reason: "Exact capability grant no longer matches",
        });
      const result = await executeAttempt(state, request, leaseRequested, spent);
      if ("kind" in result && (result.kind === "blocked" || result.kind === "failed"))
        return result;
      if (result.kind === "completed") {
        // Only approve + completed execution is remembered. Deny, timeout,
        // failure, and cancellation never reach here, so they never write.
        writeApprovalCache(
          state,
          request as Invocation<unknown, ReviewContext>,
          reviewSource,
          reviewRequested,
          admission.kind === "review" ? admission.review : "none",
          {
            risk: reviewRisk,
            reason: reviewReason,
            summary: reviewSummary,
            residuals: admission.kind === "review" ? admission.residuals : undefined,
          },
        );
        return result;
      }
      // The spent static grant is not persisted as a turn-wide permission.
      // The first attempt's exact lease is retained only so a trusted native
      // file adapter can request the one fresh reviewed retry when needed.
      return handleRuntimeOutcome(state, request, result, {
        requested: [...leaseRequested],
        admissionRequested: [...admission.requested],
        lease: leaseWithRequests(state, request.ownership, leaseRequested),
      });
    }

    const initialRequested = [...leaseRequested];
    const initial = await executeAttempt(state, request, initialRequested, undefined);
    if ("kind" in initial && (initial.kind === "blocked" || initial.kind === "failed"))
      return initial;
    if (initial.kind === "completed") return initial;
    return handleRuntimeOutcome(state, request, initial, {
      requested: initialRequested,
      admissionRequested: [...admission.requested],
      lease: leaseWithRequests(state, request.ownership, initialRequested),
    });
  };

  const executeInvocation = async <T>(
    state: TurnState,
    request: Invocation<T, ReviewContext>,
  ): Promise<ExecutionOutcome<T>> => {
    let canonicalRequest: Invocation<T, ReviewContext>;
    try {
      canonicalRequest = cloneInvocation(request);
    } catch (error) {
      return blocked({ code: "review-unavailable", reason: errorMessage(error) });
    }
    if (inFlightCallIds.has(canonicalRequest.call.id)) {
      return blocked({
        code: "concurrent-invocation",
        reason: "Another invocation owns this tool-call ID",
      });
    }
    inFlightCallIds.add(canonicalRequest.call.id);
    try {
      return await executeInvocationOwned(state, canonicalRequest);
    } finally {
      inFlightCallIds.delete(canonicalRequest.call.id);
    }
  };

  const authorizeInlineCapability = async (
    state: TurnState,
    callId: string,
    input: CapabilityAuthorizationInput,
  ): Promise<CapabilityAuthorizationDecision> => {
    if (!isCurrent(state)) {
      return {
        kind: "deny",
        error: { code: "stale-invocation", reason: "Permission context changed" },
      };
    }
    const attempt = inFlightAttempts.get(callId);
    if (!attempt) {
      return {
        kind: "deny",
        error: {
          code: "stale-invocation",
          reason: "Inline authorization does not match the active execution attempt",
        },
      };
    }
    const signal = attempt.signal;
    if (signal?.aborted) {
      return {
        kind: "deny",
        error: attempt.terminalError ?? { code: "aborted", reason: "Operation aborted" },
      };
    }
    const denyAttemptForAttempt = (error: PermissionError): CapabilityAuthorizationDecision =>
      denyAttempt(attempt, error);
    const normalized = normalizeCapabilityRequest(input.capability, attempt.call.cwd, {
      // Normalize private targets as well so the Engine can apply the
      // Codex-compatible exact-local/allowLocalBinding policy below and
      // return the precise policy-denied reason instead of “invalid”.
      allowPrivateNetwork: true,
    });
    if (!normalized) {
      return denyAttemptForAttempt({
        code: "policy-denied",
        reason: "Inline capability request is invalid",
      });
    }
    if (state.snapshot.mode === "yolo") return { kind: "allow", capability: normalized };
    if (privateNetworkBlocked(attempt.baseline.policy, normalized)) {
      return denyAttemptForAttempt({
        code: "policy-denied",
        reason: "Private or special-use network target is blocked",
        request: normalized,
      });
    }
    if (
      attempt.ownership !== "sandbox-owned" ||
      normalized.kind !== "network" ||
      normalized.port === undefined
    ) {
      return denyAttemptForAttempt({
        code: "enforcement-unavailable",
        reason: "The execution adapter cannot authorize this inline capability",
        request: normalized,
      });
    }
    const baseline = cloneLease(attempt.baseline);
    if (baseline.policy && networkPolicyDenies(baseline.policy, normalized)) {
      return denyAttemptForAttempt({
        code: "policy-denied",
        reason: "Network target is denied by sandbox policy",
        request: normalized,
      });
    }
    const policy = await policyCheck({
      call: attempt.call,
      ownership: attempt.ownership,
      requested: [normalized],
      phase: "runtime",
    });
    if (!isCurrent(state)) {
      return denyAttemptForAttempt({
        code: "stale-invocation",
        reason: "Permission context changed",
      });
    }
    if (signal?.aborted) {
      return denyAttemptForAttempt(
        attempt.terminalError ?? { code: "aborted", reason: "Operation aborted" },
      );
    }
    if (policy.kind === "error") {
      return denyAttemptForAttempt({ code: "policy-error", reason: policy.reason });
    }
    if (policy.kind === "deny") {
      return denyAttemptForAttempt({
        code: "policy-denied",
        reason: policy.reason,
        request: normalized,
      });
    }
    if (requestCovered(baseline, normalized)) {
      return { kind: "allow", capability: normalized };
    }

    // Uncovered network: fail-closed at the connection/spawn decision.
    // Guardian is not a network firewall; expand the lease via request_permissions
    // for a later new invocation. Mid-exec denials do not mint a Bash replay.
    return denyAttemptForAttempt({
      code: "permission-required",
      reason:
        "Network authority was not granted for this execution. Use request_permissions for a later new invocation; this Bash action is not replayed.",
      request: normalized,
    });
  };

  const beginTurn = (input: TurnSnapshot): TurnHandle<ReviewContext> => {
    const snapshot = cloneSnapshot(input);
    if (active) closeState(active, "turn replaced");
    const nextSessionKey = snapshot.sessionId;
    const sessionChanged = sessionKey !== undefined && sessionKey !== nextSessionKey;
    const configChanged = configKey !== undefined && configKey !== snapshot.configFingerprint;
    if (sessionChanged || configChanged) {
      circuit = createDenialCircuit(circuitPolicy);
    }
    sessionKey = nextSessionKey;
    configKey = snapshot.configFingerprint;
    // Breaker state and all capability amendments belong to one turn.
    circuit = createDenialCircuit(circuitPolicy);
    emitAutoStateChange();
    const state: TurnState = {
      generation: ++generation,
      snapshot,
      turnNetworkHosts: new Set<string>(),
      turnNetworkAll: false,
      turnWriteRoots: [],
      grants: new Map<string, GrantRecord>(),
      approvals: new Map<string, ApprovalCacheEntry>(),
      closed: false,
    };
    active = state;
    const handle: TurnHandle<ReviewContext> = {
      execute: <T>(request: Invocation<T, ReviewContext>) => executeInvocation(state, request),
      close: (reason = "turn closed") => closeState(state, reason),
    };
    return handle;
  };

  const refreshTurnMode = (patch: {
    mode: ApproveForMeMode;
    sandboxReady?: boolean;
    baseSandboxPolicy?: SandboxPolicy;
  }): boolean => {
    if (!active || !isCurrent(active)) return false;
    const modeChanged = active.snapshot.mode !== patch.mode;
    const policyChanged =
      patch.baseSandboxPolicy !== undefined &&
      fingerprintValue(active.snapshot.baseSandboxPolicy ?? null) !==
        fingerprintValue(patch.baseSandboxPolicy);
    active.snapshot.mode = patch.mode;
    if (patch.sandboxReady !== undefined) {
      active.snapshot.sandboxReady = patch.sandboxReady;
    }
    if (patch.baseSandboxPolicy !== undefined) {
      active.snapshot.baseSandboxPolicy = clonePolicy(patch.baseSandboxPolicy);
    }
    // Mode or base-policy drift voids remembered approvals: a hit must never
    // survive the context it was approved under.
    if (modeChanged || policyChanged) active.approvals.clear();
    return true;
  };

  const invalidate = (reason: string): void => {
    generation += 1;
    if (active) closeState(active, reason);
    active = undefined;
    sessionKey = undefined;
    configKey = undefined;
    circuit = createDenialCircuit(circuitPolicy);
    abortReviews(reason);
  };

  const inspect = (): PermissionStateView | undefined => {
    if (!active || !isCurrent(active)) return undefined;
    return structuredClone({
      turnId: active.snapshot.turnId,
      generation: active.generation,
      configFingerprint: active.snapshot.configFingerprint,
      mode: active.snapshot.mode,
      baseline: active.snapshot.baseSandboxPolicy,
      effective: leaseWithRequests(active, "sandbox-owned", []).policy,
      turn: {
        networkAll: active.turnNetworkAll,
        networkHosts: [...active.turnNetworkHosts],
        writeRoots: [...active.turnWriteRoots],
        expires: "turn-end" as const,
      },
      actionGrants: [...active.grants.values()].map((grant) => grant.requested),
      attempts: [...inFlightAttempts.values()].map((attempt) => ({
        callId: attempt.call.id,
        lease: attempt.baseline,
        phase: "planned-or-executing" as const,
      })),
      pendingReviews: reviewControllers.size,
      // Inline connection reviews retired (Native Proxy + Lease Spawn Gate).
      pendingConnections: 0,
    });
  };
  return { beginTurn, refreshTurnMode, invalidate, inspect };
}
