/**
 * Pure string predicates over shell words. The survivors of the retired
 * hand-written lexer: everything here is a stateless function of text in,
 * answer out, with no notion of segmentation or syntax state. Anything that
 * needed a scan (partitioning, heredoc queues, substitution pairing) now
 * reads the grammar in `shell-ast.ts` instead.
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
 * `argument.split_once('=').is_some_and(|(name, _)| !name.is_empty() && !name.startsWith('-'))`.
 * Used only in `env` wrapper contexts, where the wider predicate
 * closes the gap that let `env 1=foo rm -f x` stop the wrapper
 * walk early and hide its `rm` from every danger check.
 */
export function isEnvAssignmentToken(token: string): boolean {
  const eq = token.indexOf("=");
  return eq > 0 && !token.startsWith("-");
}

const MAX_LIVE_SUBSTITUTIONS = 8;

/**
 * The outermost live substitution bodies of a text: one body per substitution
 * site at depth 0, in source order, capped. Inner levels are NOT reported —
 * the expander parses each body recursively, so eager nesting multiplies work
 * exponentially (20-deep `echo "$($(…))"` produced 250k segments). Siblings
 * are all kept; depth is the recursion's job, not the list's.
 *
 * Quoting mirrors shell rules: single-quoted and escaped sites are
 * inert, double-quoted sites are live. Backtick bodies do not nest.
 */
export function outermostSubstitutionBodies(source: string): string[] {
  const bodies: string[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;
  // Skip the inside of a substitution once reported: the recursion owns it.
  let skipUntil = -1;
  for (let index = 0; index < source.length; index += 1) {
    if (index < skipUntil) continue;
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
    // A single quote is literal inside a double-quoted string: opening a
    // region here would swallow the closing `"`, hiding every substitution
    // behind it.
    if (character === "'" && quote === undefined) {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    // Only the single-quoted region above is inert (it continued); a `"`
    // region falls through: double-quoted substitutions run.
    if (character === "`") {
      const body = matchBacktickSubstitution(source, index + 1);
      if (body !== undefined && bodies.length < MAX_LIVE_SUBSTITUTIONS) bodies.push(body);
      // A backtick body never nests, but its text is consumed either way: a
      // second opener inside would pair with the wrong closer.
      const close = source.indexOf("`", index + 1);
      if (close !== -1) skipUntil = close + 1;
    } else if (character === "$" && source[index + 1] === "(") {
      const body = matchParenSubstitution(source, index + 2);
      if (body !== undefined) {
        if (bodies.length < MAX_LIVE_SUBSTITUTIONS) bodies.push(body);
        skipUntil = index + 2 + body.length + 1;
      }
    }
  }
  return bodies;
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
