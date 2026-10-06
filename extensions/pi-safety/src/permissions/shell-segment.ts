/**
 * Command semantics: wrapper reduction, interpreter re-execution detection,
 * and the construction of `CommandSegment` records. Consumes the lexer and
 * answers "is the static argv the argv that runs".
 */
import { basename } from "node:path";

import {
  gitConfigSourceEnvNames,
  gitExecutableEnvNames,
  gitExecutesNestedProgram,
} from "./git-exec-entries.ts";
import type { CommandSegment, SegmentUnprovenCause } from "./rules.ts";
import { analyzeCommandWithAst, type SegmentFacts, shellAstParserInstalled } from "./shell-ast.ts";
import {
  assignmentName,
  isEnvAssignmentToken,
  scanShellSyntax,
  shellWords,
  skippedHeredocSubstitutions,
  splitShellSegments,
  splitShellText,
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
 * Runtimes that can run a *named module* as the program (`python3 -m pip`).
 * The module name is an ordinary operand, so it reads like a script path, but
 * what runs is the module's `__main__` — `pip` reaches an index, `http.server`
 * binds a socket, `pytest` executes test files whose contents are not in argv.
 * This is the same mechanism as an inline program string, reached by a
 * different spelling, so it is unclassifiable for the same reason.
 *
 * Listed per runtime because the flag is not a shared convention: it is
 * Python's `-m`, not a general interpreter flag.
 */
const moduleExecutionRuntimes = new Set(["python", "python3"]);

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
  /**
   * No `identity`-impacting assignment and no untrusted wrapper token, so the
   * program these words name is the program that runs.
   */
  safe: boolean;
  /**
   * Something about the surroundings is unproven — a `context`-impacting
   * variable, or a wrapper whose argument grammar could not be reduced — while
   * the program itself is still identified. This is a review, not a refusal, and
   * it is kept apart from `safe` so that "we cannot prove which binary this is"
   * and "we cannot prove what this binary's surroundings are" do not share one
   * verdict.
   */
  contextUntrusted: boolean;
  /**
   * An identity-changing prefix was present but its argument grammar was not
   * fully reduced to the real command. The static word list then describes the
   * prefix, not what runs, so the segment must not be treated as decomposable.
   */
  unclassifiable: boolean;
}

/**
 * How setting or unsetting this variable affects trust in the resolved program.
 *
 * `identity` means the variable decides *which binary runs*, so a segment that
 * carries one cannot be cleared at all. `context` means the program is still the
 * one these words name, but something about its surroundings is unproven, so a
 * human should look. The distinction is not cosmetic: it is the difference
 * between refusing and reviewing, and collapsing it produced two opposite faults
 * from one rule — `GIT_TRACE=1 git status` was refused for a variable that
 * changes nothing, while `PATH=/tmp git -c alias.x='!cmd' push` was only
 * reviewed for a binary that cannot be identified at all.
 *
 * `PATH` is `identity` by definition: reassigning it redirects lookup to a
 * program these words never name. For `GIT_` the two members are separated using
 * the sets `git-exec-entries.ts` already maintains for the same question, so the
 * two layers cannot disagree about which variables substitute a program.
 * `GIT_TRACE`, `GIT_OPTIONAL_LOCKS`, `GIT_AUTHOR_*` and the rest are `context`.
 *
 * A `GIT_*` variable outside both sets is `context`, which is the safe direction
 * for a variable a future release might add: a miss costs a review rather than an
 * unearned approval. It does not mean `context` is costless — `classifyRisk`
 * reads `executableContextUntrusted` as tier 4, so `GIT_TRACE=1 git status` is a
 * review and not an approval. That is deliberate and it is the older, narrower
 * rule: any `GIT_*` assignment means Git may read configuration this layer has
 * not seen. The split here is about which verdict a miss earns, not about whether
 * it is seen at all. `GIT_AUTHOR_NAME=x git commit` was `Skip` before the `GIT_`
 * namespace was examined for executable substitution at all; it is a review now.
 */
type ExecutableTrustImpact = "identity" | "context";

function executableTrustImpact(name: string): ExecutableTrustImpact | undefined {
  if (name === "PATH") return "identity";
  // Git honours the generic editor and pager variables when no `GIT_`-prefixed
  // one is set: `GIT_EDITOR` falls back to `VISUAL` and then `EDITOR`, and
  // `core.pager` falls back to `GIT_PAGER` and then `PAGER`. Both name a program
  // Git runs, so both are `identity` — `EDITOR=/tmp/evil git commit` was
  // auto-approved because only the `GIT_` prefix was examined.
  if (name === "EDITOR" || name === "VISUAL" || name === "PAGER") return "identity";
  if (!name.startsWith("GIT_")) return undefined;
  const upper = name.toUpperCase();
  if (gitExecutableEnvNames.has(upper) || gitConfigSourceEnvNames.has(upper)) return "identity";
  // The same dynamic spellings `gitExecutesNestedProgram` treats as
  // config-bearing: any key, including an alias, can arrive this way.
  if (/^GIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$/.test(upper)) return "identity";
  return "context";
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
  let contextUntrusted = false;
  let unclassifiable = false;
  /**
   * `env` clears a variable with `-u NAME` / `--unset=NAME` as well as setting
   * one, so unsetting `PATH` redirects lookup exactly as setting it does. The
   * caller's `safe` flag covers the setting form; this records the unset form so
   * it lands on the same verdict.
   */
  const applyImpact = (name: string): void => {
    const impact = executableTrustImpact(name);
    if (impact === "identity") safe = false;
    else if (impact === "context") contextUntrusted = true;
  };
  /**
   * A delegating wrapper only hides the real command behind its own option
   * grammar. When that grammar cannot be reduced, the words name the wrapper and
   * not the program it runs, so the program is unidentified — a refusal, not the
   * review that `contextUntrusted` carries. `env -C DIR cmd` is the case: `env`
   * is found at a trusted path and `-C` is a directory, yet where the delegated
   * command begins is not established, so the program behind it is not either.
   * Recording this as `unclassifiable` alone left `executableTrusted` true and
   * the refusal never fired.
   */
  const markUnreduced = (): void => {
    unclassifiable = true;
    safe = false;
  };
  while (index < words.length) {
    const name = assignmentName(words[index] ?? "");
    if (!name) break;
    applyImpact(name);
    index += 1;
  }
  while (index < words.length) {
    const wrapperToken = words[index] ?? "";
    const wrapper = basename(wrapperToken).toLowerCase();
    if (
      wrapper === "command" ||
      wrapper === "builtin" ||
      wrapper === "nohup" ||
      wrapper === "setsid" ||
      wrapper === "exec" ||
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
      // A bare `time`/`command`/`nohup`/`setsid`/`exec` names no command at all.
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
        markUnreduced();
        break;
      }
      let next = delegatingWrapperOptionCount(wrapper, words, index + 1);
      if (next === undefined) {
        markUnreduced();
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
        if (isEnvAssignmentToken(token)) {
          // `env` accepts any non-`-`-prefixed `NAME=` item, so
          // the name is everything left of the first `=` — wider
          // than the legal shell identifier the bare-assignment
          // prefix above still requires. An unknown name carries
          // no trust impact (`executableTrustImpact` matches exact
          // names and the `GIT_` namespace only), so consuming a
          // wider item as an assignment can only widen which
          // items are eaten, never which program the words name.
          applyImpact(token.slice(0, token.indexOf("=")));
          index += 1;
          continue;
        }
        if (token === "--") {
          index += 1;
          break;
        }
        if (token === "-u" || token === "--unset") {
          const unsetName = words[index + 1];
          if (!unsetName) safe = false;
          else applyImpact(unsetName);
          index += 2;
          continue;
        }
        if (token.startsWith("--unset=")) {
          applyImpact(token.slice("--unset=".length));
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
          // `env` stays anchored here: the words after an option whose arity is
          // not established do not provably begin with the delegated command, so
          // the program behind `env` is unidentified rather than merely
          // unproven. `env -C DIR git add x` is refused, which is what the
          // working-directory relocation has always been worth.
          markUnreduced();
          // `--chdir` moves the working directory the wrapped command runs in,
          // so any path this segment's operands name is relative to a root the
          // caller never saw. Deletion targets and write roots are checked
          // against the outer cwd, which makes the check provable for the wrong
          // tree. The reference implementation does not parse `--chdir` either;
          // it sends the whole `env` invocation to review. That is the shape
          // available here, so the segment stops claiming a fixed argv instead
          // of a new option grammar being invented for one flag.
          if (token === "-C" || token === "--chdir" || token.startsWith("--chdir=")) {
            unclassifiable = true;
          }
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
  return { index, safe, contextUntrusted, unclassifiable };
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
 * Whether the command word can be rewritten before the shell runs it, so the
 * binary this parser read is not provably the binary that executes.
 *
 * Three mechanisms, all fail-closed for the same reason — the effect lands on
 * whichever word the expansion happens to yield first:
 *
 * - substitution: `$CMD`, `` `cmd` ``, `$(cmd)`.
 * - brace expansion: `{rm,echo} -f x` yields `rm` and `echo` as separate
 *   words, so `rm` receives `-f x` and deletes it. Bash expands this
 *   unconditionally, so it needs no matching file to fire.
 * - pathname expansion: `r?m`, `r*m`, `[a-z]m` name whichever cwd entry
 *   matches. Whether anything matches is not knowable statically, and a
 *   non-matching pattern is left literal, so both outcomes are possible.
 * - zsh's `=command`: expands to the full path of `command`, so `=rm -f x`
 *   runs rm. Verified in a real zsh (`zsh -fc '=echo hi'` prints). Bash treats
 *   a leading `=` literally, but the cost of the shared rule is a review on a
 *   command word no one writes, while the cost of missing the zsh form is a
 *   deletion.
 *
 * Only the command word is checked. Expansion in an argument position leaves
 * the executable alone (`ls {a,b}` still runs `ls`), so `awk '{ print }'` and
 * `find . -name '*.txt'` are unaffected.
 *
 * `[` is the one metacharacter that is also a real builtin, so the bare token
 * is exempt; `[...]` with any other character is a glob.
 */
function commandWordIsUnprovable(token: string): boolean {
  if (token.startsWith("=")) return true;
  if (token.includes("$") || token.includes("`")) return true;
  if (token.includes("*") || token.includes("?") || token.includes("{") || token.includes("}")) {
    return true;
  }
  return token.includes("[") && token !== "[";
}

/**
 * `{`/`}` as a standalone word is shell grouping, never an operand: the group
 * body is a separate argv the char segmenter did not reduce (`function f {
 * rm -f x; }`).
 *
 * Brace *expansion* is a different thing — it is one word that becomes several,
 * and it is handled by `commandWordIsUnprovable` when that word is the command
 * word. In an argument position the executable is unaffected, so `ls {a,b}` and
 * `awk '{ print }'` stay decomposable.
 */
function hasGroupingWord(words: readonly string[]): boolean {
  return words.some((word) => word === "{" || word === "}");
}

/**
 * First non-flag operand: the script file an interpreter would run, if any.
 * A word after a value-taking option is that option's value (`bash -o pipefail`,
 * `python -X utf8`). A runtime's leading mode word selects what runs (`deno
 * run`). A bare `-` is the stdin sentinel (`deno run -`, `python -`): the program
 * arrives on a pipe, so no word here names it and the caller must fail closed.
 *
 * Redirection is not among the skip reasons. The lexer drops operators and their
 * targets, so an unquoted `sh < script` never reaches here. A *quoted* one can:
 * in `python '>out' script.py` the first positional operand is a file called
 * `>out` and that is the script Python runs, with `script.py` as `sys.argv[1]`.
 * It is a defined operand and therefore a fixed argv, which is what this
 * function is for; skipping the next word would instead report no script at all
 * and send an ordinary command to review.
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
    if (optionValueFlags.has(arg)) {
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
 * `--version`/`--help` as the *first* argument: the one invocation form where
 * the interpreter prints and exits without running a program.
 *
 * The position restriction is the whole rule, and it is stricter than it looks.
 * A flag that appears later may be the value of an option ahead of it, and
 * then it is an ordinary operand rather than a terminal flag — verified, not
 * assumed: `python3 -W --help` passes `--help` to `-W`, prints a warning, and
 * goes on to run the program on stdin, and `kubectl --as --help delete pod x`
 * prompts for a username and then deletes. Checking "is there a flag before
 * it" is not enough either, because such a flag is exactly the thing that can
 * consume it. Only the first argument has nothing in front of it.
 *
 * The short forms stay unclassifiable: `sh -v` reads stdin.
 */
export function hasTerminalInfoFlag(args: readonly string[]): boolean {
  const first = args[0];
  return first === "--version" || first === "--help";
}

/**
 * Index of the option that carries a shell's inline program, or -1 when it has
 * none.
 *
 * POSIX option names are case-sensitive and `-C` is not `-c`: `-C` is noclobber
 * and takes no value, `-c` is what takes the program. Matching case-insensitively
 * resolved `bash -C -c 'rm -rf build'` to the first hit, took the literal `-c` as
 * the program, and left the body unexamined — so one added flag turned a forced
 * deletion from HARD into an auto-approved LOW.
 *
 * `c` need not end the group, because it takes a value: `bash -cex` runs `ex`.
 * Both the executable parse and the nested-segment expansion read the program
 * through this one function so the two cannot disagree about where it is.
 */
export function inlineProgramOptionIndex(args: readonly string[]): number {
  return args.findIndex((arg) => arg === "--command" || /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
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
  // Both the separated and the attached spelling: `python3 -m pip` and
  // `python3 -mpip` run the same module, and only matching the bare flag let
  // `python3 -mfoo main.py` through.
  if (moduleExecutionRuntimes.has(executable) && args.some((arg) => arg.startsWith("-m")))
    return true;
  return (
    hasInlineProgramArgument(args) ||
    (scriptOperand(executable, args) === undefined && !hasTerminalInfoFlag(args))
  );
}

/**
 * Above this the fold refuses an argv as untrustworthy. The AST adapter enforces the
 * same bound on its side; repeating it here is what stops a front end from handing the
 * fold a word list the danger scan would never finish reading.
 */
const MAX_SEGMENT_WORDS = 1024;

/**
 * The V1 front end's facts for one segment: the hand-written lexer's word list plus
 * the raw-text syntax scan.
 *
 * Redirections are shell syntax, not words: `>out rm -f x` runs `rm`, and the lexer has
 * already dropped the operator and its target, so the word list here is the argv the
 * command actually receives. Nothing downstream has to know that a redirect existed —
 * `hasRedirect` and `hasHereDocument` come from a separate scan of the raw text.
 */
function segmentLexFacts(source: string): SegmentFacts {
  const lexed = shellWords(source);
  const syntax = scanShellSyntax(source);
  return {
    source,
    words: lexed.words,
    lexIncomplete: lexed.error !== undefined || lexed.incomplete !== undefined,
    hasExecutableSubstitution: syntax.hasExecutableSubstitution,
    hasActiveRedirect: syntax.hasActiveRedirect,
    hasHereDocument: syntax.hasHereDocument,
    heredocExpansionRisk: false,
    bodies: syntax.liveSubstitutions,
  };
}

function foldSegment(facts: SegmentFacts): CommandSegment {
  const { source, words } = facts;
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
  const commandIndex = inlineProgramOptionIndex(args);
  const nestedShell = shellExecutables.has(executable) && commandIndex >= 0;
  const reExec = reExecutesString(executable, args, nestedShell);
  // A Git invocation can be told to run another program — a shell alias, a
  // pager, a `bisect run` payload — without any of those words naming it.
  const nestedGitProgram = executable === "git" && gitExecutesNestedProgram(words, args);
  // The decomposable conjunction evaluated clause by clause, with the first
  // failing clause recorded as this segment's cause. Clause order matches the
  // conjunction that used to stand in its place, so the boolean is exactly
  // `cause === undefined` and no consumer can drift from the fold.
  let unprovenCause: SegmentUnprovenCause | undefined;
  // Tracked apart from the `lex_incomplete` cause: a brace group is the one
  // unproven clause whose body can hide a nested command, so the fallback in
  // `risk.ts` must fail closed on it rather than judge the leading word.
  let grouped = false;
  if (facts.lexIncomplete || nameless) {
    unprovenCause = "lex_incomplete";
  } else if (context.unclassifiable) {
    unprovenCause = "wrapper_unreduced";
  } else if (nestedGitProgram) {
    unprovenCause = "nested_git_program";
  } else if (commandWordIsUnprovable(executableToken)) {
    unprovenCause = "command_word_unproven";
  } else if (reExec) {
    unprovenCause = "program_reinterpreted";
  } else if (facts.hasExecutableSubstitution) {
    unprovenCause = "substitution_unproven";
  } else if (facts.heredocExpansionRisk) {
    unprovenCause = "heredoc_unproven";
  } else if (hasGroupingWord(words)) {
    unprovenCause = "lex_incomplete";
    grouped = true;
  }
  return {
    source,
    executableToken,
    executable,
    executableTrusted: context.safe && isTrustedExecutableToken(executableToken, executable),
    // Deliberately not derived from `executableTrusted`. A segment can name an
    // identified program and still carry unproven surroundings, and a segment
    // whose program is unidentified is refused regardless of what else is true —
    // folding the two together let an untrusted binary buy a lighter verdict by
    // adding an argument that made it non-decomposable.
    executableContextUntrusted: context.contextUntrusted,
    args,
    hasRedirect: facts.hasActiveRedirect,
    hasSubstitution: facts.hasExecutableSubstitution,
    nestedShell,
    // Static argv equals runtime argv only when nothing can rewrite the word
    // list: the lexing completed, no dynamic executable, no re-interpreted
    // string, no nested Git program, no substitution, no heredoc body, no
    // unreduced brace group, and no wrapper whose argument grammar could not be
    // reduced to the real command. The clauses live in `unprovenCause` above;
    // defining the boolean as their negation is what stops the fold and the
    // cause from ever disagreeing.
    decomposable: unprovenCause === undefined,
    grouped,
    unprovenCause,
  };
}

export function parseCommandSegments(command: string): CommandSegment[] {
  return parseSegmentsAtDepth(command, 0);
}

/**
 * Whether a command's argv is not fixed, at command-line scale.
 *
 * `risk.ts` uses this to refuse tier 3 and to name the tier 4 cause, so the question it
 * answers is "can any segment of this command line hide argv behind an expansion". The
 * V1 text scan is the floor and is never retired here: a `$` the grammar happens to read
 * as an ordinary character still counts, and a front end that abstains must not buy a
 * relaxation with its silence. The AST is consulted per segment, on the statement's own
 * span, where the text scan cannot tell a quoted `|` from an operator.
 */
export function commandHasExecutableSubstitution(command: string): boolean {
  if (scanShellSyntax(command).hasExecutableSubstitution) return true;
  const facts = astSegmentFacts(command);
  if (facts?.some((segment) => segment.hasExecutableSubstitution)) {
    return true;
  }
  return skippedHeredocSubstitutions(command).some((bodies) => bodies.length > 0);
}

/**
 * The AST front end's facts for a whole command line, or `undefined` when it abstains.
 *
 * Three abstentions, in the order they are checked.
 *
 *  - **No parser installed.** The host never enabled the migration, or the WASM bridge
 *    failed to load. This is the default state of the shipped extension.
 *  - **Outside the model.** The adapter returns nothing for a control-flow form, a
 *    subshell, a `!` negation, a pipeline behind a redirect, a node type it does not
 *    know, or a parse that threw.
 *  - **Not the same partition, or not the same argv.** The segments have to land on the
 *    exact byte spans the character splitter cut, and each span's word list has to be
 *    the list the lexer builds, after the grammar-correction zones below are settled.
 *
 * The third rule is what makes "V2 is never looser than V1" a property of the code
 * rather than of a test suite. A richer syntax tree can disagree with the lexer in two
 * ways, and both of them are relaxations: re-segmenting the line changes which argv
 * belong to which command, and a shorter word list for one span removes argv from the
 * danger check. Where the AST is *more* complete than the lexer, the divergence is a
 * fail-closed loss of the AST path, never a quieter verdict. Retiring the lexer's
 * partition is later-phase work, gated on the differential suite.
 */
function astSegmentFacts(command: string): SegmentFacts[] | undefined {
  if (!shellAstParserInstalled()) return undefined;
  const analysis = analyzeCommandWithAst(command);
  if (analysis === undefined) return undefined;
  const chunks = splitShellSegments(command);
  if (analysis.segments.length !== chunks.length) return undefined;
  const facts: SegmentFacts[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index] ?? "";
    const segment = analysis.segments[index];
    if (segment === undefined || segment.source !== chunk) return undefined;
    const lexed = segmentLexFacts(chunk);
    if (!argvAligned(lexed, segment)) return undefined;
    facts.push({
      source: chunk,
      // The lexer's list is used once agreement is proven, rather than the AST's copy:
      // it is the same list, and reading it from one owner keeps the fold's argv exactly
      // the argv the danger scan saw before the migration.
      words: lexed.words,
      // The front end attributes incompleteness to the span it
      // belongs to — the lexer's own scan of the span, or an
      // error region the grammar marked inside the span's
      // statement — so an error elsewhere in the line cannot
      // tighten a span the front end read whole.
      lexIncomplete: lexed.lexIncomplete || segment.lexIncomplete,
      hasExecutableSubstitution:
        lexed.hasExecutableSubstitution || segment.hasExecutableSubstitution,
      hasActiveRedirect: lexed.hasActiveRedirect || segment.hasActiveRedirect,
      hasHereDocument: lexed.hasHereDocument || segment.hasHereDocument,
      heredocExpansionRisk: lexed.heredocExpansionRisk || segment.heredocExpansionRisk,
      // A body either front end saw gets expanded. The AST can name a substitution the
      // text scan shredded; the scan can name one the grammar hid inside a construct.
      bodies: [...new Set([...lexed.bodies, ...segment.bodies])],
    });
  }
  return facts;
}

/**
 * Whether the AST front end answered for this command line — the
 * same predicate the segment fold dispatches on, exposed so the
 * differential suite gates on production's own engagement instead
 * of re-deriving a weaker one that can drift from it.
 */
export function astFrontEndEngaged(command: string): boolean {
  return astSegmentFacts(command) !== undefined;
}

/**
 * Whether the two front ends name the same argv for the same span.
 *
 * `shellWords` keeps a `VAR=value` prefix word — only the redirect path
 * drops words — and the fold's `executableContext` consumes those words by
 * advancing its index, so the assignment has to be present for the wrapper
 * reduction to see the program behind it (`FOO=1 rm -f x` must keep `FOO=1`
 * for `rm` to be found). The AST's word list must therefore equal the
 * lexer's word for word: a shorter list on either side removes argv from the
 * danger check, and any disagreement sends the whole command line to the
 * lexer.
 */
function argvAligned(lexed: SegmentFacts, ast: SegmentFacts): boolean {
  if (lexed.words.length > MAX_SEGMENT_WORDS || ast.words.length > MAX_SEGMENT_WORDS) {
    return false;
  }
  return (
    lexed.words.length === ast.words.length &&
    lexed.words.every((word, index) => word === (ast.words[index] ?? ""))
  );
}

/**
 * Substitution bodies nest; expansion stops at the same depth bound the
 * dangerous-wrapper walk uses (`MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH` in
 * dangerous-commands.ts). A command that hides its argv under more than
 * eight substitutions has already failed every decomposable gate on the way
 * down; the cap only bounds work, never a trust decision.
 */
const MAX_SUBSTITUTION_NESTING = 8;

function parseSegmentsAtDepth(command: string, depth: number): CommandSegment[] {
  // Only the top-level line is a candidate for the AST. A body the expander pulled out
  // of `bash -c '…'` or `$(…)` is already text whose quoting the outer front end
  // resolved, and re-parsing it with a second grammar would compare spans that were
  // never comparable. The lexer owns those.
  const ast = depth === 0 ? astSegmentFacts(command) : undefined;
  // One walk: segments and the skipped-body lists are projections of
  // it. A second walk can store a body past the last segment, and
  // that entry is never read.
  const {
    segments: chunks,
    skippedBodies: heredocSubstitutions,
    heredocExpansionRisk,
  } = splitShellText(command);
  // Substitutions inside an active heredoc body run, but the body is
  // data the splitter never lets become a chunk, so no per-chunk scan
  // can see them. They belong to the chunk that opened the heredoc,
  // and the expander below treats them exactly like a substitution in
  // that chunk's own text — the same `bodies` -> `expandBody` path an
  // inline substitution takes, so the danger check and its
  // `dangerousSubstitution` attribution apply unchanged.
  const facts = chunks.map((source, index) => {
    const frontEnd = ast?.[index] ?? segmentLexFacts(source);
    const skipped = heredocSubstitutions[index];
    const risk = heredocExpansionRisk[index] === true;
    const withRisk =
      risk && !frontEnd.heredocExpansionRisk
        ? { ...frontEnd, heredocExpansionRisk: true }
        : frontEnd;
    if (skipped === undefined || skipped.length === 0) return withRisk;
    return {
      ...withRisk,
      bodies: [...new Set([...withRisk.bodies, ...skipped])],
    };
  });
  const segments = facts.map((fact) => {
    // `foldSegment` is the whole verdict, and it is the same call on both paths: the
    // AST can change a fact, never a rule.
    return foldSegment(fact);
  });
  const nested = segments.flatMap((segment, index) => {
    // The body inherits the host segment's environment, and the inner parse
    // starts from a fresh `executableContext`, so it cannot see what the outer
    // words established. That made the trust gate a single wrapper away:
    // `env PATH=/tmp /bin/bash -c 'git push origin main'` marked the inner `git`
    // trusted and auto-approved it, because the only segment that had seen
    // `PATH=/tmp` was the shell. An untrusted host is inherited whole — its
    // program cannot be identified, and nothing it runs is identified either.
    //
    // `GIT_DIR` is the case that needs care: it is a `context` impact, so the
    // host stays trusted and the body inherits only that. Inheriting trust here
    // would be wrong — the body runs in a different repository, and reading it
    // as trusted would let the relocation decide nothing. Inheriting the
    // unproven marker is what makes the body's own `git push` a review.
    //
    // This inheritance is deliberately shared by both body sources below: a
    // substitution body runs in the segment's environment exactly as a
    // `shell -c` body runs in the shell's.
    const inherit = (nestedSegment: CommandSegment): CommandSegment =>
      segment.executableTrusted
        ? segment.executableContextUntrusted
          ? { ...nestedSegment, executableContextUntrusted: true }
          : nestedSegment
        : { ...nestedSegment, executableTrusted: false, executableContextUntrusted: true };
    // The body is shell code, so a substitution or heredoc in it is live even
    // when outer quoting made it inert for the parent shell: `bash -c 'cat
    // $(pwd)'` runs the substitution. The char segmenter drops the `(`, so the
    // body text itself is what proves the inner argv is not static — and the
    // body's own words are what make its dangerous argv a plain segment that
    // tier 1 can see, whether it came from a `-c` argument or from a live
    // `$(…)` that the splitter only ever shredded by accident.
    const expandBody = (
      body: string,
      nestedFrom: "shell_body" | "substitution",
    ): CommandSegment[] => {
      const syntax = scanShellSyntax(body);
      // Only a live substitution rewrites the body's argv. A bare `<<`
      // alone must not flip `hasHereDocument` into a forced
      // decomposable:false + heredoc_unproven for the nested body:
      // the direct scanShellSyntax(body) call already sees active-body
      // `$`/backtick chars and sets hasExecutableSubstitution for them,
      // and inert bodies never expand at all.
      const bodyRewritesArgv = syntax.hasExecutableSubstitution;
      return parseSegmentsAtDepth(body, depth + 1).map((nestedSegment) => {
        const inherited = { ...inherit(nestedSegment), nestedFrom };
        return bodyRewritesArgv
          ? {
              ...inherited,
              decomposable: false,
              // The host body re-runs a program string, so even a well-formed
              // inner argv is not the argv the outer command started with. Keep
              // the inner segment's own cause when it has one; otherwise name
              // the body mechanism that forced this.
              unprovenCause: inherited.unprovenCause ?? "substitution_unproven",
            }
          : inherited;
      });
    };
    const results: CommandSegment[] = [];
    const commandIndex = shellExecutables.has(segment.executable)
      ? inlineProgramOptionIndex(segment.args)
      : -1;
    const shellBody = commandIndex >= 0 ? segment.args[commandIndex + 1] : undefined;
    if (shellBody !== undefined && shellBody !== "")
      results.push(...expandBody(shellBody, "shell_body"));
    // Substitution bodies go unexpanded only below the nesting bound: the
    // words there still set every boolean on their own segment's scan, so the
    // command still fails closed; just the extra inspection stops.
    if (depth < MAX_SUBSTITUTION_NESTING) {
      for (const body of facts[index]?.bodies ?? []) {
        results.push(...expandBody(body, "substitution"));
      }
    }
    return results;
  });
  return [...segments, ...nested];
}

/**
 * Commands that publish shell state every later segment of the same command
 * line sees.
 *
 * Two kinds, because they are the same defect by different means. A variable
 * setter hands a later segment a value its argv never named. A directory
 * changer hands it a root: `cd /tmp; git push origin main` runs in a different
 * repository, with a different config, a different `core.hooksPath` and a
 * different implicit remote — and the implicit-remote lookup reads repository
 * metadata from the `cwd` this request arrived with, not from `/tmp`. The
 * destination that gets bound is then the wrong repository's.
 *
 * `cd` is the case the references leave open, and they leave it open in opposite
 * ways. fx refuses every `;`-joined command as `unsupported_shell`
 * (`command_effect.zig:392`), which closes the relocation by refusing all
 * composition. Codex parses `cd` and accumulates the new root
 * (`parse_command.rs:1472`, `cd_target` + `join_paths`), but that feeds
 * `ParsedCommand` for event reporting and tool registration — its authorization
 * path reads raw tokens through `is_dangerous_command` and never sees it. This
 * package deliberately supports composition (`git add README.md;` auto-runs), so
 * refusing `;` is not available either. The rule is already here for variable
 * setters; a directory changer belongs in it.
 *
 * The exemption is a no-op relocation, not a general one. `cd .` and
 * `cd <the request's own cwd>` provably reach the directory the request already
 * named, and a read-only probe written as `cd <cwd> && git status` is ordinary
 * work. The comparison is literal on purpose: `cd /a/b/../c` against `/a/c`
 * compares unequal and is treated as a relocation, which is the direction that
 * cannot fail open. Symlinks are not resolved, so a path that merely looks like
 * the cwd counts as a relocation rather than being waved through.
 */
export const shellDirectoryChangers = new Set(["cd", "pushd", "popd"]);

export const shellStateSetters = new Set(["declare", "export", "local", "readonly", "typeset"]);

function isNoOpRelocation(segment: CommandSegment, requestCwd: string | undefined): boolean {
  if (requestCwd === undefined) return false;
  const [target] = segment.args;
  if (target === undefined) return false;
  if (target === ".") return true;
  return stripTrailingSlash(target) === stripTrailingSlash(requestCwd);
}

function stripTrailingSlash(value: string): string {
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * Whether one segment of a compound command can change what a later one does.
 *
 * `GIT_EDITOR='rm -f x' git commit` is caught by the assignment check on the
 * segment that carries it, but `export GIT_EDITOR='rm -f x'; git commit` puts
 * the assignment in its own segment, and the `git commit` segment is then
 * analysed as though nothing had been set. The editor program is named by the
 * environment rather than by argv, so the static argv is not the argv that
 * runs. `cd` reaches the same conclusion by handing over a root instead of a
 * value.
 *
 * Tracking the value across segments would mean modelling shell state, which is
 * a different model from the one this layer uses. The reference implementation
 * does not model it either: it routes a compound command carrying an assignment
 * to `unsupported_shell`. This is that rule, expressed over segments we already
 * have — a compound command that publishes state is not decomposable, and the
 * reviewer decides.
 */
export function shellStateCrossesSegments(
  segments: readonly CommandSegment[],
  requestCwd?: string,
): boolean {
  if (segments.length < 2) return false;
  return segments.some((segment) => {
    if (segment.executable === "") return true;
    if (shellStateSetters.has(segment.executable)) return true;
    if (!shellDirectoryChangers.has(segment.executable)) return false;
    return !isNoOpRelocation(segment, requestCwd);
  });
}
