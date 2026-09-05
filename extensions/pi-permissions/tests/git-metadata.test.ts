import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverGitMetadataProtectionRoots,
  inspectRepositoryGitMetadata,
  readRepositoryRemoteHosts,
} from "../src/git-metadata.ts";

async function createGitDirectory(path: string, config = ""): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(path, "config"), config);
  await mkdir(join(path, "objects"));
  await mkdir(join(path, "refs"));
}

describe("Git metadata ownership", () => {
  it("discovers a separate-git-dir target without requiring worktree ownership", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-separate-git-dir-worktree-"));
    const metadata = await mkdtemp(join(tmpdir(), "pi-permissions-separate-git-dir-metadata-"));
    await createGitDirectory(metadata);
    await writeFile(join(cwd, ".git"), `gitdir: ${metadata}\n`);

    await expect(discoverGitMetadataProtectionRoots(cwd)).resolves.toEqual({
      ok: true,
      roots: [await realpath(metadata)],
    });
  });

  it("discovers a common root from an ordinary Git metadata directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-ordinary-git-worktree-"));
    const gitDirectory = join(cwd, ".git");
    const commonGit = join(cwd, "common.git");
    await createGitDirectory(gitDirectory);
    await createGitDirectory(commonGit);
    await writeFile(join(gitDirectory, "commondir"), "../common.git\n");

    await expect(discoverGitMetadataProtectionRoots(cwd)).resolves.toEqual({
      ok: true,
      roots: [await realpath(gitDirectory), await realpath(commonGit)],
    });
  });

  it("fails closed when an existing common metadata pointer is malformed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-ordinary-git-worktree-"));
    const gitDirectory = join(cwd, ".git");
    await mkdir(gitDirectory);
    await writeFile(join(gitDirectory, "commondir"), "missing-common\n");

    await expect(discoverGitMetadataProtectionRoots(cwd)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("common metadata"),
    });
  });

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

  it.each([
    ["HEAD", "file"],
    ["config", "file"],
    ["objects", "directory"],
    ["refs", "directory"],
  ] as const)("rejects a symbolic link used as the Git %s structure", async (entry, kind) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-git-structure-"));
    const gitDirectory = join(cwd, ".git");
    const external = join(cwd, `external-${entry}`);
    await createGitDirectory(gitDirectory);
    await rm(join(gitDirectory, entry), { recursive: true });
    if (kind === "file") {
      await writeFile(external, "");
    } else {
      await mkdir(external);
    }
    await symlink(external, join(gitDirectory, entry));

    await expect(inspectRepositoryGitMetadata(cwd)).resolves.toMatchObject({ ok: false });
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

  it("rejects a forged worktree directory that points at an unrelated common repository", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-permissions-forged-worktree-"));
    const cwd = join(parent, "worktree");
    const forgedWorktreeGit = join(parent, "forged-worktree.git");
    const victimGit = join(parent, "victim.git");
    await mkdir(cwd);
    await mkdir(forgedWorktreeGit);
    await writeFile(join(forgedWorktreeGit, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(forgedWorktreeGit, "gitdir"), `${join(cwd, ".git")}\n`);
    await writeFile(join(forgedWorktreeGit, "commondir"), "../victim.git\n");
    await createGitDirectory(victimGit);
    await writeFile(join(cwd, ".git"), `gitdir: ${forgedWorktreeGit}\n`);

    await expect(inspectRepositoryGitMetadata(cwd)).resolves.toMatchObject({ ok: false });
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

  it("rejects duplicate core.worktree values even when the first matches", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-submodule-worktree-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "pi-permissions-other-worktree-"));
    const gitDirectory = await mkdtemp(join(tmpdir(), "pi-permissions-submodule-git-"));
    await createGitDirectory(
      gitDirectory,
      `[core]\n\tworktree = "${cwd}"\n\tworktree = "${elsewhere}"\n`,
    );
    await writeFile(join(cwd, ".git"), `gitdir: ${gitDirectory}\n`);

    await expect(inspectRepositoryGitMetadata(cwd)).resolves.toMatchObject({ ok: false });
  });

  it("reads SSH remote hosts without rewriting the config", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-git-metadata-"));
    const configPath = join(cwd, "config");
    const contents = '[remote "origin"]\n\turl = git@github.com:owner/repo.git\n';
    await writeFile(configPath, contents);

    await expect(readRepositoryRemoteHosts(configPath, "fetch")).resolves.toEqual({
      ok: true,
      hosts: ["github.com"],
    });
    await expect(readFile(configPath, "utf8")).resolves.toBe(contents);
  });

  it("selects fetch and push hosts without rewriting the config", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-git-metadata-"));
    const configPath = join(cwd, "config");
    const contents = [
      '[remote "origin"]',
      "\turl = git@github.com:owner/repo.git",
      "\tpushurl = ssh://git@127.1/owner/repo.git",
      '[remote "mirror"]',
      "\turl = ssh://git@gitlab.example/group/repo.git",
      '[remote "local"]',
      "\turl = https://fallback.example/owner/repo.git",
      "\tpushurl = ../local.git",
      "",
    ].join("\n");
    await writeFile(configPath, contents);

    await expect(readRepositoryRemoteHosts(configPath, "fetch")).resolves.toEqual({
      ok: true,
      hosts: ["github.com", "gitlab.example", "fallback.example"],
    });
    await expect(readRepositoryRemoteHosts(configPath, "push")).resolves.toEqual({
      ok: true,
      hosts: ["127.1", "gitlab.example"],
    });
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

    await expect(readRepositoryRemoteHosts(configPath, "fetch")).resolves.toEqual({
      ok: true,
      hosts: ["github.com", "gitlab.example"],
    });
    await expect(readFile(configPath, "utf8")).resolves.toBe(contents);
  });

  it("dequotes a quoted Git config URL before extracting its host", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-git-metadata-"));
    const configPath = join(cwd, "config");
    await writeFile(configPath, '[remote "origin"]\n\turl = "ssh://git@127.1/owner/repo.git"\n');

    await expect(readRepositoryRemoteHosts(configPath, "fetch")).resolves.toEqual({
      ok: true,
      hosts: ["127.1"],
    });
  });

  it("fails closed for a non-local remote URL that cannot be parsed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-git-metadata-"));
    const configPath = join(cwd, "config");
    await writeFile(configPath, '[remote "origin"]\n\turl = ssh://[broken/repo.git\n');

    await expect(readRepositoryRemoteHosts(configPath, "fetch")).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("remote"),
    });
  });
});
