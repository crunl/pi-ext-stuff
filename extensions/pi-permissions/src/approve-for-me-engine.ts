import { isIP } from "node:net";
import { relative, resolve } from "node:path";
import { fingerprintValue } from "./config.ts";
import { hasGlobSyntax } from "./filesystem-policy.ts";
import { isPublicNetworkHost, normalizeNetworkHost } from "./network-host.ts";
import type { SandboxPolicy } from "./sandbox.ts";
import { errorMessage, isRecord } from "./unknown-value.ts";

/** The only permission modes understood by the deep module. */
export type ApproveForMeMode = "auto" | "yolo";
export type AdmissionRisk = "LOW" | "REVIEW" | "HARD";
export type CommandExecutionMode = "escalated";

/** Ownership says which external execution Adapter is authoritative. */
export type InvocationOwnership = "sandbox-owned" | "host-admission" | "permission-amendment";

/**
 * Trusted adapter policy for a capability denial discovered after execution
 * has started. The default is terminal; only an adapter which can prove that
 * its runtime boundary is safe to re-enter may opt into one fresh review and
 * retry (the Engine, not the executor, owns that one-shot transition).
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
      executionMode?: CommandExecutionMode;
      justification?: string;
    }
  | {
      kind: "deny";
      reason: string;
    };

/**
 * A turn snapshot is immutable from the Engine's point of view. The caller
 * may load it asynchronously before beginTurn, but cannot replace its policy
 * or identity while a call is in flight.
 */
export interface TurnSnapshot {
  sessionId: string;
  turnId: string | number;
  mode: ApproveForMeMode;
  cwd: string;
  configFingerprint: string;
  baseSandboxPolicy?: SandboxPolicy;
  sandboxReady?: boolean;
  /** Immutable, host-derived facts required before a Bash escalation review. */
  escalationEligibility?: {
    eligible: boolean;
    reason: string;
  };
  transcript?: readonly unknown[];
}

/** The effective lease supplied to a concrete execution Adapter. */
export interface CapabilityLease {
  readonly mode: "sandboxed" | "host-admitted" | "escalated" | "unrestricted";
  readonly policy?: SandboxPolicy;
}

/** Runtime capability facts are deliberately normalized after an Adapter returns them. */
export type CapabilityRequest =
  | { kind: "filesystem"; operation: "read" | "write"; path: string }
  | { kind: "network"; host: string; port?: number; protocol?: string }
  | { kind: "credential"; name: string }
  | { kind: "process"; executable: string; argv?: readonly string[] }
  | { kind: "external-tool"; provider: string; name: string };

/** Adapter output is untrusted input even though the TypeScript shape is narrow. */
export type CapabilityRequestInput = CapabilityRequest;

export type RuntimeOutcome<T> =
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
  source: "preview" | "inline" | "permission-amendment" | "manual-retry";
  risk?: AdmissionRisk;
  baseline: CapabilityLease;
  effective: CapabilityLease;
  transcript: readonly unknown[];
  reason?: string;
  summary?: string;
  executionMode?: CommandExecutionMode;
  justification?: string;
  context: ReviewContext;
  approvalOverride?: ApprovalOverride;
}

export type GuardianDecision =
  | { kind: "approve"; rationale: string }
  | { kind: "deny"; rationale: string }
  | { kind: "timed-out" }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: string };

/** True external decision Adapter. It cannot mint or shape capabilities. */
export interface GuardianAdapter<ReviewContext = undefined> {
  review(
    input: GuardianReviewInput<ReviewContext>,
    signal?: AbortSignal,
  ): Promise<GuardianDecision>;
}

export interface PermissionPolicyCheck {
  call: InvocationCall;
  ownership: InvocationOwnership;
  requested: readonly CapabilityRequest[];
  phase: "preview" | "runtime" | "permission-amendment";
}

export type PermissionPolicyDecision = { kind: "allow" } | { kind: "deny"; reason: string };

type PolicyCheckResult = PermissionPolicyDecision | { kind: "error"; reason: string };

/** Explicit hard policy is separate from static risk classification. */
export interface PermissionPolicy {
  check(input: PermissionPolicyCheck): PermissionPolicyDecision | Promise<PermissionPolicyDecision>;
}

export interface RetryHandle {
  readonly token: string;
  readonly __brand: "pi-permissions-retry-handle";
}

export interface ApprovalOverride {
  readonly denialId: string;
  readonly actionFingerprint: string;
}

export interface AutoState {
  readonly consecutiveDenials: number;
  readonly recentDenials: number;
  readonly paused: boolean;
}

export type ReviewEvent =
  | {
      readonly status: "reviewing";
      readonly reviewId: string;
      readonly call: InvocationCall;
      readonly displaySummary?: string;
    }
  | {
      readonly status: "approved" | "denied";
      readonly reviewId: string;
      readonly call: InvocationCall;
      readonly rationale: string;
      readonly displaySummary?: string;
    }
  | {
      readonly status: "aborted" | "timed-out";
      readonly reviewId: string;
      readonly call: InvocationCall;
      readonly displaySummary?: string;
    }
  | {
      readonly status: "failed";
      readonly reviewId: string;
      readonly call: InvocationCall;
      readonly reason: string;
      readonly displaySummary?: string;
    };

export type PermissionErrorCode =
  | "aborted"
  | "no-active-turn"
  | "stale-invocation"
  | "policy-denied"
  | "policy-error"
  | "review-denied"
  | "review-timeout"
  | "review-unavailable"
  | "runtime-denied"
  | "circuit-open"
  | "concurrent-invocation"
  | "enforcement-unavailable"
  | "execution-failed";

export interface PermissionError {
  code: PermissionErrorCode;
  reason: string;
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

export interface ApproveForMeEngineOptions<ReviewContext = undefined> {
  guardian?: GuardianAdapter<ReviewContext>;
  policy?: PermissionPolicy;
  onDenial?: (notice: DenialNotice) => void;
  onAutoStateChange?: (state: AutoState) => void;
  onReviewEvent?: (event: ReviewEvent) => void;
  maxConsecutiveDenials?: number;
  denialWindowSize?: number;
  maxWindowDenials?: number;
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

export interface ApproveForMeEngine<ReviewContext = undefined> {
  beginTurn(snapshot: TurnSnapshot): TurnHandle<ReviewContext>;
  invalidate(reason: string): void;
  listDenials(): readonly DenialNotice[];
  armRetry(handle: RetryHandle): boolean;
}

interface TurnState {
  readonly generation: number;
  readonly snapshot: TurnSnapshot;
  readonly turnNetworkHosts: Set<string>;
  readonly turnWriteRoots: string[];
  readonly grants: Map<string, GrantRecord>;
  closed: boolean;
}

interface GrantRecord {
  readonly callFingerprint: string;
  readonly requested: readonly CapabilityRequest[];
}

interface RetryRecord {
  readonly fingerprint: string;
  readonly call: InvocationCall;
  readonly ownership: InvocationOwnership;
  /** Capabilities the denied review would have granted. */
  readonly requested: readonly CapabilityRequest[];
  /** Exact normalized admission scope observed for the denied action. */
  readonly admissionRequested: readonly CapabilityRequest[];
  readonly risk?: AdmissionRisk;
  readonly rationale: string;
  readonly summary?: string;
  readonly executionMode?: CommandExecutionMode;
  readonly justification?: string;
}

interface ReviewRequest {
  readonly source: GuardianReviewInput["source"];
  readonly requested: readonly CapabilityRequest[];
  readonly risk?: AdmissionRisk;
  readonly reason?: string;
  readonly summary?: string;
  /** Override the derived post-review lease for a retry of an existing attempt. */
  readonly effective?: CapabilityLease;
  readonly approvalOverride?: ApprovalOverride;
  readonly executionMode?: CommandExecutionMode;
  readonly justification?: string;
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
      executionMode?: CommandExecutionMode;
      justification?: string;
    }
  | { kind: "deny"; reason: string };

const DEFAULT_MAX_CONSECUTIVE_DENIALS = 3;
const DEFAULT_DENIAL_WINDOW_SIZE = 50;
const DEFAULT_MAX_WINDOW_DENIALS = 10;
const MAX_DENIAL_NOTICES = 10;

function clonePolicy(policy: SandboxPolicy | undefined): SandboxPolicy | undefined {
  return policy === undefined ? undefined : structuredClone(policy);
}

function cloneLease(lease: CapabilityLease): CapabilityLease {
  const policy = clonePolicy(lease.policy);
  return {
    mode: lease.mode,
    ...(policy === undefined ? {} : { policy }),
  };
}

function withExecutionEffects(error: PermissionError): PermissionError {
  return error.effectsMayHaveOccurred === true ? error : { ...error, effectsMayHaveOccurred: true };
}

function cloneMetadata(metadata: unknown): unknown {
  if (metadata === undefined) return undefined;
  try {
    return structuredClone(metadata);
  } catch {
    throw new Error("Invocation metadata must be structured-cloneable");
  }
}

function cloneInvocationCall(call: InvocationCall): InvocationCall {
  const metadata = cloneMetadata(call.metadata);
  let input: unknown;
  try {
    input = structuredClone(call.input);
  } catch {
    throw new Error("Invocation input must be structured-cloneable");
  }
  return {
    id: call.id,
    tool: call.tool,
    input,
    cwd: resolve(call.cwd),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function cloneInvocation<T, ReviewContext>(
  invocation: Invocation<T, ReviewContext>,
): Invocation<T, ReviewContext> {
  let admission: AdmissionPlan | undefined;
  let intent: PermissionAmendment | undefined;
  const runtimeDenialPolicy = invocation.runtimeDenialPolicy;
  if (
    runtimeDenialPolicy !== undefined &&
    runtimeDenialPolicy !== "terminal" &&
    runtimeDenialPolicy !== "review-and-retry"
  ) {
    throw new Error("Invocation runtime denial policy is invalid");
  }
  try {
    admission =
      invocation.admission === undefined ? undefined : structuredClone(invocation.admission);
    intent = invocation.intent === undefined ? undefined : structuredClone(invocation.intent);
  } catch {
    throw new Error("Invocation authorization evidence must be structured-cloneable");
  }
  return {
    ownership: invocation.ownership,
    call: cloneInvocationCall(invocation.call),
    ...(admission === undefined ? {} : { admission }),
    ...(intent === undefined ? {} : { intent }),
    ...(runtimeDenialPolicy === undefined ? {} : { runtimeDenialPolicy }),
    reviewContext: invocation.reviewContext,
    executor: invocation.executor,
    ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
  };
}

function cloneSnapshot(snapshot: TurnSnapshot): TurnSnapshot {
  return {
    sessionId: snapshot.sessionId,
    turnId: snapshot.turnId,
    mode: snapshot.mode,
    cwd: resolve(snapshot.cwd),
    configFingerprint: snapshot.configFingerprint,
    baseSandboxPolicy: clonePolicy(snapshot.baseSandboxPolicy),
    sandboxReady: snapshot.sandboxReady,
    escalationEligibility:
      snapshot.escalationEligibility === undefined
        ? undefined
        : {
            eligible: snapshot.escalationEligibility.eligible,
            reason: snapshot.escalationEligibility.reason,
          },
    transcript: snapshot.transcript === undefined ? [] : structuredClone(snapshot.transcript),
  };
}

function isPathWithin(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${"/"}`));
}

function pathMatches(pattern: string, path: string): boolean {
  // A glob is a potentially matching deny rule. The Engine never tries to
  // interpret it as an allow; callers must let the real enforcer decide.
  if (hasGlobSyntax(pattern)) return true;
  return isPathWithin(pattern, path);
}

function splitDomainPatternPort(pattern: string): { host: string; port?: number } {
  const value = pattern.trim();
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close >= 0) {
      const host = value.slice(1, close);
      const suffix = value.slice(close + 1);
      if (suffix === "") {
        return { host: normalizeNetworkHost(host) ?? host };
      }
      const match = /^:([1-9][0-9]{0,4})$/.exec(suffix);
      const port = match ? Number(match[1]) : undefined;
      return port !== undefined && port <= 65535
        ? { host: normalizeNetworkHost(host) ?? host, port }
        : { host: value };
    }
  }
  const lastColon = value.lastIndexOf(":");
  if (lastColon >= 0 && value.indexOf(":") === lastColon) {
    const match = /^([1-9][0-9]{0,4})$/.exec(value.slice(lastColon + 1));
    const port = match ? Number(match[1]) : undefined;
    if (port !== undefined && port <= 65535) {
      return { host: value.slice(0, lastColon), port };
    }
  }
  return { host: normalizeNetworkHost(value) ?? value };
}

export function matchesNetworkDomainPattern(pattern: string, host: string, port?: number): boolean {
  const parsed = splitDomainPatternPort(pattern);
  if (parsed.port !== undefined && parsed.port !== port) return false;
  const candidate = normalizeNetworkHost(host) ?? host.trim().toLowerCase();
  const domain = normalizeNetworkHost(parsed.host) ?? parsed.host.toLowerCase();
  if (domain === "*") return true;
  if (domain.startsWith("*.")) {
    if (isIP(normalizeNetworkHost(candidate) ?? candidate) !== 0) return false;
    return candidate.endsWith(`.${domain.slice(2)}`);
  }
  return candidate === domain;
}

function exactLocalNetworkAllow(
  policy: SandboxPolicy | undefined,
  host: string,
  port: number | undefined,
): boolean {
  if (!policy) return false;
  const normalizedHost = normalizeNetworkHost(host);
  if (!normalizedHost) return false;
  if (isIP(normalizedHost) === 0 && normalizedHost !== "localhost") return false;
  return policy.network.allowedDomains.some((pattern) => {
    const normalizedPattern = pattern.trim().toLowerCase();
    // A wildcard is never an exact local exception. In particular, an
    // accidentally broad `*` must not turn loopback into an implicit grant.
    if (normalizedPattern === "*" || normalizedPattern.startsWith("*.")) return false;
    return matchesNetworkDomainPattern(pattern, normalizedHost, port);
  });
}

function localNetworkAllowed(
  policy: SandboxPolicy | undefined,
  host: string,
  port: number | undefined,
): boolean {
  return policy?.network.allowLocalBinding === true || exactLocalNetworkAllow(policy, host, port);
}

function normalizeCapabilityRequest(
  raw: unknown,
  cwd: string,
  options: { allowPrivateNetwork?: boolean } = {},
): CapabilityRequest | undefined {
  if (!isRecord(raw) || typeof raw.kind !== "string") return undefined;
  if (raw.kind === "filesystem") {
    if (raw.operation !== "read" && raw.operation !== "write") return undefined;
    if (typeof raw.path !== "string" || raw.path.trim().length === 0) return undefined;
    if (hasGlobSyntax(raw.path) || raw.path.length > 4096) return undefined;
    return { kind: "filesystem", operation: raw.operation, path: resolve(cwd, raw.path.trim()) };
  }
  if (raw.kind === "network") {
    if (typeof raw.host !== "string") return undefined;
    const host = normalizeNetworkHost(raw.host);
    if (!host || (!options.allowPrivateNetwork && !isPublicNetworkHost(host))) return undefined;
    const port = raw.port;
    if (
      port !== undefined &&
      (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    ) {
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
    const request = normalizeCapabilityRequest(item, cwd);
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
    return typeof raw.reason === "string" && raw.reason.trim().length > 0
      ? { ok: true, admission: { kind: "deny", reason: raw.reason } }
      : { ok: false };
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
    (raw.risk !== "LOW" && raw.risk !== "REVIEW" && raw.risk !== "HARD") ||
    typeof raw.reason !== "string" ||
    raw.reason.trim().length === 0 ||
    (raw.summary !== undefined && typeof raw.summary !== "string")
  ) {
    return { ok: false };
  }
  if (raw.executionMode !== undefined && raw.executionMode !== "escalated") {
    return { ok: false };
  }
  if (
    raw.justification !== undefined &&
    (typeof raw.justification !== "string" ||
      raw.justification.trim().length === 0 ||
      raw.justification.length > 1000)
  ) {
    return { ok: false };
  }
  if (raw.executionMode === "escalated" && raw.justification === undefined) {
    return { ok: false };
  }
  return {
    ok: true,
    admission: {
      kind: "review",
      requested: normalized.requests,
      review: raw.review,
      risk: raw.risk,
      reason: raw.reason,
      ...(raw.summary === undefined ? {} : { summary: raw.summary }),
      ...(raw.executionMode === undefined ? {} : { executionMode: raw.executionMode }),
      ...(raw.justification === undefined ? {} : { justification: raw.justification.trim() }),
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
    return policy.filesystem.allowWrite.some((root) => isPathWithin(root, request.path));
  }
  if (request.kind === "network") {
    if (networkPolicyDenies(policy, request)) return false;
    return policy.network.allowedDomains.some((pattern) =>
      matchesNetworkDomainPattern(pattern, request.host, request.port),
    );
  }
  return false;
}

function networkPolicyDenies(policy: SandboxPolicy, request: CapabilityRequest): boolean {
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

function isExactEscalatedBashCall(call: InvocationCall): boolean {
  if (call.tool.toLowerCase() !== "bash" || !isRecord(call.input)) return false;
  return (
    call.input.sandbox_permissions === "require_escalated" &&
    call.input.additional_permissions === undefined &&
    typeof call.input.command === "string" &&
    typeof call.input.justification === "string" &&
    call.input.justification.trim().length > 0
  );
}

function requestKey(request: CapabilityRequest): string {
  return fingerprintValue(request);
}

function sameRequests(
  left: readonly CapabilityRequest[],
  right: readonly CapabilityRequest[],
): boolean {
  if (left.length !== right.length) return false;
  const rightKeys = new Set(right.map(requestKey));
  return left.every((request) => rightKeys.has(requestKey(request)));
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

function invocationFingerprint(
  state: TurnState,
  call: InvocationCall,
  ownership: InvocationOwnership,
  includeCallId: boolean,
): string {
  const identity = {
    sessionId: state.snapshot.sessionId,
    turnId: state.snapshot.turnId,
    configFingerprint: state.snapshot.configFingerprint,
    ownership,
    tool: call.tool.toLowerCase(),
    input: call.input,
    cwd: resolve(call.cwd),
    metadata: call.metadata,
  };
  return fingerprintValue(includeCallId ? { ...identity, id: call.id } : identity);
}

function callFingerprint(
  state: TurnState,
  call: InvocationCall,
  ownership: InvocationOwnership,
): string {
  return invocationFingerprint(state, call, ownership, true);
}

function retryFingerprint(
  state: TurnState,
  call: InvocationCall,
  ownership: InvocationOwnership,
  grantScope: readonly CapabilityRequest[],
  admissionScope: readonly CapabilityRequest[],
  executionMode?: CommandExecutionMode,
  justification?: string,
): string {
  // A manually armed retry is a request to review the same action in the
  // next turn, not permission to replay the old tool-call envelope.  Keep the
  // session/config/ownership/action identity, but deliberately omit both the
  // old turn id and old call id so Pi can issue a fresh invocation.
  return fingerprintValue({
    sessionId: state.snapshot.sessionId,
    configFingerprint: state.snapshot.configFingerprint,
    ownership,
    tool: call.tool.toLowerCase(),
    input: call.input,
    cwd: resolve(call.cwd),
    metadata: call.metadata,
    grantScope,
    admissionScope,
    executionMode,
    justification,
  });
}

export function createApproveForMeEngine<ReviewContext = undefined>(
  options: ApproveForMeEngineOptions<ReviewContext> = {},
): ApproveForMeEngine<ReviewContext> {
  let generation = 0;
  let active: TurnState | undefined;
  let sessionKey: string | undefined;
  let configKey: string | undefined;
  let retrySequence = 0;
  let denialWindow: boolean[] = [];
  let consecutiveDenials = 0;
  let circuitOpen = false;
  const retryRecords = new Map<string, RetryRecord>();
  const denialNotices: DenialNotice[] = [];
  let armedRetry: { record: RetryRecord; denialId: string } | undefined;
  let reviewSequence = 0;
  const reviewControllers = new Set<AbortController>();
  const inFlightCallIds = new Set<string>();
  const inFlightAttempts = new Map<string, InFlightAttempt<ReviewContext>>();
  const inlineCapabilityReviews = new Map<string, Promise<CapabilityAuthorizationDecision>>();
  const maxConsecutiveDenials = options.maxConsecutiveDenials ?? DEFAULT_MAX_CONSECUTIVE_DENIALS;
  const denialWindowSize = options.denialWindowSize ?? DEFAULT_DENIAL_WINDOW_SIZE;
  const maxWindowDenials = options.maxWindowDenials ?? DEFAULT_MAX_WINDOW_DENIALS;

  const consumeArmedRetry = (armedRecord: { record: RetryRecord; denialId: string }): void => {
    armedRetry = undefined;
    retryRecords.delete(armedRecord.denialId);
    const noticeIndex = denialNotices.findIndex(
      (notice) => notice.handle.token === armedRecord.denialId,
    );
    if (noticeIndex >= 0) denialNotices.splice(noticeIndex, 1);
  };

  const recordWindow = (denied: boolean): void => {
    denialWindow.push(denied);
    if (denialWindow.length > denialWindowSize) {
      denialWindow.splice(0, denialWindow.length - denialWindowSize);
    }
  };

  const recordDenialStats = (): void => {
    recordWindow(true);
    consecutiveDenials += 1;
    if (
      consecutiveDenials >= maxConsecutiveDenials ||
      denialWindow.filter(Boolean).length >= maxWindowDenials
    ) {
      circuitOpen = true;
    }
    emitAutoStateChange();
  };

  const emitAutoStateChange = (): void => {
    options.onAutoStateChange?.({
      consecutiveDenials,
      recentDenials: denialWindow.filter(Boolean).length,
      paused: circuitOpen,
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
    recordWindow(false);
    consecutiveDenials = 0;
    circuitOpen = false;
    emitAutoStateChange();
  };

  const makeRetryHandle = (record: RetryRecord): RetryHandle => {
    const handle: RetryHandle = {
      token: `retry-${++retrySequence}`,
      __brand: "pi-permissions-retry-handle",
    };
    retryRecords.set(handle.token, record);
    return handle;
  };

  const recordDenial = (
    state: TurnState,
    request: Invocation<unknown, ReviewContext>,
    denial: {
      readonly rationale: string;
      readonly requested: readonly CapabilityRequest[];
      readonly admissionRequested: readonly CapabilityRequest[];
      readonly risk?: AdmissionRisk;
      readonly summary?: string;
      readonly executionMode?: CommandExecutionMode;
      readonly justification?: string;
    },
  ): RetryHandle => {
    recordDenialStats();
    const frozenRequested = denial.requested.map((item) => structuredClone(item));
    const frozenAdmissionRequested = denial.admissionRequested.map((item) => structuredClone(item));
    const retryHandle = makeRetryHandle({
      fingerprint: retryFingerprint(
        state,
        request.call,
        request.ownership,
        frozenRequested,
        frozenAdmissionRequested,
        denial.executionMode,
        denial.justification,
      ),
      call: cloneInvocationCall(request.call),
      ownership: request.ownership,
      requested: frozenRequested,
      admissionRequested: frozenAdmissionRequested,
      ...(denial.risk === undefined ? {} : { risk: denial.risk }),
      rationale: denial.rationale,
      ...(denial.summary === undefined ? {} : { summary: denial.summary }),
      ...(denial.executionMode === undefined ? {} : { executionMode: denial.executionMode }),
      ...(denial.justification === undefined ? {} : { justification: denial.justification }),
    });
    const notice: DenialNotice = {
      call: cloneInvocationCall(request.call),
      ...(denial.summary === undefined ? {} : { summary: denial.summary }),
      rationale: denial.rationale,
      handle: retryHandle,
    };
    denialNotices.push(notice);
    if (denialNotices.length > MAX_DENIAL_NOTICES) {
      const removed = denialNotices.shift();
      if (removed !== undefined) {
        const removedRecord = retryRecords.get(removed.handle.token);
        retryRecords.delete(removed.handle.token);
        if (armedRetry?.record === removedRecord) armedRetry = undefined;
      }
    }
    options.onDenial?.({
      ...notice,
      call: cloneInvocationCall(notice.call),
      handle: { ...notice.handle },
    });
    return retryHandle;
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
    if (wasActive) abortAttempts(reason);
    inFlightAttempts.clear();
    state.turnNetworkHosts.clear();
    state.turnWriteRoots.length = 0;
    if (wasActive) {
      abortReviews(reason);
      active = undefined;
    }
  };

  const blocked = <T>(error: PermissionError, retryHandle?: RetryHandle): ExecutionOutcome<T> => ({
    kind: "blocked",
    error,
    ...(retryHandle === undefined ? {} : { retryHandle }),
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
      return { kind: "approve", rationale: "Full access is active" };
    }
    if (circuitOpen) return { code: "circuit-open", reason: "Auto-review circuit is open" };
    const reviewId = `review-${++reviewSequence}`;
    const displaySummary = review.summary?.trim() || undefined;
    emitReviewEvent(() => ({
      status: "reviewing",
      reviewId,
      call: cloneInvocationCall(request.call),
      ...(displaySummary === undefined ? {} : { displaySummary }),
    }));
    const guardian = options.guardian;
    if (!guardian) {
      const reason = "The configured reviewer is unavailable";
      emitReviewEvent(() => ({
        status: "failed",
        reviewId,
        call: cloneInvocationCall(request.call),
        reason,
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
          risk: review.risk,
          baseline: cloneLease(baseline),
          effective:
            review.effective === undefined
              ? leaseWithRequests(state, request.ownership, review.requested)
              : cloneLease(review.effective),
          transcript: structuredClone(state.snapshot.transcript ?? []),
          reason: review.reason,
          summary: review.summary,
          ...(review.executionMode === undefined ? {} : { executionMode: review.executionMode }),
          ...(review.justification === undefined ? {} : { justification: review.justification }),
          context: request.reviewContext,
          ...(review.approvalOverride === undefined
            ? {}
            : { approvalOverride: review.approvalOverride }),
        },
        signal,
      );
      if (!isCurrent(state)) {
        emitReviewEvent(() => ({
          status: "aborted",
          reviewId,
          call: cloneInvocationCall(request.call),
          ...(displaySummary === undefined ? {} : { displaySummary }),
        }));
        return { code: "stale-invocation", reason: "Permission context changed" };
      }
      if (signal.aborted) {
        emitReviewEvent(() => ({
          status: "aborted",
          reviewId,
          call: cloneInvocationCall(request.call),
          ...(displaySummary === undefined ? {} : { displaySummary }),
        }));
        return { code: "aborted", reason: "Operation aborted" };
      }
      if (decision.kind === "cancelled") {
        emitReviewEvent(() => ({
          status: "aborted",
          reviewId,
          call: cloneInvocationCall(request.call),
        }));
        return { code: "aborted", reason: "Operation aborted" };
      }
      if (decision.kind === "timed-out") {
        recordNonDenial();
        emitReviewEvent(() => ({
          status: "timed-out",
          reviewId,
          call: cloneInvocationCall(request.call),
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
          reason: decision.reason,
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
          reason,
          ...(displaySummary === undefined ? {} : { displaySummary }),
        }));
        return { code: "review-unavailable", reason };
      }
      if (decision.kind === "approve") recordNonDenial();
      emitReviewEvent(() => ({
        status: decision.kind === "approve" ? "approved" : "denied",
        reviewId,
        call: cloneInvocationCall(request.call),
        rationale: decision.rationale,
        ...(displaySummary === undefined ? {} : { displaySummary }),
      }));
      return decision;
    } catch (error) {
      if (!isCurrent(state)) {
        emitReviewEvent(() => ({
          status: "aborted",
          reviewId,
          call: cloneInvocationCall(request.call),
          ...(displaySummary === undefined ? {} : { displaySummary }),
        }));
        return { code: "stale-invocation", reason: "Permission context changed" };
      }
      if (request.signal?.aborted) {
        emitReviewEvent(() => ({
          status: "aborted",
          reviewId,
          call: cloneInvocationCall(request.call),
          ...(displaySummary === undefined ? {} : { displaySummary }),
        }));
        return { code: "aborted", reason: "Operation aborted" };
      }
      if (controller.signal.aborted) {
        emitReviewEvent(() => ({
          status: "aborted",
          reviewId,
          call: cloneInvocationCall(request.call),
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
        reason,
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
    const fingerprint = callFingerprint(state, request.call, request.ownership);
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
      if (inFlightAttempt.terminalError) return blocked(inFlightAttempt.terminalError);
      if (!isCurrent(state)) {
        return blocked(
          withExecutionEffects({ code: "stale-invocation", reason: "Permission context changed" }),
        );
      }
      if (signal.aborted) {
        return blocked(withExecutionEffects({ code: "aborted", reason: "Operation aborted" }));
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
    const normalized = normalizeCapabilityRequest(outcome.request, request.call.cwd);
    return blocked(
      withExecutionEffects({
        code: "runtime-denied",
        reason: outcome.detail ?? "Unrestricted execution reported a capability denial",
        ...(normalized === undefined ? {} : { request: normalized }),
      }),
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

    const retryableWrite =
      allowRetry &&
      request.runtimeDenialPolicy === "review-and-retry" &&
      request.ownership === "sandbox-owned" &&
      normalized.kind === "filesystem" &&
      normalized.operation === "write";
    if (retryableWrite && requestCovered(attempt.lease, normalized)) {
      return blocked(
        withExecutionEffects({
          code: "enforcement-unavailable",
          reason:
            "Runtime denied a capability already covered by the execution lease; refusing a blind retry",
          request: normalized,
        }),
      );
    }

    // Codex's native file mutation runtime can ask for one fresh exact
    // capability review after SRT denies a write. Bash is deliberately
    // terminal here: replaying a command would repeat arbitrary work, while
    // a Write/Edit adapter can safely re-enter its single-file operation.
    // The retry policy is a trusted invocation declaration; it is never
    // inferred from the executor's denial payload.
    if (retryableWrite) {
      const retryEffective = leaseWithAdditionalRequests(attempt.lease, [normalized]);
      if (!requestCovered(retryEffective, normalized)) {
        return blocked(
          withExecutionEffects({
            code: "enforcement-unavailable",
            reason: "The approved retry cannot be represented by the sandbox policy",
            request: normalized,
          }),
        );
      }
      const retryDecision = await runReview(
        state,
        request as Invocation<unknown, ReviewContext>,
        attempt.lease,
        {
          source: "inline",
          requested: [normalized],
          effective: retryEffective,
          risk: "REVIEW",
          reason:
            outcome.detail ??
            "Sandbox enforcement denied a filesystem write; review one exact retry",
          summary: `${request.call.tool} runtime write retry`,
        },
      );
      if ("code" in retryDecision) return blocked(withExecutionEffects(retryDecision));
      if (retryDecision.kind === "deny") {
        const retryHandle = recordDenial(state, request as Invocation<unknown, ReviewContext>, {
          rationale: retryDecision.rationale,
          requested: [normalized],
          admissionRequested: attempt.admissionRequested,
          risk: "REVIEW",
          summary: `${request.call.tool} runtime write retry`,
        });
        return blocked(
          withExecutionEffects({
            code: "review-denied",
            reason: retryDecision.rationale,
            request: normalized,
          }),
          retryHandle,
        );
      }

      // Do not grant the capability for the rest of the turn. This direct
      // second attempt is the exact one-shot retry owned by the Engine.
      const retryRequested = [...attempt.requested, normalized];
      const retry = await executeAttempt(state, request, retryRequested, undefined, retryEffective);
      if (retry.kind === "completed") return retry;
      if (retry.kind === "blocked") {
        return blocked(withExecutionEffects(retry.error), retry.retryHandle);
      }
      if (retry.kind === "failed") return retry;
      // A second boundary denial is always terminal. Passing false prevents
      // an executor from ever turning two denials into an unbounded loop.
      return handleRuntimeOutcome(
        state,
        request,
        retry,
        {
          requested: retryRequested,
          admissionRequested: attempt.admissionRequested,
          lease: retryEffective,
        },
        false,
      );
    }

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
      return blocked({ code: "policy-denied", reason: admission.reason });
    }
    const escalated = admission.kind === "review" && admission.executionMode === "escalated";
    if (escalated) {
      if (
        request.ownership !== "sandbox-owned" ||
        admission.kind !== "review" ||
        admission.review !== "action" ||
        admission.requested.length > 0 ||
        admission.justification === undefined ||
        !isExactEscalatedBashCall(request.call) ||
        admission.justification !==
          (isRecord(request.call.input) && typeof request.call.input.justification === "string"
            ? request.call.input.justification.trim()
            : undefined)
      ) {
        return blocked({
          code: "policy-denied",
          reason: "Command escalation admission does not match the exact Bash action",
        });
      }
      const eligibility = state.snapshot.escalationEligibility;
      if (eligibility?.eligible !== true) {
        return blocked({
          code: "enforcement-unavailable",
          reason:
            eligibility?.reason ??
            "Command escalation is unavailable without a trusted eligible sandbox snapshot",
        });
      }
    }
    if (request.ownership === "host-admission" && admission.requested.length === 0) {
      return blocked({
        code: "enforcement-unavailable",
        reason: "Host admission requires an exact capability request",
      });
    }
    if (
      admission.requested.some((item) => item.kind === "network" && !isPublicNetworkHost(item.host))
    ) {
      return blocked({
        code: "policy-denied",
        reason: "Private or special-use network target is blocked",
      });
    }
    if (
      admission.requested.some(
        (item) =>
          item.kind === "network" &&
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
    const baseline = leaseWithRequests(state, request.ownership, []);
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
        amendment.requests.some((item) => item.kind !== "filesystem" && item.kind !== "network")
      ) {
        return blocked({
          code: "enforcement-unavailable",
          reason: "Permission amendments support only filesystem and network capabilities",
        });
      }
      if (
        amendment.requests.some(
          (item) =>
            item.kind === "network" &&
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
      let amendmentRequests = amendment.requests;
      let amendmentSource: ReviewRequest["source"] = "permission-amendment";
      let amendmentReason = request.intent.reason;
      let amendmentSummary: string | undefined;
      let amendmentApprovalOverride: ApprovalOverride | undefined;
      const armed = armedRetry;
      const armedRecord =
        armed !== undefined &&
        armed.record.fingerprint ===
          retryFingerprint(
            state,
            request.call,
            request.ownership,
            armed.record.requested,
            amendment.requests,
          )
          ? armed
          : undefined;
      if (
        armedRecord !== undefined &&
        sameRequests(amendmentRequests, armedRecord.record.requested)
      ) {
        consumeArmedRetry(armedRecord);
        amendmentRequests = [...armedRecord.record.requested];
        amendmentSource = "manual-retry";
        amendmentReason = armedRecord.record.rationale;
        amendmentSummary = armedRecord.record.summary;
        amendmentApprovalOverride = {
          denialId: armedRecord.denialId,
          actionFingerprint: armedRecord.record.fingerprint,
        };
      }
      const decision = await runReview(
        state,
        request as Invocation<unknown, ReviewContext>,
        baseline,
        {
          source: amendmentSource,
          requested: amendmentRequests,
          risk: "REVIEW",
          reason: amendmentReason,
          summary: amendmentSummary,
          approvalOverride: amendmentApprovalOverride,
        },
      );
      if ("code" in decision) return blocked(decision);
      if (decision.kind === "deny") {
        const retryHandle = recordDenial(state, request as Invocation<unknown, ReviewContext>, {
          rationale: decision.rationale,
          requested: amendmentRequests,
          admissionRequested: amendment.requests,
          risk: "REVIEW",
          summary: amendmentReason,
        });
        return blocked({ code: "review-denied", reason: decision.rationale }, retryHandle);
      }
      const amended = await executeAttempt(state, request, amendmentRequests);
      if ("kind" in amended && (amended.kind === "blocked" || amended.kind === "failed"))
        return amended;
      if (amended.kind === "completed") {
        for (const item of amendmentRequests) {
          if (item.kind === "network") state.turnNetworkHosts.add(item.host);
          if (item.kind === "filesystem" && item.operation === "write") {
            appendUnique(state.turnWriteRoots, [item.path]);
          }
        }
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

    let leaseRequested = admission.requested;
    let reviewRequested =
      admission.kind === "review" && admission.review === "action"
        ? admission.requested
        : admission.kind === "review"
          ? admission.requested.filter((item) => !requestCovered(baseline, item))
          : [];
    let reviewSource: ReviewRequest["source"] = "preview";
    let forcedManualReview = admission.kind === "review" && admission.review === "action";
    let reviewReason = admission.kind === "review" ? admission.reason : undefined;
    let reviewSummary = admission.kind === "review" ? admission.summary : undefined;
    let reviewRisk = admission.kind === "review" ? admission.risk : undefined;
    let approvalOverride: ApprovalOverride | undefined;
    const effectiveLeaseOverride: CapabilityLease | undefined = escalated
      ? { mode: "escalated" }
      : undefined;
    const armed = armedRetry;
    const armedRecord =
      armed !== undefined &&
      armed.record.fingerprint ===
        retryFingerprint(
          state,
          request.call,
          request.ownership,
          armed.record.requested,
          admission.requested,
          admission.kind === "review" ? admission.executionMode : undefined,
          admission.kind === "review" ? admission.justification : undefined,
        )
        ? armed
        : undefined;
    if (armedRecord !== undefined) {
      const record = armedRecord.record;
      consumeArmedRetry(armedRecord);
      leaseRequested = [...record.requested];
      reviewRequested = [...record.requested];
      reviewSource = "manual-retry";
      forcedManualReview = true;
      reviewReason = record.rationale;
      reviewSummary = record.summary;
      reviewRisk = record.risk;
      approvalOverride = {
        denialId: armedRecord.denialId,
        actionFingerprint: record.fingerprint,
      };
    }
    if (reviewRequested.length > 0 || forcedManualReview) {
      const policy = await policyCheck({
        call: request.call,
        ownership: request.ownership,
        requested: reviewRequested,
        phase: "preview",
      });
      if (policy.kind === "error") return blocked({ code: "policy-error", reason: policy.reason });
      if (policy.kind === "deny") return blocked({ code: "policy-denied", reason: policy.reason });
      const decision = await runReview(
        state,
        request as Invocation<unknown, ReviewContext>,
        baseline,
        {
          source: reviewSource,
          requested: reviewRequested,
          risk: reviewRisk,
          reason: reviewReason,
          summary: reviewSummary,
          approvalOverride,
          effective: effectiveLeaseOverride,
          executionMode: admission.kind === "review" ? admission.executionMode : undefined,
          justification: admission.kind === "review" ? admission.justification : undefined,
        },
      );
      if ("code" in decision) return blocked(decision);
      if (decision.kind === "deny") {
        const retryHandle = recordDenial(state, request as Invocation<unknown, ReviewContext>, {
          rationale: decision.rationale,
          requested: reviewRequested,
          admissionRequested: admission.requested,
          risk: reviewRisk,
          summary: reviewSummary,
          executionMode: admission.kind === "review" ? admission.executionMode : undefined,
          justification: admission.kind === "review" ? admission.justification : undefined,
        });
        return blocked({ code: "review-denied", reason: decision.rationale }, retryHandle);
      }
      const grant: GrantRecord = {
        callFingerprint: callFingerprint(state, request.call, request.ownership),
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
      const result = await executeAttempt(
        state,
        request,
        leaseRequested,
        spent,
        effectiveLeaseOverride,
      );
      if ("kind" in result && (result.kind === "blocked" || result.kind === "failed"))
        return result;
      if (result.kind === "completed") return result;
      // The spent static grant is not persisted as a turn-wide permission.
      // The first attempt's exact lease is retained only so a trusted native
      // file adapter can request the one fresh reviewed retry when needed.
      return handleRuntimeOutcome(state, request, result, {
        requested: [...leaseRequested],
        admissionRequested: [...admission.requested],
        lease:
          effectiveLeaseOverride ?? leaseWithRequests(state, request.ownership, leaseRequested),
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
    if (attempt.baseline.mode === "escalated") {
      return denyAttemptForAttempt({
        code: "enforcement-unavailable",
        reason: "Escalated Bash executions cannot authorize a second inline capability",
        request: normalized,
      });
    }
    if (
      normalized.kind === "network" &&
      !isPublicNetworkHost(normalized.host) &&
      !localNetworkAllowed(attempt.baseline.policy, normalized.host, normalized.port)
    ) {
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

    const capabilityKey = requestKey(normalized);
    const key = `${state.generation}:${attempt.call.id}:${capabilityKey}`;
    const existing = inlineCapabilityReviews.get(key);
    if (existing) return existing;
    const pending = (async (): Promise<CapabilityAuthorizationDecision> => {
      const decision = await runReview(
        state,
        {
          ownership: attempt.ownership,
          call: cloneInvocationCall(attempt.call),
          reviewContext: attempt.reviewContext,
          signal,
          executor: async () => ({
            kind: "failed",
            error: new Error("inline review cannot execute"),
          }),
        },
        baseline,
        {
          source: "inline",
          requested: [normalized],
          risk: "REVIEW",
          reason: input.reason ?? "Network access requires approval",
          summary: `${normalized.host}:${normalized.port}`,
        },
      );
      if ("code" in decision) {
        return denyAttemptForAttempt(decision);
      }
      if (decision.kind === "approve") {
        return { kind: "allow", capability: normalized };
      }
      if (decision.kind !== "deny") {
        return denyAttemptForAttempt({
          code: "review-unavailable",
          reason: "The reviewer returned no decision",
        });
      }
      // Inline network denials are final for this connection attempt. They do
      // not mint a replay handle: there is no safe whole-command replay after
      // a mid-execution denial.
      recordDenialStats();
      return denyAttemptForAttempt({
        code: "review-denied",
        reason: decision.rationale,
        request: normalized,
      });
    })().finally(() => {
      // Retire this exact pending generation before publishing its terminal
      // decision, so a retry cannot inherit an already-consumed AllowOnce.
      if (inlineCapabilityReviews.get(key) === pending) inlineCapabilityReviews.delete(key);
    });
    inlineCapabilityReviews.set(key, pending);
    return pending;
  };

  const listDenials = (): readonly DenialNotice[] =>
    denialNotices.map((notice) => ({
      ...notice,
      call: cloneInvocationCall(notice.call),
      handle: { ...notice.handle },
    }));

  const armRetry = (handle: RetryHandle): boolean => {
    const record = retryRecords.get(handle.token);
    if (!record) return false;
    if (active && !active.closed) {
      if (
        record.fingerprint !==
        retryFingerprint(
          active,
          record.call,
          record.ownership,
          record.requested,
          record.admissionRequested,
          record.executionMode,
          record.justification,
        )
      ) {
        return false;
      }
    }
    armedRetry = { record, denialId: handle.token };
    return true;
  };

  const beginTurn = (input: TurnSnapshot): TurnHandle<ReviewContext> => {
    const snapshot = cloneSnapshot(input);
    if (active) closeState(active, "turn replaced");
    const nextSessionKey = snapshot.sessionId;
    const sessionChanged = sessionKey !== undefined && sessionKey !== nextSessionKey;
    const configChanged = configKey !== undefined && configKey !== snapshot.configFingerprint;
    if (sessionChanged || configChanged) {
      armedRetry = undefined;
      retryRecords.clear();
      denialNotices.length = 0;
      circuitOpen = false;
      consecutiveDenials = 0;
      denialWindow = [];
    }
    sessionKey = nextSessionKey;
    configKey = snapshot.configFingerprint;
    // Breaker state and all capability amendments belong to one turn.
    circuitOpen = false;
    consecutiveDenials = 0;
    denialWindow = [];
    emitAutoStateChange();
    const state: TurnState = {
      generation: ++generation,
      snapshot,
      turnNetworkHosts: new Set<string>(),
      turnWriteRoots: [],
      grants: new Map<string, GrantRecord>(),
      closed: false,
    };
    active = state;
    const handle: TurnHandle<ReviewContext> = {
      execute: <T>(request: Invocation<T, ReviewContext>) => executeInvocation(state, request),
      close: (reason = "turn closed") => closeState(state, reason),
    };
    return handle;
  };

  const invalidate = (reason: string): void => {
    generation += 1;
    if (active) closeState(active, reason);
    active = undefined;
    sessionKey = undefined;
    configKey = undefined;
    retryRecords.clear();
    denialNotices.length = 0;
    armedRetry = undefined;
    denialWindow = [];
    consecutiveDenials = 0;
    circuitOpen = false;
    abortReviews(reason);
  };

  return { beginTurn, invalidate, listDenials, armRetry };
}
