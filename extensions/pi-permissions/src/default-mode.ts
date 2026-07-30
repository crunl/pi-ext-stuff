import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { PermissionsConfig } from "./config.ts";
import { createFilesystemPolicy, defaultProtectedWritePaths } from "./filesystem-policy.ts";
import {
  inspectCurrentDirectoryGitMetadata,
  inspectRepositoryGitMetadata,
  readRepositoryRemoteHosts,
} from "./git-metadata.ts";
import { isPathAllowed } from "./permissions/paths.ts";
import {
  classifyRisk,
  isPublicNetworkHost,
  normalizeToolCall,
  type Risk,
  shellCommandCanGrantGitMetadata,
  shellCommandInitializesCurrentDirectory,
  shellCommandUsesGitMutation,
  shellCommandUsesImplicitGitNetwork,
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
  const safeKeys = Object.keys(input).filter(
    (key) => !["content", "oldText", "newText", "patch", "data"].includes(key),
  );
  return safeKeys.length > 0 ? `${tool} (${safeKeys.join(", ")})` : tool;
}

function pathOperation(operation: string): "read" | "write" | undefined {
  if (operation === "read") return "read";
  if (operation === "write") return "write";
  return undefined;
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
  const usesImplicitGitNetwork =
    request.operation === "execute" && command && shellCommandUsesImplicitGitNetwork(command);
  const usesGitMutation =
    request.operation === "execute" && command && shellCommandUsesGitMutation(command);
  const initializesCurrentDirectory =
    usesGitMutation && command && shellCommandInitializesCurrentDirectory(command);
  if (usesGitMutation && command && !shellCommandCanGrantGitMetadata(command)) {
    return {
      action: "block",
      risk: "HARD",
      reason: "Git metadata access requires a single Git mutation command",
    };
  }
  const gitMetadata =
    usesImplicitGitNetwork || usesGitMutation
      ? await (initializesCurrentDirectory
          ? inspectCurrentDirectoryGitMetadata(cwd)
          : inspectRepositoryGitMetadata(cwd))
      : undefined;
  let prospectiveGitRoot: string | undefined;
  if (
    initializesCurrentDirectory &&
    gitMetadata &&
    !gitMetadata.ok &&
    gitMetadata.reason === "unsafe Git metadata: repository not found"
  ) {
    try {
      prospectiveGitRoot = join(await realpath(cwd), ".git");
    } catch {
      // Preserve the repository inspection failure below.
    }
  }
  if (gitMetadata && !gitMetadata.ok && !prospectiveGitRoot) {
    return { action: "block", risk: "HARD", reason: gitMetadata.reason };
  }
  if (usesImplicitGitNetwork && gitMetadata?.ok) {
    request.networkTargets = [
      ...new Set([
        ...(request.networkTargets ?? []),
        ...(await readRepositoryRemoteHosts(gitMetadata.configPath)),
      ]),
    ];
  }
  const gitWriteRoots = usesGitMutation
    ? gitMetadata?.ok
      ? gitMetadata.writeRoots
      : prospectiveGitRoot
        ? [prospectiveGitRoot]
        : []
    : [];
  const additionalWriteRoots = await resolveAdditionalWriteRoots(
    input,
    cwd,
    config,
    protectedWritePaths ? [...protectedWritePaths] : defaultProtectedWritePaths(cwd),
    gitWriteRoots,
  );
  if (!additionalWriteRoots.ok) {
    return { action: "block", risk: "HARD", reason: additionalWriteRoots.reason };
  }
  const filesystemWriteRoots = [...new Set([...gitWriteRoots, ...additionalWriteRoots.writeRoots])];
  const rule = matchRules(request, config.rules);
  if (rule?.action === "deny") {
    return { action: "block", risk: "HARD", reason: "Denied by permissions rule" };
  }
  if (request.networkTargets?.some((host) => !isPublicNetworkHost(host))) {
    return {
      action: "block",
      risk: "HARD",
      reason: "Private or special-use network target is blocked",
    };
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
      reason:
        rule?.action === "ask" ? "Approval required by permissions rule" : `${risk} operation`,
      summary: summarize(tool, input),
      networkHosts:
        request.operation === "execute" && request.networkTargets?.length
          ? [...request.networkTargets]
          : undefined,
      filesystemWriteRoots: filesystemWriteRoots.length > 0 ? filesystemWriteRoots : undefined,
      justification: additionalWriteRoots.justification,
    };
  }

  return { action: "allow", risk, reason: "Low-risk operation" };
}
