import type { PermissionsConfig } from "./config.ts";
import type { StructuredExecutionPlan } from "./execution-plan.ts";
import { createFilesystemPolicy, defaultProtectedWritePaths } from "./filesystem-policy.ts";
import {
  inspectCurrentDirectoryGitInitialization,
  inspectRepositoryGitMetadata,
  readRepositoryRemoteHosts,
} from "./git-metadata.ts";
import { normalizePermissionAmendment } from "./permission-amendment.ts";
import { rmArgsIncludeForce } from "./permissions/dangerous-commands.ts";
import { isPathAllowed } from "./permissions/paths.ts";
import {
  analyzeShellGitNetwork,
  classifyRisk,
  gitInitializationPlan as createGitInitializationPlan,
  deletionExecutables,
  deletionTargets,
  isPublicNetworkHost,
  normalizeToolCall,
  parseCommandSegments,
  type Risk,
  shellCommandCanGrantGitMetadata,
  shellCommandInitializesCurrentDirectory,
  shellCommandUsesGitMutation,
} from "./permissions/risk.ts";
import { matchRules } from "./permissions/rules.ts";
import { resolveAdditionalWriteRoots } from "./shell-permissions.ts";

export type RiskDecision =
  | { action: "allow"; risk: Risk; reason: string }
  | {
      action: "prompt";
      risk: Risk;
      reason: string;
      summary: string;
      networkHosts?: string[];
      filesystemWriteRoots?: string[];
      justification?: string;
      executionPlan?: StructuredExecutionPlan;
    }
  | { action: "block"; risk: Risk; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

async function evaluateRequestPermissions(
  input: Record<string, unknown>,
  cwd: string,
  protectedWritePaths: readonly string[],
): Promise<RiskDecision> {
  const permissions = isRecord(input.permissions) ? input.permissions : {};
  const network = isRecord(permissions.network) ? permissions.network : {};
  const filesystem = isRecord(permissions.filesystem) ? permissions.filesystem : {};
  const normalized = await normalizePermissionAmendment(
    { hosts: stringList(network.hosts), writeRoots: stringList(filesystem.write) },
    cwd,
    protectedWritePaths,
  );
  if (!normalized.ok) {
    return { action: "block", risk: "HARD", reason: normalized.reason };
  }
  if (
    normalized.amendment.networkHosts.length === 0 &&
    normalized.amendment.writeRoots.length === 0
  ) {
    return {
      action: "block",
      risk: "HARD",
      reason: "request_permissions requires at least one permission",
    };
  }
  return {
    action: "prompt",
    risk: "REVIEW",
    reason: "REVIEW operation",
    summary: summarize("request_permissions", input),
    ...(normalized.amendment.networkHosts.length > 0
      ? { networkHosts: normalized.amendment.networkHosts }
      : {}),
    ...(normalized.amendment.writeRoots.length > 0
      ? { filesystemWriteRoots: normalized.amendment.writeRoots }
      : {}),
  };
}

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

export async function evaluateRiskRequest(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  config: PermissionsConfig,
  protectedWritePaths?: readonly string[],
): Promise<RiskDecision> {
  if (tool.toLowerCase() === "request_permissions") {
    return evaluateRequestPermissions(
      input,
      cwd,
      protectedWritePaths ? [...protectedWritePaths] : defaultProtectedWritePaths(cwd),
    );
  }
  const request = normalizeToolCall(tool, input, cwd);
  const command = typeof input.command === "string" ? input.command : undefined;
  const gitNetwork = command ? analyzeShellGitNetwork(command) : undefined;
  if (request.operation === "execute" && gitNetwork?.unsafeReason) {
    return {
      action: "block",
      risk: "HARD",
      reason: `Unsafe Git network invocation: ${gitNetwork.unsafeReason}`,
    };
  }
  const usesImplicitGitNetwork =
    request.operation === "execute" && Boolean(gitNetwork?.usesImplicitNetwork);
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
  const gitInitialization = initializesCurrentDirectory
    ? await inspectCurrentDirectoryGitInitialization(cwd)
    : undefined;
  if (gitInitialization && !gitInitialization.ok) {
    return { action: "block", risk: "HARD", reason: gitInitialization.reason };
  }
  const executionPlan = initializesCurrentDirectory
    ? command === undefined
      ? undefined
      : createGitInitializationPlan(command, cwd)
    : undefined;
  if (initializesCurrentDirectory && executionPlan === undefined) {
    return {
      action: "block",
      risk: "HARD",
      reason: "Trusted Git executable is unavailable for structured git init",
    };
  }
  const gitMetadata =
    !initializesCurrentDirectory && (usesImplicitGitNetwork || usesGitMutation)
      ? await inspectRepositoryGitMetadata(cwd)
      : undefined;
  if (gitMetadata && !gitMetadata.ok) {
    return { action: "block", risk: "HARD", reason: gitMetadata.reason };
  }
  if (usesImplicitGitNetwork && gitMetadata?.ok) {
    const remoteHosts = await readRepositoryRemoteHosts(
      gitMetadata.configPath,
      gitNetwork?.directImplicitPurpose === "push" ? "push" : "fetch",
    );
    if (!remoteHosts.ok) {
      return { action: "block", risk: "HARD", reason: remoteHosts.reason };
    }
    request.networkTargets = [
      ...new Set([...(request.networkTargets ?? []), ...remoteHosts.hosts]),
    ];
  }
  const gitWriteRoots = usesGitMutation
    ? gitInitialization?.ok
      ? gitInitialization.writeRoots
      : gitMetadata?.ok
        ? gitMetadata.writeRoots
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
  const filesystemWriteRoots = [...gitWriteRoots, ...additionalWriteRoots.writeRoots];
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

  const filesystem = createFilesystemPolicy(
    config.sandbox,
    cwd,
    protectedWritePaths ? [...protectedWritePaths] : undefined,
  );
  let risk = classifyRisk(
    request,
    false,
    [],
    filesystem.protectedWritePaths,
    filesystem.allowWrite,
  );
  if (filesystemWriteRoots.length > 0 && risk === "LOW") risk = "REVIEW";

  const allowWrite = [...filesystem.allowWrite];
  if (risk === "LOW" && request.operation === "execute" && command !== undefined) {
    const segments = request.commandSegments ?? parseCommandSegments(command);
    for (const segment of segments) {
      if (!deletionExecutables.has(segment.executable)) continue;
      if (segment.executable === "rm" && rmArgsIncludeForce(segment.args)) continue;
      const targets = deletionTargets(segment);
      if (targets.length === 0) continue;
      let allAllowed = true;
      for (const target of targets) {
        const decision = await isPathAllowed(target, {
          cwd,
          allowWrite,
          denyRead: [],
          denyWrite: filesystem.denyWrite,
          protectedWritePaths: filesystem.protectedWritePaths,
          operation: "write",
        });
        if (!decision.allowed) {
          allAllowed = false;
          break;
        }
      }
      if (!allAllowed) {
        risk = "REVIEW";
        break;
      }
    }
  }
  const operation = pathOperation(request.operation);
  if (operation) {
    for (const path of request.resolvedPaths) {
      const decision = await isPathAllowed(path, {
        cwd,
        allowWrite,
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

  const promptedByRule = rule?.action === "ask";
  const wouldPrompt = promptedByRule || risk !== "LOW";

  // ── escalation gate ────────────────────────────────────────────────────
  if (wouldPrompt) {
    return {
      action: "prompt",
      risk,
      reason: promptedByRule ? "Approval required by permissions rule" : `${risk} operation`,
      summary: summarize(tool, input),
      networkHosts:
        request.operation === "execute" && request.networkTargets?.length
          ? [...request.networkTargets]
          : undefined,
      filesystemWriteRoots: filesystemWriteRoots.length > 0 ? filesystemWriteRoots : undefined,
      justification: additionalWriteRoots.justification,
      ...(executionPlan === undefined ? {} : { executionPlan }),
    };
  }

  return { action: "allow", risk, reason: "Low-risk operation" };
}
