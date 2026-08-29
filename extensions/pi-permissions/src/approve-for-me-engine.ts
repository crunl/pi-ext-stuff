import { relative, resolve } from "node:path";
import { fingerprintValue } from "./config.ts";
import type { StructuredExecutionPlan } from "./execution-plan.ts";
import { hasGlobSyntax } from "./filesystem-policy.ts";
import { resolveTrustedSystemGitExecutable } from "./git-executable.ts";
import { isPublicNetworkHost, normalizeNetworkHost } from "./network-host.ts";
import type { SandboxPolicy } from "./sandbox.ts";
import { errorMessage, isRecord } from "./unknown-value.ts";

/** The only permission modes understood by the deep module. */
export type ApproveForMeMode = "auto" | "yolo";
export type AdmissionRisk = "LOW" | "REVIEW" | "HARD";

/** Ownership says which external execution Adapter is authoritative. */
export type InvocationOwnership = "sandbox-owned" | "host-admission" | "permission-amendment";

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
      execution?: StructuredExecutionPlan;
    }
  | {
      kind: "review";
      requested?: readonly CapabilityRequestInput[];
      review: "capability" | "action";
      risk: AdmissionRisk;
      reason: string;
      summary?: string;
      execution?: StructuredExecutionPlan;
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
  transcript?: readonly unknown[];
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
      retryability: "safe" | "uncertain";
      detail?: string;
    }
  | { kind: "failed"; error: unknown };

export interface ExecutionAttempt {
  readonly ordinal: 0 | 1;
  /** Canonical action snapshot reviewed and fingerprinted by the Engine. */
  readonly call: InvocationCall;
  readonly lease: CapabilityLease;
  readonly plan?: StructuredExecutionPlan;
}

export type InvocationExecutor<T> = (attempt: ExecutionAttempt) => Promise<RuntimeOutcome<T>>;

export interface PermissionAmendment {
  kind: "permission-amendment";
  requested: readonly CapabilityRequestInput[];
  scope: "turn" | "session";
  reason?: string;
}

export interface Invocation<T, ReviewContext = undefined> {
  ownership: InvocationOwnership;
  call: InvocationCall;
  /** Required in auto mode except for permission-amendment, which has its own intent. */
  admission?: AdmissionPlan;
  /** Only ownership=permission-amendment may supply this field. */
  intent?: PermissionAmendment;
  reviewContext: ReviewContext;
  executor: InvocationExecutor<T>;
  signal?: AbortSignal;
}

export interface GuardianReviewInput<ReviewContext = undefined> {
  call: InvocationCall;
  ownership: InvocationOwnership;
  requested: readonly CapabilityRequest[];
  source: "preview" | "runtime" | "permission-amendment" | "manual-retry";
  retryability?: "safe" | "uncertain";
  risk?: AdmissionRisk;
  baseline: CapabilityLease;
  effective: CapabilityLease;
  transcript: readonly unknown[];
  reason?: string;
  summary?: string;
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
  | { readonly status: "reviewing"; readonly reviewId: string; readonly call: InvocationCall }
  | {
      readonly status: "approved" | "denied";
      readonly reviewId: string;
      readonly call: InvocationCall;
      readonly rationale: string;
    }
  | {
      readonly status: "aborted" | "timed-out";
      readonly reviewId: string;
      readonly call: InvocationCall;
    }
  | {
      readonly status: "failed";
      readonly reviewId: string;
      readonly call: InvocationCall;
      readonly reason: string;
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
  | "retry-denied"
  | "retry-uncertain"
  | "circuit-open"
  | "concurrent-invocation"
  | "enforcement-unavailable"
  | "execution-failed";

export interface PermissionError {
  code: PermissionErrorCode;
  reason: string;
  request?: CapabilityRequest;
}

export type ExecutionOutcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "blocked"; error: PermissionError; retryHandle?: RetryHandle }
  | { kind: "failed"; error: unknown };

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

export interface ApproveForMeEngine<ReviewContext = undefined> {
  beginTurn(snapshot: TurnSnapshot): TurnHandle<ReviewContext>;
  invalidate(reason: string): void;
  listDenials(): readonly DenialNotice[];
  armRetry(handle: RetryHandle): boolean;
}

interface TurnState {
  readonly generation: number;
  readonly snapshot: TurnSnapshot;
  readonly sessionNetworkHosts: Set<string>;
  readonly sessionWriteRoots: string[];
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
  readonly execution?: StructuredExecutionPlan;
  readonly risk?: AdmissionRisk;
  readonly rationale: string;
  readonly summary?: string;
}

interface ReviewRequest {
  readonly source: GuardianReviewInput["source"];
  readonly requested: readonly CapabilityRequest[];
  readonly retryability?: "safe" | "uncertain";
  readonly risk?: AdmissionRisk;
  readonly reason?: string;
  readonly summary?: string;
  readonly approvalOverride?: ApprovalOverride;
}

type ResolvedAdmission =
  | { kind: "allow"; requested: CapabilityRequest[]; execution?: StructuredExecutionPlan }
  | {
      kind: "review";
      requested: CapabilityRequest[];
      review: "capability" | "action";
      risk: AdmissionRisk;
      reason: string;
      summary?: string;
      execution?: StructuredExecutionPlan;
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

function hostMatches(pattern: string, host: string): boolean {
  return host === pattern || host.endsWith(`.${pattern}`);
}

function normalizeCapabilityRequest(raw: unknown, cwd: string): CapabilityRequest | undefined {
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
    if (!host || !isPublicNetworkHost(host)) return undefined;
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

function normalizeExecutionPlan(raw: unknown, cwd: string): StructuredExecutionPlan | undefined {
  if (!isRecord(raw) || raw.kind !== "git-init") return undefined;
  if (typeof raw.executable !== "string") return undefined;
  const executable = resolveTrustedSystemGitExecutable(raw.executable);
  if (!executable) return undefined;
  if (!Array.isArray(raw.args) || !raw.args.every((arg) => typeof arg === "string")) {
    return undefined;
  }
  const args = raw.args;
  if (
    !(args.length === 1 && args[0] === "init") &&
    !(args.length === 2 && args[0] === "init" && args[1] === ".")
  ) {
    return undefined;
  }
  if (typeof raw.cwd !== "string" || resolve(raw.cwd) !== resolve(cwd)) return undefined;
  return {
    kind: "git-init",
    executable,
    args: args.length === 1 ? ["init"] : ["init", "."],
    cwd: resolve(raw.cwd),
  };
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
    const execution =
      raw.execution === undefined ? undefined : normalizeExecutionPlan(raw.execution, cwd);
    if (raw.execution !== undefined && execution === undefined) return { ok: false };
    return {
      ok: true,
      admission: {
        kind: "allow",
        requested: normalized.requests,
        ...(execution === undefined ? {} : { execution }),
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
  const execution =
    raw.execution === undefined ? undefined : normalizeExecutionPlan(raw.execution, cwd);
  if (raw.execution !== undefined && execution === undefined) return { ok: false };
  return {
    ok: true,
    admission: {
      kind: "review",
      requested: normalized.requests,
      review: raw.review,
      risk: raw.risk,
      reason: raw.reason,
      ...(raw.summary === undefined ? {} : { summary: raw.summary }),
      ...(execution === undefined ? {} : { execution }),
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
    if (policy.network.deniedDomains.some((pattern) => hostMatches(pattern, request.host)))
      return false;
    return policy.network.allowedDomains.some((pattern) => hostMatches(pattern, request.host));
  }
  return false;
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

/**
 * Release only the protected deny identities explicitly classified as
 * grantable, and only when the approved write capability names that identity
 * exactly. A broad allow root must never erase a nested protected deny.
 */
function releaseExactGrantableWriteDenies(
  policy: SandboxPolicy,
  exactWritePaths: readonly string[],
): void {
  const grantable = new Set(policy.filesystem.grantableDenyWrite ?? []);
  const released = new Set(
    policy.filesystem.denyWrite.filter(
      (path) => grantable.has(path) && exactWritePaths.includes(path),
    ),
  );
  if (released.size === 0) return;
  policy.filesystem.denyWrite = policy.filesystem.denyWrite.filter((path) => !released.has(path));
  policy.filesystem.grantableDenyWrite = (policy.filesystem.grantableDenyWrite ?? []).filter(
    (path) => !released.has(path),
  );
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
  const sessionHosts = [...state.sessionNetworkHosts];
  const turnHosts = [...state.turnNetworkHosts];
  const sessionRoots = [...state.sessionWriteRoots];
  const turnRoots = [...state.turnWriteRoots];
  const extraHosts = [...sessionHosts, ...turnHosts];
  const extraRoots = [...sessionRoots, ...turnRoots];
  for (const request of requested) {
    if (request.kind === "network") extraHosts.push(request.host);
    if (request.kind === "filesystem" && request.operation === "write") {
      extraRoots.push(request.path);
    }
  }
  appendUnique(policy.network.allowedDomains, extraHosts);
  appendUnique(policy.filesystem.allowWrite, extraRoots);
  releaseExactGrantableWriteDenies(policy, extraRoots);
  // Keep ownership in the call, not in the lease. The Adapter sees the same
  // immutable policy shape for sandbox-owned and permission-amendment calls.
  return { mode: "sandboxed", policy };
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
  execution?: StructuredExecutionPlan,
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
    execution,
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
  const sessionNetworkHosts = new Set<string>();
  const sessionWriteRoots: string[] = [];
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
      readonly execution?: StructuredExecutionPlan;
    },
  ): RetryHandle => {
    recordWindow(true);
    consecutiveDenials += 1;
    if (
      consecutiveDenials >= maxConsecutiveDenials ||
      denialWindow.filter(Boolean).length >= maxWindowDenials
    ) {
      circuitOpen = true;
    }
    emitAutoStateChange();
    const frozenRequested = denial.requested.map((item) => structuredClone(item));
    const frozenAdmissionRequested = denial.admissionRequested.map((item) => structuredClone(item));
    const frozenExecution =
      denial.execution === undefined ? undefined : structuredClone(denial.execution);
    const retryHandle = makeRetryHandle({
      fingerprint: retryFingerprint(
        state,
        request.call,
        request.ownership,
        frozenRequested,
        frozenAdmissionRequested,
        frozenExecution,
      ),
      call: cloneInvocationCall(request.call),
      ownership: request.ownership,
      requested: frozenRequested,
      admissionRequested: frozenAdmissionRequested,
      ...(frozenExecution === undefined ? {} : { execution: frozenExecution }),
      ...(denial.risk === undefined ? {} : { risk: denial.risk }),
      rationale: denial.rationale,
      ...(denial.summary === undefined ? {} : { summary: denial.summary }),
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

  const closeState = (state: TurnState, reason: string): void => {
    if (state.closed) return;
    const wasActive = active === state;
    state.closed = true;
    state.grants.clear();
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
    emitReviewEvent(() => ({
      status: "reviewing",
      reviewId,
      call: cloneInvocationCall(request.call),
    }));
    const guardian = options.guardian;
    if (!guardian) {
      const reason = "The configured reviewer is unavailable";
      emitReviewEvent(() => ({
        status: "failed",
        reviewId,
        call: cloneInvocationCall(request.call),
        reason,
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
        }));
        return { code: "aborted", reason: "Operation aborted" };
      }
      const decision = await guardian.review(
        {
          call: cloneInvocationCall(request.call),
          ownership: request.ownership,
          requested: review.requested.map((item) => structuredClone(item)),
          source: review.source,
          retryability: review.retryability,
          risk: review.risk,
          baseline: cloneLease(baseline),
          effective: leaseWithRequests(state, request.ownership, review.requested),
          transcript: structuredClone(state.snapshot.transcript ?? []),
          reason: review.reason,
          summary: review.summary,
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
        }));
        return { code: "stale-invocation", reason: "Permission context changed" };
      }
      if (signal.aborted) {
        emitReviewEvent(() => ({
          status: "aborted",
          reviewId,
          call: cloneInvocationCall(request.call),
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
        }));
        return { code: "review-unavailable", reason };
      }
      if (decision.kind === "approve") recordNonDenial();
      emitReviewEvent(() => ({
        status: decision.kind === "approve" ? "approved" : "denied",
        reviewId,
        call: cloneInvocationCall(request.call),
        rationale: decision.rationale,
      }));
      return decision;
    } catch (error) {
      if (!isCurrent(state)) {
        emitReviewEvent(() => ({
          status: "aborted",
          reviewId,
          call: cloneInvocationCall(request.call),
        }));
        return { code: "stale-invocation", reason: "Permission context changed" };
      }
      if (request.signal?.aborted) {
        emitReviewEvent(() => ({
          status: "aborted",
          reviewId,
          call: cloneInvocationCall(request.call),
        }));
        return { code: "aborted", reason: "Operation aborted" };
      }
      if (controller.signal.aborted) {
        emitReviewEvent(() => ({
          status: "aborted",
          reviewId,
          call: cloneInvocationCall(request.call),
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

  const executeAttempt = async <T>(
    state: TurnState,
    request: Invocation<T, ReviewContext>,
    requested: readonly CapabilityRequest[],
    ordinal: 0 | 1,
    grant?: GrantRecord,
    plan?: StructuredExecutionPlan,
  ): Promise<RuntimeOutcome<T> | ExecutionOutcome<T>> => {
    if (!isCurrent(state))
      return blocked({ code: "stale-invocation", reason: "Permission context changed" });
    if (request.signal?.aborted) return blocked({ code: "aborted", reason: "Operation aborted" });
    const lease = leaseWithRequests(state, request.ownership, [
      ...requested,
      ...(grant?.requested ?? []),
    ]);
    try {
      const result = await request.executor({
        ordinal,
        call: cloneInvocationCall(request.call),
        lease,
        ...(plan === undefined ? {} : { plan }),
      });
      if (!isCurrent(state)) {
        return blocked({ code: "stale-invocation", reason: "Permission context changed" });
      }
      if (request.signal?.aborted) {
        return blocked({ code: "aborted", reason: "Operation aborted" });
      }
      return result;
    } catch (error) {
      if (request.signal?.aborted) return blocked({ code: "aborted", reason: "Operation aborted" });
      if (!isCurrent(state))
        return blocked({ code: "stale-invocation", reason: "Permission context changed" });
      return { kind: "failed", error };
    }
  };

  const executeUnrestricted = async <T>(
    state: TurnState,
    request: Invocation<T, ReviewContext>,
  ): Promise<ExecutionOutcome<T>> => {
    const outcome = await executeAttempt(state, request, [], 0);
    if (outcome.kind === "blocked") return outcome;
    if (outcome.kind === "failed") return { kind: "failed", error: outcome.error };
    if (outcome.kind === "completed") return outcome;
    const normalized = normalizeCapabilityRequest(outcome.request, request.call.cwd);
    return blocked({
      code: outcome.retryability === "uncertain" ? "retry-uncertain" : "runtime-denied",
      reason:
        outcome.detail ??
        (outcome.retryability === "uncertain"
          ? "Runtime denial may have committed an effect; replay is disabled"
          : "Unrestricted execution reported a capability denial"),
      ...(normalized === undefined ? {} : { request: normalized }),
    });
  };

  const handleRuntimeOutcome = async <T>(
    state: TurnState,
    request: Invocation<T, ReviewContext>,
    baseline: CapabilityLease,
    outcome: RuntimeOutcome<T>,
    admissionRequested: readonly CapabilityRequest[],
    execution?: StructuredExecutionPlan,
  ): Promise<ExecutionOutcome<T>> => {
    if (outcome.kind === "completed") return outcome;
    if (outcome.kind === "failed") return { kind: "failed", error: outcome.error };
    const normalized = normalizeCapabilityRequest(outcome.request, request.call.cwd);
    if (!normalized) {
      return blocked({
        code: "runtime-denied",
        reason: "Runtime denial did not contain a valid capability request",
      });
    }
    if (!runtimeCapabilitySupported(request.ownership, normalized)) {
      return blocked({
        code: "enforcement-unavailable",
        reason: "The execution adapter cannot enforce this runtime capability",
        request: normalized,
      });
    }
    const runtimePolicy = await policyCheck({
      call: request.call,
      ownership: request.ownership,
      requested: [normalized],
      phase: "runtime",
    });
    if (!isCurrent(state))
      return blocked({ code: "stale-invocation", reason: "Permission context changed" });
    if (request.signal?.aborted) return blocked({ code: "aborted", reason: "Operation aborted" });
    if (runtimePolicy.kind === "error")
      return blocked({ code: "policy-error", reason: runtimePolicy.reason, request: normalized });
    if (runtimePolicy.kind === "deny")
      return blocked({ code: "policy-denied", reason: runtimePolicy.reason, request: normalized });
    if (outcome.retryability !== "safe") {
      return blocked({
        code: "retry-uncertain",
        reason: outcome.detail ?? "Runtime denial may have committed an effect; replay is disabled",
        request: normalized,
      });
    }
    if (requestCovered(baseline, normalized)) {
      return blocked({
        code: "runtime-denied",
        reason: "Enforcement denied a capability already in the effective lease",
        request: normalized,
      });
    }
    const decision = await runReview(
      state,
      request as Invocation<unknown, ReviewContext>,
      baseline,
      {
        source: "runtime",
        requested: [normalized],
        retryability: outcome.retryability,
        risk: "REVIEW",
        reason: outcome.detail,
      },
    );
    if ("code" in decision) return blocked(decision, undefined);
    if (decision.kind === "deny") {
      const retryHandle = recordDenial(state, request as Invocation<unknown, ReviewContext>, {
        rationale: decision.rationale,
        requested: [normalized],
        admissionRequested,
        risk: "REVIEW",
        execution,
      });
      return blocked(
        { code: "review-denied", reason: decision.rationale, request: normalized },
        retryHandle,
      );
    }
    const grant: GrantRecord = {
      callFingerprint: callFingerprint(state, request.call, request.ownership),
      requested: [normalized],
    };
    state.grants.set(request.call.id, grant);
    const spent = consumeGrant(state, request as Invocation<unknown, ReviewContext>, [normalized]);
    if (!spent)
      return blocked({
        code: "stale-invocation",
        reason: "Exact capability grant no longer matches",
      });
    const retried = await executeAttempt(
      state,
      request,
      [...admissionRequested, normalized],
      1,
      spent,
    );
    if ("kind" in retried && (retried.kind === "blocked" || retried.kind === "failed"))
      return retried;
    if (retried.kind === "completed") return retried;
    return blocked({
      code: "retry-denied",
      reason: retried.detail ?? "The exact retry was denied by enforcement",
      request: normalizeCapabilityRequest(retried.request, request.call.cwd),
    });
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
    if (request.ownership === "host-admission" && admission.requested.length === 0) {
      return blocked({
        code: "enforcement-unavailable",
        reason: "Host admission requires an exact capability request",
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
      const amended = await executeAttempt(state, request, amendmentRequests, 0);
      if ("kind" in amended && (amended.kind === "blocked" || amended.kind === "failed"))
        return amended;
      if (amended.kind === "completed") {
        if (request.intent.scope === "session") {
          for (const item of amendmentRequests) {
            if (item.kind === "network") state.sessionNetworkHosts.add(item.host);
            if (item.kind === "filesystem" && item.operation === "write") {
              appendUnique(state.sessionWriteRoots, [item.path]);
            }
          }
        } else {
          for (const item of amendmentRequests) {
            if (item.kind === "network") state.turnNetworkHosts.add(item.host);
            if (item.kind === "filesystem" && item.operation === "write") {
              appendUnique(state.turnWriteRoots, [item.path]);
            }
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
          return blocked({
            code: "enforcement-unavailable",
            reason: "The execution adapter cannot enforce this runtime capability",
            request: normalized,
          });
        }
        return blocked({
          code: "runtime-denied",
          reason: amended.detail ?? "Permission amendment acknowledgement was denied",
          ...(normalized === undefined ? {} : { request: normalized }),
        });
      }
      return blocked({
        code: "runtime-denied",
        reason: "Permission amendment acknowledgement failed",
      });
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
          admission.execution,
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
          execution: admission.execution,
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
        0,
        spent,
        admission.execution,
      );
      if ("kind" in result && (result.kind === "blocked" || result.kind === "failed"))
        return result;
      if (result.kind === "completed") return result;
      // The spent static grant is never replayed. A distinct capability that
      // enforcement itself denied at runtime may still receive one fresh
      // runtime review through the standard escalation path.
      return handleRuntimeOutcome(
        state,
        request,
        leaseWithRequests(state, request.ownership, leaseRequested),
        result,
        leaseRequested,
        admission.execution,
      );
    }

    const initial = await executeAttempt(
      state,
      request,
      leaseRequested,
      0,
      undefined,
      admission.execution,
    );
    if ("kind" in initial && (initial.kind === "blocked" || initial.kind === "failed"))
      return initial;
    if (initial.kind === "completed") return initial;
    return handleRuntimeOutcome(
      state,
      request,
      baseline,
      initial,
      admission.requested,
      admission.execution,
    );
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
          record.execution,
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
      sessionNetworkHosts.clear();
      sessionWriteRoots.length = 0;
      retryRecords.clear();
      denialNotices.length = 0;
      circuitOpen = false;
      consecutiveDenials = 0;
      denialWindow = [];
    }
    sessionKey = nextSessionKey;
    configKey = snapshot.configFingerprint;
    // Breaker state belongs to a turn. Session-scoped capabilities remain in
    // the durable world above, but a new turn gets a fresh denial window.
    circuitOpen = false;
    consecutiveDenials = 0;
    denialWindow = [];
    emitAutoStateChange();
    const state: TurnState = {
      generation: ++generation,
      snapshot,
      sessionNetworkHosts,
      sessionWriteRoots,
      turnNetworkHosts: new Set<string>(),
      turnWriteRoots: [],
      grants: new Map<string, GrantRecord>(),
      closed: false,
    };
    // Session-scoped amendments survive a normal turn close. Carry them from
    // the prior state only when it belongs to the same session/config.
    // `active` was closed above, so the previous state is not available there;
    // keep the durable world in local variables instead.
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
    sessionNetworkHosts.clear();
    sessionWriteRoots.length = 0;
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
