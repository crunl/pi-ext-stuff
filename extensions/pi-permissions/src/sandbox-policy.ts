import { isAbsolute, join, resolve } from "node:path";
import type { PermissionsConfig } from "./config.ts";
import {
  effectiveNetworkAuthority,
  fingerprintValue,
  type NetworkAccess,
  validateNetworkAccess,
  validateNetworkPolicy,
} from "./config.ts";
import {
  createFilesystemPolicy,
  expandSymlinkAliases,
  hasGlobSyntax,
  resolveSandboxDenyPattern,
} from "./filesystem-policy.ts";
import { isNetworkPatternCoveredBy } from "./network-domain-pattern.ts";

/** An attempt's required network enforcement, not an authorization ledger. */
export type ExecutionNetwork =
  | { readonly kind: "restricted" }
  | { readonly kind: "proxy"; readonly inlineReview: boolean; readonly tls?: "system" }
  | { readonly kind: "direct" };

/**
 * Our own sandbox policy — the complete description of what a sandboxed
 * process may touch. Deliberately plain data so it can be derived from
 * grants and rendered into any enforcer's flags.
 */
export interface SandboxPolicy {
  filesystem: {
    allowWrite: string[];
    denyRead: string[];
    denyWrite: string[];
  };
  network: {
    access?: NetworkAccess;
    /** Codex `network_access`: whole TCP network including private/loopback/bind when true. */
    network_access?: boolean;
    allowPrivateTargets?: boolean;
    macosTls?: "strict" | "system";
    /** Resolved finite child ceiling; never broad delegation consent. */
    delegated?: true;
    /** Engine-derived, immutable for this execution attempt; absent on base policies. */
    execution?: ExecutionNetwork;
    allowedDomains: string[];
    deniedDomains: string[];
    trustedFakeIpRanges?: string[];
    allowLocalBinding?: boolean;
  };
}

/**
 * Ledger projection of already-authorized network policy. Not an OS network
 * mode: pristine SRT has no network.mode. `access` is deprecated for
 * enforcement; authority lives in Engine lease / requestCovered.
 */
export function projectExecutionNetwork(policy: SandboxPolicy): ExecutionNetwork {
  const network = policy.network;
  const access = "access" in network ? validateNetworkAccess(network.access) : undefined;
  validateNetworkPolicy(network);
  const authority = effectiveNetworkAuthority(network);
  const tls = network.macosTls === "system" ? { tls: "system" as const } : {};
  if (access?.kind !== "explicit")
    return Object.freeze({ kind: "proxy", inlineReview: true, ...tls });
  const hasAuthority =
    (authority.wholeNetwork && !network.deniedDomains.includes("*")) ||
    network.allowedDomains.some(
      (allowed) =>
        !network.deniedDomains.some((denied) => isNetworkPatternCoveredBy(denied, allowed)),
    );
  if (!hasAuthority) return Object.freeze({ kind: "restricted" });
  if (access.transport === "direct") {
    if (!authority.wholeNetwork)
      throw new Error("Direct requires whole-network authority, not a host grant");
    return Object.freeze({ kind: "direct" });
  }
  return Object.freeze({ kind: "proxy", inlineReview: false, ...tls });
}

/** Defensive derived evidence, shared by review and read-only status. Absent TLS means strict. */
export function describeExecutionNetwork(policy: SandboxPolicy) {
  const required = projectExecutionNetwork(policy);
  const authority = effectiveNetworkAuthority(policy.network);
  return {
    requestPath: policy.network.access?.kind ?? "inline-proxy",
    wholeNetwork: authority.wholeNetwork,
    hosts: [...policy.network.allowedDomains],
    denies: [...policy.network.deniedDomains],
    required,
    configuredTls: policy.network.macosTls ?? "strict",
    effectiveTls: required.kind === "proxy" && required.tls === "system" ? "system" : "strict",
    privateTargets: authority.privateTargets,
    localBindingAndInbound: authority.localBinding,
    helperEgressRisk: required.kind === "proxy" && required.tls === "system",
    delegated: policy.network.delegated === true,
    policyFingerprint: fingerprintValue(policy),
  };
}
export type NetworkPolicyView = ReturnType<typeof describeExecutionNetwork>;

/**
 * Trusted, immutable evidence authority for one Guardian review.
 *
 * It deliberately carries only the part of the parent policy that remains
 * meaningful after intersecting it with Guardian's fixed read-only,
 * zero-write, zero-network profile. It is never included in the model prompt.
 */
export interface GuardianEvidenceScope {
  readonly cwd: string;
  readonly denyRead: readonly string[];
  readonly authorityFingerprint: string;
}

function guardianAuthorityFingerprint(cwd: string, denyRead: readonly string[]): string {
  return fingerprintValue({
    cwd,
    denyRead,
    allowWrite: [],
    network: "denied",
  });
}

function normalizedGuardianDenyRead(denyRead: readonly string[]): string[] {
  if (!Array.isArray(denyRead)) throw new Error("Guardian evidence denyRead must be an array");
  const normalized = denyRead.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || !isAbsolute(entry)) {
      throw new Error("Guardian evidence denyRead entries must be non-empty absolute paths");
    }
    return entry;
  });
  if (process.platform === "linux" && normalized.some(hasGlobSyntax)) {
    throw new Error("Guardian evidence cannot enforce glob denyRead entries on Linux");
  }
  return [...new Set(normalized)].sort();
}

/** Derive Guardian authority from the exact parent lease, never from a grant. */
export function createGuardianEvidenceScope(
  cwd: string,
  parentPolicy: SandboxPolicy,
): GuardianEvidenceScope {
  if (!parentPolicy || typeof parentPolicy !== "object") {
    throw new Error("Guardian evidence requires an exact parent sandbox policy");
  }
  const resolvedCwd = resolve(cwd);
  const denyRead = Object.freeze(normalizedGuardianDenyRead(parentPolicy.filesystem.denyRead));
  return Object.freeze({
    cwd: resolvedCwd,
    denyRead,
    authorityFingerprint: guardianAuthorityFingerprint(resolvedCwd, denyRead),
  });
}

/**
 * Evidence ceiling for host-admission reviews when the main sandbox is
 * disabled. Host tools are not given a synthetic execution sandbox; this
 * policy only records the least-authority Guardian profile (zero writes and
 * zero network) while preserving the parent process's unrestricted read
 * authority through an empty denyRead set.
 */
export function createGuardianEvidencePolicyCeiling(): SandboxPolicy {
  return {
    filesystem: {
      allowWrite: [],
      denyRead: [],
      denyWrite: [],
    },
    network: {
      allowedDomains: [],
      deniedDomains: ["*"],
      trustedFakeIpRanges: [],
      allowLocalBinding: false,
    },
  };
}

/** Validate and defensively copy authority received across an internal seam. */
export function copyGuardianEvidenceScope(scope: GuardianEvidenceScope): GuardianEvidenceScope {
  if (!scope || typeof scope !== "object" || !isAbsolute(scope.cwd)) {
    throw new Error("Guardian evidence scope is invalid");
  }
  const cwd = resolve(scope.cwd);
  const denyRead = Object.freeze(normalizedGuardianDenyRead(scope.denyRead));
  const authorityFingerprint = guardianAuthorityFingerprint(cwd, denyRead);
  if (scope.authorityFingerprint !== authorityFingerprint) {
    throw new Error("Guardian evidence authority fingerprint does not match its scope");
  }
  return Object.freeze({ cwd, denyRead, authorityFingerprint });
}

export interface SandboxNetworkEndpoint {
  readonly host: string;
  readonly port: number;
  /**
   * DNS answers frozen by the parent boundary. The guard must try only these
   * literals and must never resolve `host` again after authorization.
   */
  readonly addresses: readonly string[];
}

export interface SandboxNetworkAuthorization {
  readonly allowed: boolean;
  readonly endpoint?: SandboxNetworkEndpoint;
  readonly reason?: string;
}

/** Authorization is evaluated by the Engine; the sandbox only transports it. */
export type SandboxNetworkAuthorize = (input: {
  host: string;
  port: number;
  signal?: AbortSignal;
}) => Promise<SandboxNetworkAuthorization>;

export interface SandboxProgram {
  executable: string;
  args: readonly string[];
}

export interface SandboxExecutionRequest {
  policy: SandboxPolicy;
  program: SandboxProgram;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Replace the inherited host environment instead of overlaying it. */
  envMode?: "inherit" | "replace";
  signal?: AbortSignal;
  stdin?: "ignore" | string;
  timeoutMs?: number;
  commandId?: string;
  commandText?: string;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** Per-command inline network authorization seam. */
  networkAuthorize?: SandboxNetworkAuthorize;
}

export interface SandboxExecutionResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

/** An authoritative backend capability boundary, never inferred from diagnostic text. */
export type SandboxDenialCapability =
  | { kind: "filesystem"; operation: "write"; path: string }
  | { kind: "network"; host: string };

const SANDBOX_DENIAL_MARKERS =
  /operation not permitted|permission denied|read-only file system|sandbox denied|\bEPERM\b|\bEACCES\b|\bEROFS\b|connect tunnel failed/i;

/** Cheap failure pre-filter only; matching text is not proof of a sandbox denial. */
export function looksLikeSandboxDenial(text: string): boolean {
  return SANDBOX_DENIAL_MARKERS.test(text);
}

export interface SandboxBackendState {
  initialized: boolean;
  healthy: boolean;
  draining: boolean;
  fault?: string;
  networkSupport?: { apiVersion: number; platform: string; modes: readonly string[] };
  execution: "idle" | "active-lifecycle";
  requiredNetwork?: ExecutionNetwork;
  /** Public backend does not attest kernel installation or TLS success. */
  nativeEnforcement: "unknown";
}

export interface SandboxManagerLike {
  initialize(config: SandboxPolicy): Promise<void>;
  /**
   * Execute a program under the active policy. The implementation owns the
   * sandbox wrapper, child process, deadlines, and cleanup lifecycle.
   */
  execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
  /** Atomically reset and install a new process-global sandbox policy. */
  activate?(config: SandboxPolicy): Promise<void>;
  /** Live health of the backend process/coordinator, when available. */
  isHealthy?(): boolean;
  /** Wait for execution and detached cleanup/drain without mutation or fault recovery. */
  waitForIdle?(signal?: AbortSignal): Promise<void>;
  describeState?(): SandboxBackendState;
  reset(): Promise<void>;
  /**
   * After a failed execution, report the exact capability enforcement
   * denied for this invocation, only when the backend has authoritative
   * capability events. SRT diagnostics do not implement this seam, and a
   * capability fact alone never proves that a native action can safely replay.
   */
  classifyDenial?(commandId: string): Promise<SandboxDenialCapability | undefined>;
  /** Bounded observations for display only; never authorization or scope. */
  readFailureDiagnostics?(commandId: string): Promise<string | undefined>;
}

export function createGuardianReadOnlySandboxConfig(scope: GuardianEvidenceScope): SandboxPolicy {
  const trustedScope = copyGuardianEvidenceScope(scope);
  return {
    filesystem: {
      allowWrite: [],
      denyRead: [...trustedScope.denyRead],
      denyWrite: [],
    },
    network: {
      allowedDomains: [],
      deniedDomains: ["*"],
      trustedFakeIpRanges: [],
      allowLocalBinding: false,
    },
  };
}

/** Conservative fallback used only when a caller omits an explicit policy. */
export function createDefaultSandboxConfig(): SandboxPolicy {
  return {
    filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
    network: {
      allowedDomains: [],
      deniedDomains: ["*"],
      trustedFakeIpRanges: [],
      allowLocalBinding: false,
    },
  };
}

export function withAdditionalWriteRoots(
  config: SandboxPolicy,
  writeRoots: readonly string[],
): SandboxPolicy {
  const roots = [...new Set(writeRoots.flatMap(expandSymlinkAliases))];
  if (roots.length === 0) return config;
  return {
    ...config,
    filesystem: {
      ...config.filesystem,
      allowWrite: [...new Set([...config.filesystem.allowWrite, ...roots])],
    },
  };
}

export function createSandboxRuntimeConfig(
  config: PermissionsConfig["sandbox"],
  cwd: string,
  protectedWritePaths?: readonly string[],
  gitMetadataProtectionRoots: readonly string[] = [],
): SandboxPolicy {
  const filesystem = createFilesystemPolicy(
    config,
    cwd,
    protectedWritePaths ? [...protectedWritePaths] : undefined,
  );
  const denyRead = filesystem.denyRead.flatMap((pattern) =>
    expandSymlinkAliases(resolveSandboxDenyPattern(pattern, cwd)),
  );
  const denyWrite = filesystem.denyWrite.flatMap((pattern) =>
    expandSymlinkAliases(resolveSandboxDenyPattern(pattern, cwd)),
  );
  const gitRoot = resolve(cwd, ".git");
  const gitAliases = new Set(expandSymlinkAliases(gitRoot));
  const metadataRoots = [
    ...new Set(gitMetadataProtectionRoots.flatMap((path) => expandSymlinkAliases(resolve(path)))),
  ];
  const metadataDenyWrite = metadataRoots.flatMap((root) => [
    root,
    join(root, "hooks"),
    join(root, "config"),
  ]);
  const finalDenyWrite = [...new Set([...denyWrite, ...gitAliases, ...metadataDenyWrite])];
  return {
    filesystem: {
      allowWrite: filesystem.allowWrite,
      denyRead,
      denyWrite: finalDenyWrite,
    },
    network: {
      ...("access" in config.network
        ? { access: validateNetworkAccess(config.network.access) }
        : {}),
      ...(config.network.network_access === undefined
        ? {}
        : { network_access: config.network.network_access }),
      ...(config.network.allowPrivateTargets === undefined
        ? {}
        : { allowPrivateTargets: config.network.allowPrivateTargets }),
      ...(config.network.macosTls === undefined ? {} : { macosTls: config.network.macosTls }),
      allowedDomains: [...config.network.allowedDomains],
      deniedDomains: [...config.network.deniedDomains],
      trustedFakeIpRanges: [...config.network.trustedFakeIpRanges],
      ...(config.network.allowLocalBinding === undefined
        ? {}
        : { allowLocalBinding: config.network.allowLocalBinding }),
    },
  };
}

export interface NativeFileOperationFailure {
  operation: "mkdir" | "write" | "read" | "access";
  path: string;
  cwd: string;
  contentWriteStarted: boolean;
  exitCode: number | null;
  error: string;
}

export type NativeFileOperationEvent =
  | ({ kind: "failed" } & NativeFileOperationFailure)
  | { kind: "started" | "succeeded" };
