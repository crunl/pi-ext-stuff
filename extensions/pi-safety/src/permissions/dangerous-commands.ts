/**
 * Dangerous-command heuristics, mirroring openai/codex `is_dangerous_command.rs`
 * (codex-rs/shell-command). Only `rm` with a force option is flagged, plus
 * recursive checks through `sudo`/`env` wrappers and `trap` actions.
 * Everything else is left to the sandbox boundary (see stage 3 path checks).
 *
 * Delegation depth below (`landTransparentDelegation`,
 * `visibleDelegatedDanger`) is a deliberate superset of the codex mirror:
 * codex judges the first word only, so `exec sudo -D …` and
 * `timeout 1e3 rm -rf …` miss it. Each arm below names the measurement or
 * the reference that backs it; anything without one stays out.
 */
import { basename } from "node:path";

import { isEnvAssignmentToken } from "./shell-tokens.ts";

const MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH = 8;

/** True when `rm` was invoked with `-f`/`--force` (or a flag bundle containing `f`). */
function rmArgsIncludeForce(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "--force") return true;
    const flags = arg.startsWith("-") ? arg.slice(1) : undefined;
    if (flags !== undefined && !flags.startsWith("-") && flags.includes("f")) return true;
  }
  return false;
}

function dangerousEnv(words: string[], depth: number): boolean {
  let index = 1;
  while (index < words.length) {
    const argument = words[index] ?? "";
    if (argument === "--") {
      index += 1;
      break;
    }
    if (
      argument === "-i" ||
      argument === "--ignore-environment" ||
      isEnvAssignmentToken(argument)
    ) {
      index += 1;
      continue;
    }
    break;
  }
  return isDangerousWords(words.slice(index), depth + 1);
}

/**
 * Words-level dangerous check: `rm -f` and its wrappers. `trap` is handled by
 * the caller (it needs shell-command parsing of the action string).
 */
export function isDangerousWords(words: string[], depth = 0): boolean {
  // Defensive, codex-aligned invariant: past the wrapper-reasoning depth we
  // can no longer prove the nested sudo/env chain safe, so fail closed and
  // treat it as dangerous (mirrors codex's Some(Other) at the same bound).
  // The segment path pre-strips wrappers via executableContext before calling
  // in, so this bound guards direct calls to this exported helper and future
  // callers that hand over raw words.
  if (depth > MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH) return true;
  if (words.length === 0) return false;
  const executable = words[0] ?? "";
  if (executable === "rm") return rmArgsIncludeForce(words.slice(1));
  if (executable === "sudo") return isDangerousWords(words.slice(1), depth + 1);
  if (executable === "env") return dangerousEnv(words, depth);
  return false;
}

/**
 * Transparent delegators: run their operand as-is (mirrors the fold's
 * transparent loop in `shell-segment.ts`, minus trust marking).
 * `builtin` is deliberately absent — measured: `builtin sudo …` errors
 * instead of delegating, so it never hides a command.
 */
const transparentDelegators = new Set(["exec", "command", "nohup", "setsid", "time"]);

/**
 * Peel transparent delegation off raw words. Returns the landed words, or
 * null when nothing remains (bare wrapper) or when peeling must stop:
 * `command -v`/`-V` only print a path and never execute (measured).
 * Bounded: absurd nesting fails open like codex rather than hanging.
 */
export function landTransparentDelegation(words: readonly string[]): string[] | null {
  let current = [...words];
  for (let i = 0; i <= MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH; i += 1) {
    const first = basename(current[0] ?? "").toLowerCase();
    if (!transparentDelegators.has(first)) return current;
    if (first === "command" && (current[1] === "-v" || current[1] === "-V")) return null;
    let rest = current.slice(1);
    if (first === "time") {
      // `time -f FORMAT` / `-o FILE` take a value (mirrors the fold).
      const flag = rest[0] ?? "";
      if (flag === "-f" || flag === "--format" || flag === "-o" || flag === "--output") {
        if (rest[1] === undefined) return null;
        rest = rest.slice(2);
      }
    }
    // Leading dash words belong to the delegator (`command -p`, `exec -c`
    // both still delegate, measured) — except a bare `-`, which the fold
    // leaves in place.
    while (rest.length > 0 && (rest[0] ?? "").startsWith("-") && rest[0] !== "-") {
      rest = rest.slice(1);
    }
    if (rest.length === 0) return null;
    current = rest;
  }
  return null;
}

/**
 * Tail rule for landed `sudo`/`env`: an option-shaped tail is unreduced
 * (review — the tail decides nothing provable), `--` ends option parsing
 * exactly like the matcher above, and anything else is judged as the
 * command it names.
 */
function privilegeTailDanger(words: string[], depth: number): boolean {
  const tail = words.slice(1);
  const first = tail[0];
  if (first === undefined) return false;
  if (first === "--") return isDangerousWords(tail.slice(1), depth + 1);
  if (first.startsWith("-")) return true;
  return isDangerousWords(words, depth + 1);
}

/**
 * Permissive operand index for delegating wrappers with an option grammar
 * (`timeout`/`nice`/`stdbuf`). Mirrors the fold's
 * `delegatingWrapperOptionCount` minus value-shape validation: the fold
 * already reduced every provable spelling, so what reaches here failed
 * strict parsing — re-checking shapes would just re-anchor. An unknown
 * flag returns undefined (fail safe: GNU rejects unknown options with
 * rc=125, measured), as does a missing operand.
 */
function permissiveOperandIndex(
  wrapper: string,
  words: readonly string[],
  start: number,
): number | undefined {
  let index = start;
  while (index < words.length) {
    const token = words[index] ?? "";
    if (!token.startsWith("-") || token === "-") break;
    if (wrapper === "timeout") {
      if (
        token === "--foreground" ||
        token === "--preserve-status" ||
        token === "--verbose" ||
        token === "-v"
      ) {
        index += 1;
        continue;
      }
      if (
        token === "-k" ||
        token === "--kill-after" ||
        token === "-s" ||
        token === "--signal" ||
        token.startsWith("--kill-after=") ||
        token.startsWith("--signal=")
      ) {
        if (!token.includes("=")) {
          if (words[index + 1] === undefined) return undefined;
          index += 2;
        } else {
          index += 1;
        }
        continue;
      }
      return undefined;
    }
    if (wrapper === "nice") {
      if (token === "-n" || token === "--adjustment") {
        if (words[index + 1] === undefined) return undefined;
        index += 2;
        continue;
      }
      if (token.startsWith("--adjustment=") || /^-[+-]?\d+$/.test(token)) {
        index += 1;
        continue;
      }
      return undefined;
    }
    if (wrapper === "stdbuf") {
      if (token === "-i" || token === "-o" || token === "-e") {
        if (words[index + 1] === undefined) return undefined;
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
      // Attached shorts (`-o0`, `-oX!`): any attached tail counts, without
      // the fold's buffer-size shape check — the strict check is what
      // anchored these spellings here in the first place.
      if (/^-[ioe]/.test(token)) {
        index += 1;
        continue;
      }
      return undefined;
    }
    return undefined;
  }
  return index;
}

/**
 * Visible delegated danger: the command a delegating wrapper will run,
 * judged permissively. `doas`/`su` always review (auth boundary, not
 * argv); `sudo`/`env` judge the tail; `timeout` skips one duration word
 * of any shape (the fold's duration-shape check is what anchored the
 * `1e3`/`0x1` spellings here, and GNU runs them); `nice` skips a bare
 * adjustment. Anything unparseable fails safe (Skip — GNU rejects it),
 * anything degenerate (no operand) is nothing to run.
 */
export function visibleDelegatedDanger(words: readonly string[], depth = 0): boolean {
  if (depth > MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH) return true;
  const landed = landTransparentDelegation(words);
  if (landed === null || landed.length === 0) return false;
  const first = basename(landed[0] ?? "").toLowerCase();
  if (first === "rm") return rmArgsIncludeForce(landed.slice(1));
  // Auth boundary, not argv: `su`/`doas` gate on a password either way.
  if (first === "doas" || first === "su") return true;
  if (first === "sudo" || first === "env") return privilegeTailDanger(landed, depth);
  if (first === "timeout" || first === "nice" || first === "stdbuf") {
    let index = permissiveOperandIndex(first, landed, 1);
    if (index === undefined) return false;
    if (first === "timeout") {
      // One duration word of any shape (see above).
      if (landed[index] === undefined) return false;
      index += 1;
    }
    if (first === "nice") {
      if (/^[+-]\d+$/.test(landed[index] ?? "")) index += 1;
    }
    const operand = landed[index] ?? "";
    if (operand === "" || operand.startsWith("-")) return false;
    return visibleDelegatedDanger(landed.slice(index), depth + 1);
  }
  return false;
}
