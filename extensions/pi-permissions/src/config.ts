import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Keys that existed before modes collapsed to auto|yolo and human prompts were
 * removed. They are still accepted (and ignored) so old config.json files keep
 * loading instead of failing validation.
 */
const legacyIgnoredKeys = ["defaultMode", "approvalMode", "granularApproval"] as const;

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
    network: { allowedDomains: string[]; deniedDomains: string[] };
  };
  rules: Array<{ action: "allow" | "ask" | "deny"; tool: string; pattern?: string }>;
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
    };
  };
  rules?: PermissionsConfig["rules"];
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
      denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", ".env", ".env.*", "*.pem", "*.key"],
      denyWrite: [".env", ".env.*", "*.pem", "*.key"],
    },
    network: {
      allowedDomains: [],
      deniedDomains: ["localhost", "127.0.0.1", "::1", "169.254.169.254"],
    },
  },
  rules: [],
};

const profiles = new Set<PermissionsConfig["sandbox"]["profile"]>(["workspace-write", "read-only"]);
const efforts = new Set<NonNullable<PermissionsConfig["reviewer"]>["reasoningEffort"]>([
  "minimal",
  "low",
  "medium",
  "high",
]);
const actions = new Set<PermissionsConfig["rules"][number]["action"]>(["allow", "ask", "deny"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  rejectUnknownKeys(input, [...legacyIgnoredKeys, "version", "reviewer", "sandbox", "rules"], "");
  const overlay: PermissionsConfigOverlay = {};

  if ("version" in input && input.version !== undefined) {
    if (input.version !== 1) throw new ConfigError("version must be 1");
    overlay.version = 1;
  }
  // legacyIgnoredKeys are silently skipped here.
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
        ["allowedDomains", "deniedDomains"],
        "sandbox.network",
      );
      const network: NonNullable<NonNullable<PermissionsConfigOverlay["sandbox"]>["network"]> = {};
      if (
        "allowedDomains" in input.sandbox.network &&
        input.sandbox.network.allowedDomains !== undefined
      )
        network.allowedDomains = expectStrings(
          input.sandbox.network.allowedDomains,
          "sandbox.network.allowedDomains",
        );
      if (
        "deniedDomains" in input.sandbox.network &&
        input.sandbox.network.deniedDomains !== undefined
      )
        network.deniedDomains = expectStrings(
          input.sandbox.network.deniedDomains,
          "sandbox.network.deniedDomains",
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
  }
  if (overlay.rules !== undefined) config.rules = structuredClone(overlay.rules);
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

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function fingerprintValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

export function fingerprintConfig(config: PermissionsConfig): string {
  return fingerprintValue(config);
}
