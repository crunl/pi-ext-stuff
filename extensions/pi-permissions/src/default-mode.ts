import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import type { PermissionsConfig } from "./config.ts";
import { isPathAllowed } from "./permissions/paths.ts";
import {
  createFilesystemPolicy,
  defaultProtectedWritePaths,
} from "./filesystem-policy.ts";
import {
  classifyRisk,
  isPublicNetworkHost,
  normalizeToolCall,
  shellCommandCanGrantGitMetadata,
  shellCommandUsesGitMutation,
  shellCommandUsesImplicitGitNetwork,
  type Risk,
} from "./permissions/risk.ts";
import { matchRules } from "./permissions/rules.ts";
import { resolveAdditionalWriteRoots } from "./shell-permissions.ts";

export type DefaultDecision =
  | { action: "allow"; risk: Risk; reason: string }
  | {
      action: "prompt";
      risk: Risk;
      reason: string;
      summary: string;
      networkHosts?: string[];
      filesystemWriteRoots?: string[];
      justification?: string;
    }
  | { action: "block"; risk: Risk; reason: string };

function summarize(tool: string, input: Record<string, unknown>): string {
  const limit = (value: string) => value.replace(/[\r\n\t]+/g, " ").slice(0, 500);
  if (typeof input.command === "string") return limit(input.command);
  if (typeof input.path === "string") return limit(input.path);
  if (typeof input.filePath === "string") return limit(input.filePath);
  if (typeof input.url === "string") return limit(input.url);
  if (typeof input.query === "string") return limit(input.query);
  const safeKeys = Object.keys(input).filter((key) => ![
    "content",
    "oldText",
    "newText",
    "patch",
    "data",
  ].includes(key));
  return safeKeys.length > 0 ? `${tool} (${safeKeys.join(", ")})` : tool;
}

function pathOperation(operation: string): "read" | "write" | undefined {
  if (operation === "read") return "read";
  if (operation === "write") return "write";
  return undefined;
}

function remoteHost(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (new Set(["http:", "https:", "ssh:", "git:"]).has(parsed.protocol)) return parsed.hostname;
  } catch {
    // Fall through to Git's SCP-like remote syntax.
  }
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return undefined;
  return /^(?:[^@\s]+@)?([^:/\s]+):.+$/.exec(value)?.[1];
}

type GitMetadataResult =
  | { ok: true; configPath?: string; writeRoots: string[] }
  | { ok: false; reason: string };

function isFilesystemRoot(path: string): boolean {
  return path === parse(path).root;
}

async function repositoryGitMetadata(cwd: string): Promise<GitMetadataResult> {
  let directory = resolve(cwd);
  const root = parse(directory).root;
  while (true) {
    const dotGit = join(directory, ".git");
    try {
      const details = await stat(dotGit);
      if (details.isDirectory()) {
        const gitDirectory = await realpath(dotGit);
        if (isFilesystemRoot(gitDirectory)) {
          return { ok: false, reason: "unsafe Git metadata path" };
        }
        return {
          ok: true,
          configPath: join(gitDirectory, "config"),
          writeRoots: [gitDirectory],
        };
      }
      if (details.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/im.exec(await readFile(dotGit, "utf8"))?.[1]?.trim();
        if (!pointer) {
          return { ok: false, reason: "unsafe Git metadata pointer" };
        }
        try {
          const gitDirectory = await realpath(resolve(directory, pointer));
          if (isFilesystemRoot(gitDirectory) || !(await stat(gitDirectory)).isDirectory()) {
            return { ok: false, reason: "unsafe Git metadata path" };
          }
          const common = (await readFile(join(gitDirectory, "commondir"), "utf8")).trim();
          const commonDirectory = await realpath(resolve(gitDirectory, common));
          if (isFilesystemRoot(commonDirectory) || !(await stat(commonDirectory)).isDirectory()) {
            return { ok: false, reason: "unsafe Git common metadata path" };
          }
          return {
            ok: true,
            configPath: join(commonDirectory, "config"),
            writeRoots: [...new Set([gitDirectory, commonDirectory])],
          };
        } catch {
          try {
            const gitDirectory = await realpath(resolve(directory, pointer));
            if (isFilesystemRoot(gitDirectory) || !(await stat(gitDirectory)).isDirectory()) {
              return { ok: false, reason: "unsafe Git metadata path" };
            }
            return {
              ok: true,
              configPath: join(gitDirectory, "config"),
              writeRoots: [gitDirectory],
            };
          } catch {
            return { ok: false, reason: "unsafe Git metadata path" };
          }
        }
      }
    } catch {
      // Continue with the parent directory.
    }
    if (directory === root) {
      return { ok: true, writeRoots: [resolve(cwd, ".git")] };
    }
    directory = dirname(directory);
  }
}

async function repositoryRemoteHosts(configPath: string | undefined): Promise<string[]> {
  if (!configPath) return [];
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch {
    return [];
  }
  const hosts = new Set<string>();
  let inRemote = false;
  for (const line of contents.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(line)?.[1];
    if (section !== undefined) {
      inRemote = /^remote\s+"/i.test(section);
      continue;
    }
    if (!inRemote) continue;
    const value = /^\s*url\s*=\s*(.+?)\s*$/i.exec(line)?.[1];
    const host = value ? remoteHost(value) : undefined;
    if (host) hosts.add(host.toLowerCase());
  }
  return [...hosts];
}

export async function evaluateDefaultRequest(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  config: PermissionsConfig,
  protectedWritePaths?: readonly string[],
): Promise<DefaultDecision> {
  const request = normalizeToolCall(tool, input, cwd);
  const command = typeof input.command === "string" ? input.command : undefined;
  const usesImplicitGitNetwork = request.operation === "execute"
    && command
    && shellCommandUsesImplicitGitNetwork(command);
  const usesGitMutation = request.operation === "execute"
    && command
    && shellCommandUsesGitMutation(command);
  if (
    usesGitMutation
    && command
    && !shellCommandCanGrantGitMetadata(command)
  ) {
    return {
      action: "block",
      risk: "HARD",
      reason: "Git metadata access requires a single Git mutation command",
    };
  }
  const gitMetadata = usesImplicitGitNetwork || usesGitMutation
    ? await repositoryGitMetadata(cwd)
    : undefined;
  if (gitMetadata && !gitMetadata.ok) {
    return { action: "block", risk: "HARD", reason: gitMetadata.reason };
  }
  if (usesImplicitGitNetwork && gitMetadata?.ok) {
    request.networkTargets = [...new Set([
      ...(request.networkTargets ?? []),
      ...await repositoryRemoteHosts(gitMetadata.configPath),
    ])];
  }
  const gitWriteRoots = usesGitMutation && gitMetadata?.ok
    ? gitMetadata.writeRoots
    : [];
  const additionalWriteRoots = await resolveAdditionalWriteRoots(
    input,
    cwd,
    config,
    protectedWritePaths
      ? [...protectedWritePaths]
      : defaultProtectedWritePaths(cwd),
    gitWriteRoots,
  );
  if (!additionalWriteRoots.ok) {
    return { action: "block", risk: "HARD", reason: additionalWriteRoots.reason };
  }
  const filesystemWriteRoots = [...new Set([
    ...gitWriteRoots,
    ...additionalWriteRoots.writeRoots,
  ])];
  const rule = matchRules(request, config.rules);
  if (rule?.action === "deny") {
    return { action: "block", risk: "HARD", reason: "Denied by permissions rule" };
  }
  if (request.networkTargets?.some((host) => !isPublicNetworkHost(host))) {
    return { action: "block", risk: "HARD", reason: "Private or special-use network target is blocked" };
  }

  let risk = classifyRisk(request);
  if (filesystemWriteRoots.length > 0 && risk === "LOW") risk = "REVIEW";
  const operation = pathOperation(request.operation);
  if (operation) {
    const filesystem = createFilesystemPolicy(
      config.sandbox,
      cwd,
      protectedWritePaths ? [...protectedWritePaths] : undefined,
    );
    for (const path of request.resolvedPaths) {
      const decision = await isPathAllowed(path, {
        cwd,
        allowWrite: filesystem.allowWrite,
        denyRead: filesystem.denyRead,
        denyWrite: filesystem.denyWrite,
        protectedWritePaths: filesystem.protectedWritePaths,
        operation,
      });
      if (decision.allowed) continue;
      if (decision.reason === "write path is outside allowed roots") {
        risk = risk === "HARD" ? "HARD" : "REVIEW";
        continue;
      }
      return { action: "block", risk: "HARD", reason: decision.reason };
    }
  }

  if (rule?.action === "allow" && risk !== "HARD" && filesystemWriteRoots.length === 0) {
    return { action: "allow", risk, reason: "Allowed by permissions rule" };
  }

  if (rule?.action === "ask" || risk !== "LOW") {
    return {
      action: "prompt",
      risk,
      reason: rule?.action === "ask" ? "Approval required by permissions rule" : `${risk} operation`,
      summary: summarize(tool, input),
      networkHosts: request.operation === "execute" && request.networkTargets?.length
        ? [...request.networkTargets]
        : undefined,
      filesystemWriteRoots: filesystemWriteRoots.length > 0
        ? filesystemWriteRoots
        : undefined,
      justification: additionalWriteRoots.justification,
    };
  }

  return { action: "allow", risk, reason: "Low-risk operation" };
}
