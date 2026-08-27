import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";

/**
 * nono refuses to grant any directory that contains its own state root
 * (`~/.local/state/nono`). Granting `$HOME` (cwd="." when the session lives
 * in the home directory) overlaps that path and the sandbox never starts.
 */
export function nonoProtectedStateRoot(home = homedir()): string {
  return resolve(home, ".local", "state", "nono");
}

function isWithin(path: string, root: string): boolean {
  const remainder = relative(root, path);
  return remainder === "" || (!remainder.startsWith(`..${sep}`) && remainder !== "..");
}

/**
 * True when `path` can appear in a nono `filesystem.allow` / `allow_file` list.
 * Rejects ancestors of the protected state (grant would cover it) and paths
 * inside the protected state.
 */
export function isFeasibleAllowPath(
  path: string,
  protectedStateRoot = nonoProtectedStateRoot(),
): boolean {
  const resolved = resolve(path);
  const state = resolve(protectedStateRoot);
  if (isWithin(state, resolved)) return false;
  if (isWithin(resolved, state)) return false;
  return true;
}

export function filterFeasibleAllowPaths(
  paths: readonly string[],
  protectedStateRoot = nonoProtectedStateRoot(),
): string[] {
  const filtered: string[] = [];
  for (const path of paths) {
    if (!isFeasibleAllowPath(path, protectedStateRoot)) continue;
    if (!filtered.includes(path)) filtered.push(path);
  }
  return filtered;
}

export const INFEASIBLE_ALLOW_PATH_REASON =
  "OS sandbox cannot grant this write root because it overlaps protected sandbox state";
