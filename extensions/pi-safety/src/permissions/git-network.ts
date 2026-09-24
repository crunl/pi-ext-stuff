/**
 * Git-specific analysis: remote parsing for network targets, plus the Git
 * invocations and config keys that make Git run another program.
 */
import { parseGitRemoteTarget } from "../network-host.ts";
import { assignmentName } from "./dangerous-commands.ts";
import type { CommandSegment } from "./rules.ts";
import { scanShellSyntax } from "./shell-lexer.ts";
import { parseCommandSegments } from "./shell-segment.ts";

const gitNetworkSubcommands = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);

type GitRemotePurpose = "fetch" | "push";

type ParsedGitRemote =
  | { kind: "implicit"; purpose: GitRemotePurpose }
  | { kind: "host"; purpose: GitRemotePurpose; host: string }
  | { kind: "local"; purpose: GitRemotePurpose }
  | { kind: "unsafe"; purpose: GitRemotePurpose; reason: string };

interface GitRemoteOptionGrammar {
  flags: ReadonlySet<string>;
  values: ReadonlySet<string>;
  optionalValues: ReadonlySet<string>;
}

function optionSet(options: string): ReadonlySet<string> {
  return new Set(options.split(/\s+/).filter(Boolean));
}

const gitRemoteOptionGrammar = new Map<string, GitRemoteOptionGrammar>([
  [
    "clone",
    {
      flags: optionSet(
        "--bare --dissociate --ipv4 --ipv6 --local --mirror --no-checkout --no-hardlinks --no-reject-shallow --no-single-branch --no-tags --progress --quiet --reject-shallow --shared --single-branch --sparse --verbose -4 -6 -n -q -s -v",
      ),
      values: optionSet(
        "--branch --config --depth --filter --jobs --origin --reference --reference-if-able --revision --separate-git-dir --server-option --shallow-exclude --shallow-since --template --upload-pack -b -c -j -o -u",
      ),
      optionalValues: optionSet("--recurse-submodules"),
    },
  ],
  [
    "fetch",
    {
      flags: optionSet(
        "--all --append --atomic --auto-maintenance --dry-run --force --ipv4 --ipv6 --keep --multiple --no-auto-maintenance --no-recurse-submodules --no-tags --prune --prune-tags --quiet --show-forced-updates --tags --update-head-ok --verbose --write-commit-graph -4 -6 -a -f -k -p -q -t -v",
      ),
      values: optionSet(
        "--deepen --depth --filter --jobs --negotiation-tip --refmap --server-option --shallow-exclude --shallow-since --submodule-prefix --upload-pack -j -o -u",
      ),
      optionalValues: optionSet("--recurse-submodules"),
    },
  ],
  [
    "pull",
    {
      flags: optionSet(
        "--all --autostash --ff --ff-only --force --no-autostash --no-commit --no-edit --no-ff --no-rebase --no-stat --no-tags --prune --quiet --signoff --stat --tags --verbose -f -n -q -r -s -v",
      ),
      values: optionSet(
        "--cleanup --depth --gpg-sign --jobs --server-option --strategy --strategy-option --upload-pack -j -S -s -u -X",
      ),
      optionalValues: optionSet("--rebase"),
    },
  ],
  [
    "push",
    {
      flags: optionSet(
        "--all --atomic --delete --dry-run --follow-tags --force --force-if-includes --ipv4 --ipv6 --mirror --no-thin --no-verify --porcelain --prune --quiet --set-upstream --tags --thin --verbose -4 -6 -f -n -q -u -v",
      ),
      values: optionSet("--exec --push-option --receive-pack --repo -o"),
      optionalValues: optionSet("--force-with-lease --signed"),
    },
  ],
  [
    "ls-remote",
    {
      flags: optionSet(
        "--branches --exit-code --get-url --heads --quiet --refs --symref --tags -q",
      ),
      values: optionSet("--sort --upload-pack -u"),
      optionalValues: new Set(),
    },
  ],
]);

const safeGitGlobalOptions = new Set([
  "--no-pager",
  "--paginate",
  "-p",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
  "--no-lazy-fetch",
  "--no-advice",
]);

const unsafeGitGlobalValueOptions = new Set([
  "-c",
  "-C",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);

const recognizedGitSubcommands = new Set([...gitNetworkSubcommands, "config", "submodule"]);

/**
 * Config keys whose value is a program Git will run directly. A shell alias is
 * matched by prefix, since `alias.<anything>` is invoked as a command.
 *
 * `core.hooksPath` is deliberately absent: it names a directory Git searches
 * for hook files rather than a program it execs, and gating ordinary mutations
 * on it is a locked contract (`tests/risk-policy.test.ts:825-840`). The
 * residual path — write an executable hook, then point Git at its directory —
 * depends on writing a runnable file first, which the static layer does not
 * police either.
 */
const gitExecutableConfigKeys = new Set([
  "core.pager",
  "core.editor",
  "core.sshcommand",
  "core.gitproxy",
  "core.askpass",
  "core.fsmonitor",
  "sequence.editor",
  "credential.helper",
  "diff.external",
  // Git config keys are matched lowercased, so this entry is too.
  "interactive.difffilter",
  "merge.tool",
  "gpg.program",
  "uploadpack.packobjectshook",
  "receivepack.packobjectshook",
]);

/** Per-driver config keys whose value is a command Git execs. */
const gitExecutableConfigSuffixes = [".clean", ".smudge", ".process", ".command"];

/** `GIT_*` overrides that substitute an executable Git will run. */
const gitExecutableEnvNames = new Set([
  "GIT_ASKPASS",
  "GIT_EDITOR",
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_SEQUENCE_EDITOR",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
]);

/** Subcommands that only run a command in one of their sub-forms. */
const gitCommandRunningSubcommands = new Map([
  ["bisect", new Set(["run"])],
  ["hook", new Set(["run"])],
  // Every `filter-branch` form rewrites history through a shell command.
  ["filter-branch", undefined],
]);

function gitConfigKeyIsExecutable(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (gitExecutableConfigKeys.has(normalized)) return true;
  if (normalized.startsWith("alias.")) return true;
  return gitExecutableConfigSuffixes.some((suffix) => normalized.endsWith(suffix));
}

/**
 * Whether this Git invocation can run a program the static words never name.
 *
 * Codex's `is_dangerous_command` has no Git arm at all (removed in `fc073c9`),
 * so a shell alias or a `bisect run` payload reaches the sandbox with no nested
 * inspection. Once Git has been told to execute something, the segment's argv
 * describes the wrapper rather than the program, so it cannot be proven
 * decomposable.
 */
export function gitExecutesNestedProgram(
  words: readonly string[],
  args: readonly string[],
): boolean {
  for (const word of words) {
    const name = assignmentName(word);
    if (name === undefined) continue;
    if (gitExecutableEnvNames.has(name.toUpperCase())) return true;
    // `GIT_CONFIG_PARAMETERS` and the `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` /
    // `GIT_CONFIG_VALUE_n` triple can set any config key, including an alias.
    if (/^GIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$/.test(name.toUpperCase())) return true;
  }
  let subcommand: string | undefined;
  let subcommandIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    // `--exec-path`/`GIT_EXEC_PATH` put a directory on Git's search path for
    // `git-<subcommand>` dispatch, so any later subcommand may be that program.
    if (token === "--exec-path") return true;
    if (token.startsWith("--exec-path=")) return true;
    if (token === "-c" || token === "--config-env") {
      const value = args[index + 1];
      if (value === undefined || gitConfigKeyIsExecutable(value.split("=", 1)[0] ?? ""))
        return true;
      index += 1;
      continue;
    }
    if (token.startsWith("-c") && token.length > 2) {
      if (gitConfigKeyIsExecutable(token.slice(2).split("=", 1)[0] ?? "")) return true;
      continue;
    }
    if (token.startsWith("--config-env=")) {
      if (gitConfigKeyIsExecutable(token.slice("--config-env=".length).split("=", 1)[0] ?? "")) {
        return true;
      }
      continue;
    }
    // Every remaining value-taking global option consumes the next word. If
    // that value were read as the subcommand, `git -C /tmp bisect run CMD`
    // would hide both the real subcommand and its payload.
    if (unsafeGitGlobalValueOptions.has(token)) {
      if (args[index + 1] === undefined) return true;
      index += 1;
      continue;
    }
    if (token.startsWith("-") && token.includes("=")) continue;
    if (!token.startsWith("-")) {
      subcommand = token.toLowerCase();
      subcommandIndex = index;
      break;
    }
  }
  if (subcommand === undefined) return false;
  if (subcommand === "config") {
    // `git config alias.x '!cmd'` persists an executable entry point. It runs
    // on some later Git invocation, not this one, but the write is what makes
    // the next call dangerous.
    return args.some((arg) => gitConfigKeyIsExecutable(arg.split("=", 1)[0] ?? ""));
  }
  if (!gitCommandRunningSubcommands.has(subcommand)) {
    return subcommand === "submodule" && args.some((arg) => arg === "foreach" || arg === "--exec");
  }
  const requiredSubcommand = gitCommandRunningSubcommands.get(subcommand);
  if (requiredSubcommand === undefined) return true;
  // The dangerous form follows the subcommand: `git bisect run CMD`.
  const form = args[subcommandIndex + 1]?.toLowerCase();
  return form !== undefined && requiredSubcommand.has(form);
}

interface GitInvocation {
  segment: CommandSegment;
  kind: "git" | "gh";
  subcommand?: string;
  arguments: string[];
  globalOptionsSafe: boolean;
  trusted: boolean;
}

function relevantGitSubcommandIndex(args: readonly string[], start: number): number | undefined {
  for (let index = start; index < args.length; index += 1) {
    if (recognizedGitSubcommands.has((args[index] ?? "").toLowerCase())) return index;
  }
  return undefined;
}

function parseGitSubcommand(args: readonly string[]): {
  index?: number;
  safe: boolean;
} {
  let index = 0;
  let safe = true;
  while (index < args.length) {
    const token = args[index] ?? "";
    if (token === "--") {
      const candidate = args[index + 1];
      return candidate ? { index: index + 1, safe } : { safe: false };
    }
    if (!token.startsWith("-") || token === "-") return { index, safe };
    if (safeGitGlobalOptions.has(token)) {
      index += 1;
      continue;
    }
    const optionName = token.split("=", 1)[0] ?? token;
    if (
      unsafeGitGlobalValueOptions.has(optionName) ||
      token.startsWith("-c") ||
      token.startsWith("-C")
    ) {
      safe = false;
      const hasAttachedValue =
        token.includes("=") ||
        (token.length > 2 && (token.startsWith("-c") || token.startsWith("-C")));
      index += hasAttachedValue ? 1 : 2;
      continue;
    }
    safe = false;
    const candidate = relevantGitSubcommandIndex(args, index + 1);
    return candidate === undefined ? { safe } : { index: candidate, safe };
  }
  return { safe };
}

export function parseGitInvocation(segment: CommandSegment): GitInvocation | undefined {
  if (segment.executable !== "git" && segment.executable !== "gh") return undefined;
  if (segment.executable === "gh") {
    const positional = segment.args.filter((argument) => !argument.startsWith("-"));
    return {
      segment,
      kind: "gh",
      subcommand: positional[0]?.toLowerCase(),
      arguments: positional.slice(1),
      globalOptionsSafe: true,
      trusted: segment.executableTrusted,
    };
  }
  const parsed = parseGitSubcommand(segment.args);
  const subcommand =
    parsed.index === undefined ? undefined : segment.args[parsed.index]?.toLowerCase();
  const commandArguments = parsed.index === undefined ? [] : segment.args.slice(parsed.index + 1);
  return {
    segment,
    kind: "git",
    subcommand,
    arguments: commandArguments,
    globalOptionsSafe: parsed.safe,
    trusted: segment.executableTrusted,
  };
}

function parsedGitInvocations(command: string): GitInvocation[] {
  return parseCommandSegments(command).flatMap((segment) => {
    const invocation = parseGitInvocation(segment);
    return invocation ? [invocation] : [];
  });
}

export function gitInvocationUsesNetwork(invocation: GitInvocation): boolean {
  if (invocation.kind !== "git" || !invocation.subcommand) return false;
  return (
    gitNetworkSubcommands.has(invocation.subcommand) ||
    (invocation.subcommand === "submodule" &&
      invocation.arguments.some((argument) => argument === "add" || argument === "update"))
  );
}

function remotePurpose(invocation: GitInvocation): GitRemotePurpose {
  return invocation.subcommand === "push" ? "push" : "fetch";
}

function classifyGitRemoteOperand(operand: string, purpose: GitRemotePurpose): ParsedGitRemote {
  const explicit =
    operand.startsWith("/") ||
    operand.startsWith("./") ||
    operand.startsWith("../") ||
    operand.startsWith("~/") ||
    operand.includes("/") ||
    operand.includes(":");
  if (!explicit) return { kind: "implicit", purpose };
  const target = parseGitRemoteTarget(operand);
  if (target.kind === "host") return { kind: "host", purpose, host: target.host };
  if (target.kind === "local") return { kind: "local", purpose };
  return { kind: "unsafe", purpose, reason: target.reason };
}

const gitSubmoduleAddFlags = optionSet("--dissociate --force --progress --quiet -f -q");

const gitSubmoduleAddValueOptions = optionSet(
  "--branch --depth --name --reference --ref-format -b",
);

function parseGitSubmoduleAddRemote(
  args: readonly string[],
  purpose: GitRemotePurpose,
): ParsedGitRemote {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (token === "--") {
      const operand = args[index + 1];
      return operand
        ? classifyGitRemoteOperand(operand, purpose)
        : { kind: "unsafe", purpose, reason: "missing Git submodule remote operand" };
    }
    if (!token.startsWith("-") || token === "-") {
      return classifyGitRemoteOperand(token, purpose);
    }
    const equals = token.indexOf("=");
    const option = equals < 0 ? token : token.slice(0, equals);
    if (gitSubmoduleAddFlags.has(option)) {
      if (equals >= 0) {
        return { kind: "unsafe", purpose, reason: "malformed Git submodule option" };
      }
      continue;
    }
    if (gitSubmoduleAddValueOptions.has(option)) {
      const value = equals >= 0 ? token.slice(equals + 1) : args[index + 1];
      if (!value) {
        return { kind: "unsafe", purpose, reason: "missing Git submodule option value" };
      }
      if (equals < 0) index += 1;
      continue;
    }
    const shortOptionWithValue = [...gitSubmoduleAddValueOptions].find(
      (candidate) =>
        candidate.startsWith("-") &&
        !candidate.startsWith("--") &&
        token.startsWith(candidate) &&
        token.length > candidate.length,
    );
    if (shortOptionWithValue) continue;
    if (
      /^-[A-Za-z]+$/.test(token) &&
      [...token.slice(1)].every((character) => gitSubmoduleAddFlags.has(`-${character}`))
    ) {
      continue;
    }
    return { kind: "unsafe", purpose, reason: "unrecognized Git submodule option" };
  }
  return { kind: "unsafe", purpose, reason: "missing Git submodule remote operand" };
}

function parsedGitRemotes(invocation: GitInvocation): ParsedGitRemote[] {
  if (!gitInvocationUsesNetwork(invocation)) return [];
  const purpose = remotePurpose(invocation);
  if (!invocation.trusted) {
    return [{ kind: "unsafe", purpose, reason: "untrusted Git executable or wrapper context" }];
  }
  if (!invocation.globalOptionsSafe) {
    return [{ kind: "unsafe", purpose, reason: "unsafe Git global option" }];
  }
  const subcommand = invocation.subcommand ?? "";
  if (subcommand === "submodule") {
    const actionIndex = invocation.arguments.findIndex(
      (argument) => argument === "add" || argument === "update",
    );
    if (actionIndex < 0) return [];
    if (invocation.arguments[actionIndex] === "update") {
      return [{ kind: "implicit", purpose }];
    }
    return [parseGitSubmoduleAddRemote(invocation.arguments.slice(actionIndex + 1), purpose)];
  }

  const grammar = gitRemoteOptionGrammar.get(subcommand);
  const noValueOptions = grammar?.flags ?? new Set<string>();
  const valueOptions = grammar?.values ?? new Set<string>();
  const optionalValueOptions = grammar?.optionalValues ?? new Set<string>();
  let repositoryOption: string | undefined;
  let multipleFetch = false;
  const multipleFetchOperands: string[] = [];
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const token = invocation.arguments[index] ?? "";
    if (token === "--") {
      if (repositoryOption) return [classifyGitRemoteOperand(repositoryOption, purpose)];
      const operands = invocation.arguments.slice(index + 1);
      if (multipleFetch) {
        return operands.length > 0
          ? operands.map((operand) => classifyGitRemoteOperand(operand, purpose))
          : [{ kind: "unsafe", purpose, reason: "missing Git remote operand" }];
      }
      const operand = operands[0];
      return operand
        ? [classifyGitRemoteOperand(operand, purpose)]
        : [{ kind: "unsafe", purpose, reason: "missing Git remote operand" }];
    }
    if (!token.startsWith("-") || token === "-") {
      if (repositoryOption) return [classifyGitRemoteOperand(repositoryOption, purpose)];
      if (multipleFetch) {
        multipleFetchOperands.push(token);
        continue;
      }
      return [classifyGitRemoteOperand(token, purpose)];
    }
    const equals = token.indexOf("=");
    const option = equals < 0 ? token : token.slice(0, equals);
    if (optionalValueOptions.has(option)) {
      if (equals >= 0 && token.slice(equals + 1).length === 0) {
        return [{ kind: "unsafe", purpose, reason: "missing Git remote option value" }];
      }
      continue;
    }
    if (noValueOptions.has(option)) {
      if (equals >= 0) {
        return [{ kind: "unsafe", purpose, reason: "malformed Git remote option" }];
      }
      if (subcommand === "fetch" && option === "--multiple") multipleFetch = true;
      continue;
    }
    if (valueOptions.has(option)) {
      const value = equals >= 0 ? token.slice(equals + 1) : invocation.arguments[index + 1];
      if (!value) return [{ kind: "unsafe", purpose, reason: "missing Git remote option value" }];
      if (equals < 0) index += 1;
      if (option === "--repo") repositoryOption = value;
      continue;
    }
    const shortOptionWithValue = [...valueOptions].find(
      (candidate) =>
        candidate.startsWith("-") &&
        !candidate.startsWith("--") &&
        token.startsWith(candidate) &&
        token.length > candidate.length,
    );
    if (shortOptionWithValue) continue;
    if (
      /^-[A-Za-z]+$/.test(token) &&
      [...token.slice(1)].every((character) => noValueOptions.has(`-${character}`))
    ) {
      continue;
    }
    return [{ kind: "unsafe", purpose, reason: "unrecognized Git remote option" }];
  }
  if (repositoryOption) return [classifyGitRemoteOperand(repositoryOption, purpose)];
  if (multipleFetch) {
    return multipleFetchOperands.length > 0
      ? multipleFetchOperands.map((operand) => classifyGitRemoteOperand(operand, purpose))
      : [{ kind: "unsafe", purpose, reason: "missing Git remote operand" }];
  }
  if (subcommand === "push" || subcommand === "fetch" || subcommand === "pull") {
    return [{ kind: "implicit", purpose }];
  }
  return [{ kind: "unsafe", purpose, reason: "missing Git remote operand" }];
}

export interface ShellGitNetworkAnalysis {
  usesImplicitNetwork: boolean;
  directImplicitPurpose?: GitRemotePurpose;
  explicitHosts: string[];
  unsafeReason?: string;
}

export function analyzeShellGitNetwork(command: string): ShellGitNetworkAnalysis {
  const segments = parseCommandSegments(command);
  const syntax = scanShellSyntax(command);
  const remotes = parsedGitInvocations(command).flatMap((invocation) => {
    return parsedGitRemotes(invocation).map((remote) => ({ invocation, remote }));
  });
  const unsafeReason = remotes.find(({ remote }) => remote.kind === "unsafe")?.remote;
  const direct = remotes.length === 1 ? remotes[0] : undefined;
  const directImplicitPurpose =
    segments.length === 1 &&
    direct?.remote.kind === "implicit" &&
    !syntax.hasActiveControl &&
    !direct.invocation.segment.hasRedirect &&
    !direct.invocation.segment.hasSubstitution &&
    !direct.invocation.segment.nestedShell
      ? direct.remote.purpose
      : undefined;
  return {
    usesImplicitNetwork: remotes.some(({ remote }) => remote.kind === "implicit"),
    ...(directImplicitPurpose ? { directImplicitPurpose } : {}),
    explicitHosts: remotes.flatMap(({ remote }) => (remote.kind === "host" ? [remote.host] : [])),
    ...(unsafeReason?.kind === "unsafe" ? { unsafeReason: unsafeReason.reason } : {}),
  };
}
