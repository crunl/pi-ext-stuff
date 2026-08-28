import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Git is only eligible for the sealed git-init fast path when the admission
 * plan names one of these fixed system locations. The returned value is the
 * canonical identity used for spawning, so a plan can never smuggle an
 * arbitrary absolute executable into the privileged adapter.
 */
export const TRUSTED_SYSTEM_GIT_PATHS = ["/usr/bin/git", "/bin/git"] as const;

export function resolveTrustedSystemGitExecutable(candidate: string): string | undefined {
  const normalized = resolve(candidate);
  try {
    const trustedIdentities = TRUSTED_SYSTEM_GIT_PATHS.flatMap((path) => {
      try {
        const alias = lstatSync(path);
        if (!alias.isFile() && !alias.isSymbolicLink()) return [];
        const identity = realpathSync(path);
        if (!lstatSync(identity).isFile()) return [];
        accessSync(identity, constants.X_OK);
        return [identity];
      } catch {
        return [];
      }
    });
    const fixedAlias = TRUSTED_SYSTEM_GIT_PATHS.includes(
      normalized as (typeof TRUSTED_SYSTEM_GIT_PATHS)[number],
    );
    // A resolved plan may be passed back through this function by the
    // execution seam. Accept only the fixed aliases or their already-known
    // canonical identities; a /tmp/symlink pointing at Git must not qualify.
    if (!fixedAlias && !trustedIdentities.includes(normalized)) return undefined;

    const entry = lstatSync(normalized);
    if (!entry.isFile() && !entry.isSymbolicLink()) return undefined;
    const canonical = realpathSync(normalized);
    if (!lstatSync(canonical).isFile()) return undefined;
    accessSync(canonical, constants.X_OK);
    return trustedIdentities.includes(canonical) ? canonical : undefined;
  } catch {
    return undefined;
  }
}
