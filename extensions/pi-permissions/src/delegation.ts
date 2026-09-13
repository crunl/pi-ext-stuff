import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  intersectNetworkPatterns,
  isNetworkPatternCoveredBy,
  matchesNetworkDomainPattern,
  normalizeNetworkDomainPattern,
} from "./network-domain-pattern.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";

/**
 * Least-privilege envelope for a delegated subagent turn.
 * Pure data — no I/O, no host knowledge. The parent declares the upper bound;
 * the child may only narrow it.
 *
 * Phase 2 status: register.ts mints a child snapshot whose base policy is
 * parent ∩ envelope and runs the child on an isolated Engine turn.
 * Empty configured lists inherit the parent policy before resolution; an empty
 * resolved envelope is an effective no-grant result.
 */
export interface DelegationEnvelope {
  readonly writeRoots: readonly string[];
  readonly networkHosts: readonly string[];
  readonly allowReDelegate?: boolean;
  readonly maxDepth?: number;
}

export interface DelegationPlan {
  readonly envelope: DelegationEnvelope;
  readonly parentTurnId: string | number;
  readonly parentSessionId: string;
  readonly reason?: string;
  /** Maximum delegation depth below this child (0 = leaf, may not delegate). */
  readonly maxDepth: number;
  readonly noReDelegate: boolean;
}

export interface DelegationAuditLink {
  readonly parentSessionId: string;
  readonly parentTurnId: string | number;
  readonly childTurnId: string | number;
  readonly envelope: DelegationEnvelope;
}

function normalizeRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const root of roots) {
    if (typeof root !== "string" || root.length === 0) {
      throw new Error("Delegation envelope writeRoots must be non-empty strings");
    }
    // Relative roots would resolve against process.cwd(), which drifts
    // between parent and child turns. Envelopes must be absolute.
    if (!isAbsolute(root)) {
      throw new Error(`Delegation envelope writeRoots must be absolute: ${root}`);
    }
    seen.add(resolve(root));
  }
  return [...seen].sort();
}

/** Hierarchical coverage: entry is the root itself or nested beneath it. */
function isCoveredBy(entry: string, roots: ReadonlySet<string>): boolean {
  const normalized = resolve(entry);
  for (const root of roots) {
    const path = relative(resolve(root), normalized);
    if (path === "" || (path !== ".." && !path.startsWith(`..${sep}`))) {
      return true;
    }
  }
  return false;
}

function pathsIntersect(parent: string, requested: string): boolean {
  return isCoveredBy(parent, new Set([requested])) || isCoveredBy(requested, new Set([parent]));
}

function normalizeHosts(hosts: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const host of hosts) {
    if (typeof host !== "string" || host.trim().length === 0) {
      throw new Error("Delegation envelope networkHosts must be non-empty strings");
    }
    const normalized = normalizeNetworkDomainPattern(host);
    if (normalized === undefined) {
      throw new Error(`Delegation envelope networkHosts contains an unsupported pattern: ${host}`);
    }
    seen.add(normalized);
  }
  return [...seen].sort();
}

export function createDelegationPlan(input: {
  envelope: DelegationEnvelope;
  parentTurnId: string | number;
  parentSessionId: string;
  reason?: string;
  maxDepth?: number;
  noReDelegate?: boolean;
}): DelegationPlan {
  if (typeof input.parentSessionId !== "string" || input.parentSessionId.length === 0) {
    throw new Error("DelegationPlan requires a parentSessionId");
  }
  if (input.parentTurnId === undefined || input.parentTurnId === null) {
    throw new Error("DelegationPlan requires a parentTurnId");
  }
  // Precedence: explicit maxDepth > envelope.maxDepth > default leaf (1).
  if (input.envelope.maxDepth !== undefined) {
    if (!Number.isInteger(input.envelope.maxDepth) || input.envelope.maxDepth < 0) {
      throw new Error("Delegation envelope maxDepth must be a non-negative integer");
    }
  }
  const envelope: DelegationEnvelope = Object.freeze({
    writeRoots: Object.freeze(normalizeRoots(input.envelope.writeRoots ?? [])),
    networkHosts: Object.freeze(normalizeHosts(input.envelope.networkHosts ?? [])),
    ...(input.envelope.allowReDelegate === undefined
      ? {}
      : { allowReDelegate: input.envelope.allowReDelegate }),
    ...(input.envelope.maxDepth === undefined ? {} : { maxDepth: input.envelope.maxDepth }),
  });
  const maxDepth = input.maxDepth ?? input.envelope.maxDepth ?? 1;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new Error("DelegationPlan maxDepth must be a non-negative integer");
  }
  return Object.freeze({
    envelope,
    parentTurnId: input.parentTurnId,
    parentSessionId: input.parentSessionId,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    maxDepth,
    noReDelegate: input.noReDelegate ?? true,
  });
}

export function isEnvelopeSubset(child: DelegationEnvelope, parent: DelegationEnvelope): boolean {
  const childRoots = new Set(normalizeRoots(child.writeRoots ?? []));
  const parentRoots = new Set(normalizeRoots(parent.writeRoots ?? []));
  for (const root of childRoots) {
    if (!isCoveredBy(root, parentRoots)) return false;
  }
  const childHosts = normalizeHosts(child.networkHosts ?? []);
  const parentHosts = normalizeHosts(parent.networkHosts ?? []);
  for (const host of childHosts) {
    if (!parentHosts.some((parentHost) => isNetworkPatternCoveredBy(parentHost, host))) {
      return false;
    }
  }
  if (child.allowReDelegate === true && parent.allowReDelegate !== true) return false;
  return true;
}

function intersectWriteRoots(
  parentRoots: readonly string[],
  requestedRoots: readonly string[],
): string[] {
  const result = new Set<string>();
  for (const parentRoot of parentRoots) {
    for (const requestedRoot of requestedRoots) {
      if (!pathsIntersect(parentRoot, requestedRoot)) continue;
      if (isCoveredBy(parentRoot, new Set([requestedRoot]))) result.add(resolve(parentRoot));
      if (isCoveredBy(requestedRoot, new Set([parentRoot]))) result.add(resolve(requestedRoot));
    }
  }
  return [...result].sort();
}

/**
 * Derive the child sandbox base policy as parent ∩ envelope.
 * Deny lists are always inherited (never narrowed); allow lists only shrink.
 */
export function intersectSandboxPolicy(
  base: SandboxPolicy,
  envelope: DelegationEnvelope,
): SandboxPolicy {
  const allowWrite = intersectWriteRoots(
    normalizeRoots(base.filesystem.allowWrite),
    normalizeRoots(envelope.writeRoots ?? []),
  );
  const allowedDomains =
    base.network.network_access === true
      ? normalizeHosts(envelope.networkHosts ?? [])
      : [
          ...intersectNetworkPatterns(
            normalizeHosts(base.network.allowedDomains),
            normalizeHosts(envelope.networkHosts ?? []),
          ),
        ];
  return {
    filesystem: {
      allowWrite,
      denyRead: [...base.filesystem.denyRead],
      denyWrite: [...base.filesystem.denyWrite],
    },
    network: {
      ...("access" in base.network
        ? {
            access:
              base.network.access?.kind === "explicit"
                ? { kind: "explicit" as const, transport: "proxy" as const }
                : structuredClone(base.network.access),
          }
        : {}),
      network_access: false,
      delegated: true,
      macosTls: "strict",
      ...(base.network.allowPrivateTargets === undefined
        ? {}
        : { allowPrivateTargets: base.network.allowPrivateTargets }),
      // An execution projection belongs to its attempt, not a child baseline.
      allowedDomains,
      deniedDomains: [...base.network.deniedDomains],
      ...(base.network.trustedFakeIpRanges === undefined
        ? {}
        : { trustedFakeIpRanges: [...base.network.trustedFakeIpRanges] }),
      // Finite destination ceilings cannot permit native local socket bypasses.
      allowLocalBinding: false,
    },
  };
}

/**
 * Resolve configured roots against the child cwd. Unlike normalizeRoots
 * (strict absolute, for explicit API envelopes), config roots may be
 * relative and resolve against the turn that mints the child.
 */
export function resolveEnvelopeRoots(roots: readonly string[], cwd: string): string[] {
  const seen = new Set<string>();
  for (const root of roots) {
    if (typeof root !== "string" || root.length === 0) {
      throw new Error("Delegation envelope writeRoots must be non-empty strings");
    }
    seen.add(resolve(cwd, root));
  }
  return [...seen].sort();
}

export interface ResolvedChildEnvelope {
  readonly envelope: DelegationEnvelope;
  /** Effective child sandbox policy: parent policy ∩ envelope. */
  readonly childBasePolicy: SandboxPolicy;
  /** Remaining delegation levels allowed below this child. */
  readonly remainingDepth: number;
  /** Configured entries dropped for falling outside the parent policy. */
  readonly droppedWriteRoots: readonly string[];
  readonly droppedNetworkHosts: readonly string[];
}

/**
 * Mint the effective child envelope from config narrows + parent bound.
 * Empty configured lists inherit the parent base policy (no narrowing).
 * Deny lists are never narrowed — see intersectSandboxPolicy.
 */
export function resolveChildEnvelope(input: {
  configuredWriteRoots: readonly string[];
  configuredNetworkHosts: readonly string[];
  allowReDelegate: boolean;
  parentBase: SandboxPolicy;
  parentRemainingDepth: number;
  childCwd: string;
}): ResolvedChildEnvelope {
  const parentRoots = normalizeRoots(input.parentBase.filesystem.allowWrite);
  const resolvedRoots = resolveEnvelopeRoots(input.configuredWriteRoots, input.childCwd);
  const requestedRoots = normalizeRoots(resolvedRoots);
  const effectiveRequestRoots =
    input.configuredWriteRoots.length === 0 ? parentRoots : requestedRoots;
  const droppedWriteRoots =
    input.configuredWriteRoots.length === 0
      ? []
      : requestedRoots.filter(
          (requestedRoot) =>
            !parentRoots.some((parentRoot) => pathsIntersect(parentRoot, requestedRoot)),
        );
  const parentHosts = normalizeHosts(input.parentBase.network.allowedDomains);
  const configuredHosts = normalizeHosts(input.configuredNetworkHosts);
  const effectiveRequestHosts =
    input.configuredNetworkHosts.length === 0 ? parentHosts : configuredHosts;
  const droppedNetworkHosts =
    input.configuredNetworkHosts.length === 0 || input.parentBase.network.network_access === true
      ? []
      : configuredHosts.filter(
          (configuredHost) => intersectNetworkPatterns(parentHosts, [configuredHost]).length === 0,
        );
  const requestedEnvelope: DelegationEnvelope = {
    writeRoots: effectiveRequestRoots,
    networkHosts: effectiveRequestHosts,
    allowReDelegate: input.allowReDelegate,
  };
  const childBasePolicy = intersectSandboxPolicy(input.parentBase, requestedEnvelope);
  const envelope: DelegationEnvelope = Object.freeze({
    writeRoots: Object.freeze([...childBasePolicy.filesystem.allowWrite]),
    networkHosts: Object.freeze([...childBasePolicy.network.allowedDomains]),
    allowReDelegate: input.allowReDelegate,
  });
  return {
    envelope,
    childBasePolicy,
    remainingDepth: Math.max(0, input.parentRemainingDepth - 1),
    droppedWriteRoots: Object.freeze(droppedWriteRoots),
    droppedNetworkHosts: Object.freeze(droppedNetworkHosts),
  };
}

/** True when an absolute filesystem path is inside the envelope. */
export function isWriteCovered(absolutePath: string, envelope: DelegationEnvelope): boolean {
  return isCoveredBy(absolutePath, new Set(envelope.writeRoots ?? []));
}

/**
 * True when a network host is inside the envelope. Envelope entries use the
 * same SRT domain-pattern grammar as the sandbox policy (exact hosts,
 * `*.example.com` wildcards, `host:port`), so ceiling checks agree with
 * enforcement instead of false-rejecting wildcard envelopes.
 */
export function isNetworkCovered(
  host: string,
  envelope: DelegationEnvelope,
  port?: number,
): boolean {
  return (envelope.networkHosts ?? []).some((entry) =>
    matchesNetworkDomainPattern(entry, host, port),
  );
}

export function createAuditLink(input: {
  parentSessionId: string;
  parentTurnId: string | number;
  childTurnId: string | number;
  envelope: DelegationEnvelope;
}): DelegationAuditLink {
  return Object.freeze({
    parentSessionId: input.parentSessionId,
    parentTurnId: input.parentTurnId,
    childTurnId: input.childTurnId,
    envelope: input.envelope,
  });
}
