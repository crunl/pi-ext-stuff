import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectRepositoryGitMetadata, readRepositoryRemoteHosts } from "../src/git-metadata.ts";

async function createGitDirectory(path: string, config = ""): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(path, "config"), config);
  await mkdir(join(path, "objects"));
  await mkdir(join(path, "refs"));
}

describe("Git metadata ownership", () => {
  it("returns the real root for a complete ordinary .git directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-git-metadata-"));
    await createGitDirectory(join(cwd, ".git"));

    await expect(inspectRepositoryGitMetadata(cwd)).resolves.toEqual({
      ok: true,
      configPath: await realpath(join(cwd, ".git", "config")),
      writeRoots: [await realpath(join(cwd, ".git"))],
    });
  });

  it("fails closed for a missing or incomplete ordinary .git directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-git-metadata-"));
    await mkdir(join(cwd, ".git"));

    await expect(inspectRepositoryGitMetadata(cwd)).resolves.toMatchObject({ ok: false });
  });

  it("rejects a .git symbolic link before resolving its target", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-git-metadata-"));
    await symlink("/", join(cwd, ".git"));

    await expect(inspectRepositoryGitMetadata(cwd)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("symlink"),
    });
  });

  it("rejects a gitdir pointer to the filesystem root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-git-metadata-"));
    await writeFile(join(cwd, ".git"), "gitdir: /\n");

    await expect(inspectRepositoryGitMetadata(cwd)).resolves.toMatchObject({ ok: false });
  });

  it("rejects an unrelated gitdir pointer without ownership metadata", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-git-metadata-"));
    const unrelated = await mkdtemp(join(tmpdir(), "pi-permissions-unrelated-git-"));
    await createGitDirectory(unrelated);
    await writeFile(join(cwd, ".git"), `gitdir: ${unrelated}\n`);

    await expect(inspectRepositoryGitMetadata(cwd)).resolves.toMatchObject({ ok: false });
  });

  it("returns both resolved roots for a linked worktree with matching metadata", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-permissions-linked-worktree-"));
    const cwd = join(parent, "worktree");
    const commonGit = join(parent, "main.git");
    const worktreeGit = join(commonGit, "worktrees", "worktree");
    await mkdir(cwd);
    await createGitDirectory(commonGit);
    await mkdir(worktreeGit, { recursive: true });
    await writeFile(join(worktreeGit, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(worktreeGit, "gitdir"), `${join(cwd, ".git")}\n`);
    await writeFile(join(worktreeGit, "commondir"), "../..\n");
    await writeFile(join(cwd, ".git"), `gitdir: ${worktreeGit}\n`);

    await expect(inspectRepositoryGitMetadata(cwd)).resolves.toEqual({
      ok: true,
      configPath: await realpath(join(commonGit, "config")),
      writeRoots: [await realpath(worktreeGit), await realpath(commonGit)],
    });
  });

  it("rejects linked worktree metadata without a valid common Git directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-permissions-linked-worktree-"));
    const cwd = join(parent, "worktree");
    const worktreeGit = join(parent, "worktree.git");
    await mkdir(cwd);
    await mkdir(worktreeGit);
    await writeFile(join(worktreeGit, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(worktreeGit, "gitdir"), `${join(cwd, ".git")}\n`);
    await writeFile(join(worktreeGit, "commondir"), "missing-common\n");
    await writeFile(join(cwd, ".git"), `gitdir: ${worktreeGit}\n`);

    await expect(inspectRepositoryGitMetadata(cwd)).resolves.toMatchObject({ ok: false });
  });

  it("accepts a quoted submodule core.worktree that resolves to the current worktree", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-submodule-worktree-"));
    const gitDirectory = await mkdtemp(join(tmpdir(), "pi-permissions-submodule-git-"));
    await createGitDirectory(gitDirectory, `[core]\n\tworktree = "${cwd}"\n`);
    await writeFile(join(cwd, ".git"), `gitdir: ${gitDirectory}\n`);

    await expect(inspectRepositoryGitMetadata(cwd)).resolves.toEqual({
      ok: true,
      configPath: await realpath(join(gitDirectory, "config")),
      writeRoots: [await realpath(gitDirectory)],
    });
  });

  it("rejects a submodule core.worktree that resolves elsewhere", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-submodule-worktree-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "pi-permissions-other-worktree-"));
    const gitDirectory = await mkdtemp(join(tmpdir(), "pi-permissions-submodule-git-"));
    await createGitDirectory(gitDirectory, `[core]\n\tworktree = "${elsewhere}"\n`);
    await writeFile(join(cwd, ".git"), `gitdir: ${gitDirectory}\n`);

    await expect(inspectRepositoryGitMetadata(cwd)).resolves.toMatchObject({ ok: false });
  });

  it("reads SSH remote hosts without rewriting the config", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-git-metadata-"));
    const configPath = join(cwd, "config");
    const contents = '[remote "origin"]\n\turl = git@github.com:owner/repo.git\n';
    await writeFile(configPath, contents);

    await expect(readRepositoryRemoteHosts(configPath)).resolves.toEqual(["github.com"]);
    await expect(readFile(configPath, "utf8")).resolves.toBe(contents);
  });

  it("reads HTTPS and ssh remote hosts without mutating the config", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-git-metadata-"));
    const configPath = join(cwd, "config");
    const contents = [
      '[remote "origin"]',
      "\turl = https://github.com/openai/codex.git",
      '[remote "mirror"]',
      "\turl = ssh://git@gitlab.example:2222/group/repo.git",
      "",
    ].join("\n");
    await writeFile(configPath, contents);

    await expect(readRepositoryRemoteHosts(configPath)).resolves.toEqual([
      "github.com",
      "gitlab.example",
    ]);
    await expect(readFile(configPath, "utf8")).resolves.toBe(contents);
  });
});
