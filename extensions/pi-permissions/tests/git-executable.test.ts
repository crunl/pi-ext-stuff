import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveTrustedSystemGitExecutable,
  TRUSTED_SYSTEM_GIT_PATHS,
} from "../src/git-executable.ts";

describe("trusted system Git executable", () => {
  it("round-trips every available fixed alias to the same canonical identity", () => {
    const resolved = TRUSTED_SYSTEM_GIT_PATHS.flatMap((alias) => {
      const identity = resolveTrustedSystemGitExecutable(alias);
      return identity === undefined ? [] : [{ alias, identity }];
    });

    if (resolved.length === 0) return;
    for (const { alias, identity } of resolved) {
      expect(resolveTrustedSystemGitExecutable(alias)).toBe(identity);
      expect(resolveTrustedSystemGitExecutable(identity)).toBe(identity);
    }
  });

  it("rejects an arbitrary symlink even when it targets trusted Git", async () => {
    const trusted = TRUSTED_SYSTEM_GIT_PATHS.map(resolveTrustedSystemGitExecutable).find(
      (identity): identity is string => identity !== undefined,
    );
    if (!trusted) return;

    const directory = await mkdtemp(join(tmpdir(), "pi-permissions-git-executable-"));
    const untrusted = join(directory, "evil");
    try {
      await symlink(trusted, untrusted);
      expect(resolveTrustedSystemGitExecutable(untrusted)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
