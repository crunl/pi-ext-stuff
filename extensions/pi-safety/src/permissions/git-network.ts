/**
 * Git-specific analysis: remote parsing for network targets, plus the Git
 * invocations and config keys that make Git run another program.
 */
import { parseGitRemoteTarget } from "../network-host.ts";
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

/**
 * Global options that cannot relocate the repository, name a program, or change
 * what a command does. `--version`, `--help` and `-h` are here for the ordinary
 * reason that `git --version` is the most harmless Git invocation there is, and
 * leaving them out made the spelling decide: `git version` auto-approved while
 * `git --version` needed review, which is not a distinction any reader could
 * derive from the commands. They take no value, so there is no value word for an
 * unknown option to be mistaken for.
 */
const safeGitGlobalOptions = new Set([
  "--version",
  "--help",
  "-h",
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

const recognizedGitSubcommands = new Set([
  ...gitNetworkSubcommands,
  "config",
  "remote",
  "submodule",
]);

/**
 * `git remote` is mixed: most of its actions are local config edits, but three
 * contact the remote and therefore resolve a bare remote name to a destination
 * that lives in repository metadata rather than in the command text.
 *
 * Returns the named remotes for such an action, `null` when the action covers
 * every remote, and `undefined` when the action never leaves the machine. The
 * distinction matters for the same reason it does for `push`: a bare operand is
 * a config lookup, while `set-url`'s operand is config text the user is
 * replacing, not one being resolved.
 */
function gitRemoteNetworkOperands(invocation: GitInvocation): string[] | null | undefined {
  if (invocation.subcommand !== "remote") return undefined;
  const actionIndex = invocation.arguments.findIndex((argument) => !argument.startsWith("-"));
  if (actionIndex < 0) return undefined;
  const action = (invocation.arguments[actionIndex] ?? "").toLowerCase();
  const operands = invocation.arguments.slice(actionIndex + 1).filter((argument) => {
    return !argument.startsWith("-");
  });
  if (action === "update") return operands.length > 0 ? operands : null;
  if (action === "show") {
    // `-n` / `--no-query` answers from the local remote-tracking refs.
    return invocation.arguments.some((argument) => argument === "-n" || argument === "--no-query")
      ? undefined
      : operands.length > 0
        ? operands
        : null;
  }
  if (action === "set-head") {
    // Without `--auto` the head is taken from the operand; with it, from the
    // remote's own HEAD.
    return invocation.arguments.some((argument) => argument === "-a" || argument === "--auto")
      ? operands.length > 0
        ? operands
        : null
      : undefined;
  }
  return undefined;
}

/**
 * A `git` invocation with its subcommand and payload separated from Git's
 * global options. Only `git` is modelled here: `gh` is a different tool with
 * its own network and mutation semantics, handled in `shell-network.ts` and
 * `command-effects.ts`.
 */
interface GitInvocation {
  segment: CommandSegment;
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
    // `-c KEY=VALUE` and `--config-env KEY=ENVNAME` set any config key, so on
    // this path they are unconditionally unsafe. They are deliberately NOT
    // judged by `gitConfigKeyIsScalar`, which answers a different question: that
    // one asks whether the value can make Git run a program, while this flag also
    // decides whether a remote destination can be bound. A key can be inert for
    // code execution and still redirect the destination —
    // `remote.<name>.url=ext::cmd` does both. Routing this through the
    // code-execution allowlist made `git -c remote.evil.url=… ls-remote evil`
    // auto-approve, and the two layers were never actually in conflict: this one
    // governed only when the subcommand reached a remote, where it over-refused
    // even a key the other layer had proved inert (`git -c user.name=Ada push`
    // was Forbidden while `git -c user.name=Ada commit` was auto-approved).
    //
    // A malformed spelling is unsafe too: git rejects a `-c` whose value has no
    // `=`, and a form the parser cannot read is not a form it can clear.
    if (token === "-c" || token === "--config-env") {
      const value = args[index + 1];
      if (value === undefined || !value.includes("=")) safe = false;
      index += 2;
      continue;
    }
    if (token.startsWith("-c") && token.length > 2) {
      if (!token.slice(2).includes("=")) safe = false;
      index += 1;
      continue;
    }
    if (token.startsWith("--config-env=")) {
      const assignment = token.slice("--config-env=".length);
      const envName = assignment.split("=", 2)[1];
      if (envName === undefined || envName === "") safe = false;
      index += 1;
      continue;
    }
    if (unsafeGitGlobalValueOptions.has(optionName) || token.startsWith("-C")) {
      safe = false;
      const hasAttachedValue = token.includes("=") || (token.length > 2 && token.startsWith("-C"));
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
  if (segment.executable !== "git") return undefined;
  const parsed = parseGitSubcommand(segment.args);
  const subcommand =
    parsed.index === undefined ? undefined : segment.args[parsed.index]?.toLowerCase();
  const commandArguments = parsed.index === undefined ? [] : segment.args.slice(parsed.index + 1);
  return {
    segment,
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
  if (!invocation.subcommand) return false;
  return (
    gitNetworkSubcommands.has(invocation.subcommand) ||
    (invocation.subcommand === "submodule" &&
      invocation.arguments.some((argument) => argument === "add" || argument === "update")) ||
    gitRemoteNetworkOperands(invocation) !== undefined
  );
}

function remotePurpose(invocation: GitInvocation): GitRemotePurpose {
  return invocation.subcommand === "push" ? "push" : "fetch";
}

/**
 * Only a spelling that cannot be a remote name proves the operand is a local
 * path. A bare word may contain `/` and still be a configured remote — `git
 * remote add team/origin …` is ordinary, and `git push team/origin` is how it is
 * used. Reading any slash as a path turned that into `local`, which skipped the
 * implicit-remote refusal and the metadata read behind it, so an escalated push
 * reached the bare backend with a destination nothing had bound.
 *
 * `sub/dir` is also a valid relative path, and the two are genuinely ambiguous.
 * The ambiguity is resolved toward the remote, because that is the side on which
 * the destination has to be proved rather than assumed; `./sub/dir` says which
 * one it is.
 */
function classifyGitRemoteOperand(operand: string, purpose: GitRemotePurpose): ParsedGitRemote {
  const looksLikePath =
    operand.startsWith("/") ||
    operand.startsWith("./") ||
    operand.startsWith("../") ||
    operand.startsWith("~/");
  // `:` separates the host in both URL and scp spellings, and a remote name
  // cannot contain one: Git builds `refs/remotes/<name>/…` from it, and `:` is
  // illegal in a ref name. So a colon is a sound "this is not a bare name"
  // signal where a slash is not.
  if (!looksLikePath && !operand.includes(":")) return { kind: "implicit", purpose };
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

/**
 * What can be concluded about the Git program and its option grammar, before
 * any question is asked about remotes.
 *
 * These two verdicts used to be guards inside `parsedGitRemotes`, placed after
 * its `gitInvocationUsesNetwork` early return. That made them reachable only for
 * a subcommand already classified as reaching a remote, so `PATH=/tmp git status`
 * proved nothing about the program it named and still produced no remotes —
 * indistinguishable from a trusted executable. They are computed separately here
 * because the context verdict and the network classification are independent
 * questions, and answering the first by returning early from the second made
 * `git -C DIR push` stop looking like an implicit push at all, which is the one
 * case the escalation guard exists to refuse.
 *
 * `unsafe` means the program cannot be identified, so nothing in the words can
 * be trusted and a reviewer has nothing to read. `unproven` means the program is
 * Git but its surroundings are not fully established, which a human can settle by
 * reading the command.
 *
 * The two are decided from `trusted` and `executableContextUntrusted`, which are
 * independent. An earlier version used `segment.decomposable` to tell them apart,
 * which is not the same question: `decomposable` records whether the static argv
 * equals the runtime argv, so a malicious untrusted Git could buy the lighter
 * verdict simply by carrying an argument that made it non-decomposable —
 * `PATH=/tmp git -c alias.x='!cmd' push` was reviewed while `/tmp/git push` was
 * refused. It also sent the two faults in opposite directions, refusing
 * `GIT_TRACE=1 git status` for a variable that changes nothing.
 */
function gitContextVerdict(
  invocation: GitInvocation,
): { kind: "unsafe" | "unproven"; reason: string } | undefined {
  if (!invocation.trusted) {
    return { kind: "unsafe", reason: "untrusted Git executable or wrapper context" };
  }
  if (invocation.segment.executableContextUntrusted) {
    return { kind: "unproven", reason: "unproven Git invocation environment" };
  }
  if (!invocation.globalOptionsSafe) {
    return { kind: "unproven", reason: "unproven Git global option" };
  }
  return undefined;
}

function parsedGitRemotes(invocation: GitInvocation): ParsedGitRemote[] {
  if (!gitInvocationUsesNetwork(invocation)) return [];
  const purpose = remotePurpose(invocation);
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
  if (subcommand === "remote") {
    const operands = gitRemoteNetworkOperands(invocation);
    // `undefined` means this action never leaves the machine; `null` means it
    // covers every configured remote, which is still one implicit destination.
    if (operands === undefined) return [];
    return operands === null
      ? [{ kind: "implicit", purpose }]
      : operands.map((operand) => classifyGitRemoteOperand(operand, purpose));
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
  /** The program named by the command could not be identified. Refused outright. */
  unsafeReason?: string;
  /** The program is Git, but its option grammar is not fully proven. Sent to review. */
  unprovenReason?: string;
}

export function analyzeShellGitNetwork(command: string): ShellGitNetworkAnalysis {
  const segments = parseCommandSegments(command);
  const syntax = scanShellSyntax(command);
  const invocations = parsedGitInvocations(command);
  const remotes = invocations.flatMap((invocation) => {
    return parsedGitRemotes(invocation).map((remote) => ({ invocation, remote }));
  });
  // An unidentifiable program outranks an unproven grammar wherever both appear.
  const verdicts = invocations
    .map((invocation) => gitContextVerdict(invocation))
    .filter((verdict) => verdict !== undefined);
  const contextVerdict =
    verdicts.find((verdict) => verdict.kind === "unsafe") ??
    verdicts.find((verdict) => verdict.kind === "unproven");
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
    ...(contextVerdict?.kind === "unsafe"
      ? { unsafeReason: contextVerdict.reason }
      : contextVerdict?.kind === "unproven"
        ? { unprovenReason: contextVerdict.reason }
        : {}),
  };
}
