import type { SafetyConfig } from "./config.ts";
import { createFilesystemPolicy, defaultProtectedWritePaths } from "./filesystem-policy.ts";
import { inspectRepositoryGitMetadata, readRepositoryRemoteHosts } from "./git-metadata.ts";
import { normalizePermissionAmendment } from "./permission-amendment.ts";
import { isPathAllowed } from "./permissions/paths.ts";
import { type ResidualSignal, residualsForPrompt } from "./permissions/residual.ts";
import {
  type ApprovalDisposition,
  analyzeShellGitNetwork,
  classifyRiskWithCause,
  normalizeToolCall,
} from "./permissions/risk.ts";
import { matchRules } from "./permissions/rules.ts";
import { effectiveNetworkAuthority } from "./policy-primitives.ts";
import { resolveAdditionalWriteRoots } from "./shell-permissions.ts";
import { isRecord } from "./unknown-value.ts";

export type RiskDecision =
  | { action: "allow"; risk: ApprovalDisposition; reason: string }
  | {
      action: "prompt";
      risk: ApprovalDisposition;
      reason: string;
      summary: string;
      networkHosts?: string[];
      networkAll?: true;
      filesystemWriteRoots?: string[];
      justification?: string;
      residuals?: ResidualSignal[];
    }
  | { action: "block"; risk: ApprovalDisposition; reason: string };

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Reject clone-erased scope and accessor evaluation before canonical capture. */
export function isSupportedPermissionRequestShape(
  input: unknown,
): input is Record<string, unknown> & { permissions: Record<string, unknown> } {
  const dataRecord = (
    value: unknown,
    allowedKeys: readonly string[],
  ): value is Record<string, unknown> => {
    if (
      !isRecord(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    )
      return false;
    return Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key === "string" &&
        allowedKeys.includes(key) &&
        descriptor?.enumerable === true &&
        Object.hasOwn(descriptor, "value")
      );
    });
  };
  const stringArray = (value: unknown): boolean => {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
    // Only dense own string elements plus the array's intrinsic length are JSON-like.
    // Never call caller-owned iteration methods or read an element accessor.
    if (Reflect.ownKeys(value).length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor?.enumerable !== true ||
        !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "string"
      )
        return false;
    }
    return true;
  };
  const validScope = (value: unknown, key: string): boolean =>
    dataRecord(value, [key]) && Object.hasOwn(value, key) && stringArray(value[key]);
  if (
    !dataRecord(input, ["permissions", "reason", "scope"]) ||
    !Object.hasOwn(input, "permissions") ||
    (Object.hasOwn(input, "scope") && input.scope !== "turn") ||
    (Object.hasOwn(input, "reason") && typeof input.reason !== "string") ||
    !dataRecord(input.permissions, ["network", "file_system"]) ||
    (Object.hasOwn(input.permissions, "network") &&
      !validScope(input.permissions.network, "hosts") &&
      !(
        dataRecord(input.permissions.network, ["network_access"]) &&
        Object.hasOwn(input.permissions.network, "network_access") &&
        input.permissions.network.network_access === true
      )) ||
    (Object.hasOwn(input.permissions, "file_system") &&
      !validScope(input.permissions.file_system, "write"))
  )
    return false;
  return true;
}

async function evaluateRequestPermissions(
  input: Record<string, unknown>,
  cwd: string,
  protectedWritePaths: readonly string[],
  networkPolicy: SafetyConfig["sandbox"]["network"],
): Promise<RiskDecision> {
  if (!isSupportedPermissionRequestShape(input)) {
    return {
      action: "block",
      risk: "Forbidden",
      reason:
        "request_permissions supports turn-scoped network.hosts OR network_access:true, and file_system.write lists",
    };
  }
  const permissions = input.permissions;
  const network = isRecord(permissions.network) ? permissions.network : {};
  const fileSystem = isRecord(permissions.file_system) ? permissions.file_system : {};
  const authority = effectiveNetworkAuthority(networkPolicy);
  const normalized = await normalizePermissionAmendment(
    {
      hosts: stringList(network.hosts),
      writeRoots: stringList(fileSystem.write),
      allowPrivateTargets: authority.privateTargets,
      allowedDomains: networkPolicy.allowedDomains,
    },
    cwd,
    protectedWritePaths,
  );
  if (!normalized.ok) {
    return { action: "block", risk: "Forbidden", reason: normalized.reason };
  }
  if (
    network.network_access !== true &&
    normalized.amendment.networkHosts.length === 0 &&
    normalized.amendment.writeRoots.length === 0
  ) {
    return {
      action: "block",
      risk: "Forbidden",
      reason: "request_permissions requires at least one permission",
    };
  }
  return {
    action: "prompt",
    risk: "NeedsApproval",
    reason: "Needs review",
    summary:
      network.network_access === true
        ? "Whole-network outbound authority (subject to hard destination and private-target policy), current turn only"
        : summarize("request_permissions", input),
    residuals: residualsForPrompt({
      permissionAmendment: true,
      networkUncovered:
        network.network_access === true || normalized.amendment.networkHosts.length > 0,
      writeUncovered: normalized.amendment.writeRoots.length > 0,
      risk: "NeedsApproval",
    }),
    ...(network.network_access === true ? { networkAll: true as const } : {}),
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

/**
 * Host-first B: only configured `rules` deny blocks. ask/allow/no-match do
 * not enter Engine or Guardian — host-first tools have no sandbox ownership.
 */
export function evaluateHostFirstRulesOnly(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  config: SafetyConfig,
): { block: true; reason: string } | undefined {
  const request = normalizeToolCall(tool, input, cwd);
  const match = matchRules(request, config.rules);
  if (match?.decision === "deny") {
    return { block: true, reason: "Denied by permissions rule" };
  }
  return undefined;
}

/**
 * Compatibility RiskDecision shape for host-first tools under product scope B.
 * Prefer `evaluateHostFirstRulesOnly` at production call sites. Not used by
 * register.ts host-first path after foreign A / host-first B cut.
 */
export async function evaluateHostRiskRequest(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  config: SafetyConfig,
): Promise<RiskDecision> {
  const denial = evaluateHostFirstRulesOnly(tool, input, cwd, config);
  if (denial) {
    return { action: "block", risk: "Forbidden", reason: denial.reason };
  }
  return {
    action: "allow",
    risk: "Skip",
    reason: "Host tool policy",
  };
}

export async function evaluateRiskRequest(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  config: SafetyConfig,
  protectedWritePaths?: readonly string[],
): Promise<RiskDecision> {
  if (tool.toLowerCase() === "request_permissions") {
    return evaluateRequestPermissions(
      input,
      cwd,
      protectedWritePaths ? [...protectedWritePaths] : defaultProtectedWritePaths(cwd),
      config.sandbox.network,
    );
  }
  const request = normalizeToolCall(tool, input, cwd);
  const command = typeof input.command === "string" ? input.command : undefined;
  const gitNetwork = command ? analyzeShellGitNetwork(command) : undefined;
  if (request.operation === "execute" && gitNetwork?.unsafeReason) {
    return {
      action: "block",
      risk: "Forbidden",
      reason: `Unsafe Git network invocation: ${gitNetwork.unsafeReason}`,
    };
  }
  const usesImplicitGitNetwork =
    request.operation === "execute" && Boolean(gitNetwork?.usesImplicitNetwork);
  // The program here is known to be Git; what is unproven is its option grammar
  // or its wrapper. `git -C DIR` and `git --git-dir DIR` only relocate the target
  // and say so in the argv, while `git -c KEY=VALUE` can install a hook directory
  // or an alias that the same invocation then runs. A nested program Git is
  // proven to run is a static review at the classifier (`nested_git_program`),
  // and anything less than that runs under the sandbox. The verdict below keeps
  // the same shape so the summary and residual set are the same ones every
  // other review gets.
  //
  // Scoped to execute for the same reason the check above is: a `write` or
  // `read` input that happens to carry a `command` field was being sent to review
  // by this flag, while `classifyRisk` treats those operations as `Skip`.
  const gitMetadata = usesImplicitGitNetwork ? await inspectRepositoryGitMetadata(cwd) : undefined;
  if (gitMetadata && !gitMetadata.ok) {
    return { action: "block", risk: "Forbidden", reason: gitMetadata.reason };
  }
  if (usesImplicitGitNetwork && gitMetadata?.ok) {
    const remoteHosts = await readRepositoryRemoteHosts(
      gitMetadata.configPath,
      gitNetwork?.directImplicitPurpose === "push" ? "push" : "fetch",
    );
    if (!remoteHosts.ok) {
      return { action: "block", risk: "Forbidden", reason: remoteHosts.reason };
    }
    request.networkTargets = [
      ...new Set([...(request.networkTargets ?? []), ...remoteHosts.hosts]),
    ];
  }
  const additionalWriteRoots = await resolveAdditionalWriteRoots(
    input,
    cwd,
    config,
    protectedWritePaths ? [...protectedWritePaths] : defaultProtectedWritePaths(cwd),
  );
  if (!additionalWriteRoots.ok) {
    return { action: "block", risk: "Forbidden", reason: additionalWriteRoots.reason };
  }
  const filesystemWriteRoots = [...additionalWriteRoots.writeRoots];
  const rule = matchRules(request, config.rules);
  if (rule?.decision === "deny") {
    return { action: "block", risk: "Forbidden", reason: "Denied by permissions rule" };
  }
  if (request.operation === "external") {
    // Product scope 2026-09-19: owned tools do not produce operation=external;
    // host-first B uses evaluateHostFirstRulesOnly and foreign A is out of
    // tool_call governance. This branch is compatibility-only — do not route
    // host-first/foreign here to resurrect host-admission review.
    if (rule?.decision === "ask") {
      return {
        action: "prompt",
        risk: "NeedsApproval",
        reason: "Approval required by permissions rule",
        summary: summarize(tool, input),
        residuals: residualsForPrompt({
          ruleAsk: true,
          hostAdmissionReview: true,
          risk: "NeedsApproval",
        }),
      };
    }
    return {
      action: "allow",
      risk: "Skip",
      reason: rule?.decision === "allow" ? "Allowed by permissions rule" : "Host tool policy",
    };
  }
  const filesystem = createFilesystemPolicy(
    config.sandbox,
    cwd,
    protectedWritePaths ? [...protectedWritePaths] : undefined,
  );
  // Bash is executed inside the active sandbox. Static policy identifies
  // explicit additional filesystem capabilities; network egress is
  // authorized per-endpoint at the runtime NetworkBoundary (codex
  // NetworkProxy analogue), never here, so the classifier is
  // network-agnostic. Cut 3: the classifier answers two questions
  // (dangerous? nested program?) and everything else runs — a proven
  // dangerous argv is a review the user settles (codex `OnRequest`
  // → `Prompt`), not a hard block.
  const classification = classifyRiskWithCause(
    request,
    filesystem.protectedWritePaths,
    filesystem.denyWrite,
  );
  let risk = classification.disposition;
  // Kept while the write flip, carve-out and elevation go: extra write
  // roots are a *grant*, not a proof question — the justification must be
  // read by a reviewer before the scope widens. Deleting this line would
  // grant additional_permissions silently.
  if (filesystemWriteRoots.length > 0 && risk === "Skip") risk = "NeedsApproval";

  const allowWrite = [...filesystem.allowWrite];
  const operation = pathOperation(request.operation);
  let writeOutsideRoots = false;
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
        // Cut 3: no longer a static review — the sandboxed file operations
        // deny it at runtime. The flag still rides the residuals so the
        // review packet (if any) says where the write stands.
        writeOutsideRoots = true;
        continue;
      }
      return { action: "block", risk: "Forbidden", reason: decision.reason };
    }
  }

  if (
    rule?.decision === "allow" &&
    risk !== "Forbidden" &&
    filesystemWriteRoots.length === 0
  ) {
    return { action: "allow", risk, reason: "Allowed by permissions rule" };
  }

  const promptedByRule = rule?.decision === "ask";
  const wouldPrompt = promptedByRule || risk !== "Skip";
  if (wouldPrompt) {
    return {
      action: "prompt",
      risk,
      reason: promptedByRule
        ? "Approval required by permissions rule"
        : // This names where the dangerous argv itself was found, so it
          // belongs in the review packet the Guardian reads.
          classification.dangerousSubstitution !== undefined
          ? `Dangerous command inside shell substitution: ${classification.dangerousSubstitution}`
          : `${risk} operation`,
      summary: summarize(tool, input),
      residuals: residualsForPrompt({
        ruleAsk: promptedByRule,
        risk,
        writeUncovered: filesystemWriteRoots.length > 0 || writeOutsideRoots,
        actionReview: risk !== "Skip" && filesystemWriteRoots.length === 0,
      }),
      ...(filesystemWriteRoots.length > 0 ? { filesystemWriteRoots } : {}),
      justification: additionalWriteRoots.justification,
    };
  }

  return { action: "allow", risk, reason: "Low-risk operation" };
}
