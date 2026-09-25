import { effectiveNetworkAuthority, type SafetyConfig } from "./config.ts";
import { createFilesystemPolicy, defaultProtectedWritePaths } from "./filesystem-policy.ts";
import { inspectRepositoryGitMetadata, readRepositoryRemoteHosts } from "./git-metadata.ts";
import { normalizePermissionAmendment } from "./permission-amendment.ts";
import { isPathAllowed } from "./permissions/paths.ts";
import { type ResidualSignal, residualsForPrompt } from "./permissions/residual.ts";
import {
  analyzeShellGitNetwork,
  classifyRisk,
  deletionExecutables,
  deletionTargets,
  isPublicNetworkHost,
  normalizeToolCall,
  parseCommandSegments,
  type Risk,
} from "./permissions/risk.ts";
import { matchRules } from "./permissions/rules.ts";
import { requestedEscalation, resolveAdditionalWriteRoots } from "./shell-permissions.ts";
import { isRecord } from "./unknown-value.ts";

export type RiskDecision =
  | { action: "allow"; risk: Risk; reason: string }
  | {
      action: "prompt";
      risk: Risk;
      reason: string;
      summary: string;
      networkHosts?: string[];
      networkAll?: true;
      filesystemWriteRoots?: string[];
      justification?: string;
      executionMode?: "escalated";
      residuals?: ResidualSignal[];
    }
  | { action: "block"; risk: Risk; reason: string };

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
    !dataRecord(input.permissions, ["network", "filesystem"]) ||
    (Object.hasOwn(input.permissions, "network") &&
      !validScope(input.permissions.network, "hosts") &&
      !(
        dataRecord(input.permissions.network, ["network_access"]) &&
        Object.hasOwn(input.permissions.network, "network_access") &&
        input.permissions.network.network_access === true
      )) ||
    (Object.hasOwn(input.permissions, "filesystem") &&
      !validScope(input.permissions.filesystem, "write"))
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
      risk: "HARD",
      reason:
        "request_permissions supports turn-scoped network.hosts OR network_access:true, and filesystem.write lists",
    };
  }
  const permissions = input.permissions;
  const network = isRecord(permissions.network) ? permissions.network : {};
  const filesystem = isRecord(permissions.filesystem) ? permissions.filesystem : {};
  const authority = effectiveNetworkAuthority(networkPolicy);
  const normalized = await normalizePermissionAmendment(
    {
      hosts: stringList(network.hosts),
      writeRoots: stringList(filesystem.write),
      allowPrivateTargets: authority.privateTargets,
      allowedDomains: networkPolicy.allowedDomains,
    },
    cwd,
    protectedWritePaths,
  );
  if (!normalized.ok) {
    return { action: "block", risk: "HARD", reason: normalized.reason };
  }
  if (
    network.network_access !== true &&
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
    summary:
      network.network_access === true
        ? "Whole-network outbound authority (subject to hard destination and private-target policy), current turn only"
        : summarize("request_permissions", input),
    residuals: residualsForPrompt({
      permissionAmendment: true,
      networkUncovered:
        network.network_access === true || normalized.amendment.networkHosts.length > 0,
      writeUncovered: normalized.amendment.writeRoots.length > 0,
      risk: "REVIEW",
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
  if (match?.action === "deny") {
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
    return { action: "block", risk: "HARD", reason: denial.reason };
  }
  return {
    action: "allow",
    risk: "LOW",
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
  const escalation = requestedEscalation(input);
  if ("error" in escalation) {
    return { action: "block", risk: "HARD", reason: escalation.error };
  }
  if (escalation.requested && (tool.toLowerCase() !== "bash" || command === undefined)) {
    return {
      action: "block",
      risk: "HARD",
      reason: "Command escalation is supported only for Bash executions",
    };
  }
  // Codex parity (`sandboxing.rs` `unsandboxed_execution_allowed`): denied
  // reads only exist inside the sandbox. Keep the command runnable under the
  // ordinary sandboxed path instead of blocking or issuing an unsandboxed
  // lease. denyWrite / deniedDomains alone do not suppress escalation (Codex
  // drops write restrictions and the managed network proxy on bypass).
  const escalationRequested =
    escalation.requested && config.sandbox.filesystem.denyRead.length === 0;
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
  // An escalated action runs on the bare local backend, outside the sandbox and
  // therefore outside the per-connection authorizer that checks the real host.
  // If the destination came from repository metadata it is in none of the places
  // that could bind it: not the command text the reviewer reads, not the Engine's
  // call fingerprint, and not the one-shot grant — and Git re-reads it at
  // execution. There is no enforcement point left, so the destination cannot be
  // proven and the action is refused rather than approved as if it were bound.
  //
  // This deliberately does not try to model Git's remote resolution to decide
  // whether the destination happens to be known. `readRepositoryRemoteHosts` is a
  // single-file parser: it follows no `include`/`includeIf`, no
  // `config.worktree`, no `url.*.insteadOf`, and no environment relocation, so a
  // parse that yields a host is not proof and a parse that yields none is not
  // proof either. Blocking on the fact that metadata was consulted is both
  // smaller and more complete than binding a host we cannot trust to be the one
  // Git will use. A remote named in the command is unaffected: it is stated by
  // the frozen input, and `usesImplicitNetwork` does not cover it.
  //
  // A bare operand is deliberately read as a remote name, so `git clone foo` is
  // refused too when `foo` happens to be a local directory. The conservative
  // reading is the right one for a security gate, `./foo` disambiguates, and no
  // local path that reads as a path is affected.
  if (escalationRequested && usesImplicitGitNetwork) {
    return {
      action: "block",
      risk: "HARD",
      reason:
        "Command escalation cannot bind an implicit Git remote destination, and an escalated Bash action has no connection boundary that could enforce it. Run the command sandboxed so each connection is authorised, or name the remote URL in the command.",
    };
  }
  const gitMetadata = usesImplicitGitNetwork ? await inspectRepositoryGitMetadata(cwd) : undefined;
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
  const additionalWriteRoots = await resolveAdditionalWriteRoots(
    input,
    cwd,
    config,
    protectedWritePaths ? [...protectedWritePaths] : defaultProtectedWritePaths(cwd),
  );
  if (!additionalWriteRoots.ok) {
    return { action: "block", risk: "HARD", reason: additionalWriteRoots.reason };
  }
  const filesystemWriteRoots = [...additionalWriteRoots.writeRoots];
  const rule = matchRules(request, config.rules);
  if (rule?.action === "deny") {
    return { action: "block", risk: "HARD", reason: "Denied by permissions rule" };
  }
  if (request.operation === "external") {
    // Product scope 2026-09-19: owned tools do not produce operation=external;
    // host-first B uses evaluateHostFirstRulesOnly and foreign A is out of
    // tool_call governance. This branch is compatibility-only — do not route
    // host-first/foreign here to resurrect host-admission review.
    if (rule?.action === "ask") {
      return {
        action: "prompt",
        risk: "REVIEW",
        reason: "Approval required by permissions rule",
        summary: summarize(tool, input),
        residuals: residualsForPrompt({
          ruleAsk: true,
          hostAdmissionReview: true,
          risk: "REVIEW",
        }),
      };
    }
    return {
      action: "allow",
      risk: "LOW",
      reason: rule?.action === "allow" ? "Allowed by permissions rule" : "Host tool policy",
    };
  }
  const sandboxedBashNetwork =
    !escalationRequested &&
    config.sandbox.enabled &&
    request.operation === "execute" &&
    tool.toLowerCase() === "bash";
  if (request.networkTargets?.some((host) => !isPublicNetworkHost(host)) && !sandboxedBashNetwork) {
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
  // Bash is executed inside the active sandbox. Static policy identifies
  // explicit additional filesystem capabilities; network effects are
  // authorized at the SRT connection boundary so one approved endpoint never
  // turns into a whole-command replay. The sandboxed Bash path therefore runs
  // the same classifier with only that network exemption: a command whose
  // static argv cannot be shown to equal its runtime argv stays REVIEW
  // (fail closed) instead of a separate dangerous-only HARD/LOW ternary.
  // The exemption covers network effects only (`networkTargets` /
  // `invocationUsesNetwork`); an external side effect
  // (`invocationHasExternalSideEffect`, e.g. `terraform apply`) is not
  // exempted — the sandbox guards the connection boundary, not the API
  // semantics of the call — so it stays HARD.
  let risk = classifyRisk(
    request,
    sandboxedBashNetwork,
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
      const targets = deletionTargets(segment);
      if (targets.length === 0) continue;
      for (const target of targets) {
        const decision = await isPathAllowed(target, {
          cwd,
          allowWrite,
          denyRead: [],
          denyWrite: filesystem.denyWrite,
          protectedWritePaths: filesystem.protectedWritePaths,
          operation: "write",
        });
        // Ordinary outside-root writes are discovered by the real sandbox and
        // reviewed with its exact denial. Static policy only catches hard
        // protected-path carve-outs before execution.
        if (!decision.allowed && decision.reason !== "write path is outside allowed roots") {
          risk = "REVIEW";
          break;
        }
      }
      if (risk !== "LOW") {
        break;
      }
    }
  }
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
        risk = risk === "HARD" ? "HARD" : "REVIEW";
        writeOutsideRoots = true;
        continue;
      }
      return { action: "block", risk: "HARD", reason: decision.reason };
    }
  }

  if (
    rule?.action === "allow" &&
    risk !== "HARD" &&
    filesystemWriteRoots.length === 0 &&
    !escalationRequested
  ) {
    return { action: "allow", risk, reason: "Allowed by permissions rule" };
  }

  const promptedByRule = rule?.action === "ask";
  const wouldPrompt = promptedByRule || risk !== "LOW" || escalationRequested;
  if (wouldPrompt) {
    return {
      action: "prompt",
      risk,
      reason: escalationRequested
        ? "Command requires escalated sandbox permissions"
        : promptedByRule
          ? "Approval required by permissions rule"
          : `${risk} operation`,
      summary: summarize(tool, input),
      residuals: residualsForPrompt({
        ruleAsk: promptedByRule,
        escalation: escalationRequested,
        risk,
        writeUncovered: filesystemWriteRoots.length > 0 || writeOutsideRoots,
        actionReview: risk !== "LOW" && filesystemWriteRoots.length === 0 && !escalationRequested,
      }),
      ...(filesystemWriteRoots.length > 0 ? { filesystemWriteRoots } : {}),
      justification: escalation.requested
        ? escalation.justification
        : additionalWriteRoots.justification,
      ...(escalationRequested ? { executionMode: "escalated" as const } : {}),
    };
  }

  return { action: "allow", risk, reason: "Low-risk operation" };
}
