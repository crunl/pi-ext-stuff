/**
 * Risk classification: the public entry point of the static risk layer.
 *
 * Tiers, in order: proven dangerous (HARD), proven side-effecting (REVIEW),
 * proven safe (LOW), unclassifiable (REVIEW). The per-command analyses live in
 * the sibling modules; this file composes them into a single `Risk`.
 */
import { resolve } from "node:path";

import { defaultSafetyConfigPath, resolvePolicyPath } from "../filesystem-policy.ts";
import { isPublicNetworkHost } from "../network-host.ts";
import { invocationControlsProcesses, invocationHasExternalSideEffect } from "./command-effects.ts";
import { isDangerousWords } from "./dangerous-commands.ts";
import { isPathWithin } from "./paths.ts";
import type { CommandSegment, PermissionRequest } from "./rules.ts";
import { scanShellSyntax } from "./shell-lexer.ts";
import { extractShellNetworkHosts, invocationUsesNetwork } from "./shell-network.ts";
import { parseCommandSegments } from "./shell-segment.ts";

export type Risk = "LOW" | "REVIEW" | "HARD";

function extractedPaths(input: Record<string, unknown>, cwd: string): string[] {
  return ["path", "filePath", "targetPath", "sourcePath"].flatMap((key) => {
    const value = input[key];
    return typeof value === "string" ? [resolvePolicyPath(value, cwd)] : [];
  });
}

function extractNetworkTargets(input: Record<string, unknown>): string[] {
  const values = [
    ...(typeof input.url === "string" ? [input.url] : []),
    ...(Array.isArray(input.urls)
      ? input.urls.filter((value): value is string => typeof value === "string")
      : []),
  ];
  return values.map((value) => {
    try {
      return new URL(value).hostname;
    } catch {
      return value;
    }
  });
}

export function normalizeToolCall(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): PermissionRequest {
  const command = typeof input.command === "string" ? input.command : undefined;
  const lowerTool = tool.toLowerCase();
  const operation =
    lowerTool === "webfetch"
      ? "network"
      : new Set(["websearch", "read", "search", "grep", "find", "ls"]).has(lowerTool)
        ? "read"
        : ["write", "edit", "apply_patch"].includes(lowerTool)
          ? "write"
          : new Set(["bash", "powershell"]).has(lowerTool) && command
            ? "execute"
            : "external";
  return {
    tool,
    operation,
    input,
    cwd: resolve(cwd),
    resolvedPaths: extractedPaths(input, cwd),
    commandSegments: command ? parseCommandSegments(command) : undefined,
    networkTargets: command ? extractShellNetworkHosts(command) : extractNetworkTargets(input),
  };
}

function webFetchRisk(request: PermissionRequest): Risk {
  const value = request.input.url;
  if (typeof value !== "string" || value.trim() === "" || request.networkTargets?.length !== 1)
    return "HARD";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "HARD";
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname)
    return "HARD";
  return isPublicNetworkHost(parsed.hostname) ? "LOW" : "HARD";
}

function writeRisk(
  request: PermissionRequest,
  approvedWriteRoots: string[],
  protectedWritePaths: readonly string[] = [defaultSafetyConfigPath()],
  workspaceWriteRoots: readonly string[] = [request.cwd],
): Risk {
  if (
    request.resolvedPaths.some((path) =>
      protectedWritePaths.some((control) => isPathWithin(path, control)),
    )
  ) {
    return "HARD";
  }
  const roots = [...workspaceWriteRoots, ...approvedWriteRoots];
  return request.resolvedPaths.length > 0 &&
    request.resolvedPaths.every((path) => roots.some((root) => isPathWithin(path, root)))
    ? "LOW"
    : "REVIEW";
}

/**
 * Codex-aligned dangerous-command check for one parsed segment. Reserved
 * control-flow keywords, assignments, and wrappers are reduced by
 * `parseCommandSegment`, so the segment already names the real executable;
 * `trap` actions are shell code and are expanded and checked recursively.
 * `bash -lc` bodies are already expanded into their own segments by
 * parseCommandSegments, so nested `rm -f` is caught at the top level.
 */
function isDangerousSegment(segment: CommandSegment, depth = 0): boolean {
  // Mirror the wrapper-reasoning bound (Codex MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH):
  // past it we can no longer prove the trap-action chain safe, so fail closed.
  if (depth > 8) return true;
  const words = [segment.executable, ...segment.args];
  if (words[0] === "trap") {
    // words[0] is the `trap` itself, so the action starts at index 1.
    let actionIndex = 1;
    if ((words[actionIndex] ?? "") === "--") actionIndex += 1;
    const action = words[actionIndex];
    if (action === undefined || action.startsWith("-")) return false;
    return parseCommandSegments(action).some((nested) => isDangerousSegment(nested, depth + 1));
  }
  return words.length > 0 && isDangerousWords(words);
}

/** Deletion commands whose targets are checked against the sandbox write roots. */
export const deletionExecutables = new Set(["rm", "rmdir", "unlink", "shred", "truncate"]);

/**
 * Positional targets of a deletion command, honoring `--` (everything after
 * it is a target, even if it looks like an option).
 */
export function deletionTargets(segment: CommandSegment): string[] {
  const targets: string[] = [];
  let afterDashDash = false;
  for (const arg of segment.args) {
    if (arg === "--") {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && arg.startsWith("-")) continue;
    targets.push(arg);
  }
  return targets;
}

export function classifyRisk(
  request: PermissionRequest,
  networkApproved = false,
  approvedWriteRoots: string[] = [],
  protectedWritePaths: readonly string[] = [defaultSafetyConfigPath()],
  workspaceWriteRoots: readonly string[] = [request.cwd],
): Risk {
  const lowerTool = request.tool.toLowerCase();
  if (lowerTool === "websearch") return "LOW";
  if (lowerTool === "webfetch") return webFetchRisk(request);
  if (request.operation === "write") {
    return writeRisk(request, approvedWriteRoots, protectedWritePaths, workspaceWriteRoots);
  }
  if (request.operation === "read") return "LOW";
  const command = typeof request.input.command === "string" ? request.input.command : undefined;
  if (!command) return "REVIEW";
  const segments = request.commandSegments ?? parseCommandSegments(command);
  // Tier 1 — proven dangerous (forced rm, non-exempt network, external side
  // effect) is never downgraded to a review.
  if (!networkApproved && request.networkTargets?.length) return "HARD";
  const externalEffects = segments.map(invocationHasExternalSideEffect);
  if (
    segments.some(
      (segment, index) =>
        isDangerousSegment(segment) ||
        (!networkApproved && invocationUsesNetwork(segment)) ||
        externalEffects[index] === "proved",
    )
  )
    return "HARD";
  // Tier 2 — proven side-effecting: the argv is fully determined, but what it
  // does is not confined by the filesystem or network policy (Unix signals).
  // This is a review, not a block, matching fx `approval_required(
  // process_or_system)`.
  if (segments.some(invocationControlsProcesses)) return "REVIEW";
  // Tier 3 — proven safe: static argv equals runtime argv for the whole
  // command, so nothing is left to prove. An *unknown* executable is still
  // this tier; only a rewritable argv or an unreadable option grammar is not.
  const decomposable =
    !scanShellSyntax(command).hasExecutableSubstitution &&
    segments.every((segment) => segment.decomposable) &&
    // An external CLI whose options this layer cannot parse has not been shown
    // to be read-only, so it cannot reach this tier.
    !externalEffects.includes("unknown");
  // Tier 4 — unclassifiable: a dynamic executable word, a re-interpreted
  // string or stdin program, a substitution, a heredoc, or a brace group. The
  // static word list is not the argv that runs, so fail closed into review
  // instead of guessing.
  return decomposable ? "LOW" : "REVIEW";
}

export { isPublicNetworkHost } from "../network-host.ts";
export {
  analyzeShellGitNetwork,
  type ShellGitNetworkAnalysis,
} from "./git-network.ts";
export type { CommandSegment, PermissionRequest } from "./rules.ts";
export { extractShellNetworkHosts } from "./shell-network.ts";
export { parseCommandSegments } from "./shell-segment.ts";
