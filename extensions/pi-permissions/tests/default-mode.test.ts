import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type PermissionsConfig } from "../src/config.ts";
import { evaluateDefaultRequest } from "../src/default-mode.ts";

function config(overrides: Partial<PermissionsConfig> = {}): PermissionsConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...overrides,
  };
}

describe("Default mode gate", () => {
  it("allows ordinary workspace reads and writes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    await expect(evaluateDefaultRequest("read", { path: "README.md" }, cwd, config()))
      .resolves.toMatchObject({ action: "allow", risk: "LOW" });
    await expect(evaluateDefaultRequest("write", { path: "notes.txt", content: "hello" }, cwd, config()))
      .resolves.toMatchObject({ action: "allow", risk: "LOW" });
    await expect(
      evaluateDefaultRequest(
        "write",
        { path: ".pi/permissions.json", content: "{}" },
        cwd,
        config(),
      ),
    ).resolves.toMatchObject({ action: "allow", risk: "LOW" });
  });

  it("blocks protected secrets without a one-off prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    for (const path of [".env", "nested/.env", "nested/.env.local", "nested/deploy.key"]) {
      await expect(evaluateDefaultRequest("read", { path }, cwd, config()))
        .resolves.toMatchObject({ action: "block" });
      await expect(evaluateDefaultRequest("write", { path, content: "secret" }, cwd, config()))
        .resolves.toMatchObject({ action: "block" });
    }
  });

  it("keeps repository control directories read-only", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    for (const path of [
      ".git/config",
      ".agents/AGENTS.md",
      ".codex/config.toml",
    ]) {
      await expect(evaluateDefaultRequest("write", { path, content: "x" }, cwd, config()))
        .resolves.toMatchObject({
          action: "block",
          reason: "permission control path is protected",
        });
    }
  });

  it("prompts for external writes and dangerous Bash", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    await expect(evaluateDefaultRequest("write", { path: "/var/tmp/out.txt", content: "x" }, cwd, config()))
      .resolves.toMatchObject({ action: "prompt", risk: "REVIEW" });
    await expect(evaluateDefaultRequest("bash", { command: "rm -rf build" }, cwd, config()))
      .resolves.toMatchObject({ action: "prompt", risk: "HARD" });
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
      await expect(evaluateDefaultRequest("bash", { command }, cwd, config()))
        .resolves.toMatchObject({ action: "allow", risk: "LOW" });
    }
  });

  it("prompts for token-aware network commands and external mutations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    const cases = [
      ["gh issue comment 1 --body https://example.com", ["api.github.com", "github.com", "uploads.github.com"]],
      ["gh pr edit 1 --title x", ["api.github.com", "github.com", "uploads.github.com"]],
      ["node -e \"fetch('https://api.github.com/repos')\"", ["api.github.com"]],
      ["python -c \"requests.get('https://example.com')\"", ["example.com"]],
      ["/usr/bin/curl https://example.com", ["example.com"]],
      ["env curl https://example.com", ["example.com"]],
      ["env -u HTTPS_PROXY curl https://example.com", ["example.com"]],
      ["sudo -u root curl https://example.com", ["example.com"]],
      ["bash -c \"curl https://example.com\"", ["example.com"]],
      ["bash -lc \"curl https://example.com\"", ["example.com"]],
      ["git clone https://github.com/openai/codex.git", ["github.com"]],
      ["npm install lodash", ["registry.npmjs.org"]],
    ] as const;

    for (const [command, networkHosts] of cases) {
      await expect(evaluateDefaultRequest("bash", { command }, cwd, config()))
        .resolves.toMatchObject({ action: "prompt", risk: "HARD", networkHosts });
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
    await mkdir(join(cwd, ".git"));
    await writeFile(
      join(cwd, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:openai/codex.git\n',
    );

    await expect(evaluateDefaultRequest("bash", { command: "git push origin main" }, cwd, config()))
      .resolves.toMatchObject({
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
    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, ".git", "config"), "");
    const gitRoot = await realpath(join(cwd, ".git"));

    await expect(evaluateDefaultRequest("bash", { command: "git add README.md" }, cwd, config()))
      .resolves.toMatchObject({
        action: "prompt",
        risk: "REVIEW",
        filesystemWriteRoots: [gitRoot],
      });
    await expect(evaluateDefaultRequest("bash", { command: "gh pr checkout 123" }, cwd, config()))
      .resolves.toMatchObject({
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

    await expect(evaluateDefaultRequest("bash", { command }, cwd, config()))
      .resolves.toMatchObject({
        action: "block",
        reason: expect.stringContaining("single Git mutation"),
      });
  });

  it("blocks a repository pointer that would grant the filesystem root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await writeFile(join(cwd, ".git"), "gitdir: /\n");

    await expect(evaluateDefaultRequest("bash", { command: "git add README.md" }, cwd, config()))
      .resolves.toMatchObject({
        action: "block",
        reason: expect.stringContaining("unsafe Git metadata"),
      });
  });

  it("blocks a repository symlink that would grant the filesystem root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));
    await symlink("/", join(cwd, ".git"));

    await expect(evaluateDefaultRequest("bash", { command: "git add README.md" }, cwd, config()))
      .resolves.toMatchObject({
        action: "block",
        reason: expect.stringContaining("unsafe Git metadata"),
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
    await writeFile(join(worktreeGit, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(worktreeGit, "commondir"), "../..\n");
    await writeFile(join(cwd, ".git"), `gitdir: ${worktreeGit}\n`);
    const canonicalWorktreeGit = await realpath(worktreeGit);
    const canonicalCommonGit = await realpath(commonGit);

    await expect(evaluateDefaultRequest("bash", { command: "git add README.md" }, cwd, config()))
      .resolves.toMatchObject({
        action: "prompt",
        filesystemWriteRoots: [canonicalWorktreeGit, canonicalCommonGit],
      });
  });

  it("blocks private shell network targets without offering approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    await expect(
      evaluateDefaultRequest("bash", { command: "curl http://127.0.0.1/admin" }, cwd, config()),
    ).resolves.toMatchObject({
      action: "block",
      risk: "HARD",
      reason: expect.stringContaining("Private"),
    });
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

    await expect(evaluateDefaultRequest("bash", {
      command: `mkdir -p ${outputRoot}`,
      sandbox_permissions: "with_additional_permissions",
      additional_permissions: {
        file_system: { write: [outputRoot, outputRoot] },
      },
      justification: "Write the requested build artifact",
    }, cwd, config())).resolves.toMatchObject({
      action: "prompt",
      risk: "REVIEW",
      filesystemWriteRoots: [canonicalOutputRoot],
    });
  });

  it("rejects malformed or protected agent bash permission requests", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-default-"));

    await expect(evaluateDefaultRequest("bash", {
      command: "mkdir -p /var/tmp/output",
      additional_permissions: {
        file_system: { write: ["/var/tmp/output"] },
      },
      justification: "missing sandbox permission mode",
    }, cwd, config())).resolves.toMatchObject({
      action: "block",
      reason: expect.stringContaining("sandbox_permissions"),
    });

    await expect(evaluateDefaultRequest("bash", {
      command: "touch /pi-permissions-unsafe",
      sandbox_permissions: "with_additional_permissions",
      additional_permissions: {
        file_system: { write: ["/"] },
      },
      justification: "Request an unsafe broad root",
    }, cwd, config())).resolves.toMatchObject({
      action: "block",
      reason: expect.stringContaining("filesystem root"),
    });

    await expect(evaluateDefaultRequest("bash", {
      command: "printf x > .agents/AGENTS.md",
      sandbox_permissions: "with_additional_permissions",
      additional_permissions: {
        file_system: { write: [join(cwd, ".agents")] },
      },
      justification: "modify protected instructions",
    }, cwd, config())).resolves.toMatchObject({
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

    await expect(evaluateDefaultRequest("bash", { command: "npm publish" }, cwd, configured))
      .resolves.toMatchObject({ action: "block" });
    await expect(evaluateDefaultRequest("bash", { command: "npm test" }, cwd, configured))
      .resolves.toMatchObject({ action: "prompt" });
    await expect(evaluateDefaultRequest("bash", { command: "npm run lint" }, cwd, configured))
      .resolves.toMatchObject({ action: "allow" });
    await expect(evaluateDefaultRequest("bash", { command: "rm -rf build" }, cwd, configured))
      .resolves.toMatchObject({ action: "prompt", risk: "HARD" });
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
