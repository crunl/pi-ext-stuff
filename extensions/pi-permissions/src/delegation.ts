import { isAbsolute, resolve, sep } from "node:path";
import { matchesNetworkDomainPattern } from "./approve-for-me-engine.ts";
import type { SandboxPolicy } from "./sandbox.ts";

/**
 * Least-privilege envelope for a delegated subagent turn.
 * Pure data — no I/O, no host knowledge. The parent declares the upper bound;
 * the child may only narrow it.
 *
 * Phase 2 status: register.ts mints a child snapshot whose base policy is
 * parent ∩ envelope and runs the child on an isolated Engine turn.
 * An empty envelope list means "inherit the parent policy" (no narrowing).
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
    if (normalized === root || normalized.startsWith(root + sep)) return true;
  }
  return false;
}

function normalizeHosts(hosts: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const host of hosts) {
    if (typeof host !== "string" || host.trim().length === 0) {
      throw new Error("Delegation envelope networkHosts must be non-empty strings");
    }
    seen.add(host.trim().toLowerCase());
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
  const childHosts = new Set(normalizeHosts(child.networkHosts ?? []));
  const parentHosts = new Set(normalizeHosts(parent.networkHosts ?? []));
  for (const host of childHosts) {
    if (!parentHosts.has(host)) return false;
  }
  if (child.allowReDelegate === true && parent.allowReDelegate !== true) return false;
  return true;
}

/**
 * Derive the child sandbox base policy as parent ∩ envelope.
 * Deny lists are always inherited (never narrowed); allow lists only shrink.
 */
export function intersectSandboxPolicy(
  base: SandboxPolicy,
  envelope: DelegationEnvelope,
): SandboxPolicy {
  const envelopeRoots = new Set(normalizeRoots(envelope.writeRoots ?? []));
  const allowWrite = base.filesystem.allowWrite.filter((entry) =>
    isCoveredBy(entry, envelopeRoots),
  );
  const envelopeHosts = new Set(normalizeHosts(envelope.networkHosts ?? []));
  const allowedDomains = base.network.allowedDomains.filter((entry) =>
    envelopeHosts.has(entry.trim().toLowerCase()),
  );
  return {
    filesystem: {
      allowWrite,
      denyRead: [...base.filesystem.denyRead],
      denyWrite: [...base.filesystem.denyWrite],
    },
    network: {
      allowedDomains,
      deniedDomains: [...base.network.deniedDomains],
      ...(base.network.trustedFakeIpRanges === undefined
        ? {}
        : { trustedFakeIpRanges: [...base.network.trustedFakeIpRanges] }),
      ...(base.network.allowLocalBinding === undefined
        ? {}
        : { allowLocalBinding: base.network.allowLocalBinding }),
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
  parentBase?: SandboxPolicy;
  parentRemainingDepth: number;
  childCwd: string;
}): ResolvedChildEnvelope {
  const parentRoots = new Set(
    (input.parentBase?.filesystem.allowWrite ?? []).map((entry) => resolve(entry)),
  );
  const resolvedRoots = resolveEnvelopeRoots(input.configuredWriteRoots, input.childCwd);
  const keptRoots =
    input.configuredWriteRoots.length === 0
      ? [...parentRoots].sort()
      : resolvedRoots.filter((entry) =>
          parentRoots.size === 0 ? true : isCoveredBy(entry, parentRoots),
        );
  const droppedWriteRoots = resolvedRoots.filter((entry) => !keptRoots.includes(entry));
  const parentHosts = new Set(
    (input.parentBase?.network.allowedDomains ?? []).map((entry) => entry.trim().toLowerCase()),
  );
  const configuredHosts = input.configuredNetworkHosts.map((entry) => entry.trim().toLowerCase());
  const networkHosts =
    configuredHosts.length === 0
      ? [...parentHosts].sort()
      : configuredHosts.filter((entry) => parentHosts.size === 0 || parentHosts.has(entry));
  const droppedNetworkHosts = configuredHosts.filter((entry) => !networkHosts.includes(entry));
  const envelope: DelegationEnvelope = Object.freeze({
    writeRoots: Object.freeze(keptRoots),
    networkHosts: Object.freeze(networkHosts),
    allowReDelegate: input.allowReDelegate,
  });
  return {
    envelope,
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
  for (const entry of envelope.networkHosts ?? []) {
    if (entry.trim().toLowerCase() === host.trim().toLowerCase()) return true;
    if (matchesNetworkDomainPattern(entry, host, port)) return true;
  }
  return false;
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
