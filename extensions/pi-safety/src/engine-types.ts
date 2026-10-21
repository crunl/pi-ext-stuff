/**
 * The Engine's type vocabulary: everything a caller or an execution adapter
 * needs in order to talk to the Engine, and nothing that is merely the shape
 * of the Engine's own mutable state.
 *
 * This module exists to keep the type graph acyclic. `engine-clone.ts` and
 * `engine-fingerprint.ts` need these names but must not depend on `engine.ts`
 * (see `guardian/errors.ts` for why this repository counts type edges as
 * edges). Pulling the vocabulary into its own leaf-facing module turns those
 * two edges into one-way imports.
 *
 * The Engine keeps its private state shapes — `TurnState`, `EngineOptions`,
 * `ApprovalCacheEntry`, `RetryRecord`, `ReviewRequest`, `InFlightAttempt`,
 * `ResolvedAdmission` and friends — in `engine.ts`. Moving them here would
 * mean exporting them, which widens the interface for no caller.
 *
 * Nothing in this file has runtime output: every declaration is a type.
 */
import type { ResidualSignal, ReviewSource, ReviewSourceTag } from "./permissions/residual.ts";
import type { NativeFileOperationFailure, SandboxPolicy } from "./sandbox-policy.ts";

/** The only permission modes understood by the deep module. */
export type ApproveForMeMode = "auto" | "yolo";
export type AdmissionRisk = "Skip" | "NeedsApproval" | "Forbidden";

/** Ownership says which external execution Adapter is authoritative. */
export type InvocationOwnership = "sandbox-owned" | "host-admission" | "permission-amendment";

/**
 * Trusted adapter declaration for native failed-action preparation recovery.
 * The default is terminal. Opt-in still requires attempt-local stage/identity
 * evidence; a typed capability denial alone cannot authorize replay.
 * The Engine owns fresh review and the one-shot transition.
 */
export type RuntimeDenialPolicy = "terminal" | "review-and-retry";

export interface InvocationCall {
  id: string;
  tool: string;
  input: unknown;
  cwd: string;
  metadata?: unknown;
}

export type AdmissionPlan =
  | {
      kind: "allow";
      requested?: readonly CapabilityRequestInput[];
    }
  | {
      kind: "review";
      requested?: readonly CapabilityRequestInput[];
      review: "capability" | "action";
      risk: AdmissionRisk;
      reason: string;
      summary?: string;
      /** Exact Bash action may run outside the coding-agent sandbox once approved. */
      justification?: string;
      /** Stamped residual facts from the static projection; never a skip signal. */
      residuals?: readonly ResidualSignal[];
    }
  | {
      kind: "deny";
      reason: string;
      /** Present when the producer knows what the agent can do about it. */
      recoverable?: BlockRecoverability;
    };

export interface TurnSnapshot {
  sessionId: string;
  turnId: string | number;
  mode: ApproveForMeMode;
  cwd: string;
  configFingerprint: string;
  baseSandboxPolicy?: SandboxPolicy;
  sandboxReady?: boolean;
}

/** The effective lease supplied to a concrete execution Adapter. */
export interface CapabilityLease {
  readonly mode: "sandboxed" | "host-admitted" | "unrestricted";
  readonly policy?: SandboxPolicy;
}

/** Runtime capability facts are deliberately normalized after an Adapter returns them. */
export type CapabilityRequest =
  | { kind: "filesystem"; operation: "read" | "write"; path: string }
  | { kind: "network"; host: string; port?: number; protocol?: string }
  | { kind: "network-all" }
  | { kind: "credential"; name: string }
  | { kind: "process"; executable: string; argv?: readonly string[] }
  | { kind: "external-tool"; provider: string; name: string };

/** Adapter output is untrusted input even though the TypeScript shape is narrow. */
export type CapabilityRequestInput = CapabilityRequest;

/** Parent-side failed operation identity, not an exact denied syscall capability. */
export interface NativeActionFailure {
  kind: "native-action-failed";
  error: unknown;
  failure: NativeFileOperationFailure;
  /** The adapter verified the backend can represent the immediate parent root. */
  mkdirScopeSupported?: boolean;
}

export type RuntimeOutcome<T> =
  | NativeActionFailure
  | { kind: "completed"; value: T }
  | {
      kind: "capability-denied";
      request: CapabilityRequestInput;
      detail?: string;
    }
  | { kind: "failed"; error: unknown; effectsMayHaveOccurred?: true };

export interface ExecutionAttempt {
  /** Canonical action snapshot reviewed and fingerprinted by the Engine. */
  readonly call: InvocationCall;
  readonly lease: CapabilityLease;
  /** The signal owned by this execution attempt, including caller cancellation. */
  readonly signal: AbortSignal;
  /**
   * Authorize a capability at an execution boundary. The call identity is
   * bound by the Engine and cannot be supplied or replaced by an Adapter.
   */
  readonly authorizeCapability: (
    request: CapabilityAuthorizationInput,
  ) => Promise<CapabilityAuthorizationDecision>;
  /**
   * Report an authoritative capability boundary rejection from the execution
   * adapter. The Engine latches the exact denial and aborts this whole
   * attempt; this does not invoke Guardian review or mint a retry.
   */
  readonly rejectCapability: (request: CapabilityRejectionInput) => CapabilityAuthorizationDecision;
}

export type InvocationExecutor<T> = (attempt: ExecutionAttempt) => Promise<RuntimeOutcome<T>>;

export interface PermissionAmendment {
  kind: "permission-amendment";
  requested: readonly CapabilityRequestInput[];
  reason?: string;
}

export interface Invocation<T, ReviewContext = undefined> {
  ownership: InvocationOwnership;
  call: InvocationCall;
  /** Required in auto mode except for permission-amendment, which has its own intent. */
  admission?: AdmissionPlan;
  /** Only ownership=permission-amendment may supply this field. */
  intent?: PermissionAmendment;
  /** Static adapter declaration; never inferred from an executor outcome. */
  runtimeDenialPolicy?: RuntimeDenialPolicy;
  reviewContext: ReviewContext;
  executor: InvocationExecutor<T>;
  signal?: AbortSignal;
}

export interface GuardianReviewInput<ReviewContext = undefined> {
  call: InvocationCall;
  ownership: InvocationOwnership;
  requested: readonly CapabilityRequest[];
  source: ReviewSource;
  risk?: AdmissionRisk;
  baseline: CapabilityLease;
  effective: CapabilityLease;
  reason?: string;
  summary?: string;
  justification?: string;
  residuals?: readonly ResidualSignal[];
  context: ReviewContext;
  authority?: {
    generation: number;
    turnId: string | number;
    configFingerprint: string;
    turn: PermissionStateView["turn"];
  };
  approvalOverride?: ApprovalOverride;
}

export interface GuardianDecisionMetrics {
  readonly riskLevel?: string;
  readonly userAuthorization?: string;
  readonly outcome?: string;
  readonly guardianModel?: string;
  readonly guardianReasoningEffort?: string;
  readonly failureKind?: string;
  readonly sessionKind?: "trunk_new" | "trunk_reused" | "ephemeral_forked";
  readonly hadPriorReviewContext?: boolean;
  readonly staticRisk?: string;
  readonly reviewSource?: ReviewSourceTag;
  readonly residualSignals?: readonly string[];
  readonly tokenUsage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    total?: number;
  };
}

export interface RetryHandle {
  readonly token: string;
  readonly __brand: "pi-safety-retry-handle";
}

export interface ApprovalOverride {
  readonly denialId: string;
  readonly actionFingerprint: string;
}

export type ReviewEvent =
  | {
      readonly status: "reviewing";
      readonly reviewId: string;
      readonly call: InvocationCall;
      readonly ownership: InvocationOwnership;
      readonly displaySummary?: string;
    }
  | {
      readonly status: "approved" | "denied";
      readonly reviewId: string;
      readonly call: InvocationCall;
      readonly ownership: InvocationOwnership;
      readonly rationale: string;
      readonly displaySummary?: string;
      readonly metrics?: GuardianDecisionMetrics & { durationMs: number };
    }
  | {
      readonly status: "aborted" | "timed-out";
      readonly reviewId: string;
      readonly call: InvocationCall;
      readonly ownership: InvocationOwnership;
      readonly displaySummary?: string;
      readonly metrics?: GuardianDecisionMetrics & { durationMs: number };
    }
  | {
      readonly status: "failed";
      readonly reviewId: string;
      readonly call: InvocationCall;
      readonly ownership: InvocationOwnership;
      readonly reason: string;
      readonly displaySummary?: string;
      readonly metrics?: GuardianDecisionMetrics & { durationMs: number };
    };

type PermissionErrorCode =
  | "aborted"
  | "no-active-turn"
  | "stale-invocation"
  | "policy-denied"
  | "policy-error"
  | "review-denied"
  | "review-timeout"
  | "review-unavailable"
  | "runtime-denied"
  | "permission-required"
  | "circuit-open"
  | "concurrent-invocation"
  | "enforcement-unavailable"
  | "execution-failed";

/**
 * What the agent can do about a deny.
 *
 * - `fix-arguments`: the tool call itself is malformed. Retry the same intent
 *   with corrected arguments.
 * - `no`: the action was proven unsafe or denied by configuration. Retrying the
 *   same action cannot succeed.
 *
 * It is declared here rather than in the static layer because it is part of the
 * Engine's error contract; the static layer classifies, the Engine carries it.
 */
export type BlockRecoverability = "fix-arguments" | "no";

export interface PermissionError {
  code: PermissionErrorCode;
  reason: string;
  /**
   * Static-layer classification of what the agent can do about this block.
   * Absent for engine-local denials, which never need the argument-error split.
   */
  recoverable?: BlockRecoverability;
  request?: CapabilityRequest;
  /** True when the executor had started and earlier effects may exist. */
  effectsMayHaveOccurred?: true;
  /** True when the Engine already performed its one permitted reviewed retry. */
  retryAttempted?: true;
}

export type ExecutionOutcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "blocked"; error: PermissionError; retryHandle?: RetryHandle }
  | { kind: "failed"; error: unknown; effectsMayHaveOccurred?: true };

export interface DenialNotice {
  readonly call: InvocationCall;
  readonly summary?: string;
  readonly rationale: string;
  readonly handle: RetryHandle;
}

export interface TurnHandle<ReviewContext = undefined> {
  execute<T>(request: Invocation<T, ReviewContext>): Promise<ExecutionOutcome<T>>;
  close(reason?: string): void;
}

export interface CapabilityAuthorizationInput {
  readonly capability: CapabilityRequestInput;
  readonly reason?: string;
}

export interface CapabilityRejectionInput {
  readonly capability: CapabilityRequestInput;
  readonly reason: string;
}

export type CapabilityAuthorizationDecision =
  | { readonly kind: "allow"; readonly capability: CapabilityRequest }
  | { readonly kind: "deny"; readonly error: PermissionError };

export interface PermissionStateView {
  readonly turnId: string | number;
  readonly generation: number;
  readonly configFingerprint: string;
  readonly mode: ApproveForMeMode;
  readonly baseline?: SandboxPolicy;
  readonly effective?: SandboxPolicy;
  readonly turn: {
    networkAll: boolean;
    networkHosts: string[];
    writeRoots: string[];
    expires: "turn-end";
  };
  readonly actionGrants: readonly (readonly CapabilityRequest[])[];
  readonly attempts: readonly {
    callId: string;
    lease: CapabilityLease;
    phase: "planned-or-executing";
  }[];
  readonly pendingReviews: number;
  readonly pendingConnections: number;
}

export interface Engine<ReviewContext = undefined> {
  beginTurn(snapshot: TurnSnapshot): TurnHandle<ReviewContext>;
  /**
   * Step-boundary mode apply (Codex-like). Patches only mode and related
   * host-derived facts on the live turn. Never begins a turn, clears grants,
   * opens the denial circuit, or freezes attempt windows.
   */
  refreshTurnMode(patch: {
    mode: ApproveForMeMode;
    sandboxReady?: boolean;
    baseSandboxPolicy?: SandboxPolicy;
  }): boolean;
  invalidate(reason: string): void;
  listDenials(): readonly DenialNotice[];
  inspect(): PermissionStateView | undefined;
  armRetry(handle: RetryHandle): boolean;
}
