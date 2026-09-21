import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SafetyConfig } from "./config.ts";

export interface ResolvedFilesystemPolicy {
  allowWrite: string[];
  denyRead: string[];
  denyWrite: string[];
  protectedWritePaths: string[];
}

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// macOS aliases that sandbox-exec resolves to their real paths. A profile rule
// like (subpath "/tmp") does not match /private/tmp/... because the kernel
// operates on the resolved path, so allow/deny rules must cover both spellings.
const SYMLINK_ALIASES: Array<[string, string]> = [
  ["/private/tmp", "/tmp"],
  ["/private/var", "/var"],
];

export function expandSymlinkAliases(path: string): string[] {
  for (const [real, alias] of SYMLINK_ALIASES) {
    if (path === real || path === alias) return [path, path === real ? alias : real];
    if (path.startsWith(`${real}/`)) {
      return [path, `${alias}${path.slice(real.length)}`];
    }
    if (path.startsWith(`${alias}/`)) {
      return [path, `${real}${path.slice(alias.length)}`];
    }
  }
  return [path];
}

export function resolvePolicyPath(path: string, cwd: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function resolveSandboxDenyPattern(pattern: string, cwd: string): string {
  if (pattern === "~" || pattern.startsWith("~/") || isAbsolute(pattern)) {
    return resolvePolicyPath(pattern, cwd);
  }
  return resolve(cwd, pattern.includes("/") ? pattern : `**/${pattern}`);
}

export function hasGlobSyntax(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.includes("[") || value.includes("]");
}

function defaultAgentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);
  return resolve(homedir(), ".pi", "agent");
}

/** Canonical user-config path: agentDir root, decoupled from install layout. */
export function defaultSafetyConfigPath(agentDir = defaultAgentDir()): string {
  return resolve(agentDir, "safety.json");
}

export function defaultProtectedWritePaths(cwd: string, agentDir = defaultAgentDir()): string[] {
  return [
    resolve(cwd, ".git"),
    resolve(cwd, ".agents"),
    resolve(cwd, ".codex"),
    defaultSafetyConfigPath(agentDir),
  ];
}

export function createFilesystemPolicy(
  config: SafetyConfig["sandbox"],
  cwd: string,
  protectedWritePaths = defaultProtectedWritePaths(cwd),
): ResolvedFilesystemPolicy {
  return {
    allowWrite:
      config.profile === "read-only"
        ? []
        : config.filesystem.allowWrite.flatMap((path) =>
            expandSymlinkAliases(resolvePolicyPath(path, cwd)),
          ),
    denyRead: [...config.filesystem.denyRead],
    denyWrite: [...config.filesystem.denyWrite, ...protectedWritePaths],
    protectedWritePaths: [...protectedWritePaths],
  };
}
