/**
 * ApprovalDisposition classification: the public entry point of the static risk layer.
 *
 * Two questions, three dispositions (codex-aligned, Q3 removed):
 *
 *   1. proven dangerous, or proven to run another program -> NeedsApproval
 *   2. everything else                                   -> Skip
 *
 * (`Forbidden` survives only outside the command path: webfetch below,
 * protected writes, and the policy-layer blocks in `risk-policy.ts`.)
 * A non-dangerous command runs; the sandbox + runtime boundary enforce
 * the restrictions without a prompt — codex `exec_policy.rs:828-836`.
 *
 * The per-command analyses live in the sibling modules; this file composes them
 * into a single `ApprovalDisposition`.
 */
import { basename, resolve } from "node:path";

import { resolvePolicyPath } from "../filesystem-policy.ts";
import { isPublicNetworkHost } from "../network-host.ts";
import { defaultSafetyConfigPath, isPathWithin } from "../policy-primitives.ts";
import { normalizedSegmentsFor } from "./cd-normalize.ts";
import { isDangerousWords } from "./dangerous-commands.ts";
import { gitExecutableEnvNames } from "./git-exec-entries.ts";
import type { CommandSegment, PermissionRequest } from "./rules.ts";
import { deletionExecutables } from "./rules.ts";
import { assignmentName, shellWords } from "./shell-lexer.ts";
import { extractShellNetworkHosts } from "./shell-network.ts";
import { parseCommandSegments } from "./shell-segment.ts";

/**
 * Privilege-boundary wrappers: doas/su always, plus sudo/env whose option
 * grammar the fold could not reduce. Measured on this machine: BSD `env -S`
 * executes its operand, and `doas`/`su` gate on auth, not on argv — none of
 * these are answerable by judging the tail. Codex has no doas/su arm and
 * misses unreduced sudo/env tails; this review is deliberately stricter.
 */
const privilegeWrappers = new Set(["sudo", "doas", "su", "env"]);

/** Builtins that publish an assignment into the environment. */
const envPublishingBuiltins = new Set(["export", "declare", "local", "readonly", "typeset", "env"]);

/** Executable words that hide the program bash will run. A leading `=`
 * is zsh filename expansion (`=rm` → `/bin/rm`); under bash it never
 * executes, but the spelling names a different shell's expansion, so it
 * reviews too. Bare `[` is the test builtin and an empty word runs
 * nothing, so neither counts as hiding. */
const hiddenExecutablePattern = /[$`{}*?[]/;

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

export interface RiskClassification {
  disposition: ApprovalDisposition;
  /**
   * The argv of a segment proven dangerous from inside a live `$(…)` body.
   * This is evidence about the action itself, so it may enter the review
   * packet as the reason. (Cut 3: the `cause` field is gone with the Q3
   * proof gate — a proven verdict carries no failed proof.)
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
  protectedWritePaths: readonly string[] = [defaultSafetyConfigPath()],
): ApprovalDisposition {
  if (
    request.resolvedPaths.some((path) =>
      protectedWritePaths.some((control) => isPathWithin(path, control)),
    )
  ) {
    return "Forbidden";
  }
  // Cut 3: a write outside the roots is no longer a static review — the
  // sandboxed file operations deny it at runtime (with the exact-denial
  // recovery review), mirroring codex letting the sandbox enforce. Only
  // the protected-path carve-out above stays a refusal.
  return "Skip";
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
  protectedWritePaths: readonly string[] = [defaultSafetyConfigPath()],
): ApprovalDisposition {
  return classifyRiskWithCause(request, protectedWritePaths).disposition;
}

/**
 * The static question, codex-aligned: proven dangerous (or proven to run
 * another program) → NeedsApproval, everything else → Skip. The runtime
 * sandbox owns the rest.
 */
export function classifyRiskWithCause(
  request: PermissionRequest,
  protectedWritePaths: readonly string[] = [defaultSafetyConfigPath()],
): RiskClassification {
  const lowerTool = request.tool.toLowerCase();
  if (lowerTool === "websearch") return { disposition: "Skip" };
  if (lowerTool === "webfetch") return { disposition: webFetchRisk(request) };
  if (request.operation === "write") {
    return {
      disposition: writeRisk(request, protectedWritePaths),
    };
  }
  if (request.operation === "read") return { disposition: "Skip" };
  const command = typeof request.input.command === "string" ? request.input.command : undefined;
  // An execute operation with no command string is no shell at all: no argv,
  // no dangerous evidence — Skip, mirroring the codex fallback that judges
  // the (empty) word vector non-dangerous.
  if (!command) return { disposition: "Skip" };
  const segments = request.commandSegments ?? normalizedSegmentsFor(command, request.cwd);
  // Proven dangerous (forced rm, sudo, env wrapper). Mirrors
  // codex `render_decision_for_unmatched_command_for_platform`: a proven
  // dangerous command is a review the user settles, not a hard block
  // (codex `AskForApproval::OnRequest` → `Prompt`). The static layer
  // runs only in pi's `auto` mode, which is that policy; pi has no
  // `AskForApproval::Never` mode (`yolo` bypasses this layer entirely),
  // so codex's `Never → Forbidden` arm is unreachable here. A proven
  // verdict needs no cause: `static_risk` already buckets it.
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
  // Proven nested-program execution (cut 3 promotion): Git told to run
  // another program — a shell alias, a pager, `bisect run`, a filter —
  // names that program in the argv, so this is proven, not unproven.
  // It used to ride Tier 4 as `nested_git_program`; failing it closed
  // there was a category error, and deleting Tier 4 must not release it.
  // Codex has no Git arm — this review is ours, deliberately. The export
  // form (`export GIT_EDITOR=…; git commit`) never reached the fold's
  // cause, so it is named here too.
  if (
    segments.some(
      (segment) =>
        segment.unprovenCause === "nested_git_program" ||
        (envPublishingBuiltins.has(segment.executable) &&
          segment.args.some((arg) => {
            const name = assignmentName(arg);
            return name !== undefined && gitExecutableEnvNames.has(name);
          })),
    )
  ) {
    return { disposition: "NeedsApproval" };
  }
  // Unreduced privilege wrapper (cut 3 retention): doas/su gate on auth,
  // and an unreduced sudo/env tail is where the command hides. The fold
  // mangles these words past recognition (`sudo -D` → exe `-d`), so read
  // the segment source instead. Plain reduced forms (`sudo kill`, `env
  // FOO=1 cmd`) keep whatever verdict the checks above and below give.
  if (
    segments.some(
      (segment) =>
        segment.unprovenCause === "wrapper_unreduced" &&
        privilegeWrappers.has(
          basename((shellWords(segment.source).words[0] ?? "").toLowerCase()),
        ),
    )
  ) {
    return { disposition: "NeedsApproval" };
  }
  // Hidden executable word (cut 3 retention): brace expansion, variable
  // and command substitution, zsh `=` expansion, and globs decide the
  // program at runtime — measured live (`{rm,echo} -f victim` and
  // `cmd=rm; $cmd -f victim` both delete). Bare `[` is the test builtin
  // and an empty word runs nothing, so neither counts as hiding.
  if (
    segments.some(
      (segment) =>
        segment.executable !== "" &&
        segment.executable !== "[" &&
        (segment.executable.startsWith("=") || hiddenExecutablePattern.test(segment.executable)),
    )
  ) {
    return { disposition: "NeedsApproval" };
  }
  // Codex alignment, cut 3: everything else is Skip. The Q3 proof gate
  // (Tier 3 decomposable), the lex fallback (Tier 4a) and the fail-closed
  // fold (Tier 4b) are gone: a non-dangerous command runs, and the
  // sandbox + runtime boundary enforce the restrictions without a
  // prompt — codex `exec_policy.rs:828-836` verbatim.
  return { disposition: "Skip" };
}

export { isPublicNetworkHost } from "../network-host.ts";
export {
  analyzeShellGitNetwork,
  type ShellGitNetworkAnalysis,
} from "./git-network.ts";
export type { CommandSegment, PermissionRequest } from "./rules.ts";
export { extractShellNetworkHosts } from "./shell-network.ts";
export { parseCommandSegments } from "./shell-segment.ts";
