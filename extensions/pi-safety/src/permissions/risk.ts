/**
 * ApprovalDisposition classification: the public entry point of the static risk layer.
 *
 * Four tiers, three dispositions. The tiers are ordered by how much was proved,
 * and two of them land on the same disposition:
 *
 *   1. proven dangerous          -> Forbidden
 *   2. proven side-effecting     -> NeedsApproval
 *   3. proven safe               -> Skip
 *   4. unclassifiable            -> NeedsApproval
 *
 * Tiers 2 and 4 are both a review, from opposite directions: tier 2's argv is
 * fully determined and its effect is simply not confined by the filesystem or
 * network policy, while tier 4's argv is not determined at all. Tier 3 is the
 * only auto-approve and the only tier that asserts nothing is left to prove, so
 * tier 4 fails closed into review rather than downgrading into it.
 *
 * The per-command analyses live in the sibling modules; this file composes them
 * into a single `ApprovalDisposition`.
 */
import { resolve } from "node:path";

import { resolvePolicyPath } from "../filesystem-policy.ts";
import { isPublicNetworkHost } from "../network-host.ts";
import { defaultSafetyConfigPath, isPathWithin } from "../policy-primitives.ts";
import { normalizedSegmentsFor } from "./cd-normalize.ts";
import {
  invocationControlsProcesses,
  invocationRemoteEffectUnclassified,
} from "./command-effects.ts";
import { isDangerousWords } from "./dangerous-commands.ts";
import type { CommandSegment, PermissionRequest } from "./rules.ts";
import { deletionExecutables } from "./rules.ts";
import { scanShellSyntax } from "./shell-lexer.ts";
import { extractShellNetworkHosts, invocationUsesNetwork } from "./shell-network.ts";
import { parseCommandSegments, shellStateCrossesSegments } from "./shell-segment.ts";

/**
 * What this layer decided to do with an owned tool call.
 *
 * These are dispositions, not risk measurements, and the names say so. The
 * previous spelling — `Risk = "LOW" | "REVIEW" | "HARD"` — described severity
 * while the values described action: `rm -r *` was `LOW`, which is not a claim
 * that it is harmless, only that it is not stopped here. `Skip` is what the
 * decision actually is.
 *
 * The names and the three levels are Codex's, from `ExecApprovalRequirement` in
 * `codex-rs/core/src/tools/sandboxing.rs` at the pinned `129fd21`:
 * `Skip { bypass_sandbox }`, `NeedsApproval { reason }`, `Forbidden { reason }`.
 * The forbidden tier has the same source on both sides — Codex's
 * `dangerous_command_match` and this package's `isDangerousWords`, which mirrors
 * `is_dangerous_command.rs` — so a reader can check one against the other
 * directly. fx is not the reference for this shape: its `Risk { low, medium,
 * high, critical }` paired with `Decision { clear, caution }` is a two-axis
 * assessment produced by its model reviewer, and a static classifier has no
 * producer for a four-point score.
 *
 * The field carrying this in `RiskDecision` is still named `risk`, because it
 * appears in the Guardian review packet and transcript as `risk`. That is a
 * different vocabulary from the `risk_level` Guardian itself emits — a model
 * score on a four-point scale — and the two should not be read as one scale.
 */
export type ApprovalDisposition = "Skip" | "NeedsApproval" | "Forbidden";

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
    commandSegments:
      command === undefined ? undefined : normalizedSegmentsFor(command, resolve(cwd)),
    networkTargets: command ? extractShellNetworkHosts(command) : extractNetworkTargets(input),
  };
}

function webFetchRisk(request: PermissionRequest): ApprovalDisposition {
  const value = request.input.url;
  if (typeof value !== "string" || value.trim() === "" || request.networkTargets?.length !== 1)
    return "Forbidden";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "Forbidden";
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname)
    return "Forbidden";
  return isPublicNetworkHost(parsed.hostname) ? "Skip" : "Forbidden";
}

function writeRisk(
  request: PermissionRequest,
  approvedWriteRoots: string[],
  protectedWritePaths: readonly string[] = [defaultSafetyConfigPath()],
  workspaceWriteRoots: readonly string[] = [request.cwd],
): ApprovalDisposition {
  if (
    request.resolvedPaths.some((path) =>
      protectedWritePaths.some((control) => isPathWithin(path, control)),
    )
  ) {
    return "Forbidden";
  }
  const roots = [...workspaceWriteRoots, ...approvedWriteRoots];
  return request.resolvedPaths.length > 0 &&
    request.resolvedPaths.every((path) => roots.some((root) => isPathWithin(path, root)))
    ? "Skip"
    : "NeedsApproval";
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
export { deletionExecutables };

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
): ApprovalDisposition {
  const lowerTool = request.tool.toLowerCase();
  if (lowerTool === "websearch") return "Skip";
  if (lowerTool === "webfetch") return webFetchRisk(request);
  if (request.operation === "write") {
    return writeRisk(request, approvedWriteRoots, protectedWritePaths, workspaceWriteRoots);
  }
  if (request.operation === "read") return "Skip";
  const command = typeof request.input.command === "string" ? request.input.command : undefined;
  if (!command) return "NeedsApproval";
  const segments = request.commandSegments ?? normalizedSegmentsFor(command, request.cwd);
  // Tier 1 — proven dangerous (forced rm, non-exempt network, external side
  // effect) is never downgraded to a review.
  if (!networkApproved && request.networkTargets?.length) return "Forbidden";
  if (
    segments.some(
      (segment) =>
        isDangerousSegment(segment) || (!networkApproved && invocationUsesNetwork(segment)),
    )
  )
    return "Forbidden";
  // Tier 2 — proven side-effecting: the argv is fully determined, but what it
  // does is not confined by the filesystem or network policy (Unix signals).
  // This is a review, not a block, matching fx `approval_required(
  // process_or_system)`.
  if (segments.some(invocationControlsProcesses)) return "NeedsApproval";
  // A segment whose surroundings are unproven — an inert `GIT_` variable, a
  // wrapper that could not be reduced — is not decomposable either, and this is
  // where that becomes a review rather than a refusal. Refusal is the network
  // layer's `unsafeReason`, which is about not being able to identify the program
  // at all; here the program is identified and only its context is unproven, so
  // tier 3 does not hold. `GIT_TRACE=1 git status` belongs: the words name git,
  // the variable changes nothing about which binary runs, and a human settles it.
  if (segments.some((segment) => segment.executableContextUntrusted)) return "NeedsApproval";
  // Tier 3 — proven safe: static argv equals runtime argv for the whole
  // command, so nothing is left to prove. A rewritable argv, an unreadable
  // option grammar, or state crossing a segment boundary is not.
  const decomposable =
    !scanShellSyntax(command).hasExecutableSubstitution &&
    segments.every((segment) => segment.decomposable) &&
    // A compound command that publishes shell state in one segment and reads it
    // in another cannot be analysed segment by segment.
    !shellStateCrossesSegments(segments, request.cwd) &&
    // An invocation whose remote effect this layer cannot prove has not been
    // shown to be read-only.
    segments.every((segment) => !invocationRemoteEffectUnclassified(segment));
  // Tier 4 — unclassifiable: a dynamic executable word, a re-interpreted
  // string or stdin program, a substitution, a heredoc, or a brace group. The
  // static word list is not the argv that runs, so fail closed into review
  // instead of guessing.
  return decomposable ? "Skip" : "NeedsApproval";
}

export { isPublicNetworkHost } from "../network-host.ts";
export {
  analyzeShellGitNetwork,
  type ShellGitNetworkAnalysis,
} from "./git-network.ts";
export type { CommandSegment, PermissionRequest } from "./rules.ts";
export { extractShellNetworkHosts } from "./shell-network.ts";
export { parseCommandSegments } from "./shell-segment.ts";
