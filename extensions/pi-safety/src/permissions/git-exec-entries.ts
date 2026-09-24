/**
 * Git invocations that make Git run another program.
 *
 * This is a leaf concern: it needs the shell lexer for `NAME=value` detection
 * and nothing from segment construction or remote parsing. Keeping it separate
 * lets `shell-segment` consult it without depending on `git-network`, which
 * would otherwise close a cycle between the two.
 *
 * Codex's `is_dangerous_command` has no Git arm at all (removed in `fc073c9`),
 * so a shell alias or a `bisect run` payload reaches the sandbox with no nested
 * inspection upstream.
 */
import { assignmentName } from "./shell-lexer.ts";

/**
 * The final dotted segment of a config key whose value is a setting rather
 * than a program Git will run.
 *
 * This is an allowlist, which inverts the earlier design. A list of known
 * program-valued keys has to be complete, and Git's namespace defeats that:
 * besides `core.pager` and `credential.helper` there are `color.pager`,
 * `pager.<cmd>.cmd`, `diff.<driver>.textconv`, `merge.<driver>.driver`,
 * `gpg.<format>.program`, `remote.<name>.uploadpack`, and forms a future
 * release can add. Each one found by an audit is another entry, and the entry
 * that is missed is a fail-open — `git -c 'credential.https://x.helper=!cmd'`
 * reached the sandbox as LOW because the URL-scoped spelling was not in the
 * list. Here a key is treated as safe only if its last segment is a name that
 * cannot denote a program, so an unlisted key is unproven instead of allowed.
 *
 * Matching on the last segment rather than the whole key is what keeps the
 * list short: `remote.origin.url` and `core.url` are both safe because the
 * segment is `url`, while `remote.origin.uploadpack` is not because the
 * segment is `uploadpack`. No program-valued key ends in one of these names.
 *
 * `core.hooksPath` is deliberately safe here (`hooksPath` is not a program
 * name): it names a directory Git searches for hook files rather than a program
 * it execs, and gating ordinary mutations on it is a locked contract
 * (`tests/risk-policy.test.ts:825-840`). The residual path — write an
 * executable hook, then point Git at its directory — depends on writing a
 * runnable file first, which the static layer does not police either.
 */
const gitScalarConfigSegments = new Set([
  "abbrev",
  "algorithm",
  "annotated",
  "auto",
  "autocrlf",
  "autostash",
  "branch",
  "compression",
  "context",
  "defaultbranch",
  "depth",
  "detachedhead",
  "diff",
  "eol",
  "ff",
  "forcesignannotated",
  "gpgsign",
  "hookspath",
  "ignorecase",
  "logallrefupdates",
  "name",
  "prune",
  "pushrejected",
  "quotepath",
  "rebase",
  "recursesubmodules",
  "renames",
  "required",
  "safecrlf",
  "signoff",
  "status",
  "tagopt",
  "ui",
  "url",
  "usehttppath",
  "version",
]);

/**
 * Whether a `-c KEY=VALUE` / config-subcommand key is a plain setting. Anything
 * not recognised is treated as a possible program, which is the safe direction:
 * an unlisted key costs a review, a missed program key costs an auto-approval.
 */
function gitConfigKeyIsScalar(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (normalized === "") return false;
  const segment = normalized.split(".").pop() ?? "";
  return gitScalarConfigSegments.has(segment);
}

/** The inverse, named for the call sites: an unlisted key may name a program. */
function unprovenGitConfigKey(key: string): boolean {
  return !gitConfigKeyIsScalar(key);
}

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
const gitCommandRunningSubcommands = new Map<string, ReadonlySet<string> | undefined>([
  ["bisect", new Set(["run"])],
  ["hook", new Set(["run"])],
  // Every `filter-branch` form rewrites history through a shell command.
  ["filter-branch", undefined],
]);

/**
 * Global options that take a value. Their value is an option, not the
 * subcommand, so the subcommand scan below has to consume it — otherwise
 * `git -C /tmp bisect run CMD` would read `/tmp` as the subcommand and miss
 * both the real verb and its payload.
 */
const gitGlobalValueOptions = new Set([
  "-c",
  "-C",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);

/**
 * Whether this Git invocation can run a program the static words never name.
 * Once Git has been told to execute something, the segment's argv describes the
 * wrapper rather than the program, so it cannot be proven decomposable.
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
    if (token === "--exec-path" || token.startsWith("--exec-path=")) return true;
    if (token === "-c" || token === "--config-env") {
      const value = args[index + 1];
      if (value === undefined || unprovenGitConfigKey(value.split("=", 1)[0] ?? "")) {
        return true;
      }
      index += 1;
      continue;
    }
    if (token.startsWith("-c") && token.length > 2) {
      if (unprovenGitConfigKey(token.slice(2).split("=", 1)[0] ?? "")) return true;
      continue;
    }
    if (token.startsWith("--config-env=")) {
      if (unprovenGitConfigKey(token.slice("--config-env=".length).split("=", 1)[0] ?? "")) {
        return true;
      }
      continue;
    }
    if (gitGlobalValueOptions.has(token)) {
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
    //
    // Only the first non-flag operand *after the subcommand* is the key; the
    // one after it is the value. `git config --global user.name Ada` must not
    // be read as two unproven keys, and neither must the literal subcommand
    // word `config` be mistaken for the key it introduces.
    const key = args.slice(subcommandIndex + 1).find((arg) => !arg.startsWith("-"));
    return key !== undefined && unprovenGitConfigKey(key.split("=", 1)[0] ?? "");
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
