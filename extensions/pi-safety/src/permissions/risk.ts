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
import type { CommandSegment, PermissionRequest, SegmentUnprovenCause } from "./rules.ts";
import { deletionExecutables } from "./rules.ts";
import { shellWords } from "./shell-lexer.ts";
import { extractShellNetworkHosts } from "./shell-network.ts";
import {
  commandHasExecutableSubstitution,
  parseCommandSegments,
  shellStateCrossesSegments,
} from "./shell-segment.ts";

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
 * The dangerous route into that tier is the one shared with Codex, and only
 * that route: `Forbidden` is also reached here by `webFetchRisk`, by a
 * protected write path, and by a network target without a grant, none of which
 * Codex's dangerous-command layer decides. On the shared route, this package's
 * `isDangerousWords` mirrors Codex's `dangerous_command_match_for_exec`
 * (`is_dangerous_command.rs:123-150`) in three of its four arms — `rm` with a
 * force option, `sudo` pass-through, and the `env` assignment skip — and in the
 * wrapper depth bound of 8. It is not a mirror of the whole file. Codex's
 * `trap` arm lands in `isDangerousSegment` here; the `bash -lc` literal
 * recursion that Codex runs inside `dangerous_command_match_with_depth`
 * (`:65-72`) is done here by `parseCommandSegments`; and the basename lookup
 * Codex performs in `executable_name_lookup_key` (`:96-121`) happens in
 * `shell-segment.ts` before a segment is built. That lookup is also one
 * deliberate divergence — Codex does not fold case on POSIX, this package does
 * — as are Codex's Windows and PowerShell rules, which have no counterpart
 * here. So a reader can check the three arms and the bound against Codex
 * directly, and must look elsewhere for the rest.
 * fx is not the reference for this shape: its `Risk { low, medium,
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

/**
 * Which proof the static layer failed to make, for an action that did not get
 * a Skip. Segment-level causes are recorded at the fold itself
 * (`parseCommandSegment`); the rest are named at the tier that refuses.
 * `unproven_other` is the defensive member: reaching it means a new refusal
 * path forgot to name itself, and it must surface as `other_explicit_review`
 * rather than be guessed.
 *
 * A cause names the mechanism that failed, never the disposition it produced
 * — the `risk_not_low` rename showed that a tag naming a value from the
 * disposition vocabulary starts lying the moment that vocabulary moves. The
 * cause is observational and travels as a co-stamped residual signal; it is
 * never a skip credential (`src/permissions/residual.ts`).
 */
export type ReviewCause =
  | SegmentUnprovenCause
  | "process_control"
  | "env_context_unproven"
  | "state_crosses_segments"
  | "remote_effect_unclassified"
  | "unproven_other";

export interface RiskClassification {
  disposition: ApprovalDisposition;
  /** Present exactly when the disposition is a static review (NeedsApproval). */
  cause?: ReviewCause;
  /**
   * The argv of a segment proven dangerous from inside a live `$(…)` body.
   * This is evidence about the action itself — unlike a review cause, which
   * is a process label — so it may enter the review packet as the reason.
   */
  dangerousSubstitution?: string;
}

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
  approvedWriteRoots: string[] = [],
  protectedWritePaths: readonly string[] = [defaultSafetyConfigPath()],
  workspaceWriteRoots: readonly string[] = [request.cwd],
): ApprovalDisposition {
  return classifyRiskWithCause(
    request,
    approvedWriteRoots,
    protectedWritePaths,
    workspaceWriteRoots,
  ).disposition;
}

/**
 * `classifyRisk` with the failed proof named. The tier logic is the original
 * one — same order, same conditions — only each refusal now says which of its
 * own conjuncts it hit. `unprovenGitReason` (a `{kind, reason}` verdict whose
 * code never reached the metrics) is the precedent this closes: the code
 * travels, the human string stays optional.
 */
export function classifyRiskWithCause(
  request: PermissionRequest,
  approvedWriteRoots: string[] = [],
  protectedWritePaths: readonly string[] = [defaultSafetyConfigPath()],
  workspaceWriteRoots: readonly string[] = [request.cwd],
): RiskClassification {
  const lowerTool = request.tool.toLowerCase();
  if (lowerTool === "websearch") return { disposition: "Skip" };
  if (lowerTool === "webfetch") return { disposition: webFetchRisk(request) };
  if (request.operation === "write") {
    return {
      disposition: writeRisk(request, approvedWriteRoots, protectedWritePaths, workspaceWriteRoots),
    };
  }
  if (request.operation === "read") return { disposition: "Skip" };
  const command = typeof request.input.command === "string" ? request.input.command : undefined;
  // An execute operation with no command string is not unreadable shell, it
  // is no shell at all; naming it lex_incomplete keeps "nothing to read" and
  // "could not read" in one honest bucket.
  if (!command) return { disposition: "NeedsApproval", cause: "lex_incomplete" };
  const segments = request.commandSegments ?? normalizedSegmentsFor(command, request.cwd);
  // Tier 1 — proven dangerous (forced rm, sudo, env wrapper). Mirrors
  // codex `render_decision_for_unmatched_command_for_platform`: a proven
  // dangerous command is a review the user settles, not a hard block
  // (codex `AskForApproval::OnRequest` → `Prompt`). The static layer
  // runs only in pi's `auto` mode, which is that policy; pi has no
  // `AskForApproval::Never` mode (`yolo` bypasses this layer entirely),
  // so codex's `Never → Forbidden` arm is unreachable here. A proven
  // verdict needs no cause: `static_risk` already buckets it, and the
  // review-cause vocabulary names failed proofs, not succeeded ones.
  // Network egress is not judged here — the runtime `NetworkBoundary`
  // owns it (codex `NetworkProxy`), so a non-exempt network target is
  // no longer a static refusal.
  if (segments.some((segment) => isDangerousSegment(segment))) {
    const substituted = segments.find(
      (segment) => segment.nestedFrom === "substitution" && isDangerousSegment(segment),
    );
    return {
      disposition: "NeedsApproval",
      ...(substituted ? { dangerousSubstitution: substituted.source } : {}),
    };
  }
  // Tier 2 — proven side-effecting: the argv is fully determined, but what it
  // does is not confined by the filesystem or network policy (Unix signals).
  // This is a review, not a block, matching fx `approval_required(
  // process_or_system)`.
  if (segments.some(invocationControlsProcesses))
    return { disposition: "NeedsApproval", cause: "process_control" };
  // A segment whose surroundings are unproven — an inert `GIT_` variable, a
  // wrapper that could not be reduced — is not decomposable either, and this is
  // where that becomes a review rather than a refusal. Refusal is the network
  // layer's `unsafeReason`, which is about not being able to identify the program
  // at all; here the program is identified and only its context is unproven, so
  // tier 3 does not hold. `GIT_TRACE=1 git status` belongs: the words name git,
  // the variable changes nothing about which binary runs, and a human settles it.
  if (segments.some((segment) => segment.executableContextUntrusted))
    return { disposition: "NeedsApproval", cause: "env_context_unproven" };
  // Tier 3 — proven safe: static argv equals runtime argv for the whole
  // command, so nothing is left to prove. A rewritable argv, an unreadable
  // option grammar, or state crossing a segment boundary is not.
  const decomposable =
    !commandHasExecutableSubstitution(command) &&
    segments.every((segment) => segment.decomposable) &&
    // A compound command that publishes shell state in one segment and reads it
    // in another cannot be analysed segment by segment.
    !shellStateCrossesSegments(segments, request.cwd) &&
    // An invocation whose remote effect this layer cannot prove has not been
    // shown to be read-only.
    segments.every((segment) => !invocationRemoteEffectUnclassified(segment));
  if (decomposable) return { disposition: "Skip" };
  // Tier 4a — lex parse failure / incomplete input. codex
  // `commands_for_exec_policy_for_platform` (exec_policy.rs:876-904)
  // uses the parser's plain commands when non-empty, and only falls
  // back to the raw command vector (exec_policy.rs:900-903) — judged
  // by `dangerous_command_match_for_platform`
  // (shell-command/src/command_safety/is_dangerous_command.rs:42),
  // whose `dangerous_command_match_for_exec` (:123-147) matches the
  // first word against `rm`(+force)/`sudo`/`env`/`trap` — when the
  // parse yields none (a failed parse, or a command with no plain
  // commands such as `FOO=1` or `>out`). Mirror the fallback: judge
  // the raw command's words — a dangerous program is still a review, a
  // non-dangerous one is Allow (the default policy). pi's
  // `isDangerousWords` (dangerous-commands.ts:47-65) matches the
  // first word against `rm`/`sudo`/`env`; the matcher's `trap` and
  // shell-literal branches do not arise for the lex-incomplete /
  // no-plain-commands commands that reach this tier, so the sets
  // coincide here. A brace group is excluded: codex parses it
  // successfully and judges the commands nested inside it, so a group —
  // whose nested argv the leading word cannot see — fails closed below
  // instead of taking this fallback. The fallback needs *every* segment
  // to be `lex_incomplete`: codex's fallback hands the whole raw
  // command vector over as one unit (exec_policy.rs:900-902) and does
  // not care that one segment parsed and another did not, so one
  // segment with a stronger unproven reason
  // (command_word_unproven/substitution_unproven/heredoc_unproven/
  // wrapper_unreduced/nested_git_program/program_reinterpreted/grouped)
  // means the command is not the "no token-level expansion at all"
  // case the fallback describes, and it fails closed below as Tier 4b.
  if (
    !segments.some((segment) => segment.grouped) &&
    segments.every((segment) => segment.unprovenCause === "lex_incomplete")
  ) {
    return isDangerousWords(shellWords(command).words)
      ? { disposition: "NeedsApproval" }
      : { disposition: "Skip" };
  }
  // Tier 4b — unclassifiable: a dynamic executable word, a re-interpreted
  // string or stdin program, a substitution, a heredoc, or a brace group. The
  // static word list is not the argv that runs, so fail closed into review
  // instead of guessing.
  return {
    disposition: "NeedsApproval",
    cause: firstUnprovenCause(command, segments, request.cwd),
  };
}

/**
 * The first failed clause of the tier-3 gate, read off the same conjuncts in
 * the same order so the cause and the boolean can never disagree. Segment
 * folds report themselves; a non-decomposable segment without a reported
 * cause is a gap in the fold and surfaces as `unproven_other`, never as a
 * guessed bucket.
 */
function firstUnprovenCause(
  command: string,
  segments: readonly CommandSegment[],
  cwd: string,
): ReviewCause {
  if (commandHasExecutableSubstitution(command)) return "substitution_unproven";
  for (const segment of segments) {
    if (!segment.decomposable) return segment.unprovenCause ?? "unproven_other";
  }
  if (shellStateCrossesSegments(segments, cwd)) return "state_crosses_segments";
  if (segments.some(invocationRemoteEffectUnclassified)) return "remote_effect_unclassified";
  return "unproven_other";
}

export { isPublicNetworkHost } from "../network-host.ts";
export {
  analyzeShellGitNetwork,
  type ShellGitNetworkAnalysis,
} from "./git-network.ts";
export type { CommandSegment, PermissionRequest } from "./rules.ts";
export { extractShellNetworkHosts } from "./shell-network.ts";
export { parseCommandSegments } from "./shell-segment.ts";
