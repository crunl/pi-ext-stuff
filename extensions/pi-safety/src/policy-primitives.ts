/**
 * Hermetic policy primitives: pure path, network, fingerprint, and error
 * helpers with no filesystem, process, or socket I/O of their own.
 *
 * This module exists so the Engine value-closure stays hermetic: everything
 * here is safe to import from `approve-for-me-engine.ts` without dragging
 * `node:fs`, `node:child_process`, or host packages along. The boundary is
 * pinned by `tests/structure-invariants.test.ts` ("decide-closure purity").
 *
 * Deliberate exception: `validateNetworkPolicy` reaches the pure predicate
 * `networkPatternHasLocalException` in `./network-domain-pattern.ts`, which
 * pulls `node:net` (`isIP`) into the closure. That edge is named and
 * sanctioned in the purity assertion — `node:net` for address predicates is
 * not socket I/O.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { networkPatternHasLocalException } from "./network-domain-pattern.ts";
import { isRecord } from "./unknown-value.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function hasGlobSyntax(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.includes("[") || value.includes("]");
}

export function defaultAgentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);
  return resolve(homedir(), ".pi", "agent");
}

/** Canonical user-config path: agentDir root, decoupled from install layout. */
export function defaultSafetyConfigPath(agentDir = defaultAgentDir()): string {
  return resolve(agentDir, "safety.json");
}

export function isPathWithin(path: string, root: string): boolean {
  const remainder = relative(root, path);
  // `relative` returns an absolute path when the two paths share no root —
  // different Windows drives (`C:\a` vs `D:\b`). That remainder is not a
  // descendant, so it must fail closed rather than read as "inside".
  return (
    remainder === "" ||
    (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`))
  );
}

export type NetworkAccess =
  | { readonly kind: "inline-proxy" }
  | { readonly kind: "explicit"; readonly transport: "proxy" | "direct" };

/** Only supported request paths are accepted; presence never downgrades to legacy. */
export function validateNetworkAccess(input: unknown): NetworkAccess {
  if (isRecord(input)) {
    const keys = Object.keys(input);
    if (input.kind === "inline-proxy" && keys.length === 1 && keys[0] === "kind") {
      return { kind: "inline-proxy" };
    }
    if (
      input.kind === "explicit" &&
      (input.transport === "proxy" || input.transport === "direct") &&
      keys.length === 2 &&
      keys.includes("kind") &&
      keys.includes("transport")
    ) {
      return { kind: "explicit", transport: input.transport };
    }
  }
  throw new ConfigError(
    "sandbox.network.access must be inline-proxy or explicit with transport proxy or direct",
  );
}

/** Codex `network_access` analogue: whole TCP network including private/loopback/bind. */
export type EffectiveNetworkAuthority = {
  wholeNetwork: boolean;
  privateTargets: boolean;
  localBinding: boolean;
};

/**
 * Derive effective network authority. Explicit false on a fine axis wins over
 * `network_access`; undefined falls back to `network_access`. Never materialize
 * back into the policy fields (fingerprint, delegation, status views).
 */
export function effectiveNetworkAuthority(network: {
  network_access?: boolean;
  allowPrivateTargets?: boolean;
  allowLocalBinding?: boolean;
}): EffectiveNetworkAuthority {
  const wholeNetwork = network.network_access === true;
  return {
    wholeNetwork,
    privateTargets: network.allowPrivateTargets ?? wholeNetwork,
    localBinding: network.allowLocalBinding ?? wholeNetwork,
  };
}

/** Shared structural eligibility for configuration, Engine plans and backend mapping. */
export function validateNetworkPolicy(network: {
  access?: NetworkAccess;
  network_access?: boolean;
  allowPrivateTargets?: boolean;
  macosTls?: "strict" | "system";
  allowLocalBinding?: boolean;
  allowedDomains: readonly string[];
  deniedDomains: readonly string[];
  delegated?: true;
}): void {
  const authority = effectiveNetworkAuthority(network);
  const direct = network.access?.kind === "explicit" && network.access.transport === "direct";
  if (direct) {
    if (!authority.privateTargets && !authority.localBinding)
      throw new ConfigError(
        "Direct requires unrestricted private/special outbound eligibility (network_access or allowPrivateTargets)",
      );
    if (network.allowedDomains.length || network.deniedDomains.length || network.delegated)
      throw new ConfigError("Direct cannot enforce domain constraints or delegation");
    if (network.macosTls === "system") throw new ConfigError("Direct/system TLS is unsupported");
  }
  if (network.access?.kind === "explicit" && authority.localBinding && !authority.wholeNetwork) {
    throw new ConfigError(
      "sandbox.network.allowLocalBinding is incompatible with grant-dependent explicit access",
    );
  }
  if (network.macosTls === "system") {
    if (process.platform !== "darwin") throw new ConfigError("System TLS requires macOS");
    const localException = network.allowedDomains.some(networkPatternHasLocalException);
    if (
      network.deniedDomains.length ||
      network.delegated ||
      authority.localBinding ||
      localException
    ) {
      throw new ConfigError(
        "System TLS helper egress conflicts with destination denies, delegated confinement or native local exceptions",
      );
    }
  }
}

/** JSON-compatible value: the domain stableValue normalizes into for hashing. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function stableValue(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  // Non-container leaves pass through; JSON.stringify drops what JSON cannot
  // represent (undefined/functions) exactly as it did before typing.
  return value as JsonValue;
}

export function fingerprintValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}
