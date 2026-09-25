/**
 * Shell lexing: segment splitting, quoting/escape handling, redirection
 * recognition, and lexical-defect detection. Produces words and raw-text
 * syntax facts; it makes no claim about what a command does.
 */

/** The shell variable name in a `NAME=value` word, if it has that shape. */
export function assignmentName(token: string): string | undefined {
  return /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token)?.[1];
}

export function splitShellSegments(command: string): string[] {
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
export type ShellLexError = "unbalanced-quote" | "trailing-escape" | "nul-byte";

export interface ShellWords {
  words: string[];
  error?: ShellLexError;
  /** A bare redirect operator never received the target word it requires. */
  incomplete?: true;
}

/**
 * A redirection operator, optionally prefixed by a file descriptor. In the
 * shell grammar the target is part of the same word when it is attached
 * (`>out`, `2>err`, `2>&1`) and a separate word when it is not (`> out`).
 * Neither form is ever the command word.
 */
export const REDIRECT_OPERATOR = /^\d*(?:<<<|<<|>>|<>|>&|<&|>\||<|>)/;

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
}

export function scanShellSyntax(source: string): ShellSyntax {
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
