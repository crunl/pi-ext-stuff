/**
 * Shell lexing: segment splitting, quoting/escape handling, redirection
 * recognition, and lexical-defect detection. Produces words and raw-text
 * syntax facts; it makes no claim about what a command does.
 */
import { assignmentName } from "./dangerous-commands.ts";

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
}

export function shellWords(source: string): ShellWords {
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
export const REDIRECT_OPERATOR = /^\d*(?:<<<|<<|>>|<>|>&|<&|>\||<|>)/;

/** A redirection operator with no attached target, so its target is the next word. */
export const BARE_REDIRECT_OPERATOR = /^\d*(?:<<<|<<|>>|<>|>&|<&|>\||<|>)$/;

export interface LeadingSyntax {
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
export function stripLeadingSyntax(words: readonly string[]): LeadingSyntax {
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
