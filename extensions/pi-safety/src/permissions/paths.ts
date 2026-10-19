import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { defaultSafetyConfigPath, isPathWithin } from "../policy-primitives.ts";

interface PathPolicy {
  cwd: string;
  allowWrite: string[];
  denyRead: string[];
  denyWrite: string[];
  protectedWritePaths?: string[];
  operation: "read" | "write";
}

type PathDecision =
  | { allowed: true; canonicalPath: string }
  | { allowed: false; canonicalPath: string; reason: string };

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
}

/** Resolve existing path components while preserving the missing suffix. */
export async function canonicalize(path: string): Promise<string> {
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

function globMatches(value: string, pattern: string, caseInsensitive = false): boolean {
  const expression = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${expression}$`, caseInsensitive ? "i" : "").test(value);
}

async function matchesProtectedPattern(
  lexicalPath: string,
  canonicalPath: string,
  lexicalCwd: string,
  canonicalCwd: string,
  patterns: string[],
): Promise<boolean> {
  return (
    await Promise.all(
      patterns.map(async (rawPattern) => {
        const pattern = expandHome(rawPattern);
        if (isAbsolute(pattern)) {
          if (pattern.includes("*")) {
            return globMatches(lexicalPath, pattern) || globMatches(canonicalPath, pattern);
          }
          const canonicalPattern = await canonicalize(pattern);
          return (
            isPathWithin(lexicalPath, pattern) || isPathWithin(canonicalPath, canonicalPattern)
          );
        }
        const candidates = [
          basename(lexicalPath),
          relative(lexicalCwd, lexicalPath),
          basename(canonicalPath),
          relative(canonicalCwd, canonicalPath),
        ];
        return candidates.some((candidate) => globMatches(candidate, pattern));
      }),
    )
  ).some(Boolean);
}

/**
 * Synchronous lexical projection of `matchesProtectedPattern`: no filesystem
 * canonicalization. Sound only where the final path component is never
 * followed — `rm` without `-r` deletes the entry itself, so the lexical path
 * is what gets removed. Anything symlink-sensitive must keep using
 * `isPathAllowed`.
 */
export function matchesProtectedPatternLexical(
  lexicalPath: string,
  lexicalCwd: string,
  patterns: readonly string[],
): boolean {
  // Deletion is irreversible, and darwin/win32 filesystems fold case while
  // the regex does not: `rm -f ID.PEM` would dodge `*.pem`. Fold where the
  // platform does. The async `isPathAllowed` path is untouched (zero blast
  // radius); the divergence denies more, never less. Absolute non-glob
  // patterns keep exact `isPathWithin` semantics, identical on both paths.
  const foldCase = process.platform === "darwin" || process.platform === "win32";
  return patterns.some((rawPattern) => {
    const pattern = expandHome(rawPattern);
    if (isAbsolute(pattern)) {
      if (pattern.includes("*")) return globMatches(lexicalPath, pattern, foldCase);
      return isPathWithin(lexicalPath, pattern);
    }
    const candidates = [basename(lexicalPath), relative(lexicalCwd, lexicalPath)];
    return candidates.some((candidate) => globMatches(candidate, pattern, foldCase));
  });
}

/** Resolves symlinks in every existing ancestor before comparing path components. */
export async function isPathAllowed(path: string, policy: PathPolicy): Promise<PathDecision> {
  const lexicalCwd = resolve(expandHome(policy.cwd));
  const cwd = await canonicalize(lexicalCwd);
  const requested = isAbsolute(expandHome(path))
    ? expandHome(path)
    : resolve(lexicalCwd, expandHome(path));
  const canonicalPath = await canonicalize(requested);
  const protectedControls = policy.protectedWritePaths ?? [defaultSafetyConfigPath()];
  const canonicalControls = await Promise.all(protectedControls.map(canonicalize));

  if (
    policy.operation === "write" &&
    (protectedControls.some((control) => isPathWithin(requested, control)) ||
      canonicalControls.some((control) => isPathWithin(canonicalPath, control)))
  ) {
    return { allowed: false, canonicalPath, reason: "permission control path is protected" };
  }

  const denied = policy.operation === "write" ? policy.denyWrite : policy.denyRead;
  if (await matchesProtectedPattern(requested, canonicalPath, lexicalCwd, cwd, denied)) {
    return { allowed: false, canonicalPath, reason: "path matches protected pattern" };
  }

  if (policy.operation === "read") return { allowed: true, canonicalPath };

  const writeRoots = await Promise.all(
    policy.allowWrite.map(async (root) => {
      const expanded = expandHome(root);
      const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
      return {
        lexical: isAbsolute(expanded) ? expanded : resolve(lexicalCwd, expanded),
        canonical: await canonicalize(absolute),
      };
    }),
  );
  if (
    !writeRoots.some(
      (root) =>
        isPathWithin(requested, root.lexical) && isPathWithin(canonicalPath, root.canonical),
    )
  ) {
    return { allowed: false, canonicalPath, reason: "write path is outside allowed roots" };
  }

  return { allowed: true, canonicalPath };
}
