import { isIP } from "node:net";
import { basename, resolve } from "node:path";
import { defaultSafetyConfigPath, resolvePolicyPath } from "../filesystem-policy.ts";
import {
  isPublicNetworkHost,
  normalizeNetworkHost,
  parseGitRemoteTarget,
} from "../network-host.ts";
import { assignmentName, isDangerousWords } from "./dangerous-commands.ts";
import { isPathWithin } from "./paths.ts";
import type { CommandSegment, PermissionRequest } from "./rules.ts";

export type Risk = "LOW" | "REVIEW" | "HARD";
export type { CommandSegment, PermissionRequest } from "./rules.ts";
export { isPublicNetworkHost };

const directNetworkExecutables = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "ftp",
  "nc",
  "ncat",
  "sftp",
  "npx",
  "pnpx",
  "bunx",
]);
const shellExecutables = new Set(["bash", "sh", "zsh", "fish", "dash"]);
/**
 * Interpreters that run a *string* (an argument or stdin) as a program, so the
 * argv this parser reads is not the argv that runs. This is a mechanism-closed
 * class, not a list of dangerous commands: `eval`/`source`/`.` take shell code,
 * `trap ACTION` stores shell code to run later, `xargs` assembles argv from
 * stdin words, `find -exec` runs a command per match, the shells run `-c
 * STRING` (expanded recursively below) or a program from stdin, and the
 * language runtimes run an inline program flag (`python -c`, `php -r`) or a
 * subcommand (`deno eval`) or a stdin program.
 */
const stringInterpreters = new Set([
  "eval",
  "source",
  ".",
  "trap",
  "xargs",
  "find",
  ...shellExecutables,
  "python",
  "python3",
  "node",
  "nodejs",
  "perl",
  "ruby",
  "php",
  "deno",
]);
/** `find` actions that run another command per match. */
const findExecActions = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/**
 * Flags whose value is a program string. `-p`/`--print`, `-E`, and `-r` are
 * included fail-closed: for perl/ruby `-p`/`-E` can be loop/encoding flags and
 * for node `-r` is `--require`, where the extra review only costs a prompt,
 * never a wrong auto-approval. `-r` is the php inline-program flag.
 */
const inlineProgramFlags = new Set([
  "-c",
  "--command",
  "-e",
  "--eval",
  "-E",
  "-p",
  "--print",
  "-r",
]);
/**
 * Runtimes whose inline program is a *subcommand* rather than a flag
 * (`deno eval STRING`), keyed to the first non-flag operand.
 */
const inlineProgramSubcommands = new Map([["deno", "eval"]]);
/**
 * Flags that consume the *next word* as their value, so that word is not an
 * operand: `bash -o pipefail`, `python -X utf8`, `perl -I lib`, `php -d
 * memory_limit=1G`. Attached forms (`-Xutf8`, `-Ilib`) are one flag word and
 * need no entry here. The set is shared by the whole interpreter class (the
 * mechanism is "an option that eats a word", not a per-runtime flag table) and
 * fail-closed: a value-less flag read as value-taking (`python -I` isolated
 * mode, `perl -d` debugger, `ruby -Ilibexec` attached) only costs an extra
 * review, never a wrong auto-approval.
 */
const optionValueFlags = new Set([
  "-o",
  "+o",
  "-O",
  "+O",
  "-X",
  "-W",
  "-I",
  "-d",
  "--init-file",
  "--rcfile",
]);
/**
 * Runtimes whose first operand is a *mode* word, not a script: `deno run
 * script.ts` runs `script.ts`, so `run` is the subcommand and the script
 * operand is the word after it. A mode word with no operand behind it (`deno
 * test`, `deno fmt`) leaves the program to filesystem discovery, which is
 * equally unclassifiable from the argv. `deno eval STRING` is caught earlier
 * as an inline program.
 */
const subcommandRuntimes = new Set(["deno"]);
const gitNetworkSubcommands = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);
const packageNetworkSubcommands = new Set([
  "add",
  "audit",
  "ci",
  "dlx",
  "exec",
  "info",
  "install",
  "outdated",
  "publish",
  "search",
  "update",
  "upgrade",
  "view",
]);

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      current += character;
      quote = character;
      continue;
    }
    if (/[;&|()\n]/.test(character)) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/**
 * Lexical defects that make the word list an incomplete picture of what the
 * shell will run. Mirrors fx `command_lex.zig:43-75,483-486`
 * (`ShellScan` / `LexError`): an unterminated construct is not a safe default,
 * it is an unproven one.
 */
type ShellLexError = "unbalanced-quote" | "trailing-escape" | "nul-byte";

interface ShellWords {
  words: string[];
  error?: ShellLexError;
}

function shellWords(source: string): ShellWords {
  const words: string[] = [];
  let current = "";
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let error: ShellLexError | undefined;
  const flush = (): void => {
    if (tokenStarted) words.push(current);
    current = "";
    tokenStarted = false;
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string;
    if (character === "\0") {
      error ??= "nul-byte";
      current += character;
      tokenStarted = true;
      continue;
    }
    if (escaped) {
      current += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      // A backslash before a newline is a line continuation: it is removed
      // before word splitting, so it must neither open an escape nor start a
      // word. Without this, `r\` + newline + `m -f x` lexes as `r` and `m`,
      // and the forced removal is never inspected.
      if (source[index + 1] === "\n") {
        index += 1;
        continue;
      }
      tokenStarted = true;
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else {
        current += character;
        tokenStarted = true;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      tokenStarted = true;
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    current += character;
    tokenStarted = true;
  }
  if (escaped) error ??= "trailing-escape";
  if (quote !== undefined) error ??= "unbalanced-quote";
  flush();
  return error === undefined ? { words } : { words, error };
}

/**
 * A redirection operator, optionally prefixed by a file descriptor. In the
 * shell grammar the target is part of the same word when it is attached
 * (`>out`, `2>err`, `2>&1`) and a separate word when it is not (`> out`).
 * Neither form is ever the command word.
 */
const REDIRECT_OPERATOR = /^\d*(?:<<<|<<|>>|<>|>&|<&|>\||<|>)/;
/** A redirection operator with no attached target, so its target is the next word. */
const BARE_REDIRECT_OPERATOR = /^\d*(?:<<<|<<|>>|<>|>&|<&|>\||<|>)$/;

interface LeadingSyntax {
  words: string[];
  /** A redirect operator appeared without the target word it requires. */
  incomplete: boolean;
}

/**
 * Drop the leading assignments and redirections that precede the command word
 * in a simple command. `executableContext` already reduces assignments, but a
 * redirect such as `>out rm -f x` would otherwise be read as the executable and
 * hide the real command.
 */
function stripLeadingSyntax(words: readonly string[]): LeadingSyntax {
  const remaining: string[] = [];
  let index = 0;
  let incomplete = false;
  while (index < words.length) {
    const word = words[index] ?? "";
    if (assignmentName(word) !== undefined) {
      remaining.push(word);
      index += 1;
      continue;
    }
    if (BARE_REDIRECT_OPERATOR.test(word)) {
      if (index + 1 >= words.length) {
        incomplete = true;
        break;
      }
      index += 2;
      continue;
    }
    if (REDIRECT_OPERATOR.test(word)) {
      index += 1;
      continue;
    }
    break;
  }
  remaining.push(...words.slice(index));
  return { words: remaining, incomplete };
}

interface ExecutableContext {
  index: number;
  safe: boolean;
  /**
   * An identity-changing prefix was present but its argument grammar was not
   * fully reduced to the real command. The static word list then describes the
   * prefix, not what runs, so the segment must not be treated as decomposable.
   */
  unclassifiable: boolean;
}

function isUnsafeGitContextVariable(name: string): boolean {
  return name === "PATH" || name.startsWith("GIT_");
}

/** `timeout` duration: decimal with at most one non-trailing dot, optional s/m/h/d. */
const TIMEOUT_DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

/**
 * Delegating process wrappers whose option words are value-taking. Stripping
 * them must reach the real command, or a nested `rm -f` is never inspected.
 * Mirrors fx `command_lex.zig:304-442` (`wrapper_strip_argv`): a wrapper is
 * removed only when its own grammar is provable; anything ambiguous stays
 * anchored and therefore never yields a `LOW` verdict.
 */
function delegatingWrapperOptionCount(
  wrapper: string,
  args: readonly string[],
  start: number,
): number | undefined {
  let index = start;
  while (index < args.length) {
    const token = args[index] ?? "";
    if (!token.startsWith("-") || token === "-") break;
    if (wrapper === "timeout") {
      if (token === "--foreground" || token === "--preserve-status" || token === "--verbose") {
        index += 1;
        continue;
      }
      if (token === "-v") {
        index += 1;
        continue;
      }
      // `-k DURATION` / `--kill-after[=]DURATION`, `-s SIGNAL` / `--signal[=]SIGNAL`
      const takesValue =
        token === "-k" || token === "--kill-after" || token === "-s" || token === "--signal";
      if (takesValue) {
        if (args[index + 1] === undefined) return undefined;
        index += 2;
        continue;
      }
      if (token.startsWith("--kill-after=") || token.startsWith("--signal=")) {
        index += 1;
        continue;
      }
      return undefined;
    }
    if (wrapper === "nice") {
      if (token === "-n" || token === "--adjustment") {
        const value = args[index + 1];
        if (value === undefined || !/^[+-]?\d+$/.test(value)) return undefined;
        index += 2;
        continue;
      }
      if (token.startsWith("--adjustment=")) {
        if (!/^[+-]?\d+$/.test(token.slice("--adjustment=".length))) return undefined;
        index += 1;
        continue;
      }
      if (/^-[+-]?\d+$/.test(token)) {
        index += 1;
        continue;
      }
      return undefined;
    }
    if (wrapper === "stdbuf") {
      if (token === "-i" || token === "-o" || token === "-e") {
        const value = args[index + 1];
        if (value === undefined) return undefined;
        index += 2;
        continue;
      }
      if (
        token === "--input" ||
        token === "--output" ||
        token === "--error" ||
        token.startsWith("--input=") ||
        token.startsWith("--output=") ||
        token.startsWith("--error=")
      ) {
        index += token.includes("=") ? 1 : 2;
        continue;
      }
      // Attached short forms: `-o0`, `-iL`, `-o4k`, `-ioe`. The leading run of
      // `i`/`o`/`e` flags is consumed separately from the attached buffer-size
      // value so neither alternative can backtrack (a nested quantifier here
      // is a ReDoS on agent-authored commands).
      const attached = /^(-[ioe]*)([A-Za-z0-9]+)?$/.exec(token);
      if (attached) {
        index += 1;
        continue;
      }
      return undefined;
    }
    return undefined;
  }
  return index;
}

function executableContext(words: readonly string[]): ExecutableContext {
  let index = 0;
  let safe = true;
  let unclassifiable = false;
  while (index < words.length) {
    const name = assignmentName(words[index] ?? "");
    if (!name) break;
    if (isUnsafeGitContextVariable(name)) safe = false;
    index += 1;
  }
  while (index < words.length) {
    const wrapperToken = words[index] ?? "";
    const wrapper = basename(wrapperToken).toLowerCase();
    if (
      wrapper === "command" ||
      wrapper === "builtin" ||
      wrapper === "nohup" ||
      wrapper === "time"
    ) {
      safe = safe && isTrustedExecutableToken(wrapperToken, wrapper);
      index += 1;
      while (index < words.length && words[index]?.startsWith("-")) {
        if (words[index] === "-p") safe = false;
        // `time -f FORMAT` / `time -o FILE` take a value argument; consume it so
        // the real command is not mistaken for the format string.
        if (
          wrapper === "time" &&
          (words[index] === "-f" ||
            words[index] === "--format" ||
            words[index] === "-o" ||
            words[index] === "--output")
        ) {
          if (words[index + 1] === undefined) {
            unclassifiable = true;
            break;
          }
          index += 1;
        }
        index += 1;
      }
      // A bare `time`/`command`/`nohup` names no command at all.
      if (unclassifiable || words[index] === undefined) {
        unclassifiable = true;
      }
      continue;
    }
    // Delegating wrappers hide the real command behind a fixed-arity option
    // grammar. Strip them so the nested command is classified, and fail closed
    // (stay anchored) whenever the grammar is not provable.
    if (
      wrapper === "timeout" ||
      wrapper === "nice" ||
      wrapper === "stdbuf" ||
      wrapper === "unbuffer"
    ) {
      if (!isTrustedExecutableToken(wrapperToken, wrapper)) {
        unclassifiable = true;
        break;
      }
      let next = delegatingWrapperOptionCount(wrapper, words, index + 1);
      if (next === undefined) {
        unclassifiable = true;
        break;
      }
      // `timeout` takes a bare DURATION as its first operand.
      if (wrapper === "timeout") {
        const duration = words[next];
        if (duration === undefined || !TIMEOUT_DURATION.test(duration)) {
          unclassifiable = true;
          break;
        }
        next += 1;
      }
      const commandToken = words[next];
      if (commandToken === undefined || commandToken.startsWith("-")) {
        unclassifiable = true;
        break;
      }
      // GNU `nice` accepts a bare `+N`/`-N` adjustment operand. Consume it so
      // the adjustment is never read as the executable.
      if (wrapper === "nice" && /^[+-]\d+$/.test(commandToken)) {
        const following = words[next + 1];
        if (following === undefined || following.startsWith("-")) {
          unclassifiable = true;
          break;
        }
        next += 1;
      }
      index = next;
      continue;
    }
    if (wrapper === "env") {
      safe = safe && isTrustedExecutableToken(wrapperToken, wrapper);
      index += 1;
      while (index < words.length) {
        const token = words[index] ?? "";
        const name = assignmentName(token);
        if (name) {
          if (isUnsafeGitContextVariable(name)) safe = false;
          index += 1;
          continue;
        }
        if (token === "--") {
          index += 1;
          break;
        }
        if (token === "-u" || token === "--unset") {
          const unsetName = words[index + 1];
          if (!unsetName || isUnsafeGitContextVariable(unsetName)) safe = false;
          index += 2;
          continue;
        }
        if (token.startsWith("--unset=")) {
          if (isUnsafeGitContextVariable(token.slice("--unset=".length))) safe = false;
          index += 1;
          continue;
        }
        if (
          token === "-C" ||
          token === "--chdir" ||
          token.startsWith("--chdir=") ||
          token === "-i" ||
          token === "--ignore-environment"
        ) {
          safe = false;
          index += token === "-C" || token === "--chdir" ? 2 : 1;
          continue;
        }
        // An unrecognized `env` option may take a value (`-S string`,
        // `-P path`). Its value would otherwise be read as the executable, so
        // the segment cannot claim a provable argv.
        if (token.startsWith("-")) {
          safe = false;
          unclassifiable = true;
          break;
        }
        break;
      }
      continue;
    }
    if (wrapper === "sudo") {
      safe = safe && isTrustedExecutableToken(wrapperToken, wrapper);
      index += 1;
      while (index < words.length) {
        const token = words[index] ?? "";
        if (token === "-u" || token === "-g" || token === "-h" || token === "-p") {
          if (words[index + 1] === undefined) {
            unclassifiable = true;
            break;
          }
          index += 2;
          continue;
        }
        if (token === "-C" || token === "--chdir" || token.startsWith("--chdir=")) {
          safe = false;
          if (token.startsWith("--chdir=")) {
            index += 1;
            continue;
          }
          if (words[index + 1] === undefined) {
            unclassifiable = true;
            break;
          }
          index += 2;
          continue;
        }
        if (new Set(["-n", "-S", "-H", "-k", "-K", "-b"]).has(token)) {
          index += 1;
          continue;
        }
        // Unknown `sudo` options include value-taking ones (`-D dir` chdir,
        // `-R dir` chroot, `-T timeout`). Without a complete grammar their
        // value would be read as the executable.
        if (token.startsWith("-")) {
          safe = false;
          unclassifiable = true;
          break;
        }
        break;
      }
      continue;
    }
    // `su` / `doas` change identity and may carry an inline command
    // (`su root -c 'rm -rf x'`, `doas rm -rf x`). Their option grammar differs
    // per platform, so the wrapper stays anchored and the segment is marked
    // unclassifiable rather than guessing where the real command starts.
    if (wrapper === "su" || wrapper === "doas") {
      unclassifiable = true;
    }
    break;
  }
  return { index, safe, unclassifiable };
}

function isTrustedExecutableToken(token: string, executable: string): boolean {
  return (
    token === executable || token === `/usr/bin/${executable}` || token === `/bin/${executable}`
  );
}

interface ShellSyntax {
  hasExecutableSubstitution: boolean;
  hasActiveRedirect: boolean;
  hasActiveControl: boolean;
  hasHereDocument: boolean;
}

function scanShellSyntax(source: string): ShellSyntax {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let hasExecutableSubstitution = false;
  let hasActiveRedirect = false;
  let hasActiveControl = false;
  let hasHereDocument = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    const isBashAlternateCommandSubstitution =
      character === "$" &&
      source[index + 1] === "{" &&
      (/\s/.test(source[index + 2] ?? "") || source[index + 2] === "|");
    if (
      character === "`" ||
      (character === "$" && source[index + 1] === "(") ||
      isBashAlternateCommandSubstitution
    ) {
      hasExecutableSubstitution = true;
    }
    if (quote === undefined && (character === "<" || character === ">")) {
      hasActiveRedirect = true;
    }
    // `<<WORD` (heredoc) and `<<<WORD` (here-string) feed content the char
    // segmenter keeps as separate text, so the command's real input is not in
    // the argv we parsed.
    if (quote === undefined && character === "<" && source[index + 1] === "<") {
      hasHereDocument = true;
    }
    if (
      quote === undefined &&
      (character === "&" ||
        character === ";" ||
        character === "|" ||
        character === "\n" ||
        character === "(" ||
        character === ")")
    ) {
      hasActiveControl = true;
    }
  }
  return { hasExecutableSubstitution, hasActiveRedirect, hasActiveControl, hasHereDocument };
}

/**
 * Shell reserved words: syntax, never real executables. A segment that begins
 * with one (e.g. `do rm -f /`, `then rm --force x`, `{ rm -f /`) has its real
 * command hidden behind control-flow / brace structure the char segmenter did
 * not reduce. Stripping them here, at the single parse boundary, surfaces the
 * hidden argv for every consumer — danger check, deletion targets, network and
 * Git-invocation detection — without over-matching, since no binary is named
 * `do`/`then`/`{`. Approximates codex's AST descent into control-flow clauses.
 */
const SHELL_RESERVED_WORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "for",
  "case",
  "esac",
  "select",
  "{",
  "}",
  "!",
]);

/**
 * Whether a leading token is a reserved word. Matching on the basename also
 * covers a path form of the same keyword. (`time` is handled separately as a
 * real executable wrapper in executableContext, since it is both a keyword and
 * a binary.)
 */
function isReservedCommandWord(token: string): boolean {
  return SHELL_RESERVED_WORDS.has(basename(token).toLowerCase());
}

/**
 * A dynamic executable word (`$CMD`, `` `cmd` ``, `$(cmd)`) means the binary
 * that runs is not the one this parser read. A dynamic *argument* (`ls $DIR`)
 * is not this class: the executable still is `ls`.
 */
function isDynamicExecutableToken(token: string): boolean {
  return token.includes("$") || token.includes("`");
}

/**
 * `{`/`}` as a standalone word is shell grouping, never an operand: the group
 * body is a separate argv the char segmenter did not reduce (`function f {
 * rm -f x; }`). Brace *expansion* (`{a,b}`, `awk '{ print }'`) is a single word
 * and stays decomposable.
 */
function hasGroupingWord(words: readonly string[]): boolean {
  return words.some((word) => word === "{" || word === "}");
}

/**
 * First non-flag operand: the script file an interpreter would run, if any.
 * Three kinds of word are not that operand. Redirect words leak into the word
 * list (`sh < script`, `sh <<< 'code'`), and the word after one is a filename
 * or here-string. A word after a value-taking option is that option's value
 * (`bash -o pipefail`, `python -X utf8`). A runtime's leading mode word
 * selects what runs (`deno run`). A bare `-` is the stdin sentinel (`deno run
 * -`, `python -`): the program arrives on a pipe, so no word here names it and
 * the caller must fail closed.
 */
function scriptOperand(executable: string, args: readonly string[]): string | undefined {
  let skipNext = false;
  let skipSubcommand = subcommandRuntimes.has(executable);
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === "-") return undefined;
    // A shell given `-s` (`bash -s name`, where `name` is only $0) reads its
    // program from stdin, so no argv operand names the program.
    if (shellExecutables.has(executable) && /^-[^-]+$/.test(arg) && arg.includes("s")) {
      return undefined;
    }
    if (arg.startsWith("<") || arg.startsWith(">") || optionValueFlags.has(arg)) {
      skipNext = true;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (skipSubcommand) {
      skipSubcommand = false;
      continue;
    }
    return arg;
  }
  return undefined;
}

/** Whether an argument names an inline program string (`python -c`, `perl -we`, `php -r`, `perl -E`). */
function hasInlineProgramArgument(args: readonly string[]): boolean {
  return args.some((arg) => {
    if (arg === "--" || !arg.startsWith("-")) return false;
    if (inlineProgramFlags.has(arg)) return true;
    // Bundled single-letter flags mirror inlineProgramFlags exactly: c/e/E/p/r.
    return /^-[A-Za-z]+$/.test(arg) && /[ceEpr]/.test(arg.slice(1));
  });
}

/**
 * `--version`/`--help` are the one invocation form where every interpreter in
 * the set prints and exits without running a program, so the argv read here is
 * the argv that runs. The short forms stay unclassifiable: `sh -v` reads stdin.
 */
function hasTerminalInfoFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--version" || arg === "--help");
}

/**
 * Whether a segment re-interprets a string or stdin as the program, so its
 * static argv is not the argv that runs. Shell `-c STRING` bodies are expanded
 * into their own segments by parseCommandSegments and therefore count as
 * decomposed; `eval`/`source`/`.`, a `trap` action, `xargs`, `find -exec`, a
 * bare or redirect-fed interpreter, and an inline program string do not. An
 * interpreter with a script-file operand (`python script.py`) is a fixed argv
 * and stays classifiable — an unknown *program* is not the same as a rewritable
 * argv.
 */
function reExecutesString(
  executable: string,
  args: readonly string[],
  nestedShell: boolean,
): boolean {
  if (!stringInterpreters.has(executable)) return false;
  if (executable === "eval" || executable === "source" || executable === ".") return true;
  if (executable === "trap") {
    // `trap ACTION SIGNAL` stores shell code to run later, so ACTION is a
    // program string. A bare `trap`, `trap -l`, `trap - SIGNAL` (reset), and
    // `trap '' SIGNAL` (ignore) run nothing and stay classifiable.
    let actionIndex = 0;
    if (args[actionIndex] === "--") actionIndex += 1;
    const action = args[actionIndex];
    return action !== undefined && action !== "" && !action.startsWith("-");
  }
  if (executable === "xargs") return true;
  if (executable === "find") return args.some((arg) => findExecActions.has(arg));
  if (shellExecutables.has(executable)) {
    return (
      !nestedShell && scriptOperand(executable, args) === undefined && !hasTerminalInfoFlag(args)
    );
  }
  const subcommand = args.find((arg) => !arg.startsWith("-"));
  if (subcommand !== undefined && inlineProgramSubcommands.get(executable) === subcommand)
    return true;
  return (
    hasInlineProgramArgument(args) ||
    (scriptOperand(executable, args) === undefined && !hasTerminalInfoFlag(args))
  );
}

function parseCommandSegment(source: string): CommandSegment {
  const lexed = shellWords(source);
  // Redirections are shell syntax: `>out rm -f x` runs `rm`, it does not run a
  // program named `>out`. Strip the leading operator/target pairs before the
  // command word is read, keeping assignments so the Git context check in
  // `executableContext` still sees them.
  const leading = stripLeadingSyntax(lexed.words);
  const words = leading.words;
  // Reserved words are structural only in command position, which the char
  // segmenter already isolated: it splits on `;`/`&`/`|`/newline, so the
  // keyword is leading. Bash treats one behind an assignment or wrapper
  // (`FOO=1 do rm -f x`, `env FOO=1 do rm -f x`) as an ordinary command name,
  // so only the leading run is dropped and the reduction still sees the real
  // executable of `do FOO=1 rm -f x`. `source` keeps the original text for the
  // regex consumers, and args stay offset from the real executable.
  let start = 0;
  while (start < words.length && isReservedCommandWord(words[start] ?? "")) start += 1;
  const context = executableContext(words.slice(start));
  const index = start + context.index;
  const executableToken = words[index] ?? "";
  // A simple command with no command word runs nothing provable: `>out` is a
  // redirection with no target, `FOO=1` is an assignment with no command.
  const nameless = executableToken === "";
  const executable = basename(executableToken).toLowerCase();
  const args = words.slice(index + 1);
  const syntax = scanShellSyntax(source);
  const commandIndex = args.findIndex(
    (arg) => arg === "--command" || /^-[a-z]*c[a-z]*$/i.test(arg),
  );
  const nestedShell = shellExecutables.has(executable) && commandIndex >= 0;
  const reExec = reExecutesString(executable, args, nestedShell);
  // A Git invocation can be told to run another program — a shell alias, a
  // pager, a `bisect run` payload — without any of those words naming it.
  const nestedGitProgram = executable === "git" && gitExecutesNestedProgram(words, args);
  return {
    source,
    executableToken,
    executable,
    executableTrusted: context.safe && isTrustedExecutableToken(executableToken, executable),
    args,
    hasRedirect: syntax.hasActiveRedirect,
    hasSubstitution: syntax.hasExecutableSubstitution,
    nestedShell,
    // Static argv equals runtime argv only when nothing can rewrite the word
    // list: the lexing completed, no dynamic executable, no re-interpreted
    // string, no nested Git program, no substitution, no heredoc body, no
    // unreduced brace group, and no wrapper whose argument grammar could not be
    // reduced to the real command.
    decomposable:
      lexed.error === undefined &&
      !leading.incomplete &&
      !nameless &&
      !context.unclassifiable &&
      !nestedGitProgram &&
      !isDynamicExecutableToken(executableToken) &&
      !reExec &&
      !syntax.hasExecutableSubstitution &&
      !syntax.hasHereDocument &&
      !hasGroupingWord(words),
  };
}

export function parseCommandSegments(command: string): CommandSegment[] {
  const segments = splitShellSegments(command).map(parseCommandSegment);
  const nested = segments.flatMap((segment) => {
    if (!shellExecutables.has(segment.executable)) return [];
    const commandIndex = segment.args.findIndex(
      (arg) => arg === "--command" || /^-[a-z]*c[a-z]*$/i.test(arg),
    );
    const nestedCommand = commandIndex >= 0 ? segment.args[commandIndex + 1] : undefined;
    if (!nestedCommand) return [];
    // The body is shell code, so a substitution or heredoc in it is live even
    // when outer quoting made it inert for the parent shell: `bash -c 'cat
    // $(pwd)'` runs the substitution. The char segmenter drops the `(`, so the
    // body text itself is what proves the inner argv is not static.
    const body = scanShellSyntax(nestedCommand);
    const bodyRewritesArgv = body.hasExecutableSubstitution || body.hasHereDocument;
    const inner = parseCommandSegments(nestedCommand);
    return bodyRewritesArgv
      ? inner.map((nestedSegment) => ({ ...nestedSegment, decomposable: false }))
      : inner;
  });
  return [...segments, ...nested];
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
    commandSegments: command ? parseCommandSegments(command) : undefined,
    networkTargets: command ? extractShellNetworkHosts(command) : extractNetworkTargets(input),
  };
}

function normalizeHostToken(value: string): string | undefined {
  let token = value.trim().replace(/^['"]|['"],?$/g, "");
  if (!token) return undefined;
  try {
    if (/^https?:\/\//i.test(token)) return normalizeNetworkHost(new URL(token).hostname);
  } catch {
    return undefined;
  }
  token = token.replace(/^[^@]+@/, "");
  if (token.startsWith("[")) {
    return normalizeNetworkHost(/^\[([^\]]+)\]/.exec(token)?.[1] ?? "");
  }
  token = token.replace(/:.*$/, "");
  return normalizeNetworkHost(token);
}

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
function gitExecutesNestedProgram(words: readonly string[], args: readonly string[]): boolean {
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

function parseGitInvocation(segment: CommandSegment): GitInvocation | undefined {
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

function gitInvocationUsesNetwork(invocation: GitInvocation): boolean {
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

function invocationUsesNetwork(segment: CommandSegment): boolean {
  const args = segment.args.map((arg) => arg.toLowerCase());
  if (directNetworkExecutables.has(segment.executable)) {
    return !args.some((arg) => arg === "--version" || arg === "--help");
  }
  if (segment.executable === "gh") {
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    return (
      subcommand !== undefined &&
      !new Set(["alias", "completion", "config", "help", "version"]).has(subcommand)
    );
  }
  if (
    new Set(["node", "nodejs", "python", "python3", "ruby", "php", "deno"]).has(segment.executable)
  ) {
    return /\b(?:fetch|axios|https?\.request|requests\.|urllib|httpx|aiohttp|socket)\b/i.test(
      segment.source,
    );
  }
  if (segment.executable === "git") {
    const invocation = parseGitInvocation(segment);
    return invocation ? gitInvocationUsesNetwork(invocation) : false;
  }
  if (new Set(["npm", "pnpm", "yarn", "bun"]).has(segment.executable)) {
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    return subcommand !== undefined && packageNetworkSubcommands.has(subcommand);
  }
  if (segment.executable === "pip" || segment.executable === "pip3") {
    return args.some((arg) => new Set(["install", "uninstall", "download", "index"]).has(arg));
  }
  if (segment.executable === "cargo") {
    return args.some((arg) => new Set(["install", "publish", "search", "update"]).has(arg));
  }
  if (segment.executable === "go") {
    return args.some((arg) => arg === "get" || arg === "install");
  }
  return false;
}

export function extractShellNetworkHosts(command: string): string[] {
  const gitNetwork = analyzeShellGitNetwork(command);
  const hosts = new Set<string>(gitNetwork.explicitHosts);
  const segments = parseCommandSegments(command);
  for (const segment of segments) {
    if (
      !invocationUsesNetwork(segment) ||
      segment.executable === "git" ||
      segment.executable === "gh"
    )
      continue;
    for (const match of segment.source.matchAll(/https?:\/\/[^\s"'`<>]+/gi)) {
      const host = normalizeHostToken(match[0]);
      if (host) hosts.add(host.toLowerCase());
    }
  }

  for (const segment of segments) {
    if (!invocationUsesNetwork(segment)) continue;
    if (segment.executable === "git") continue;
    if (segment.executable === "gh") {
      hosts.add("api.github.com");
      hosts.add("github.com");
      hosts.add("uploads.github.com");
      continue;
    }
    if (new Set(["npm", "pnpm", "yarn", "bun", "npx", "pnpx", "bunx"]).has(segment.executable)) {
      hosts.add("registry.npmjs.org");
    }
    if (
      !directNetworkExecutables.has(segment.executable) &&
      segment.executable !== "git" &&
      segment.executable !== "gh"
    )
      continue;
    for (const token of segment.args) {
      if (token.startsWith("-")) continue;
      const remoteLike =
        /^https?:\/\//i.test(token) ||
        token.includes("@") ||
        (segment.executable === "scp" && token.includes(":")) ||
        token.includes(".") ||
        isIP(token.replace(/:.*$/, "")) !== 0;
      if (!remoteLike) continue;
      const host = normalizeHostToken(token);
      if (host) hosts.add(host.toLowerCase());
    }
    const positional = segment.args.filter((token) => !token.startsWith("-"));
    const implicitHost =
      segment.executable === "ssh" || segment.executable === "sftp"
        ? positional.at(-1)
        : segment.executable === "ftp" ||
            segment.executable === "nc" ||
            segment.executable === "ncat"
          ? positional[0]
          : undefined;
    const normalizedImplicitHost = implicitHost ? normalizeHostToken(implicitHost) : undefined;
    if (normalizedImplicitHost) hosts.add(normalizedImplicitHost.toLowerCase());
  }
  return [...hosts];
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
