/**
 * Known-cwd directory normalization.
 *
 * A leading `cd <literal>` is statically decidable: the effective directory
 * is computable from data the analyser already holds (the invocation cwd), so
 * the segment chain needs no cross-segment state. This helper FOLDS that `cd`
 * segment so `shellStateCrossesSegments` stops firing, and nothing else.
 *
 * The fold is subtraction only: the returned list is always a subset of the
 * input, so every retained segment reaches the tiers with the argv it would
 * have had anyway. The one judgement the fold removes is "a directory change
 * happened", which is why the admission list below is a deny list and not a
 * read-only allow list — `cp`, `mv`, `tee` and `docker` all fold, exactly as
 * they would be decided without a `cd` in front of them. Writes stay inside
 * the sandbox, which computes its roots from the real directory.
 *
 * What it deliberately does NOT do:
 * - It never rewrites a relative path argument into an absolute one. Lexical
 *   cwd is not real cwd: `/tmp` is `/private/tmp`, and `realpath` needs fs
 *   I/O, which the propose layer is forbidden from touching
 *   (`tests/structure-invariants.test.ts`).
 * - It never folds a relocation that is followed by a VCS or a package/task
 *   runner. Implicit git remotes are read from the request cwd
 *   (`inspectRepositoryGitMetadata(cwd)` in `risk-policy.ts`), not from the
 *   directory the command changes into, so a folded `cd` would bind the wrong
 *   repository.
 * - It never folds before a deletion executable, a state setter, a second
 *   directory changer, or a non-decomposable segment.
 *
 * Anything not admitted here is returned unchanged, so the existing
 * fail-closed review path is the only outcome. Tier-1 danger detection runs on
 * the returned segments, which keep every non-`cd` segment intact.
 */
import { resolve } from "node:path";
import type { CommandSegment } from "./rules.ts";
import { deletionExecutables } from "./rules.ts";
import {
  parseCommandSegments,
  shellDirectoryChangers,
  shellStateSetters,
} from "./shell-segment.ts";

/** Programs whose behaviour depends on state a directory change invalidates. */
const CONTEXT_DEPENDENT_EXECUTABLES = new Set([
  "git",
  "gh",
  "glab",
  "hg",
  "svn",
  "bzr",
  "fossil",
  "jj",
  "eval",
  "source",
  ".",
  "npx",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "make",
  "just",
  "task",
  "direnv",
]);

/** `cd` targets we can resolve without touching the environment. */
function isLiteralDirectoryTarget(target: string | undefined): target is string {
  if (target === undefined) return false;
  if (target.length === 0) return false;
  if (target.startsWith("-")) return false;
  if (target === "~" || target.startsWith("~/")) return false;
  if (/[$`\\*?[\]{}()!]/.test(target)) return false;
  if (target.includes("=")) return false;
  if (target.split("/").some((part) => part === "..")) return false;
  return true;
}

function isAdmissibleFollowingSegment(segment: CommandSegment): boolean {
  if (segment.executable === "") return false;
  if (shellDirectoryChangers.has(segment.executable)) return false;
  if (shellStateSetters.has(segment.executable)) return false;
  if (deletionExecutables.has(segment.executable)) return false;
  if (CONTEXT_DEPENDENT_EXECUTABLES.has(segment.executable)) return false;
  if (!segment.decomposable) return false;
  if (!segment.executableTrusted) return false;
  if (segment.hasRedirect) return false;
  if (segment.hasSubstitution) return false;
  return true;
}

/**
 * Fold leading literal `cd` segments when every following segment is provably
 * independent of the working directory. Returns the original segment list
 * unchanged when the command is not admissible.
 */
export function normalizeKnownCwdDirectory(
  segments: readonly CommandSegment[],
  cwd: string,
): CommandSegment[] {
  if (segments.length < 2) return segments as CommandSegment[];
  let index = 0;
  let effectiveCwd = resolve(cwd);
  let relocated = false;
  while (index < segments.length) {
    const segment = segments[index];
    if (segment === undefined) break;
    if (segment.executable !== "cd" || segment.executableToken !== "cd") break;
    if (segment.args.length !== 1) break;
    if (segment.hasRedirect || segment.hasSubstitution || !segment.decomposable) break;
    if (!isLiteralDirectoryTarget(segment.args[0])) break;
    const nextCwd = resolve(effectiveCwd, segment.args[0] as string);
    if (nextCwd !== effectiveCwd) relocated = true;
    effectiveCwd = nextCwd;
    index += 1;
  }
  if (index === 0) return segments as CommandSegment[];
  const rest = segments.slice(index);
  // Only a single leading `cd` is folded. A contiguous chain (`cd a && cd b`)
  // is left alone: the second changer would be consumed here and would never
  // reach `isAdmissibleFollowingSegment`, so `shellStateCrossesSegments` would
  // stop seeing a directory change that is still live for the rest of the line.
  if (index > 1) return segments as CommandSegment[];
  if (!relocated) {
    // A no-op chain (`cd .`, `cd <cwd>`) still drops out: the working
    // directory never moved, so no following segment can depend on it.
    return rest;
  }
  for (const segment of rest) {
    if (!isAdmissibleFollowingSegment(segment)) return segments as CommandSegment[];
  }
  return rest;
}

/** Convenience wrapper for callers that still hold only the command text. */
export function normalizedSegmentsFor(command: string, cwd: string): CommandSegment[] {
  return normalizeKnownCwdDirectory(parseCommandSegments(command), cwd);
}
