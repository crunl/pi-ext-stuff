/**
 * Shell lexing: segment splitting, quoting/escape handling, redirection
 * recognition, and lexical-defect detection. Produces words and raw-text
 * syntax facts; it makes no claim about what a command does.
 */

/** The shell variable name in a `NAME=value` word, if it has that shape. */
export function assignmentName(token: string): string | undefined {
  return /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token)?.[1];
}

/**
 * Whether a word is an `env` assignment item: an `=` whose left
 * side is non-empty and does not start with `-`. This is
 * deliberately wider than `assignmentName`, and it is the shape
 * `env` (coreutils) itself accepts: `env 1=foo cmd` and
 * `env FOO-BAR=1 cmd` set a variable for the delegated command,
 * while the same words are not legal bare shell assignments
 * (`1=foo echo hi` is a command-not-found, which is why the
 * bare-assignment prefix keeps using `assignmentName`). The
 * `-` guard keeps option spellings (`--chdir=/tmp`, `-u`) on the
 * option path. Mirrors codex `is_dangerous_command.rs`:
 * `argument.split_once('=').is_some_and(|(name, _)| !name.is_empty() && !name.starts_with('-'))`.
 * Used only in `env` wrapper contexts, where the wider predicate
 * closes the gap that let `env 1=foo rm -f x` stop the wrapper
 * walk early and hide its `rm` from every danger check.
 */
export function isEnvAssignmentToken(token: string): boolean {
  const eq = token.indexOf("=");
  return eq > 0 && !token.startsWith("-");
}

/**
 * One walk of a command line. `segments` and `skippedBodies` are the
 * projections `splitShellSegments` and `skippedHeredocSubstitutions`
 * return. A second copy of this walk can drift, and a body stored
 * past the last segment is never read.
 *
 * @internal Exported for `shell-segment.ts` and the invariant tests only.
 * Callers outside this package should use the two projections, which carry
 * the contract; this shape exists so both can share one traversal.
 */
export function splitShellText(command: string): {
  segments: string[];
  skippedBodies: string[][];
} {
  const segments: string[] = [];
  const skippedBodies: string[][] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  // Heredocs opened on the line being scanned, in the order the
  // shell consumes their bodies; one line can queue more than one
  // (`cat <<A <<B`). The newline that ends the command line opens
  // the first queued body. `chunk` is the index this segment will
  // take: the operator's text is still in `current`, so the segment
  // has not been pushed yet, and `segments.length` is that index.
  const pendingHeredocs: { spec: HeredocSpec; active: boolean; chunk: number }[] = [];
  // A `#` that begins a word starts a comment that runs to the
  // end of its line. Nothing in a comment is shell syntax, so a
  // `<<` there names no heredoc and the lines after it stay
  // commands — the splitter keeps cutting them exactly as it
  // always did, which is what keeps a commented `<<EOF` from
  // swallowing the real commands that follow it.
  let comment = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] as string;
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
    if (!comment && (character === "'" || character === '"')) {
      current += character;
      quote = character;
      continue;
    }
    if (character === "\n") {
      comment = false;
    } else if (
      !comment &&
      character === "#" &&
      (index === 0 || /\s/.test(command[index - 1] as string))
    ) {
      comment = true;
    }
    // A heredoc operator is not word text: everything from the
    // body's first line through its delimiter line is data, so the
    // operator and its delimiter stay in the command's span and
    // the body never reaches the split. An unrecognized shape (an
    // empty delimiter, a here-string) falls through and keeps the
    // character-at-a-time reading, which is today's behavior.
    if (!comment && character === "<" && command[index + 1] === "<" && command[index + 2] !== "<") {
      const heredoc = heredocDelimiterAt(command, index, true);
      if (heredoc !== undefined) {
        pendingHeredocs.push({
          spec: heredoc.spec,
          // `inertHeredocAt` answers for a quoted or escaped delimiter,
          // whose body the shell reads as literal text; an active body's
          // substitutions run and must reach the danger check. Kept as a
          // second call rather than folded into `heredocDelimiterAt`.
          active: inertHeredocAt(command, index) === undefined,
          chunk: segments.length,
        });
        current += command.slice(index, heredoc.end);
        index = heredoc.end - 1;
        continue;
      }
    }
    if (/[;&|()\n]/.test(character)) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      // The newline that opens a queued body: consume every queued
      // body through its delimiter line and resume at the start of
      // the line after the last one, which is where the shell
      // resumes reading commands.
      if (character === "\n" && pendingHeredocs.length > 0) {
        let newline = index;
        let next = command.length;
        while (pendingHeredocs.length > 0) {
          const pending = pendingHeredocs.shift() as {
            spec: HeredocSpec;
            active: boolean;
            chunk: number;
          };
          const consumed = heredocBodySpan(command, newline, pending.spec);
          if (pending.active) {
            const bodies = scanShellSyntax(consumed.body).liveSubstitutions;
            if (bodies.length > 0) {
              skippedBodies[pending.chunk] = [...(skippedBodies[pending.chunk] ?? []), ...bodies];
            }
          }
          next = consumed.next;
          if (next >= command.length) break;
          newline = next - 1;
        }
        index = next - 1;
      }
      continue;
    }
    current += character;
  }
  if (current.trim()) segments.push(current.trim());
  return { segments, skippedBodies };
}

/**
 * Split a command line into the character spans of its top-level
 * commands: the shell's own statement boundaries (`;`, `&`, `|`,
 * `\n`, and the grouping parentheses) and nothing inside a
 * heredoc body. A heredoc body is the command's input data, not
 * code the shell will run — a body spelling `rm -rf /` deletes
 * nothing — so a body line raises no segment of its own and the
 * split resumes at the line after the body's delimiter. An
 * unterminated body runs to the end of the source, exactly as
 * the shell reads it (everything after it is data). Substitutions
 * inside an *active* (unquoted-delimiter) body still run, and
 * are still caught — by the raw-source scan, not by this split.
 *
 * These spans are the `segments` projection of `splitShellText`.
 * `skippedHeredocSubstitutions` is the other projection of that
 * same walk, not a second copy of it.
 */
export function splitShellSegments(command: string): string[] {
  return splitShellText(command).segments;
}

/**
 * The live substitution bodies that lie inside the heredoc bodies
 * `splitShellSegments` skips, one array per chunk it returns, in
 * chunk order.
 *
 * A heredoc body is the command's input data, so the splitter never
 * lets a body line become a chunk of its own — but an active
 * (unquoted-delimiter) body still runs every substitution in it, and
 * those bodies are the only live text the per-chunk scan can no
 * longer reach once the splitter skips the body. The raw-source scan
 * walks an active body and consumes only an inert one, and it reports
 * those substitutions only when no inert heredoc is queued ahead of an
 * active one — a mixed queue drops them. This function fills that gap
 * and hands each skipped active body's substitutions to the chunk that
 * opened its heredoc, where the segment expander treats them exactly as
 * it treats a substitution in that chunk's own text.
 *
 * This list is the `skippedBodies` projection of `splitShellText`,
 * the same walk `splitShellSegments` projects — same comment
 * tracking, same operator recognition, same body consumption — so
 * the arrays line up with its chunks by index. Only active bodies
 * contribute: an inert body is literal text the shell never
 * re-reads, so its substitutions stay unreported. That is the same
 * active/inert decision `inertHeredocAt` already encodes for the
 * raw-source scan, reused here rather than re-derived.
 */
export function skippedHeredocSubstitutions(command: string): string[][] {
  return splitShellText(command).skippedBodies;
}

/**
 * Lexical defects that make the word list an incomplete picture of what the
 * shell will run. Mirrors fx `command_lex.zig:43-75,483-486`
 * (`ShellScan` / `LexError`): an unterminated construct is not a safe default,
 * it is an unproven one.
 */
export type ShellLexError = "unbalanced-quote" | "trailing-escape" | "nul-byte";

export interface ShellWords {
  words: string[];
  error?: ShellLexError;
  /** A bare redirect operator never received the target word it requires. */
  incomplete?: true;
}

/**
 * A redirection operator, matched at the character where the shell starts one.
 * Any file-descriptor digits are already in the word being built, so this must
 * not also accept a leading `\d*`: the alternative would be unreachable at the
 * only call site, and a documented capability nothing exercises is one a reader
 * will assume has been tested.
 */
export const REDIRECT_OPERATOR = /^(?:<<<|<<|>>|<>|>&|<&|>\||<|>)/;

export function shellWords(source: string): ShellWords {
  const words: string[] = [];
  let current = "";
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let error: ShellLexError | undefined;
  // A redirection operator is its own token wherever it appears unquoted, not
  // only at the start of a word: the shell reads `git>log push` as the command
  // `git` redirecting stdout to `log`, with `push` as an argument. Treating the
  // operator as word text made the executable `git>log`, which is in no
  // executable table, so both the implicit-Git-remote refusal and the forced
  // deletion gate were skipped by a single `>`.
  let inRedirect = false;
  // The word as it stood the moment the operator was recognised, with its file
  // descriptor if it had one. "Bare" means nothing was appended after that, and
  // that has to be decided by comparison rather than by re-matching the operator
  // pattern: `shellWords` strips quotes, so the attached target of `>'>'` leaves
  // `current` as `>>`, which the bare pattern accepts. Testing that way dropped
  // the next real argument, and `rm >'>' -rf /` lost its `-rf`.
  let redirectOperatorWord = "";
  // A bare operator's target is the word after it, and that word is a filename,
  // not an argument: in `git > push origin` the shell writes to a file called
  // `push`. The next completed word is therefore dropped rather than emitted.
  let dropRedirectTarget = false;
  const bareRedirect = (): boolean => current === redirectOperatorWord;
  const flush = (): void => {
    if (tokenStarted) {
      if (dropRedirectTarget) {
        dropRedirectTarget = false;
      } else if (inRedirect) {
        if (bareRedirect()) dropRedirectTarget = true;
      } else {
        words.push(current);
      }
    }
    current = "";
    tokenStarted = false;
    inRedirect = false;
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
    if (!inRedirect && (character === "<" || character === ">")) {
      // Digits already in the word are this operator's file descriptor and stay
      // with it; anything else is the command or argument the shell redirects,
      // so it ends here. A bare descriptor with no operator is ordinary text,
      // which is why `git2>log` stays the command `git2`.
      if (!tokenStarted || !/^\d+$/.test(current)) flush();
      const operator = REDIRECT_OPERATOR.exec(source.slice(index))?.[0] ?? character;
      current += operator;
      redirectOperatorWord = current;
      tokenStarted = true;
      inRedirect = true;
      index += operator.length - 1;
      continue;
    }
    current += character;
    tokenStarted = true;
  }
  if (escaped) error ??= "trailing-escape";
  if (quote !== undefined) error ??= "unbalanced-quote";
  // A bare operator still open at end of input never received its target, so the
  // word list is an incomplete picture of the command.
  const incomplete = inRedirect && bareRedirect();
  flush();
  if (error === undefined) return incomplete ? { words, incomplete } : { words };
  return incomplete ? { words, error, incomplete } : { words, error };
}

export interface ShellSyntax {
  hasExecutableSubstitution: boolean;
  hasActiveRedirect: boolean;
  hasActiveControl: boolean;
  hasHereDocument: boolean;
  /**
   * The body text of every live `$(…)` or backtick substitution this scan
   * saw live — outside single quotes and unescaped. This is the only place
   * the quoting state exists: the segmenter's `shellWords` output is
   * byte-identical for `'$(pwd)'`, `"$(pwd)"` and `$(pwd)`, so whether a
   * substitution is live or inert can only be decided here, on the raw
   * source. Consumers parse the bodies; they add no verdict of their own.
   * An unclosed or unpairable substitution yields no body — the booleans
   * already fail the command closed, and a parser must never be fed
   * half-matched text. Count is capped (precedent:
   * `MAX_DANGEROUS_WRAPPER_DEPTH`); the cap only limits how many bodies are
   * reported, never the booleans.
   */
  liveSubstitutions: string[];
}

const MAX_LIVE_SUBSTITUTIONS = 8;

interface HeredocSpec {
  delimiter: string;
  stripTabs: boolean;
}

/**
 * Parse the delimiter word of a heredoc operator whose two
 * angle brackets begin at `start` (both known-unquoted), in
 * every form the shell accepts: `<<'X'` and `<<"X"` (the
 * body is literal text), `<<\X` (the delimiter is X, escaped
 * against further parsing), and the bare `<<X` (the body
 * expands). Returns the spec and the position just past the
 * delimiter word, or undefined for a here-string, an empty
 * delimiter, or a shape not understood — the fail-closed
 * directions, where the caller keeps reading characters one
 * at a time. Whitespace between `<<` and the delimiter is
 * not accepted even though bash allows it — refusing keeps
 * the flags the existing scan has always raised, and it is
 * what keeps `cat < <(cmd)` from being misread as a heredoc
 * whose process substitution the caller then declared inert.
 *
 * `allowActive` admits the bare form. The syntax scan passes
 * `false`: an unquoted delimiter means the body expands, and
 * that scan must keep reading such a body as live source, so
 * the bare form reports undefined exactly as it always has.
 */
function insideArithmeticContext(source: string, index: number): boolean {
  let depth = 0;
  let back = index - 1;
  while (back >= 0 && /\s/.test(source[back] as string)) back -= 1;
  for (; back >= 0; back -= 1) {
    const character = source[back];
    // A command separator ends the enclosing expression: an arithmetic context
    // can never span `;`, a newline, or a pipeline/boolean operator, so a `((`
    // found beyond one belongs to an earlier command (possibly inside a string)
    // and must not be attributed to this `<<`. Without this the scan reaches an
    // unclosed literal `((` in a prior quoted word and the real heredoc opener
    // is lost, over-blocking every following line.
    if (character === ";" || character === "\n" || character === "|" || character === "&")
      return false;
    if (character === ")") depth += 1;
    else if (character === "(") {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      let before = back - 1;
      while (before >= 0 && /\s/.test(source[before] as string)) before -= 1;
      return source[before] === "(";
    }
  }
  return false;
}

function heredocDelimiterAt(
  source: string,
  start: number,
  allowActive: boolean,
): { spec: HeredocSpec; end: number } | undefined {
  if (insideArithmeticContext(source, start)) return undefined;
  let position = start + 2;
  if (source[position] === "<") return undefined; // here-string: one word, expands
  const stripTabs = source[position] === "-";
  if (stripTabs) position += 1;
  const quote = source[position];
  let delimiter: string;
  if (quote === "'") {
    const end = source.indexOf("'", position + 1);
    if (end === -1) return undefined;
    delimiter = source.slice(position + 1, end);
    position = end + 1;
  } else if (quote === '"') {
    let text = "";
    let escaped = false;
    position += 1;
    for (; position < source.length; position += 1) {
      const character = source[position];
      if (escaped) {
        text += character;
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        break;
      } else {
        text += character;
      }
    }
    if (position >= source.length) return undefined;
    delimiter = text;
    position += 1;
  } else if (quote === "\\") {
    position += 1;
    const begin = position;
    while (position < source.length && !/\s/.test(source[position] as string)) {
      position += 1;
    }
    delimiter = source.slice(begin, position);
  } else if (allowActive && quote !== undefined && !/\s/.test(quote) && !/[;&|()<>]/.test(quote)) {
    // The bare form's delimiter is the first word: it ends at
    // whitespace or a shell operator, the way the shell ends
    // any word. A backslash inside it would have to be
    // quote-removed to name the shell's delimiter, which is
    // not modelled here — such a shape reports undefined and
    // keeps today's character reading, the fail-closed side.
    const begin = position;
    while (position < source.length && !/[\s;&|()<>]/.test(source[position] as string)) {
      position += 1;
    }
    delimiter = source.slice(begin, position);
    if (delimiter.includes("\\")) return undefined;
  } else {
    return undefined;
  }
  if (delimiter === "") return undefined;
  return { spec: { delimiter, stripTabs }, end: position };
}

/**
 * Peek at a `<<` (at `start`, both angle brackets known-unquoted) for an
 * INERT heredoc: a quoted (`<<'X'`, `<<"X"`) or escaped (`<<\X`) delimiter
 * means the body is literal text — the shell never re-reads it as code.
 * Returns undefined for here-strings, unquoted delimiters (their bodies DO
 * expand — left exactly as active as today), empty delimiters, and any shape
 * not understood: every undefined is today's behavior, which is the
 * fail-closed direction. Whitespace between `<<` and the delimiter is not
 * accepted even though bash allows it — refusing keeps today's flags, and it
 * is what keeps `cat < <(cmd)` from being misread as a heredoc whose
 * process substitution the scanner then declared inert.
 */
function inertHeredocAt(source: string, start: number): HeredocSpec | undefined {
  return heredocDelimiterAt(source, start, false)?.spec;
}

/**
 * Consume a body from the newline that opens it. The body and its
 * delimiter line carry no flags, so the scan resumes at the start of the
 * line after the delimiter. An unterminated body runs to the end of the
 * source — the input is incomplete, and the caller's other checks already
 * refuse it.
 *
 * The body is the lines before the delimiter line; the delimiter line
 * itself is not body content, so a delimiter that spells a `$` or a
 * backtick is never read back as a substitution the shell never
 * performed.
 */
function heredocBodySpan(
  source: string,
  newlineIndex: number,
  spec: HeredocSpec,
): { body: string; next: number } {
  let lineStart = newlineIndex + 1;
  while (lineStart < source.length) {
    const nextNewline = source.indexOf("\n", lineStart);
    const lineEnd = nextNewline === -1 ? source.length : nextNewline;
    let line = source.slice(lineStart, lineEnd);
    if (spec.stripTabs) line = line.replace(/^\t+/, "");
    if (line === spec.delimiter) {
      return {
        body: source.slice(newlineIndex + 1, lineStart),
        next: lineEnd === source.length ? source.length : lineEnd + 1,
      };
    }
    if (nextNewline === -1) break;
    lineStart = nextNewline + 1;
  }
  return { body: source.slice(newlineIndex + 1), next: source.length };
}

/**
 * Match a `$(…)` body from just after the opening paren: parentheses count
 * only when unquoted, quotes and escapes track the inner shell's own rules.
 * Returns undefined when the paren never closes — fail closed to "no body",
 * never a guess.
 */
function matchParenSubstitution(source: string, start: number): string | undefined {
  let depth = 1;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
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
    if (quote === '"') {
      if (character === '"') quote = undefined;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index);
    }
  }
  return undefined;
}

/**
 * Match a backtick body: the next unescaped backtick closes it. POSIX gives
 * no nesting without `\`` escaping, so quoting inside a body gets no special
 * treatment — a body can end up truncated relative to a pathological quoting
 * nest, which is safe in the only direction that matters: the outer booleans
 * still see the raw text, and a consumer parses at most a prefix.
 */
function matchBacktickSubstitution(source: string, start: number): string | undefined {
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "`") return source.slice(start, index);
  }
  return undefined;
}

export function scanShellSyntax(source: string): ShellSyntax {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let hasExecutableSubstitution = false;
  let hasActiveRedirect = false;
  let hasActiveControl = false;
  let hasHereDocument = false;
  const liveSubstitutions: string[] = [];
  // Quoted-delimiter heredocs detected on the current line; each body starts
  // at the next newline, in order, the way the shell assigns them.
  const pendingHeredocs: HeredocSpec[] = [];
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
    // A single quote is literal inside a double-quoted string. Opening a
    // single-quoted region here regardless would swallow the rest of the input,
    // including the closing `"`, and report no substitution, no redirect and no
    // control operator behind it: `echo "it's" `+"`rm -rf /`"+` reached Tier 3's
    // substitution gate as satisfied and auto-approved LOW.
    if (character === "'" && quote === undefined) {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    // Any `$` or backtick outside a single-quoted region expands, and an expanded
    // word is whatever the variable holds — so the static argv is not the argv that
    // runs. This used to require a *command* substitution (`` ` ``, `$(`, `${ `),
    // which missed every parameter expansion: `git commit "${FLAG:--S}" -m x`
    // reached Tier 3 and auto-approved, and the flag it injects is chosen at
    // runtime.
    //
    // fx takes the same shape for the same reason, one step wider: any of
    // ``$ ` * ? [ ~`` outside single quotes is a dynamic shell
    // (`command_effect.zig:386-394`). Globs are not adopted here — a path glob is
    // expanded by the caller's shell into filenames, which is a different claim
    // from a variable substituting an arbitrary value, and `rm -f build/*` is
    // ordinary work. The `$` case is adopted because there is no reading of
    // `${…}` under which the static layer knows the resulting word.
    //
    // Single-quoted regions returned above, so a literal `$` inside quotes is not
    // reached here; an escaped `\$` was consumed by the `escaped` branch.
    if (character === "`" || character === "$") {
      hasExecutableSubstitution = true;
      // Reaching here means the substitution is live: single-quoted regions
      // returned above, and `\$` was consumed by the `escaped` branch. The
      // main scan deliberately does not skip the body — the flags keep their
      // exact pre-extraction meaning — and the body is instead handed to the
      // parser, which recurses through the same trust inheritance as a
      // `shell -c` body.
      if (liveSubstitutions.length < MAX_LIVE_SUBSTITUTIONS) {
        const body =
          character === "`"
            ? matchBacktickSubstitution(source, index + 1)
            : source[index + 1] === "("
              ? matchParenSubstitution(source, index + 2)
              : undefined;
        if (body !== undefined) liveSubstitutions.push(body);
      }
    }
    if (quote === undefined && (character === "<" || character === ">")) {
      hasActiveRedirect = true;
    }
    // `<<WORD` (heredoc) and `<<<WORD` (here-string) feed content the char
    // segmenter keeps as separate text, so the command's real input is not in
    // the argv we parsed.
    if (quote === undefined && character === "<" && source[index + 1] === "<") {
      hasHereDocument = true;
      const inert = inertHeredocAt(source, index);
      if (inert !== undefined) pendingHeredocs.push(inert);
    }
    // The newline that opens a pending heredoc body is a real line
    // terminator, so its own flag stays; the body lines it opens are literal
    // text and raise nothing. Consume through the delimiter line — and
    // through any further pending body that starts on the line right after,
    // the way the shell queues them.
    if (character === "\n" && pendingHeredocs.length > 0 && quote === undefined) {
      hasActiveControl = true;
      let newline = index;
      let next = source.length;
      while (pendingHeredocs.length > 0) {
        next = heredocBodySpan(source, newline, pendingHeredocs.shift() as HeredocSpec).next;
        if (next >= source.length) break;
        newline = next - 1; // the newline terminating this delimiter line
      }
      index = next - 1; // the loop's step lands on `next`
      continue;
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
  return {
    hasExecutableSubstitution,
    hasActiveRedirect,
    hasActiveControl,
    hasHereDocument,
    liveSubstitutions,
  };
}
