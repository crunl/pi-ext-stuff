import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type PermissionsConfig } from "../src/config.ts";
import { evaluateDefaultRequest } from "../src/default-mode.ts";
import { packageRoot } from "../src/filesystem-policy.ts";

function config(overrides: Partial<PermissionsConfig> = {}): PermissionsConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...overrides,
  };
}

async function createGitDirectory(path: string, contents = ""): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(path, "config"), contents);
  await mkdir(join(path, "objects"));
  await mkdir(join(path, "refs"));
}

describe("Default mode gate", () => {
  it("allows ordinary workspace reads and writes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    await expect(
      evaluateDefaultRequest("read", { path: "README.md" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
    await expect(
      evaluateDefaultRequest("write", { path: "notes.txt", content: "hello" }, cwd, config()),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
    await expect(
      evaluateDefaultRequest(
        "write",
        { path: ".pi/permissions.json", content: "{}" },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("allows ordinary writes in the extension package root", async () => {
    await expect(
      evaluateDefaultRequest(
        "write",
        { path: "p2-3-package-root.txt", content: "hello" },
        packageRoot,
        config(),
      ),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("blocks protected secrets without a one-off prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    for (const path of [".env", "nested/.env", "nested/.env.local", "nested/deploy.key"]) {
      await expect(evaluateDefaultRequest("read", { path }, cwd, config())).resolves.toMatchObject({
        action: "block",
      });
      await expect(
        evaluateDefaultRequest("write", { path, content: "secret" }, cwd, config()),
      ).resolves.toMatchObject({ action: "block" });
    }
  });

  it("keeps repository control directories read-only", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    for (const path of [".git/config", ".agents/AGENTS.md", ".codex/config.toml"]) {
      await expect(
        evaluateDefaultRequest("write", { path, content: "x" }, cwd, config()),
      ).resolves.toMatchObject({
        action: "block",
        reason: "permission control path is protected",
      });
    }
  });

  it("prompts for external writes and dangerous Bash", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    await expect(
      evaluateDefaultRequest("write", { path: "/var/tmp/out.txt", content: "x" }, cwd, config()),
    ).resolves.toMatchObject({ action: "prompt", risk: "REVIEW" });
    await expect(
      evaluateDefaultRequest("bash", { command: "rm -rf build" }, cwd, config()),
    ).resolves.toMatchObject({ action: "prompt", risk: "HARD" });
  });

  it("auto-runs ordinary shell syntax inside the sandbox", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    for (const command of [
      "npm test",
      "git status",
      "cat README.md | wc -l",
      "pnpm lint",
      "rg production",
      "git grep deploy",
      "npm run production",
      "printf 'git push'",
      "rg https://example.com",
      "gh --version",
      "curl --version",
    ]) {
      await expect(
        evaluateDefaultRequest("bash", { command }, cwd, config()),
      ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
    }
  });

  it("prompts for token-aware network commands and external mutations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    const cases = [
      [
        "gh issue comment 1 --body https://example.com",
        ["api.github.com", "github.com", "uploads.github.com"],
      ],
      ["gh pr edit 1 --title x", ["api.github.com", "github.com", "uploads.github.com"]],
      ["node -e \"fetch('https://api.github.com/repos')\"", ["api.github.com"]],
      ["python -c \"requests.get('https://example.com')\"", ["example.com"]],
      ["/usr/bin/curl https://example.com", ["example.com"]],
      ["env curl https://example.com", ["example.com"]],
      ["env -u HTTPS_PROXY curl https://example.com", ["example.com"]],
      ["sudo -u root curl https://example.com", ["example.com"]],
      ['bash -c "curl https://example.com"', ["example.com"]],
      ['bash -lc "curl https://example.com"', ["example.com"]],
      ["git clone https://github.com/openai/codex.git", ["github.com"]],
      ["npm install lodash", ["registry.npmjs.org"]],
    ] as const;

    for (const [command, networkHosts] of cases) {
      await expect(
        evaluateDefaultRequest("bash", { command }, cwd, config()),
      ).resolves.toMatchObject({ action: "prompt", risk: "HARD", networkHosts });
    }
  });

  it("does not mistake network option values for destination hosts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    await expect(
      evaluateDefaultRequest(
        "bash",
        { command: "curl -X POST -H 'accept: application/json' https://example.com/api" },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({
      action: "prompt",
      risk: "HARD",
      networkHosts: ["example.com"],
    });
  });

  it("infers the approved host for git operations from the repository remote", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await createGitDirectory(
      join(cwd, ".git"),
      '[remote "origin"]\n\turl = git@github.com:openai/codex.git\n',
    );

    await expect(
      evaluateDefaultRequest("bash", { command: "git push origin main" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "prompt",
      risk: "HARD",
      networkHosts: ["github.com"],
    });
  });

  it.each([
    "git push origin main",
    "env git push origin main",
    "command git push origin main",
    "sudo -u root git push origin main",
    "X=1 git push origin main",
  ])("blocks a private Git pushurl for %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await createGitDirectory(
      join(cwd, ".git"),
      [
        '[remote "origin"]',
        "\turl = git@github.com:openai/codex.git",
        "\tpushurl = ssh://git@127.1/openai/codex.git",
        "",
      ].join("\n"),
    );

    await expect(evaluateDefaultRequest("bash", { command }, cwd, config())).resolves.toMatchObject(
      {
        action: "block",
        risk: "HARD",
        reason: expect.stringContaining("Private"),
      },
    );
  });

  it.each(["git push origin HEAD:main", "git push --porcelain origin HEAD:main"])(
    "uses the remote operand rather than a push refspec for %s",
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
      await createGitDirectory(
        join(cwd, ".git"),
        [
          '[remote "origin"]',
          "\turl = git@github.com:openai/codex.git",
          "\tpushurl = ssh://git@127.1/openai/codex.git",
          "",
        ].join("\n"),
      );

      await expect(
        evaluateDefaultRequest("bash", { command }, cwd, config()),
      ).resolves.toMatchObject({
        action: "block",
        risk: "HARD",
        reason: expect.stringContaining("Private"),
      });
    },
  );

  it.each([
    "git push ssh://git@127.1/owner/repo.git HEAD:main",
    "git push git://2130706433/owner/repo.git HEAD:main",
    "git push 0x7f000001:owner/repo.git HEAD:main",
  ])("blocks a private explicit Git remote operand in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(evaluateDefaultRequest("bash", { command }, cwd, config())).resolves.toMatchObject(
      {
        action: "block",
        risk: "HARD",
        reason: expect.stringContaining("Private"),
      },
    );
  });

  it.each([
    "git push --repo=ssh://git@127.1/owner/repo.git -- HEAD:main",
    "git fetch --multiple https://github.com/openai/codex.git ssh://git@127.1/owner/repo.git",
    "git submodule add -b main ssh://git@127.1/owner/repo.git child",
    "git fetch ext::/tmp/network-helper",
  ])("fails closed for a private or unsupported Git remote in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(evaluateDefaultRequest("bash", { command }, cwd, config())).resolves.toMatchObject(
      {
        action: "block",
        risk: "HARD",
      },
    );
  });

  it.each([
    ["git push --repo=ssh://git@github.com/openai/codex.git -- HEAD:main", ["github.com"]],
    [
      "git fetch --multiple https://github.com/openai/codex.git ssh://git@gitlab.com/openai/codex.git",
      ["github.com", "gitlab.com"],
    ],
    ["git submodule add -b main ssh://git@github.com/openai/codex.git child", ["github.com"]],
  ] as const)("preserves public Git remote operands in %s", async (command, networkHosts) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(evaluateDefaultRequest("bash", { command }, cwd, config())).resolves.toMatchObject(
      {
        action: "prompt",
        risk: "HARD",
        networkHosts,
      },
    );
  });

  it("keeps a public SSH Git remote explicit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(
      evaluateDefaultRequest(
        "bash",
        { command: "git push ssh://git@github.com/openai/codex.git HEAD:main" },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({
      action: "prompt",
      risk: "HARD",
      networkHosts: ["github.com"],
    });
  });

  it("keeps a local Git remote operand out of network policy", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await createGitDirectory(join(cwd, ".git"));
    const gitRoot = await realpath(join(cwd, ".git"));

    await expect(
      evaluateDefaultRequest("bash", { command: "git push ../local.git HEAD:main" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "prompt",
      risk: "HARD",
      networkHosts: undefined,
      filesystemWriteRoots: [gitRoot],
    });
  });

  it("fails closed when a Git remote option cannot be parsed reliably", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(
      evaluateDefaultRequest(
        "bash",
        { command: "git push --future-option origin HEAD:main" },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({
      action: "block",
      risk: "HARD",
      reason: expect.stringContaining("Git network"),
    });
  });

  it("uses only the public fetch URL for Git fetch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await createGitDirectory(
      join(cwd, ".git"),
      [
        '[remote "origin"]',
        "\turl = git@github.com:openai/codex.git",
        "\tpushurl = ssh://git@127.1/openai/codex.git",
        "",
      ].join("\n"),
    );

    await expect(
      evaluateDefaultRequest("bash", { command: "git fetch origin" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "prompt",
      risk: "HARD",
      networkHosts: ["github.com"],
    });
  });

  it("does not mistake a fetch refspec for the remote operand", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await createGitDirectory(
      join(cwd, ".git"),
      '[remote "origin"]\n\turl = git@github.com:openai/codex.git\n',
    );

    await expect(
      evaluateDefaultRequest(
        "bash",
        { command: "git fetch --prune origin HEAD:refs/remotes/origin/main" },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({
      action: "prompt",
      risk: "HARD",
      networkHosts: ["github.com"],
    });
  });

  it("includes the requested public host in network approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    await expect(
      evaluateDefaultRequest("bash", { command: "curl https://example.com/docs" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "prompt",
      risk: "HARD",
      networkHosts: ["example.com"],
    });
  });

  it("requests one-call Git metadata access for agent Git mutations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await createGitDirectory(join(cwd, ".git"));
    const gitRoot = await realpath(join(cwd, ".git"));

    await expect(
      evaluateDefaultRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "prompt",
      risk: "REVIEW",
      filesystemWriteRoots: [gitRoot],
    });
    await expect(
      evaluateDefaultRequest("bash", { command: "gh pr checkout 123" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "prompt",
      networkHosts: ["api.github.com", "github.com", "uploads.github.com"],
      filesystemWriteRoots: [gitRoot],
    });
    for (const command of [
      "git commit -m 'document input > output'",
      'git commit -m "document bash support"',
      "git add docs/fish.md",
      "git add '$" + "{ touch .git/hooks/pre-commit; }'",
      'git add "\\$' + '{ touch .git/hooks/pre-commit; }"',
      "git add '$" + "{| touch .git/hooks/pre-commit; }'",
      'git add "\\$' + '{| touch .git/hooks/pre-commit; }"',
    ]) {
      await expect(
        evaluateDefaultRequest("bash", { command }, cwd, config()),
      ).resolves.toMatchObject({
        action: "prompt",
        filesystemWriteRoots: [gitRoot],
      });
    }
  });

  it.each([
    "git -C child commit -am update",
    "git --git-dir ../repo.git commit -am update",
    "git --work-tree ../tree commit -am update",
    "git -c core.hooksPath=/tmp/hooks commit -am update",
    "git --config-env=core.hooksPath=HOOKS commit -am update",
    "git --unknown-global commit -am update",
  ])("blocks Git metadata grants through unsafe global options in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(evaluateDefaultRequest("bash", { command }, cwd, config())).resolves.toMatchObject(
      {
        action: "block",
        risk: "HARD",
        reason: expect.stringContaining("single Git mutation"),
      },
    );
  });

  it.each([
    "./git commit -am update",
    "/tmp/git commit -am update",
    "./gh pr checkout 123",
    "PATH=/tmp git commit -am update",
    "env PATH=/tmp git commit -am update",
    "GIT_DIR=/tmp/repo.git git add README.md",
    "env GIT_WORK_TREE=/tmp/tree git add README.md",
    "env -C /tmp git add README.md",
    "sudo -C /tmp git push origin main",
    "sudo --chdir /tmp git push origin main",
  ])(
    "blocks Git metadata grants through an untrusted executable context in %s",
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
      await createGitDirectory(join(cwd, ".git"));

      await expect(
        evaluateDefaultRequest("bash", { command }, cwd, config()),
      ).resolves.toMatchObject({
        action: "block",
        risk: "HARD",
      });
    },
  );

  it.each([
    "git add README.md &",
    "(git add README.md)",
    "; git add README.md",
    "git add README.md;",
    "| git add README.md",
    "git add README.md |",
    "\ngit add README.md",
    "git add README.md\n",
  ])("blocks Git metadata grants with top-level shell controls in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(evaluateDefaultRequest("bash", { command }, cwd, config())).resolves.toMatchObject(
      {
        action: "block",
        risk: "HARD",
        reason: expect.stringContaining("single Git mutation"),
      },
    );
  });

  it.each(["git init", "git init ."])(
    "grants the prospective current-directory metadata root for %s",
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-git-init-"));
      const prospectiveGitRoot = join(await realpath(cwd), ".git");

      await expect(
        evaluateDefaultRequest("bash", { command }, cwd, config()),
      ).resolves.toMatchObject({
        action: "prompt",
        risk: "REVIEW",
        filesystemWriteRoots: [prospectiveGitRoot],
      });
    },
  );

  it("grants a child prospective root for git init inside an existing parent repository", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-permissions-parent-repository-"));
    const cwd = join(parent, "child");
    await createGitDirectory(join(parent, ".git"));
    await mkdir(cwd);
    const prospectiveGitRoot = join(await realpath(cwd), ".git");

    await expect(
      evaluateDefaultRequest("bash", { command: "git init" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "prompt",
      risk: "REVIEW",
      filesystemWriteRoots: [prospectiveGitRoot],
    });
  });

  it.each(['git init ""', "git init ''"])(
    "blocks an explicit empty repository path in %s",
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-empty-git-init-"));

      await expect(
        evaluateDefaultRequest("bash", { command }, cwd, config()),
      ).resolves.toMatchObject({
        action: "block",
        risk: "HARD",
        reason: expect.stringContaining("single Git mutation"),
      });
    },
  );

  it("keeps a missing repository fail-closed for non-init Git mutations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-no-repository-"));

    await expect(
      evaluateDefaultRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "block",
      risk: "HARD",
      reason: expect.stringContaining("repository not found"),
    });
  });

  it.each([
    "git add README.md; printf '#!/bin/sh\\n' > .git/hooks/pre-commit",
    "git add README.md > .git/hooks/pre-commit",
    'bash -c "git add README.md"',
    'fish -c "git add README.md"',
    'git add "$(printf README.md)"',
    'git add "$' + '{ touch .git/hooks/pre-commit; }"',
    'git add "$' + '{| touch .git/hooks/pre-commit; }"',
    "git add README.md | tee result.txt",
  ])("blocks Git metadata grants for compound shell effects in %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, ".git", "config"), "");

    await expect(evaluateDefaultRequest("bash", { command }, cwd, config())).resolves.toMatchObject(
      {
        action: "block",
        reason: expect.stringContaining("single Git mutation"),
      },
    );
  });

  it("blocks a repository pointer that would grant the filesystem root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await writeFile(join(cwd, ".git"), "gitdir: /\n");

    await expect(
      evaluateDefaultRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "block",
      reason: expect.stringContaining("unsafe Git"),
    });
  });

  it("blocks a repository symlink that would grant the filesystem root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await symlink("/", join(cwd, ".git"));

    await expect(
      evaluateDefaultRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "block",
      reason: expect.stringContaining("unsafe Git metadata"),
    });
  });

  it("blocks a repository symlink that redirects Git access outside the workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    const unrelated = await mkdtemp(join(tmpdir(), "pi-permissions-unrelated-"));
    await writeFile(join(unrelated, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(unrelated, "config"), "");
    await mkdir(join(unrelated, "objects"));
    await mkdir(join(unrelated, "refs"));
    await symlink(unrelated, join(cwd, ".git"));

    await expect(
      evaluateDefaultRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "block",
      reason: expect.stringContaining("unsafe Git metadata"),
    });
  });

  it("blocks a gitdir pointer that does not belong to the current worktree", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    const unrelated = await mkdtemp(join(tmpdir(), "pi-permissions-unrelated-"));
    await writeFile(join(unrelated, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(unrelated, "config"), "");
    await mkdir(join(unrelated, "objects"));
    await mkdir(join(unrelated, "refs"));
    await writeFile(join(cwd, ".git"), `gitdir: ${unrelated}\n`);

    await expect(
      evaluateDefaultRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "block",
      reason: expect.stringContaining("unsafe Git metadata"),
    });
  });

  it("blocks a back-pointer without valid worktree or submodule metadata", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    const unrelated = await mkdtemp(join(tmpdir(), "pi-permissions-unrelated-"));
    await writeFile(join(cwd, ".git"), `gitdir: ${unrelated}\n`);
    await writeFile(join(unrelated, "gitdir"), `${join(cwd, ".git")}\n`);

    await expect(
      evaluateDefaultRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "block",
      reason: expect.stringContaining("unsafe Git"),
    });
  });

  it("grants both per-worktree and common Git metadata roots", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    const cwd = join(parent, "worktree");
    const commonGit = join(parent, "main.git");
    const worktreeGit = join(commonGit, "worktrees", "worktree");
    await mkdir(cwd);
    await mkdir(worktreeGit, { recursive: true });
    await writeFile(join(commonGit, "config"), "");
    await writeFile(join(commonGit, "HEAD"), "ref: refs/heads/main\n");
    await mkdir(join(commonGit, "objects"));
    await mkdir(join(commonGit, "refs"));
    await writeFile(join(worktreeGit, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(worktreeGit, "commondir"), "../..\n");
    await writeFile(join(cwd, ".git"), `gitdir: ${worktreeGit}\n`);
    await writeFile(join(worktreeGit, "gitdir"), `${join(cwd, ".git")}\n`);
    const canonicalWorktreeGit = await realpath(worktreeGit);
    const canonicalCommonGit = await realpath(commonGit);

    await expect(
      evaluateDefaultRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "prompt",
      filesystemWriteRoots: [canonicalWorktreeGit, canonicalCommonGit],
    });
  });

  it("preserves a structurally valid submodule gitdir pointer", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-submodule-"));
    const gitDirectory = await mkdtemp(join(tmpdir(), "pi-permissions-module-git-"));
    await writeFile(join(gitDirectory, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(gitDirectory, "config"), `[core]\n\tworktree = ${cwd}\n`);
    await mkdir(join(gitDirectory, "objects"));
    await mkdir(join(gitDirectory, "refs"));
    await writeFile(join(cwd, ".git"), `gitdir: ${gitDirectory}\n`);
    const canonicalGitDirectory = await realpath(gitDirectory);

    await expect(
      evaluateDefaultRequest("bash", { command: "git add README.md" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "prompt",
      filesystemWriteRoots: [canonicalGitDirectory],
    });
  });

  it("blocks private shell network targets without offering approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    const decision = await evaluateDefaultRequest(
      "bash",
      { command: "curl http://127.0.0.1/admin" },
      cwd,
      config(),
    );

    expect(decision).toMatchObject({
      action: "block",
      risk: "HARD",
      reason: expect.stringContaining("Private"),
    });
    if (decision.action === "block") {
      expect(decision.reason).not.toContain("approval");
    }
  });

  it("blocks private WebFetch targets without offering reviewer approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    for (const url of [
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      await expect(
        evaluateDefaultRequest("WebFetch", { url }, cwd, config()),
      ).resolves.toMatchObject({
        action: "block",
        risk: "HARD",
        reason: expect.stringContaining("Private"),
      });
    }
  });

  it("accepts Codex-style one-call write roots for agent bash", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    const outputName = `pi-permissions-output-${Date.now()}`;
    const outputRoot = join("/var/tmp", outputName);
    const canonicalOutputRoot = join(await realpath("/var/tmp"), outputName);

    await expect(
      evaluateDefaultRequest(
        "bash",
        {
          command: `mkdir -p ${outputRoot}`,
          sandbox_permissions: "with_additional_permissions",
          additional_permissions: {
            file_system: { write: [outputRoot, outputRoot] },
          },
          justification: "Write the requested build artifact",
        },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({
      action: "prompt",
      risk: "REVIEW",
      filesystemWriteRoots: [canonicalOutputRoot],
    });
  });

  it("rejects malformed or protected agent bash permission requests", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    await expect(
      evaluateDefaultRequest(
        "bash",
        {
          command: "mkdir -p /var/tmp/output",
          additional_permissions: {
            file_system: { write: ["/var/tmp/output"] },
          },
          justification: "missing sandbox permission mode",
        },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({
      action: "block",
      reason: expect.stringContaining("sandbox_permissions"),
    });

    await expect(
      evaluateDefaultRequest(
        "bash",
        {
          command: "touch /pi-permissions-unsafe",
          sandbox_permissions: "with_additional_permissions",
          additional_permissions: {
            file_system: { write: ["/"] },
          },
          justification: "Request an unsafe broad root",
        },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({
      action: "block",
      reason: expect.stringContaining("filesystem root"),
    });

    await expect(
      evaluateDefaultRequest(
        "bash",
        {
          command: "printf x > .agents/AGENTS.md",
          sandbox_permissions: "with_additional_permissions",
          additional_permissions: {
            file_system: { write: [join(cwd, ".agents")] },
          },
          justification: "modify protected instructions",
        },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({
      action: "block",
      reason: expect.stringContaining("protected"),
    });
  });

  it("applies deny, ask, and allow rules without allowing HARD bypass", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    const rules: PermissionsConfig["rules"] = [
      { action: "deny", tool: "bash", pattern: "npm publish*" },
      { action: "ask", tool: "bash", pattern: "npm test*" },
      { action: "allow", tool: "bash", pattern: "npm run lint*" },
      { action: "allow", tool: "bash", pattern: "rm *" },
    ];
    const configured = config({ rules });

    await expect(
      evaluateDefaultRequest("bash", { command: "npm publish" }, cwd, configured),
    ).resolves.toMatchObject({ action: "block" });
    await expect(
      evaluateDefaultRequest("bash", { command: "npm test" }, cwd, configured),
    ).resolves.toMatchObject({ action: "prompt" });
    await expect(
      evaluateDefaultRequest("bash", { command: "npm run lint" }, cwd, configured),
    ).resolves.toMatchObject({ action: "allow" });
    await expect(
      evaluateDefaultRequest("bash", { command: "rm -rf build" }, cwd, configured),
    ).resolves.toMatchObject({ action: "prompt", risk: "HARD" });
  });

  it("summarizes requests without including write content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    const decision = await evaluateDefaultRequest(
      "write",
      { path: "/var/tmp/out.txt", content: "DO_NOT_RENDER_THIS_SECRET" },
      cwd,
      config(),
    );

    expect(decision.action).toBe("prompt");
    if (decision.action === "prompt") {
      expect(decision.summary).toContain("/var/tmp/out.txt");
      expect(decision.summary).not.toContain("DO_NOT_RENDER_THIS_SECRET");
    }
  });
});

describe("deletion sandbox boundary (stage 3)", () => {
  it("auto-approves deletions inside the workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-del-"));
    await writeFile(join(cwd, "build", "a.ts"), "x").catch(() => {});
    for (const command of [
      "rm build/a.ts",
      "rm -r build",
      "rmdir cache",
      "unlink build/a.ts",
      "shred build/a.ts",
      "truncate -s 0 build/a.ts",
    ]) {
      await expect(
        evaluateDefaultRequest("bash", { command }, cwd, config()),
      ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
    }
  });

  it("escalates deletions that touch anything outside the sandbox roots", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-del-"));
    for (const command of [
      "rm /etc/pi-permissions-outside.txt",
      "rm /etc/passwd",
      "rm ~/.aws/credentials",
      "truncate -s 0 /etc/passwd",
    ]) {
      await expect(
        evaluateDefaultRequest("bash", { command }, cwd, config()),
      ).resolves.toMatchObject({ action: "prompt", risk: "REVIEW" });
    }
  });

  it("escalates deletions of protected metadata paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-del-"));
    await expect(
      evaluateDefaultRequest("bash", { command: "rm .git/HEAD" }, cwd, config()),
    ).resolves.toMatchObject({ action: "prompt", risk: "REVIEW" });
    await expect(
      evaluateDefaultRequest("bash", { command: "rm .env" }, cwd, config()),
    ).resolves.toMatchObject({ action: "prompt", risk: "REVIEW" });
  });

  it("keeps forced rm at HARD even inside the workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-del-"));
    await expect(
      evaluateDefaultRequest("bash", { command: "rm -rf build" }, cwd, config()),
    ).resolves.toMatchObject({ action: "prompt", risk: "HARD" });
  });
});

describe("session approval memory (stage 5)", () => {
  it("skips the prompt for user-approved command prefixes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-approval-"));
    const approvals = {
      commandPrefixes: [
        ["npm", "install"],
        ["rm", "-r", "build"],
      ],
    };

    await expect(
      evaluateDefaultRequest(
        "bash",
        { command: "npm install lodash" },
        cwd,
        config(),
        undefined,
        approvals,
      ),
    ).resolves.toMatchObject({ action: "allow" });
    await expect(
      evaluateDefaultRequest(
        "bash",
        { command: "rm -r build extra" },
        cwd,
        config(),
        undefined,
        approvals,
      ),
    ).resolves.toMatchObject({ action: "allow" });
    await expect(
      evaluateDefaultRequest(
        "bash",
        { command: "rm /etc/pi-permissions-outside.txt" },
        cwd,
        config(),
        undefined,
        approvals,
      ),
    ).resolves.toMatchObject({ action: "prompt" });
    await expect(
      evaluateDefaultRequest(
        "bash",
        { command: "rm -rf other" },
        cwd,
        config(),
        undefined,
        approvals,
      ),
    ).resolves.toMatchObject({ action: "prompt" });
  });

  it("never lets approval memory bypass the deletion sandbox boundary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-approval-"));
    const approvals = { commandPrefixes: [["rm", "-r", "build"]] };
    await expect(
      evaluateDefaultRequest(
        "bash",
        { command: "rm -r build /etc/pi-permissions-outside.txt" },
        cwd,
        config(),
        undefined,
        approvals,
      ),
    ).resolves.toMatchObject({ action: "prompt" });
    await expect(
      evaluateDefaultRequest(
        "bash",
        { command: "rm -r build .git/objects" },
        cwd,
        config(),
        undefined,
        approvals,
      ),
    ).resolves.toMatchObject({ action: "prompt" });
  });

  it("drops session-approved network hosts before escalating", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-approval-"));
    const approvals = { networkHosts: new Set(["registry.npmjs.org"]) };
    await expect(
      evaluateDefaultRequest(
        "bash",
        { command: "curl https://registry.npmjs.org/x" },
        cwd,
        config(),
        undefined,
        approvals,
      ),
    ).resolves.toMatchObject({ action: "allow" });
    await expect(
      evaluateDefaultRequest(
        "bash",
        { command: "curl https://evil.example.com" },
        cwd,
        config(),
        undefined,
        approvals,
      ),
    ).resolves.toMatchObject({ action: "prompt", risk: "HARD" });
  });

  it("honors session approval memory for exact prefixes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-approval-"));
    const approvals = { commandPrefixes: [["npm", "test"]] };
    await expect(
      evaluateDefaultRequest(
        "bash",
        { command: "npm test -- --watch" },
        cwd,
        config(),
        undefined,
        approvals,
      ),
    ).resolves.toMatchObject({ action: "allow" });
    await expect(
      evaluateDefaultRequest("bash", { command: "npm test" }, cwd, config(), undefined, approvals),
    ).resolves.toMatchObject({ action: "allow" });
  });
});

describe("request_permissions write-root grants (stage 6)", () => {
  it("expands the deletion sandbox boundary with granted roots", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-rp-"));
    const approved = { filesystemWriteRoots: ["/etc/pi-permissions-granted"] };
    // Without the grant the deletion escalates…
    await expect(
      evaluateDefaultRequest(
        "bash",
        { command: "rm /etc/pi-permissions-granted/x" },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({ action: "prompt", risk: "REVIEW" });
    // …with the grant it auto-approves (still guarded by denyWrite/protected).
    await expect(
      evaluateDefaultRequest(
        "bash",
        { command: "rm /etc/pi-permissions-granted/x" },
        cwd,
        config(),
        undefined,
        approved,
      ),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
    await expect(
      evaluateDefaultRequest(
        "bash",
        { command: "rm /etc/pi-permissions-granted/.env" },
        cwd,
        config(),
        undefined,
        approved,
      ),
    ).resolves.toMatchObject({ action: "prompt" });
  });

  it("expands write-tool checks with granted roots", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-rp-"));
    const approved = { filesystemWriteRoots: ["/etc/pi-permissions-granted"] };
    await expect(
      evaluateDefaultRequest(
        "write",
        { path: "/etc/pi-permissions-granted/out.txt", content: "x" },
        cwd,
        config(),
        undefined,
        approved,
      ),
    ).resolves.toMatchObject({ action: "allow" });
  });
});

describe("custom/MCP tool approvals (codex-aligned)", () => {
  it("reviews external tools by default", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-mcp-"));
    for (const [tool, input] of [
      ["gitee__create_issue", { title: "x" }],
      ["mcp__github__get_issue", { owner: "a", repo: "b", number: 1 }],
      ["my_custom_tool", { query: "hello" }],
    ] as const) {
      await expect(
        evaluateDefaultRequest(tool, input, cwd, config()),
      ).resolves.toMatchObject({ action: "prompt", risk: "REVIEW" });
    }
  });

  it("allows external tools via exact-name or glob rules", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-mcp-"));
    const exact = config({ rules: [{ action: "allow", tool: "gitee__create_issue" }] });
    await expect(
      evaluateDefaultRequest("gitee__create_issue", { title: "x" }, cwd, exact),
    ).resolves.toMatchObject({ action: "allow" });
    await expect(
      evaluateDefaultRequest("gitee__create_pr", { title: "y" }, cwd, exact),
    ).resolves.toMatchObject({ action: "prompt" });

    const globbed = config({ rules: [{ action: "allow", tool: "mcp__*" }] });
    await expect(
      evaluateDefaultRequest("mcp__github__get_issue", { owner: "a" }, cwd, globbed),
    ).resolves.toMatchObject({ action: "allow" });
    await expect(
      evaluateDefaultRequest("gitee__create_issue", { title: "x" }, cwd, globbed),
    ).resolves.toMatchObject({ action: "prompt" });
  });

  it("keeps exact-name rules for built-in tools intact", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-mcp-"));
    const configured = config({ rules: [{ action: "deny", tool: "bash", pattern: "rm *" }] });
    await expect(
      evaluateDefaultRequest("bash", { command: "rm build/a.ts" }, cwd, configured),
    ).resolves.toMatchObject({ action: "block" });
    await expect(
      evaluateDefaultRequest("read", { path: "README.md" }, cwd, configured),
    ).resolves.toMatchObject({ action: "allow" });
  });
});
