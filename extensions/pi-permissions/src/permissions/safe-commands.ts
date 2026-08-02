import { parseCommandSegments, type CommandSegment } from "./risk.ts";

/**
 * Read-only command whitelist for approvalMode "untrusted", mirroring
 * openai/codex `is_safe_command.rs` (codex-rs/shell-command). A command is
 * auto-approved only when it is on the whitelist AND carries no dangerous
 * options; anything else prompts the user.
 */

const SAFE_READ_EXECUTABLES = new Set([
  "cat",
  "cd",
  "cut",
  "echo",
  "expr",
  "false",
  "grep",
  "head",
  "id",
  "ls",
  "nl",
  "paste",
  "pwd",
  "rev",
  "seq",
  "stat",
  "tail",
  "tr",
  "true",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami",
]);

const SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh", "fish", "dash"]);

const UNSAFE_BASE64_OPTIONS = new Set(["-o", "--output"]);

const UNSAFE_FIND_OPTIONS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
]);

const UNSAFE_RIPGREP_OPTIONS_WITH_ARGS = ["--pre", "--hostname-bin"];
const UNSAFE_RIPGREP_OPTIONS_WITHOUT_ARGS = new Set(["--search-zip", "-z"]);

const SAFE_GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "branch"]);

const UNSAFE_GIT_GLOBAL_OPTIONS = new Set([
  "-C",
  "-c",
  "-p",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--paginate",
  "--super-prefix",
  "--work-tree",
]);

const UNSAFE_GIT_SUBCOMMAND_OPTIONS = new Set(["--output", "--ext-diff", "--textconv", "--exec"]);

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);

/** Returns true when `arg` is a read-only query flag for `git branch`. */
function gitBranchIsReadOnly(args: string[]): boolean {
  if (args.length === 0) return true;
  let sawReadOnlyFlag = false;
  for (const arg of args) {
    if (
      arg === "--list" ||
      arg === "-l" ||
      arg === "--show-current" ||
      arg === "-a" ||
      arg === "--all" ||
      arg === "-r" ||
      arg === "--remotes" ||
      arg === "-v" ||
      arg === "-vv" ||
      arg === "--verbose" ||
      arg.startsWith("--format=")
    ) {
      sawReadOnlyFlag = true;
      continue;
    }
    // Any other flag or positional argument may create, rename, or delete branches.
    return false;
  }
  return sawReadOnlyFlag;
}

function isGitGlobalOptionWithValue(arg: string): boolean {
  return GIT_GLOBAL_OPTIONS_WITH_VALUE.has(arg);
}

function isGitGlobalOptionWithInlineValue(arg: string): boolean {
  return (
    [...GIT_GLOBAL_OPTIONS_WITH_VALUE].some((option) => arg.startsWith(`${option}=`)) ||
    ((arg.startsWith("-C") || arg.startsWith("-c")) && arg.length > 2)
  );
}

function gitUnsafeGlobalOption(arg: string): boolean {
  if (UNSAFE_GIT_GLOBAL_OPTIONS.has(arg)) return true;
  return (
    arg.startsWith("--config-env=") ||
    arg.startsWith("--exec-path=") ||
    arg.startsWith("--git-dir=") ||
    arg.startsWith("--namespace=") ||
    arg.startsWith("--super-prefix=") ||
    arg.startsWith("--work-tree=") ||
    ((arg.startsWith("-C") || arg.startsWith("-c")) && arg.length > 2)
  );
}

function gitUnsafeSubcommandOption(arg: string): boolean {
  return (
    UNSAFE_GIT_SUBCOMMAND_OPTIONS.has(arg) ||
    arg.startsWith("--output=") ||
    arg.startsWith("--exec=")
  );
}

function isSafeGitSegment(segment: CommandSegment): boolean {
  const args = segment.args;
  let subcommandIndex: number | undefined;
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (isGitGlobalOptionWithValue(arg)) {
      skipNext = true;
      continue;
    }
    if (isGitGlobalOptionWithInlineValue(arg)) continue;
    if (arg === "--" || arg.startsWith("-")) continue;
    if (!SAFE_GIT_SUBCOMMANDS.has(arg)) return false;
    subcommandIndex = i;
    break;
  }
  if (subcommandIndex === undefined) return false;
  const subcommand = args[subcommandIndex] ?? "";
  if (args.slice(0, subcommandIndex).some(gitUnsafeGlobalOption)) return false;
  const subcommandArgs = args.slice(subcommandIndex + 1);
  if (subcommandArgs.some(gitUnsafeSubcommandOption)) return false;
  if (subcommand === "branch") return gitBranchIsReadOnly(subcommandArgs);
  return true;
}

/** `sed -n {N|M,N}p` prints selected lines without writing. */
function isSafeSedSegment(args: string[]): boolean {
  if (args.length > 3) return false;
  if (args[0] !== "-n") return false;
  const pattern = args[1];
  if (typeof pattern !== "string") return false;
  const core = pattern.endsWith("p") ? pattern.slice(0, -1) : undefined;
  if (core === undefined || core === "") return false;
  const parts = core.split(",");
  return (
    (parts.length === 1 || parts.length === 2) &&
    parts.every((part) => part !== "" && /^\d+$/.test(part))
  );
}

/** Script argument following `-c`/`-lc`-style flags (e.g. `bash -lc "ls && grep x"`). */
function shellScriptArgument(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-c" || (arg.startsWith("-") && arg.endsWith("c") && arg.length > 2)) {
      return args[i + 1];
    }
  }
  return undefined;
}

/**
 * True when every command in a `bash -lc "a && b"` script is itself
 * whitelisted — mirroring codex's plain-command composite check.
 */
function isSafeShellComposite(segment: CommandSegment): boolean {
  const script = shellScriptArgument(segment.args);
  if (script === undefined) return false;
  const inner = parseCommandSegments(script);
  return inner.length > 0 && inner.every((innerSegment) => isSafeSegment(innerSegment));
}

export function isSafeSegment(segment: CommandSegment): boolean {
  const executable = segment.executable;

  if (SHELL_EXECUTABLES.has(executable)) {
    return isSafeShellComposite(segment);
  }
  if (SAFE_READ_EXECUTABLES.has(executable)) return true;

  if (executable === "base64") {
    return !segment.args.some(
      (arg) =>
        UNSAFE_BASE64_OPTIONS.has(arg) ||
        arg.startsWith("--output=") ||
        (arg.startsWith("-o") && arg !== "-o"),
    );
  }
  if (executable === "find") {
    return !segment.args.some((arg) => UNSAFE_FIND_OPTIONS.has(arg));
  }
  if (executable === "rg") {
    return !segment.args.some(
      (arg) =>
        UNSAFE_RIPGREP_OPTIONS_WITHOUT_ARGS.has(arg) ||
        UNSAFE_RIPGREP_OPTIONS_WITH_ARGS.some(
          (option) => arg === option || arg.startsWith(`${option}=`),
        ),
    );
  }
  if (executable === "git") return isSafeGitSegment(segment);
  if (executable === "sed") return isSafeSedSegment(segment.args);
  return false;
}

/**
 * True when the whole command line consists only of whitelisted commands.
 * Mirrors codex's plain-command composite rule: sequences joined by
 * `&&`/`||`/`;`/`|` are safe when every command is whitelisted. Redirects and
 * substitutions are rejected (conservative deviation: pi's sandbox is not an
 * OS-enforced boundary).
 */
export function isKnownSafeCommand(command: string): boolean {
  const segments = parseCommandSegments(command);
  if (segments.length === 0) return false;
  return segments.every(
    (segment) => !segment.hasRedirect && !segment.hasSubstitution && isSafeSegment(segment),
  );
}
