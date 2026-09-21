import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { defaultSafetyConfigPath, hasGlobSyntax } from "./filesystem-policy.ts";
import { networkPatternHasLocalException } from "./network-domain-pattern.ts";
import { isValidNetworkCidr } from "./network-host.ts";
import { isRecord } from "./unknown-value.ts";

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

export interface SafetyConfig {
  version: 1;
  reviewer?: {
    provider: string;
    model: string;
    reasoningEffort: "minimal" | "low" | "medium" | "high";
  };
  sandbox: {
    enabled: boolean;
    profile: "workspace-write" | "read-only";
    filesystem: {
      allowWrite: string[];
      denyRead: string[];
      denyWrite: string[];
    };
    network: {
      /**
       * @deprecated No OS network.mode on pristine SRT. Ledger/status only;
       * Engine lease (`network_access` / allowedDomains) is the authority.
       */
      access?: NetworkAccess;
      /** Engine lease: whole-TCP authorized for owned spawn/connection cover. Not OS open. */
      network_access?: boolean;
      allowPrivateTargets?: boolean;
      /** @deprecated system TLS no longer pairs with wrap-level network modes. */
      macosTls?: "strict" | "system";
      allowedDomains: string[];
      deniedDomains: string[];
      /** CIDRs reserved for a user-managed TUN/fake-IP resolver. */
      trustedFakeIpRanges: string[];
      /** High privilege: SRT may allow local bind/inbound and loopback outbound. */
      allowLocalBinding?: boolean;
      /**
       * Absolute unix-socket path allowlist projected to SRT
       * `network.allowUnixSockets` (macOS seatbelt). Default/empty = omit =
       * SRT blocks AF_UNIX. Orthogonal to Engine `network_access` (TCP lease).
       * Codex analogue: `features.network_proxy.unix_sockets` allow entries.
       * docker.sock etc. ≈ host privilege — opt-in only.
       */
      allowUnixSockets?: string[];
      /**
       * Projected to SRT `network.allowAllUnixSockets`. Codex analogue:
       * `dangerously_allow_all_unix_sockets` (default false). High privilege.
       */
      dangerouslyAllowAllUnixSockets?: boolean;
    };
  };
  rules: Array<{ action: "allow" | "ask" | "deny"; tool: string; pattern?: string }>;
  delegation: {
    /** Master switch for nested-turn envelope enforcement. Empty roots inherit. */
    enabled: boolean;
    /** Max nested subagent levels below the outer turn (0 = leaf-only outer). */
    maxDepth: number;
    /** Whether a delegated child may itself spawn subagents. */
    allowReDelegate: boolean;
    /** Narrowed write roots for children; [] inherits the parent policy. */
    writeRoots: string[];
    /** Narrowed network hosts for children; [] inherits the parent policy. */
    networkHosts: string[];
  };
}

export type SafetyConfigSource = "new" | "default";

export interface LoadedSafetyConfig {
  config: SafetyConfig;
  /** Which config file was loaded; paths are not part of the fingerprint. */
  source: SafetyConfigSource;
  /** Absolute path of the loaded file, or undefined when using DEFAULT_CONFIG. */
  sourcePath?: string;
}

export type SafetyConfigOverlay = {
  version?: 1;
  reviewer?: SafetyConfig["reviewer"];
  sandbox?: {
    enabled?: boolean;
    profile?: SafetyConfig["sandbox"]["profile"];
    filesystem?: {
      allowWrite?: string[];
      denyRead?: string[];
      denyWrite?: string[];
    };
    network?: {
      access?: NetworkAccess;
      network_access?: boolean;
      allowPrivateTargets?: boolean;
      macosTls?: "strict" | "system";
      allowedDomains?: string[];
      deniedDomains?: string[];
      trustedFakeIpRanges?: string[];
      allowLocalBinding?: boolean;
      allowUnixSockets?: string[];
      dangerouslyAllowAllUnixSockets?: boolean;
    };
  };
  rules?: SafetyConfig["rules"];
  delegation?: {
    enabled?: boolean;
    maxDepth?: number;
    allowReDelegate?: boolean;
    writeRoots?: string[];
    networkHosts?: string[];
  };
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const DEFAULT_CONFIG: SafetyConfig = {
  version: 1,
  sandbox: {
    enabled: true,
    profile: "workspace-write",
    filesystem: {
      allowWrite: [".", "/tmp"],
      // Match Codex workspace-write: extra sensitive-file carve-outs are opt-in.
      denyRead: [],
      denyWrite: [],
    },
    network: {
      allowedDomains: [],
      // The network boundary rejects private/special targets by default. Keep
      // this list empty so an explicit exact local allow can model Codex's
      // narrow exception without being shadowed by a built-in deny rule.
      deniedDomains: [],
      trustedFakeIpRanges: [],
      // allowLocalBinding stays absent so network_access can expand bind/inbound.
    },
  },
  rules: [],
  delegation: {
    enabled: true,
    maxDepth: 8,
    allowReDelegate: true,
    writeRoots: [],
    networkHosts: [],
  },
};

const profiles = new Set<SafetyConfig["sandbox"]["profile"]>(["workspace-write", "read-only"]);
const efforts = new Set<NonNullable<SafetyConfig["reviewer"]>["reasoningEffort"]>([
  "minimal",
  "low",
  "medium",
  "high",
]);
const actions = new Set<SafetyConfig["rules"][number]["action"]>(["allow", "ask", "deny"]);

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ConfigError(`${path} must be a string`);
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ConfigError(`${path} must be a boolean`);
  return value;
}

function expectAbsoluteUnixSocketPaths(value: unknown, path: string): string[] {
  return expectStrings(value, path).map((entry, index) => {
    if (!entry.startsWith("/")) {
      throw new ConfigError(`${path}[${index}] must be an absolute unix socket path`);
    }
    if (hasGlobSyntax(entry)) {
      throw new ConfigError(`${path}[${index}] must not contain glob syntax`);
    }
    // macOS SRT matches allowlist entries as seatbelt subpaths: "/" or any
    // directory prefix would silently grant every AF_UNIX path under it.
    const basename = entry.slice(entry.lastIndexOf("/") + 1);
    if (
      entry === "/" ||
      entry.endsWith("/") ||
      basename.length === 0 ||
      basename === "." ||
      basename === ".."
    ) {
      throw new ConfigError(
        `${path}[${index}] must be an exact socket file path, not "/" or a directory ` +
          `(macOS SRT subpath match would widen the allowlist)`,
      );
    }
    return entry;
  });
}

function expectStrings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new ConfigError(`${path} must be an array of strings`);
  return value.map((entry, index) => expectString(entry, `${path}[${index}]`));
}

function expectNetworkCidrs(value: unknown, path: string): string[] {
  return expectStrings(value, path).map((entry, index) => {
    if (!isValidNetworkCidr(entry)) {
      throw new ConfigError(`${path}[${index}] must be a valid CIDR range`);
    }
    return entry;
  });
}

function validDomainPortSuffix(value: string): boolean {
  return /^:[1-9][0-9]{0,4}$/.test(value) && Number(value.slice(1)) <= 65535;
}

/** Match SRT's domain-port grammar before activation, so malformed entries fail at load. */
function isValidNetworkDomainPattern(value: string, allowDenyAll: boolean): boolean {
  if (value.length === 0 || value.trim() !== value || /\s/.test(value)) return false;
  let host = value;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0 || isIP(value.slice(1, close)) !== 6) return false;
    host = value.slice(1, close);
    const suffix = value.slice(close + 1);
    return suffix === "" || validDomainPortSuffix(suffix);
  }
  const firstColon = value.indexOf(":");
  if (firstColon >= 0) {
    if (value.indexOf(":", firstColon + 1) >= 0) return false;
    host = value.slice(0, firstColon);
    if (!validDomainPortSuffix(value.slice(firstColon))) return false;
  }
  if (host === "*") return allowDenyAll;
  if (host.includes("://") || host.includes("/") || host.includes(":")) return false;
  if (isIP(host) === 4 || host === "localhost") return true;
  if (host.startsWith("*.")) {
    const domain = host.slice(2);
    const parts = domain.split(".");
    return (
      parts.length >= 2 &&
      domain.length > 0 &&
      !domain.startsWith(".") &&
      !domain.endsWith(".") &&
      parts.every((part) => part.length > 0) &&
      !domain.includes("*")
    );
  }
  return host.includes(".") && !host.startsWith(".") && !host.endsWith(".") && !host.includes("*");
}

function expectNetworkDomainPatterns(
  value: unknown,
  path: string,
  allowDenyAll: boolean,
): string[] {
  return expectStrings(value, path).map((entry, index) => {
    if (!isValidNetworkDomainPattern(entry, allowDenyAll)) {
      throw new ConfigError(`${path}[${index}] must be a valid SRT domain pattern`);
    }
    return entry;
  });
}

function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`${path}${path ? "." : ""}${key} is not allowed`);
    }
  }
}

function cloneConfig(config: SafetyConfig): SafetyConfig {
  return structuredClone(config);
}

function parseOverlay(input: unknown): SafetyConfigOverlay {
  if (!isRecord(input)) throw new ConfigError("config must be an object");
  rejectUnknownKeys(input, ["version", "reviewer", "sandbox", "rules", "delegation"], "");
  const overlay: SafetyConfigOverlay = {};

  if ("version" in input && input.version !== undefined) {
    if (input.version !== 1) throw new ConfigError("version must be 1");
    overlay.version = 1;
  }
  if ("reviewer" in input && input.reviewer !== undefined) {
    if (!isRecord(input.reviewer)) throw new ConfigError("reviewer must be an object");
    const reviewer = input.reviewer;
    const removedReviewerPolicyKeys = [
      "timeoutMs",
      "maxAttempts",
      "maxConsecutiveDenials",
    ] as const;
    const removedKey = removedReviewerPolicyKeys.find((key) => key in reviewer);
    if (removedKey) {
      throw new ConfigError(
        `reviewer.${removedKey} is fixed by the Auto-review policy; remove it from config`,
      );
    }
    rejectUnknownKeys(reviewer, ["provider", "model", "reasoningEffort"], "reviewer");
    const reasoningEffort = expectString(reviewer.reasoningEffort, "reviewer.reasoningEffort");
    if (!efforts.has(reasoningEffort as NonNullable<SafetyConfig["reviewer"]>["reasoningEffort"])) {
      throw new ConfigError("reviewer.reasoningEffort is invalid");
    }
    overlay.reviewer = {
      provider: expectString(reviewer.provider, "reviewer.provider"),
      model: expectString(reviewer.model, "reviewer.model"),
      reasoningEffort: reasoningEffort as NonNullable<SafetyConfig["reviewer"]>["reasoningEffort"],
    };
  }
  if ("sandbox" in input && input.sandbox !== undefined) {
    if (!isRecord(input.sandbox)) throw new ConfigError("sandbox must be an object");
    rejectUnknownKeys(input.sandbox, ["enabled", "profile", "filesystem", "network"], "sandbox");
    const sandbox: NonNullable<SafetyConfigOverlay["sandbox"]> = {};
    if ("enabled" in input.sandbox && input.sandbox.enabled !== undefined)
      sandbox.enabled = expectBoolean(input.sandbox.enabled, "sandbox.enabled");
    if ("profile" in input.sandbox && input.sandbox.profile !== undefined) {
      if (
        typeof input.sandbox.profile !== "string" ||
        !profiles.has(input.sandbox.profile as SafetyConfig["sandbox"]["profile"])
      ) {
        throw new ConfigError("sandbox.profile is invalid");
      }
      sandbox.profile = input.sandbox.profile as SafetyConfig["sandbox"]["profile"];
    }
    if ("filesystem" in input.sandbox && input.sandbox.filesystem !== undefined) {
      if (!isRecord(input.sandbox.filesystem))
        throw new ConfigError("sandbox.filesystem must be an object");
      rejectUnknownKeys(
        input.sandbox.filesystem,
        ["allowWrite", "denyRead", "denyWrite"],
        "sandbox.filesystem",
      );
      const filesystem: NonNullable<NonNullable<SafetyConfigOverlay["sandbox"]>["filesystem"]> = {};
      if (
        "allowWrite" in input.sandbox.filesystem &&
        input.sandbox.filesystem.allowWrite !== undefined
      )
        filesystem.allowWrite = expectStrings(
          input.sandbox.filesystem.allowWrite,
          "sandbox.filesystem.allowWrite",
        );
      if ("denyRead" in input.sandbox.filesystem && input.sandbox.filesystem.denyRead !== undefined)
        filesystem.denyRead = expectStrings(
          input.sandbox.filesystem.denyRead,
          "sandbox.filesystem.denyRead",
        );
      if (
        "denyWrite" in input.sandbox.filesystem &&
        input.sandbox.filesystem.denyWrite !== undefined
      )
        filesystem.denyWrite = expectStrings(
          input.sandbox.filesystem.denyWrite,
          "sandbox.filesystem.denyWrite",
        );
      sandbox.filesystem = filesystem;
    }
    if ("network" in input.sandbox && input.sandbox.network !== undefined) {
      if (!isRecord(input.sandbox.network))
        throw new ConfigError("sandbox.network must be an object");
      if ("enabled" in input.sandbox.network) {
        throw new ConfigError(
          "sandbox.network.enabled was removed; use sandbox.network.network_access. " +
            "network_access:true now also opens private/loopback/bind (Codex Enabled), not public-only.",
        );
      }
      rejectUnknownKeys(
        input.sandbox.network,
        [
          "access",
          "network_access",
          "allowPrivateTargets",
          "macosTls",
          "allowedDomains",
          "deniedDomains",
          "trustedFakeIpRanges",
          "allowLocalBinding",
          "allowUnixSockets",
          "dangerouslyAllowAllUnixSockets",
        ],
        "sandbox.network",
      );
      const network: NonNullable<NonNullable<SafetyConfigOverlay["sandbox"]>["network"]> = {};
      for (const key of [
        "network_access",
        "allowPrivateTargets",
        "dangerouslyAllowAllUnixSockets",
      ] as const) {
        if (key in input.sandbox.network)
          network[key] = expectBoolean(input.sandbox.network[key], `sandbox.network.${key}`);
      }
      if ("macosTls" in input.sandbox.network) {
        const tls = input.sandbox.network.macosTls;
        if (tls !== "strict" && tls !== "system")
          throw new ConfigError("sandbox.network.macosTls must be strict or system");
        network.macosTls = tls;
      }
      if ("access" in input.sandbox.network) {
        network.access = validateNetworkAccess(input.sandbox.network.access);
      }
      if (
        "allowedDomains" in input.sandbox.network &&
        input.sandbox.network.allowedDomains !== undefined
      )
        network.allowedDomains = expectNetworkDomainPatterns(
          input.sandbox.network.allowedDomains,
          "sandbox.network.allowedDomains",
          false,
        );
      if (
        "deniedDomains" in input.sandbox.network &&
        input.sandbox.network.deniedDomains !== undefined
      )
        network.deniedDomains = expectNetworkDomainPatterns(
          input.sandbox.network.deniedDomains,
          "sandbox.network.deniedDomains",
          true,
        );
      if (
        "trustedFakeIpRanges" in input.sandbox.network &&
        input.sandbox.network.trustedFakeIpRanges !== undefined
      )
        network.trustedFakeIpRanges = expectNetworkCidrs(
          input.sandbox.network.trustedFakeIpRanges,
          "sandbox.network.trustedFakeIpRanges",
        );
      if (
        "allowLocalBinding" in input.sandbox.network &&
        input.sandbox.network.allowLocalBinding !== undefined
      )
        network.allowLocalBinding = expectBoolean(
          input.sandbox.network.allowLocalBinding,
          "sandbox.network.allowLocalBinding",
        );
      if (
        "allowUnixSockets" in input.sandbox.network &&
        input.sandbox.network.allowUnixSockets !== undefined
      )
        network.allowUnixSockets = expectAbsoluteUnixSocketPaths(
          input.sandbox.network.allowUnixSockets,
          "sandbox.network.allowUnixSockets",
        );
      sandbox.network = network;
    }
    overlay.sandbox = sandbox;
  }
  if ("rules" in input && input.rules !== undefined) {
    if (!Array.isArray(input.rules)) throw new ConfigError("rules must be an array");
    overlay.rules = input.rules.map((rule, index) => {
      if (!isRecord(rule)) throw new ConfigError(`rules[${index}] must be an object`);
      rejectUnknownKeys(rule, ["action", "tool", "pattern"], `rules[${index}]`);
      const action = expectString(rule.action, `rules[${index}].action`);
      if (!actions.has(action as SafetyConfig["rules"][number]["action"])) {
        throw new ConfigError(`rules[${index}].action is invalid`);
      }
      const parsed = {
        action: action as SafetyConfig["rules"][number]["action"],
        tool: expectString(rule.tool, `rules[${index}].tool`),
      };
      return "pattern" in rule
        ? { ...parsed, pattern: expectString(rule.pattern, `rules[${index}].pattern`) }
        : parsed;
    });
  }
  if ("delegation" in input && input.delegation !== undefined) {
    if (!isRecord(input.delegation)) throw new ConfigError("delegation must be an object");
    rejectUnknownKeys(
      input.delegation,
      ["enabled", "maxDepth", "allowReDelegate", "writeRoots", "networkHosts"],
      "delegation",
    );
    const delegation: NonNullable<SafetyConfigOverlay["delegation"]> = {};
    if ("enabled" in input.delegation && input.delegation.enabled !== undefined)
      delegation.enabled = expectBoolean(input.delegation.enabled, "delegation.enabled");
    if ("maxDepth" in input.delegation && input.delegation.maxDepth !== undefined) {
      const maxDepth: unknown = input.delegation.maxDepth;
      if (
        typeof maxDepth !== "number" ||
        !Number.isInteger(maxDepth) ||
        maxDepth < 0 ||
        maxDepth > 31
      ) {
        throw new ConfigError("delegation.maxDepth must be an integer between 0 and 31");
      }
      delegation.maxDepth = maxDepth;
    }
    if ("allowReDelegate" in input.delegation && input.delegation.allowReDelegate !== undefined)
      delegation.allowReDelegate = expectBoolean(
        input.delegation.allowReDelegate,
        "delegation.allowReDelegate",
      );
    if ("writeRoots" in input.delegation && input.delegation.writeRoots !== undefined)
      delegation.writeRoots = expectStrings(input.delegation.writeRoots, "delegation.writeRoots");
    if ("networkHosts" in input.delegation && input.delegation.networkHosts !== undefined)
      delegation.networkHosts = expectNetworkDomainPatterns(
        input.delegation.networkHosts,
        "delegation.networkHosts",
        false,
      );
    overlay.delegation = delegation;
  }
  return overlay;
}

function applyOverlay(base: SafetyConfig, overlay: SafetyConfigOverlay): SafetyConfig {
  const config = cloneConfig(base);
  if (overlay.version !== undefined) config.version = overlay.version;
  if (overlay.reviewer !== undefined) config.reviewer = structuredClone(overlay.reviewer);
  if (overlay.sandbox !== undefined) {
    if (overlay.sandbox.enabled !== undefined) config.sandbox.enabled = overlay.sandbox.enabled;
    if (overlay.sandbox.profile !== undefined) config.sandbox.profile = overlay.sandbox.profile;
    if (overlay.sandbox.filesystem?.allowWrite !== undefined)
      config.sandbox.filesystem.allowWrite = [...overlay.sandbox.filesystem.allowWrite];
    if (overlay.sandbox.filesystem?.denyRead !== undefined)
      config.sandbox.filesystem.denyRead = [...overlay.sandbox.filesystem.denyRead];
    if (overlay.sandbox.filesystem?.denyWrite !== undefined)
      config.sandbox.filesystem.denyWrite = [...overlay.sandbox.filesystem.denyWrite];
    for (const key of ["network_access", "allowPrivateTargets", "macosTls"] as const) {
      const value = overlay.sandbox.network?.[key];
      if (value !== undefined) Object.assign(config.sandbox.network, { [key]: value });
    }
    if (overlay.sandbox.network && "access" in overlay.sandbox.network)
      config.sandbox.network.access = validateNetworkAccess(overlay.sandbox.network.access);
    if (overlay.sandbox.network?.allowedDomains !== undefined)
      config.sandbox.network.allowedDomains = [...overlay.sandbox.network.allowedDomains];
    if (overlay.sandbox.network?.deniedDomains !== undefined)
      config.sandbox.network.deniedDomains = [...overlay.sandbox.network.deniedDomains];
    if (overlay.sandbox.network?.trustedFakeIpRanges !== undefined)
      config.sandbox.network.trustedFakeIpRanges = [...overlay.sandbox.network.trustedFakeIpRanges];
    if (overlay.sandbox.network?.allowLocalBinding !== undefined)
      config.sandbox.network.allowLocalBinding = overlay.sandbox.network.allowLocalBinding;
    if (overlay.sandbox.network?.allowUnixSockets !== undefined)
      config.sandbox.network.allowUnixSockets = [...overlay.sandbox.network.allowUnixSockets];
    if (overlay.sandbox.network?.dangerouslyAllowAllUnixSockets !== undefined)
      config.sandbox.network.dangerouslyAllowAllUnixSockets =
        overlay.sandbox.network.dangerouslyAllowAllUnixSockets;
  }
  if (overlay.rules !== undefined) config.rules = structuredClone(overlay.rules);
  if (overlay.delegation !== undefined) {
    if (overlay.delegation.enabled !== undefined)
      config.delegation.enabled = overlay.delegation.enabled;
    if (overlay.delegation.maxDepth !== undefined)
      config.delegation.maxDepth = overlay.delegation.maxDepth;
    if (overlay.delegation.allowReDelegate !== undefined)
      config.delegation.allowReDelegate = overlay.delegation.allowReDelegate;
    if (overlay.delegation.writeRoots !== undefined)
      config.delegation.writeRoots = [...overlay.delegation.writeRoots];
    if (overlay.delegation.networkHosts !== undefined)
      config.delegation.networkHosts = [...overlay.delegation.networkHosts];
  }
  validateNetworkPolicy(config.sandbox.network);
  return config;
}

export function validateSafetyConfig(input: unknown): SafetyConfig {
  return applyOverlay(DEFAULT_CONFIG, parseOverlay(input));
}

function mergeGlobalSafetyConfig(base: SafetyConfig, overlay: SafetyConfigOverlay): SafetyConfig {
  const parsedOverlay = parseOverlay(overlay);
  const merged = applyOverlay(base, { ...parsedOverlay, rules: undefined });
  const baseDenies = base.rules.filter((rule) => rule.action === "deny");
  const baseOtherRules = base.rules.filter((rule) => rule.action !== "deny");
  merged.rules = [...baseDenies, ...baseOtherRules, ...(parsedOverlay.rules ?? [])];
  return merged;
}

async function readConfigFile(path: string): Promise<SafetyConfigOverlay | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return parseOverlay(JSON.parse(contents));
  } catch (error: unknown) {
    if (error instanceof ConfigError) throw new ConfigError(`${path}: ${error.message}`);
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new ConfigError(`${path}: ${message}`);
  }
}

export async function loadSafetyConfig(agentDir: string): Promise<LoadedSafetyConfig> {
  const path = defaultSafetyConfigPath(agentDir);
  const overlay = await readConfigFile(path);
  if (overlay) {
    return {
      config: mergeGlobalSafetyConfig(DEFAULT_CONFIG, overlay),
      source: "new",
      sourcePath: path,
    };
  }
  return { config: cloneConfig(DEFAULT_CONFIG), source: "default" };
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

export function fingerprintConfig(config: SafetyConfig): string {
  return fingerprintValue(config);
}
