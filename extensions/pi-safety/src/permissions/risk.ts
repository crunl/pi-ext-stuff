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
import { isDangerousWords } from "./dangerous-commands.ts";
import { isPathWithin } from "./paths.ts";
import type { CommandSegment, PermissionRequest } from "./rules.ts";
import { scanShellSyntax } from "./shell-lexer.ts";
import { extractShellNetworkHosts, invocationUsesNetwork } from "./shell-network.ts";
import { hasTerminalInfoFlag, parseCommandSegments } from "./shell-segment.ts";

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

/**
 * Commands that act on process state rather than on files or arguments. SRT
 * confines the filesystem and the network but cannot observe Unix signals, so
 * a process-control command stays reviewable even though its argv is fully
 * determined.
 *
 * fx classifies the same primitive as `process_or_system`
 * (`command_effect.zig:894-906`). `killall` is the macOS/BSD spelling of
 * `pkill` and is not in fx's list; it is included here because leaving it next
 * to a gated `pkill` would be incoherent.
 */
const processControlExecutables = new Set(["kill", "pkill", "killall"]);

/**
 * `kill` invocations that only report: `-l` lists signal names, `--version`
 * and `--help` print and exit. None of them signal a process. Any other
 * argument form is treated as process control, so a mixed invocation such as
 * `kill -l -9 1` still reviews.
 */
const processControlReportFlags = new Set(["-l", "--list", "-L", "--table", "--version", "--help"]);

function invocationControlsProcesses(segment: CommandSegment): boolean {
  if (!processControlExecutables.has(segment.executable)) return false;
  if (segment.executable !== "kill") return true;
  // A bare `kill` names no process; it is left to the shell to reject.
  if (segment.args.length === 0) return false;
  return !segment.args.every((arg) => processControlReportFlags.has(arg));
}

/**
 * Global options that take a value across the CLIs below, so the word after one
 * is an option value rather than the subcommand.
 */
const cliGlobalValueFlags = new Set([
  "-n",
  "--namespace",
  "-c",
  "--context",
  "--project",
  "--profile",
  "-p",
  "--region",
  "-g",
  "--group",
  "--cluster",
  "-u",
  "--user",
  "-t",
  "--tenant",
]);

/**
 * The leading operands that are neither flags nor the value of a value-taking
 * flag. Verb depth varies by tool — `kubectl exec` puts it first, `aws s3 rm`
 * and `gh pr merge` second, `gcloud compute instances delete` third — so the
 * first three positions are compared against the tool's verb set.
 */
function leadingOperands(args: readonly string[], valueFlags: ReadonlySet<string>): string[] {
  const operands: string[] = [];
  for (let index = 0; index < args.length && operands.length < 3; index += 1) {
    const token = args[index] ?? "";
    if (valueFlags.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    operands.push(token.toLowerCase());
  }
  return operands;
}

/**
 * CLI verbs are sometimes compound (`terminate-instances`, `delete-bucket`),
 * so a `verb-` prefix counts as the verb. An exact-only match would let those
 * through, while the prefixes used here (`get-`, `list-`, `describe-`) are not
 * themselves mutation verbs.
 */
function matchesMutationVerb(operand: string, verbs: ReadonlySet<string>): boolean {
  if (verbs.has(operand)) return true;
  const dash = operand.indexOf("-");
  return dash > 0 && verbs.has(operand.slice(0, dash));
}

/** Subcommands that mutate remote state through a control-plane API. */
const cliMutationVerbs = new Map<string, ReadonlySet<string>>([
  [
    "kubectl",
    new Set([
      "annotate",
      "apply",
      "attach",
      "autoscale",
      "cordon",
      "cp",
      "create",
      "debug",
      "delete",
      "drain",
      "edit",
      "exec",
      "expose",
      "label",
      "patch",
      "port-forward",
      "replace",
      "rollout",
      "run",
      "scale",
      "set",
      "taint",
    ]),
  ],
  [
    "aws",
    new Set([
      "attach",
      "authorize",
      "cancel",
      "copy",
      "create",
      "delete",
      "deploy",
      "deregister",
      "detach",
      "disable",
      "disassociate",
      "enable",
      "import",
      "install",
      "invoke",
      "modify",
      "publish",
      "put",
      "reboot",
      "reinstall",
      "register",
      "release",
      "remove",
      "replicate",
      "reset",
      "restore",
      "revoke",
      "rm",
      "run",
      "start",
      "stop",
      "sync",
      "terminate",
      "unassociate",
      "unregister",
      "update",
    ]),
  ],
  [
    "gcloud",
    new Set([
      "add-iam-policy-binding",
      "create",
      "delete",
      "deploy",
      "destroy",
      "remove-iam-policy-binding",
      "set-iam-policy",
      "start",
      "stop",
      "update",
    ]),
  ],
  ["az", new Set(["create", "delete", "destroy", "remove", "start", "stop", "update"])],
  ["helm", new Set(["install", "rollback", "uninstall", "upgrade"])],
  [
    "gh",
    new Set([
      "cancel",
      "close",
      "create",
      "delete",
      "deploy",
      "merge",
      "publish",
      "reopen",
      "rerun",
      "sync",
    ]),
  ],
  ["npm", new Set(["deprecate", "dist-tag", "owner", "publish", "unpublish"])],
  ["pnpm", new Set(["deprecate", "owner", "publish", "unpublish"])],
  ["yarn", new Set(["deprecate", "owner", "publish", "unpublish"])],
  ["cargo", new Set(["owner", "publish", "yank"])],
  ["twine", new Set(["upload"])],
  ["poetry", new Set(["publish"])],
  ["doctl", new Set(["create", "delete", "rename", "update"])],
]);

/**
 * Tools whose first operand is a noun rather than a verb, so only the second
 * operand may be read as the verb. `gh run list` is read-only even though
 * `run` is a mutation verb elsewhere; every other tool is scanned across the
 * first three, because `kubectl exec`, `aws s3 rm`, and
 * `gcloud compute instances delete` place the verb at different depths.
 */
const cliNounLedCommands = new Set(["gh"]);

/** `terraform`/`tofu` take their verb as the first operand. */
const terraformMutationSubcommands = new Set([
  "apply",
  "destroy",
  "force-unlock",
  "import",
  "refresh",
  "taint",
  "untaint",
]);

/** CLIs whose bare invocation already deploys or mutates external state. */
const wholeInvocationIsExternal = new Set(["vercel", "netlify", "wrangler", "flyctl", "heroku"]);

function invocationHasExternalSideEffect(segment: CommandSegment): boolean {
  if (segment.executable === "terraform" || segment.executable === "tofu") {
    return terraformMutationSubcommands.has(segment.args[0]?.toLowerCase() ?? "");
  }
  if (wholeInvocationIsExternal.has(segment.executable)) {
    // These CLIs deploy by default, so the invocation as a whole is external.
    // A version or help query still only prints.
    return !hasTerminalInfoFlag(segment.args);
  }
  const verbs = cliMutationVerbs.get(segment.executable);
  if (verbs === undefined) return false;
  const operands = leadingOperands(segment.args, cliGlobalValueFlags);
  const candidates = cliNounLedCommands.has(segment.executable) ? operands.slice(1) : operands;
  return candidates.some((operand) => matchesMutationVerb(operand, verbs));
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
  if (
    segments.some(
      (segment) =>
        isDangerousSegment(segment) ||
        (!networkApproved && invocationUsesNetwork(segment)) ||
        invocationHasExternalSideEffect(segment),
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
  // this tier; only a rewritable argv is not.
  const decomposable =
    !scanShellSyntax(command).hasExecutableSubstitution &&
    segments.every((segment) => segment.decomposable);
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
