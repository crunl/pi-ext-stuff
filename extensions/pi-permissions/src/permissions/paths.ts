import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface PathPolicy {
  cwd: string;
  allowWrite: string[];
  denyRead: string[];
  denyWrite: string[];
  operation: "read" | "write";
}

export type PathDecision =
  | { allowed: true; canonicalPath: string }
  | { allowed: false; canonicalPath: string; reason: string };

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
}

function isWithin(path: string, root: string): boolean {
  const remainder = relative(root, path);
  return remainder === "" || (!remainder.startsWith(`..${sep}`) && remainder !== "..");
}

async function canonicalize(path: string): Promise<string> {
  const missing: string[] = [];
  let ancestor = path;
  while (true) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      return resolve(canonicalAncestor, ...missing.reverse());
    } catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) return resolve(path);
      missing.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

function globMatches(value: string, pattern: string): boolean {
  const expression = pattern
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${expression}$`).test(value);
}

function matchesProtectedPattern(path: string, cwd: string, patterns: string[]): boolean {
  const workspaceRelative = relative(cwd, path);
  const candidates = [basename(path), workspaceRelative];
  return patterns.some((rawPattern) => {
    const pattern = expandHome(rawPattern);
    if (isAbsolute(pattern)) return isWithin(path, pattern);
    return candidates.some((candidate) => globMatches(candidate, pattern));
  });
}

/** Resolves symlinks in every existing ancestor before comparing path components. */
export async function isPathAllowed(path: string, policy: PathPolicy): Promise<PathDecision> {
  const cwd = await canonicalize(resolve(expandHome(policy.cwd)));
  const requested = isAbsolute(expandHome(path))
    ? expandHome(path)
    : resolve(cwd, expandHome(path));
  const canonicalPath = await canonicalize(requested);
  const protectedControls = [
    resolve(homedir(), ".pi/agent/permissions.json"),
    resolve(cwd, ".pi/permissions.json"),
  ];

  if (policy.operation === "write" && (isWithin(canonicalPath, packageRoot) || protectedControls.some((control) => canonicalPath === control))) {
    return { allowed: false, canonicalPath, reason: "permission control path is protected" };
  }

  const denied = policy.operation === "write" ? policy.denyWrite : policy.denyRead;
  if (matchesProtectedPattern(canonicalPath, cwd, denied)) {
    return { allowed: false, canonicalPath, reason: "path matches protected pattern" };
  }

  if (policy.operation === "read") return { allowed: true, canonicalPath };

  const writeRoots = await Promise.all(policy.allowWrite.map(async (root) => {
    const expanded = expandHome(root);
    const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    return canonicalize(absolute);
  }));
  if (!writeRoots.some((root) => isWithin(canonicalPath, root))) {
    return { allowed: false, canonicalPath, reason: "write path is outside allowed roots" };
  }

  return { allowed: true, canonicalPath };
}

export const DEFAULT_WRITE_ROOTS = [".", tmpdir()];
