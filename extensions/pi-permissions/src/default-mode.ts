import type { PermissionsConfig } from "./config.ts";
import { createFilesystemPolicy, defaultProtectedWritePaths } from "./filesystem-policy.ts";
import {
  inspectCurrentDirectoryGitInitialization,
  inspectRepositoryGitMetadata,
  readRepositoryRemoteHosts,
} from "./git-metadata.ts";
import { isPathAllowed } from "./permissions/paths.ts";
import {
  analyzeShellGitNetwork,
  classifyRisk,
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
import { rmArgsIncludeForce } from "./permissions/dangerous-commands.ts";
import { matchRules } from "./permissions/rules.ts";
import { isKnownSafeCommand } from "./permissions/safe-commands.ts";
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

/**
 * Session-scoped approvals (codex ExecpolicyAmendment/ApprovedForSession/
 * NetworkPolicyAmendment equivalents). Populated when the user approves a
 * call; matching later calls skip the prompt but never bypass hard blocks
 * (protected paths, private networks, git single-command constraint).
 */
export interface SessionApprovals {
  /** Whole-segment token prefixes of user-approved commands. */
  commandPrefixes?: string[][];
  /** Network hosts the user approved this session. */
  networkHosts?: ReadonlySet<string>;
}

/** True when every segment of `command` starts with an approved prefix. */
function isApprovedCommand(command: string, prefixes: string[][]): boolean {
  if (prefixes.length === 0) return false;
  const segments = parseCommandSegments(command);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const tokens = [segment.executable, ...segment.args];
    return prefixes.some((prefix) => {
      if (prefix.length > tokens.length) return false;
      return prefix.every((token, index) => token === tokens[index]);
    });
  });
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

export async function evaluateDefaultRequest(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  config: PermissionsConfig,
  protectedWritePaths?: readonly string[],
  approved: SessionApprovals = {},
): Promise<DefaultDecision> {
  const request = normalizeToolCall(tool, input, cwd);
  // Drop session-approved hosts from the network targets so they no longer
  // escalate; anything still pending keeps the existing checks.
  const approvedHosts = approved.networkHosts;
  const networkTargets = request.networkTargets ?? [];
  const hadNetworkTargets = networkTargets.length > 0;
  if (approvedHosts && approvedHosts.size > 0 && hadNetworkTargets) {
    const pending = networkTargets.filter((host) => !approvedHosts.has(host));
    request.networkTargets = pending.length > 0 ? pending : undefined;
  }
  const networkFullyApproved = hadNetworkTargets && (request.networkTargets?.length ?? 0) === 0;
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

  let risk = classifyRisk(request, networkFullyApproved);
  if (filesystemWriteRoots.length > 0 && risk === "LOW") risk = "REVIEW";

  // Stage 3 (codex sandbox boundary): deletion commands auto-approve only
  // when every target sits inside the sandbox write roots (and outside
  // denyWrite/protected paths). Anything else escalates to REVIEW; `rm -f`
  // is already HARD via classifyRisk.
  let deletionBoundaryViolation = false;
  if (risk === "LOW" && request.operation === "execute" && command !== undefined) {
    const segments = request.commandSegments ?? parseCommandSegments(command);
    const filesystem = createFilesystemPolicy(
      config.sandbox,
      cwd,
      protectedWritePaths ? [...protectedWritePaths] : undefined,
    );
    for (const segment of segments) {
      if (!deletionExecutables.has(segment.executable)) continue;
      if (segment.executable === "rm" && rmArgsIncludeForce(segment.args)) continue;
      const targets = deletionTargets(segment);
      if (targets.length === 0) continue;
      let allAllowed = true;
      for (const target of targets) {
        const decision = await isPathAllowed(target, {
          cwd,
          allowWrite: filesystem.allowWrite,
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
        deletionBoundaryViolation = true;
        break;
      }
    }
  }
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

  const promptedByRule = rule?.action === "ask";
  const wouldPrompt = promptedByRule || risk !== "LOW";

  // Session-approved commands skip the prompt (but never hard blocks or the
  // deletion sandbox boundary).
  const commandApproved =
    !deletionBoundaryViolation &&
    approved.commandPrefixes !== undefined &&
    approved.commandPrefixes.length > 0 &&
    command !== undefined &&
    isApprovedCommand(command, approved.commandPrefixes);

  // ── approval-mode adjustments (mirrors codex AskForApproval) ──────────
  if (commandApproved) {
    return { action: "allow", risk, reason: "Approved command prefix (session)" };
  }
  if (config.approvalMode === "never" && wouldPrompt) {
    // Never ask: escalation is forbidden, failures return to the model.
    return { action: "block", risk, reason: `Blocked by approvalMode=never (${risk} operation)` };
  }
  if (config.approvalMode === "granular" && wouldPrompt) {
    if (promptedByRule && !config.granularApproval.rules) {
      return { action: "block", risk, reason: "Blocked by granularApproval.rules=false" };
    }
    if (!promptedByRule && !config.granularApproval.sandboxApproval) {
      return { action: "block", risk, reason: "Blocked by granularApproval.sandboxApproval=false" };
    }
  }

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
    };
  }

  // untrusted: only read-only whitelisted commands auto-approve; any other
  // command prompts even when it is otherwise low-risk.
  if (
    config.approvalMode === "untrusted" &&
    request.operation === "execute" &&
    command !== undefined &&
    !isKnownSafeCommand(command)
  ) {
    return {
      action: "prompt",
      risk: "REVIEW",
      reason: "Command is not in the read-only whitelist (untrusted mode)",
      summary: summarize(tool, input),
    };
  }

  return { action: "allow", risk, reason: "Low-risk operation" };
}
