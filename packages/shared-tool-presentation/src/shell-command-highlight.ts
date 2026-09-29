import { highlightCode } from "@earendil-works/pi-coding-agent";

/** Cap before shell highlight / command evidence so pathological commands cannot stall the renderer. */
export const MAX_COMMAND_CHARS = 4_000;

interface CommandRange {
  readonly start: number;
  readonly end: number;
}

const SHELL_COMMAND_SEPARATORS = new Set(["&&", "||", "|", ";", "&", "(", "{", "\n"]);
const SHELL_COMMAND_PREFIX_WORDS = new Set(["do", "elif", "else", "if", "then", "until", "while"]);
const SHELL_RESERVED_WORDS = new Set([
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "time",
  "until",
  "while",
]);

type ThemeLike = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

function resolvePiTheme(): ThemeLike | undefined {
  const key = Symbol.for("@earendil-works/pi-coding-agent:theme");
  const t = (globalThis as Record<symbol, unknown>)[key] as ThemeLike | undefined;
  if (t && typeof t.fg === "function" && typeof t.bold === "function") return t;
  return undefined;
}

/**
 * Shell-command highlight (MiniMax / Codex style): highlight.js `bash` base,
 * then paint each command-position executable in accent bold so `cp`/`grep`
 * stay distinct from args. Falls back to plain `highlightCode("bash")` when
 * the host theme is not initialized.
 */
export function highlightShellCommandLines(command: string): string[] {
  const source = command.length > MAX_COMMAND_CHARS ? command.slice(0, MAX_COMMAND_CHARS) : command;
  if (source.length === 0) return [];
  const ranges = findShellCommandRanges(source);
  const theme = resolvePiTheme();
  if (ranges.length === 0 || !theme) return highlightCode(source, "bash");

  const replacements = ranges.map((range, index) => ({
    ...range,
    token: source.slice(range.start, range.end),
    placeholder: uniquePlaceholder(source, index),
  }));
  let prepared = source;
  for (const replacement of [...replacements].reverse()) {
    prepared = `${prepared.slice(0, replacement.start)}${replacement.placeholder}${prepared.slice(replacement.end)}`;
  }

  const highlighted = highlightCode(prepared, "bash");
  return highlighted.map((line) => {
    let out = line;
    for (const replacement of replacements) {
      if (!out.includes(replacement.placeholder)) continue;
      out = out.replace(replacement.placeholder, theme.fg("accent", theme.bold(replacement.token)));
    }
    return out;
  });
}

function findShellCommandRanges(command: string): CommandRange[] {
  const ranges: CommandRange[] = [];
  let expectCommand = true;
  let index = 0;

  while (index < command.length) {
    const character = command[index] ?? "";
    if (character === " " || character === "\t" || character === "\r") {
      index += 1;
      continue;
    }
    if (character === "#") {
      const newline = command.indexOf("\n", index);
      index = newline === -1 ? command.length : newline;
      continue;
    }

    const operator = readShellOperator(command, index);
    if (operator) {
      if (SHELL_COMMAND_SEPARATORS.has(operator.value)) expectCommand = true;
      index = operator.end;
      continue;
    }

    const word = readShellWord(command, index);
    if (word.end === index) {
      index += 1;
      continue;
    }
    index = word.end;
    if (!expectCommand) continue;

    const plainWord = unquoteShellWord(command.slice(word.start, word.end));
    if (isShellAssignment(plainWord)) continue;
    if (SHELL_RESERVED_WORDS.has(plainWord)) {
      expectCommand = SHELL_COMMAND_PREFIX_WORDS.has(plainWord);
      continue;
    }
    ranges.push(word);
    expectCommand = false;
  }
  return ranges;
}

function readShellOperator(
  command: string,
  start: number,
): { readonly value: string; readonly end: number } | undefined {
  const pair = command.slice(start, start + 2);
  if (pair === "&&" || pair === "||") return { value: pair, end: start + 2 };
  const character = command[start];
  if ("|;&(){}\n<>".includes(character ?? "")) {
    return { value: character ?? "", end: start + 1 };
  }
  return undefined;
}

function readShellWord(command: string, start: number): CommandRange {
  let index = start;
  let quote: "'" | '"' | undefined;
  while (index < command.length) {
    const character = command[index] ?? "";
    if (character === "\\") {
      index = Math.min(command.length, index + 2);
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      index += 1;
      continue;
    }
    if (/\s/u.test(character) || "|;&(){}<>".includes(character)) break;
    index += 1;
  }
  return { start, end: index };
}

function unquoteShellWord(word: string): string {
  if (word.length >= 2) {
    const first = word[0];
    const last = word.at(-1);
    if ((first === "'" || first === '"') && last === first) return word.slice(1, -1);
  }
  return word;
}

function isShellAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word);
}

function uniquePlaceholder(command: string, index: number): string {
  let attempt = `PICOMMANDTOKEN${String(index)}X`;
  while (command.includes(attempt)) attempt += "X";
  return attempt;
}
