import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { isValidNetworkCidr } from "./network-host.ts";
import { isRecord } from "./unknown-value.ts";

export interface PermissionsConfig {
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
      allowedDomains: string[];
      deniedDomains: string[];
      /** CIDRs reserved for a user-managed TUN/fake-IP resolver. */
      trustedFakeIpRanges: string[];
      /** High privilege: SRT may allow local bind/inbound and loopback outbound. */
      allowLocalBinding: boolean;
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

export interface LoadedPermissionsConfig {
  config: PermissionsConfig;
}

export type PermissionsConfigOverlay = {
  version?: 1;
  reviewer?: PermissionsConfig["reviewer"];
  sandbox?: {
    enabled?: boolean;
    profile?: PermissionsConfig["sandbox"]["profile"];
    filesystem?: {
      allowWrite?: string[];
      denyRead?: string[];
      denyWrite?: string[];
    };
    network?: {
      allowedDomains?: string[];
      deniedDomains?: string[];
      trustedFakeIpRanges?: string[];
      allowLocalBinding?: boolean;
    };
  };
  rules?: PermissionsConfig["rules"];
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

export const DEFAULT_CONFIG: PermissionsConfig = {
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
      allowLocalBinding: false,
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

const profiles = new Set<PermissionsConfig["sandbox"]["profile"]>(["workspace-write", "read-only"]);
const efforts = new Set<NonNullable<PermissionsConfig["reviewer"]>["reasoningEffort"]>([
  "minimal",
  "low",
  "medium",
  "high",
]);
const actions = new Set<PermissionsConfig["rules"][number]["action"]>(["allow", "ask", "deny"]);

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ConfigError(`${path} must be a string`);
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ConfigError(`${path} must be a boolean`);
  return value;
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

function cloneConfig(config: PermissionsConfig): PermissionsConfig {
  return structuredClone(config);
}

function parseOverlay(input: unknown): PermissionsConfigOverlay {
  if (!isRecord(input)) throw new ConfigError("config must be an object");
  rejectUnknownKeys(input, ["version", "reviewer", "sandbox", "rules", "delegation"], "");
  const overlay: PermissionsConfigOverlay = {};

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
    if (
      !efforts.has(reasoningEffort as NonNullable<PermissionsConfig["reviewer"]>["reasoningEffort"])
    ) {
      throw new ConfigError("reviewer.reasoningEffort is invalid");
    }
    overlay.reviewer = {
      provider: expectString(reviewer.provider, "reviewer.provider"),
      model: expectString(reviewer.model, "reviewer.model"),
      reasoningEffort: reasoningEffort as NonNullable<
        PermissionsConfig["reviewer"]
      >["reasoningEffort"],
    };
  }
  if ("sandbox" in input && input.sandbox !== undefined) {
    if (!isRecord(input.sandbox)) throw new ConfigError("sandbox must be an object");
    rejectUnknownKeys(input.sandbox, ["enabled", "profile", "filesystem", "network"], "sandbox");
    const sandbox: NonNullable<PermissionsConfigOverlay["sandbox"]> = {};
    if ("enabled" in input.sandbox && input.sandbox.enabled !== undefined)
      sandbox.enabled = expectBoolean(input.sandbox.enabled, "sandbox.enabled");
    if ("profile" in input.sandbox && input.sandbox.profile !== undefined) {
      if (
        typeof input.sandbox.profile !== "string" ||
        !profiles.has(input.sandbox.profile as PermissionsConfig["sandbox"]["profile"])
      ) {
        throw new ConfigError("sandbox.profile is invalid");
      }
      sandbox.profile = input.sandbox.profile as PermissionsConfig["sandbox"]["profile"];
    }
    if ("filesystem" in input.sandbox && input.sandbox.filesystem !== undefined) {
      if (!isRecord(input.sandbox.filesystem))
        throw new ConfigError("sandbox.filesystem must be an object");
      rejectUnknownKeys(
        input.sandbox.filesystem,
        ["allowWrite", "denyRead", "denyWrite"],
        "sandbox.filesystem",
      );
      const filesystem: NonNullable<
        NonNullable<PermissionsConfigOverlay["sandbox"]>["filesystem"]
      > = {};
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
      rejectUnknownKeys(
        input.sandbox.network,
        ["allowedDomains", "deniedDomains", "trustedFakeIpRanges", "allowLocalBinding"],
        "sandbox.network",
      );
      const network: NonNullable<NonNullable<PermissionsConfigOverlay["sandbox"]>["network"]> = {};
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
      if (!actions.has(action as PermissionsConfig["rules"][number]["action"])) {
        throw new ConfigError(`rules[${index}].action is invalid`);
      }
      const parsed = {
        action: action as PermissionsConfig["rules"][number]["action"],
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
    const delegation: NonNullable<PermissionsConfigOverlay["delegation"]> = {};
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

function applyOverlay(
  base: PermissionsConfig,
  overlay: PermissionsConfigOverlay,
): PermissionsConfig {
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
    if (overlay.sandbox.network?.allowedDomains !== undefined)
      config.sandbox.network.allowedDomains = [...overlay.sandbox.network.allowedDomains];
    if (overlay.sandbox.network?.deniedDomains !== undefined)
      config.sandbox.network.deniedDomains = [...overlay.sandbox.network.deniedDomains];
    if (overlay.sandbox.network?.trustedFakeIpRanges !== undefined)
      config.sandbox.network.trustedFakeIpRanges = [...overlay.sandbox.network.trustedFakeIpRanges];
    if (overlay.sandbox.network?.allowLocalBinding !== undefined)
      config.sandbox.network.allowLocalBinding = overlay.sandbox.network.allowLocalBinding;
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
  return config;
}

export function validatePermissionsConfig(input: unknown): PermissionsConfig {
  return applyOverlay(DEFAULT_CONFIG, parseOverlay(input));
}

function mergeGlobalPermissionsConfig(
  base: PermissionsConfig,
  overlay: PermissionsConfigOverlay,
): PermissionsConfig {
  const parsedOverlay = parseOverlay(overlay);
  const merged = applyOverlay(base, { ...parsedOverlay, rules: undefined });
  const baseDenies = base.rules.filter((rule) => rule.action === "deny");
  const baseOtherRules = base.rules.filter((rule) => rule.action !== "deny");
  merged.rules = [...baseDenies, ...baseOtherRules, ...(parsedOverlay.rules ?? [])];
  return merged;
}

async function readConfigFile(path: string): Promise<PermissionsConfigOverlay | undefined> {
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

export async function loadPermissionsConfig(agentDir: string): Promise<LoadedPermissionsConfig> {
  const globalPath = join(agentDir, "extensions", "pi-permissions", "config.json");
  const overlay = await readConfigFile(globalPath);
  return {
    config: overlay
      ? mergeGlobalPermissionsConfig(DEFAULT_CONFIG, overlay)
      : cloneConfig(DEFAULT_CONFIG),
  };
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

export function fingerprintConfig(config: PermissionsConfig): string {
  return fingerprintValue(config);
}
