import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PermissionsConfig } from "./config.ts";

export interface ResolvedFilesystemPolicy {
  allowWrite: string[];
  denyRead: string[];
  denyWrite: string[];
  protectedWritePaths: string[];
}

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

export function defaultProtectedWritePaths(
  cwd: string,
  agentDir = resolve(homedir(), ".pi", "agent"),
): string[] {
  return [
    resolve(cwd, ".git"),
    resolve(cwd, ".agents"),
    resolve(cwd, ".codex"),
    resolve(agentDir, "extensions", "pi-permissions", "config.json"),
  ];
}

export function createFilesystemPolicy(
  config: PermissionsConfig["sandbox"],
  cwd: string,
  protectedWritePaths = defaultProtectedWritePaths(cwd),
): ResolvedFilesystemPolicy {
  return {
    allowWrite:
      config.profile === "read-only"
        ? []
        : config.filesystem.allowWrite.map((path) => resolvePolicyPath(path, cwd)),
    denyRead: [...config.filesystem.denyRead],
    denyWrite: [...config.filesystem.denyWrite, ...protectedWritePaths],
    protectedWritePaths: [...protectedWritePaths],
  };
}
