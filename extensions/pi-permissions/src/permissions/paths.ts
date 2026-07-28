import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface PathPolicy {
  cwd: string;
  allowWrite: string[];
  denyRead: string[];
  denyWrite: string[];
  protectedWritePaths?: string[];
  operation: "read" | "write";
}

export type PathDecision =
  | { allowed: true; canonicalPath: string }
  | { allowed: false; canonicalPath: string; reason: string };

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

async function matchesProtectedPattern(
  lexicalPath: string,
  canonicalPath: string,
  lexicalCwd: string,
  canonicalCwd: string,
  patterns: string[],
): Promise<boolean> {
  return (await Promise.all(patterns.map(async (rawPattern) => {
    const pattern = expandHome(rawPattern);
    if (isAbsolute(pattern)) {
      if (pattern.includes("*")) {
        return globMatches(lexicalPath, pattern) || globMatches(canonicalPath, pattern);
      }
      const canonicalPattern = await canonicalize(pattern);
      return isWithin(lexicalPath, pattern) || isWithin(canonicalPath, canonicalPattern);
    }
    const candidates = [
      basename(lexicalPath),
      relative(lexicalCwd, lexicalPath),
      basename(canonicalPath),
      relative(canonicalCwd, canonicalPath),
    ];
    return candidates.some((candidate) => globMatches(candidate, pattern));
  }))).some(Boolean);
}

/** Resolves symlinks in every existing ancestor before comparing path components. */
export async function isPathAllowed(path: string, policy: PathPolicy): Promise<PathDecision> {
  const lexicalCwd = resolve(expandHome(policy.cwd));
  const cwd = await canonicalize(lexicalCwd);
  const requested = isAbsolute(expandHome(path))
    ? expandHome(path)
    : resolve(lexicalCwd, expandHome(path));
  const canonicalPath = await canonicalize(requested);
  const protectedControls = policy.protectedWritePaths ?? [
    resolve(homedir(), ".pi/agent/permissions.json"),
    resolve(lexicalCwd, ".pi/permissions.json"),
  ];
  const canonicalControls = await Promise.all(protectedControls.map(canonicalize));

  if (policy.operation === "write" && (
    protectedControls.some((control) => isWithin(requested, control))
    || canonicalControls.some((control) => isWithin(canonicalPath, control))
  )) {
    return { allowed: false, canonicalPath, reason: "permission control path is protected" };
  }

  const denied = policy.operation === "write" ? policy.denyWrite : policy.denyRead;
  if (await matchesProtectedPattern(requested, canonicalPath, lexicalCwd, cwd, denied)) {
    return { allowed: false, canonicalPath, reason: "path matches protected pattern" };
  }

  if (policy.operation === "read") return { allowed: true, canonicalPath };

  const writeRoots = await Promise.all(policy.allowWrite.map(async (root) => {
    const expanded = expandHome(root);
    const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    return { lexical: isAbsolute(expanded) ? expanded : resolve(lexicalCwd, expanded), canonical: await canonicalize(absolute) };
  }));
  if (!writeRoots.some((root) => isWithin(requested, root.lexical) && isWithin(canonicalPath, root.canonical))) {
    return { allowed: false, canonicalPath, reason: "write path is outside allowed roots" };
  }

  return { allowed: true, canonicalPath };
}

export const DEFAULT_WRITE_ROOTS = [".", tmpdir()];
