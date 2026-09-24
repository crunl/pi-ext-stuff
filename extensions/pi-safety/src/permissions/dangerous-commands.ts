/**
 * Dangerous-command heuristics, mirroring openai/codex `is_dangerous_command.rs`
 * (codex-rs/shell-command). Only `rm` with a force option is flagged, plus
 * recursive checks through `sudo`/`env` wrappers and `trap` actions.
 * Everything else is left to the sandbox boundary (see stage 3 path checks).
 */
import { assignmentName } from "./shell-lexer.ts";

const MAX_DANGEROUS_WRAPPER_DEPTH = 8;

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
      assignmentName(argument) !== undefined
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
  if (depth > MAX_DANGEROUS_WRAPPER_DEPTH) return true;
  if (words.length === 0) return false;
  const executable = words[0] ?? "";
  if (executable === "rm") return rmArgsIncludeForce(words.slice(1));
  if (executable === "sudo") return isDangerousWords(words.slice(1), depth + 1);
  if (executable === "env") return dangerousEnv(words, depth);
  return false;
}
