/**
 * Command semantics: wrapper reduction, interpreter re-execution detection,
 * and the construction of `CommandSegment` records. Consumes the lexer and
 * answers "is the static argv the argv that runs".
 */
import { basename } from "node:path";

import { gitExecutesNestedProgram } from "./git-exec-entries.ts";
import type { CommandSegment } from "./rules.ts";
import {
  assignmentName,
  scanShellSyntax,
  shellWords,
  splitShellSegments,
  stripLeadingSyntax,
} from "./shell-lexer.ts";

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
export function hasTerminalInfoFlag(args: readonly string[]): boolean {
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
