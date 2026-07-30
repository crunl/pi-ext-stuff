import type { Stats } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

export type GitMetadataResult =
  | { ok: true; configPath: string; writeRoots: string[] }
  | { ok: false; reason: string };

function isFilesystemRoot(path: string): boolean {
  return path === parse(path).root;
}

function remoteHost(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (new Set(["http:", "https:", "ssh:", "git:"]).has(parsed.protocol)) {
      return parsed.hostname;
    }
  } catch {
    // Fall through to Git's SCP-like remote syntax.
  }
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) {
    return undefined;
  }
  return /^(?:[^@\s]+@)?([^:/\s]+):.+$/.exec(value)?.[1];
}

async function hasGitDirectoryStructure(directory: string): Promise<boolean> {
  try {
    const [head, config, objects, refs] = await Promise.all([
      stat(join(directory, "HEAD")),
      stat(join(directory, "config")),
      stat(join(directory, "objects")),
      stat(join(directory, "refs")),
    ]);
    return head.isFile() && config.isFile() && objects.isDirectory() && refs.isDirectory();
  } catch {
    return false;
  }
}

async function hasWorktreeGitDirectoryStructure(directory: string): Promise<boolean> {
  try {
    return (await stat(join(directory, "HEAD"))).isFile();
  } catch {
    return false;
  }
}

function coreWorktree(config: string): string | undefined {
  let inCore = false;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1];
    if (section) {
      inCore = section.toLowerCase() === "core";
      continue;
    }
    if (!inCore) continue;
    const value = /^\s*worktree\s*=\s*(.+?)\s*$/i.exec(line)?.[1];
    if (value) return value.replace(/^"(.*)"$/, "$1");
  }
  return undefined;
}

async function worktreeGitDirectoryPointsBack(
  gitDirectory: string,
  dotGit: string,
): Promise<boolean> {
  try {
    const backPointer = (await readFile(join(gitDirectory, "gitdir"), "utf8")).trim();
    return (
      backPointer.length > 0 &&
      (await realpath(resolve(gitDirectory, backPointer))) === (await realpath(dotGit))
    );
  } catch {
    return false;
  }
}

async function submoduleGitDirectoryBelongsToWorktree(
  gitDirectory: string,
  worktree: string,
): Promise<boolean> {
  try {
    if (!(await hasGitDirectoryStructure(gitDirectory))) return false;
    const config = await readFile(join(gitDirectory, "config"), "utf8");
    const configuredWorktree = coreWorktree(config);
    return (
      configuredWorktree !== undefined &&
      (await realpath(resolve(gitDirectory, configuredWorktree))) === (await realpath(worktree))
    );
  } catch {
    return false;
  }
}

function filesystemErrorReason(error: unknown): string {
  return error instanceof Error ? error.message : "Git metadata filesystem error";
}

export async function inspectRepositoryGitMetadata(cwd: string): Promise<GitMetadataResult> {
  let directory = resolve(cwd);
  const root = parse(directory).root;
  while (true) {
    const dotGit = join(directory, ".git");
    let details: Stats;
    try {
      details = await lstat(dotGit);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        return { ok: false, reason: `unsafe Git metadata: ${filesystemErrorReason(error)}` };
      }
      if (directory === root) {
        return { ok: false, reason: "unsafe Git metadata: repository not found" };
      }
      directory = dirname(directory);
      continue;
    }

    if (details.isSymbolicLink()) {
      return { ok: false, reason: "unsafe Git metadata symlink" };
    }
    if (details.isDirectory()) {
      try {
        const gitDirectory = await realpath(dotGit);
        if (isFilesystemRoot(gitDirectory) || !(await hasGitDirectoryStructure(gitDirectory))) {
          return { ok: false, reason: "unsafe Git metadata path" };
        }
        return {
          ok: true,
          configPath: join(gitDirectory, "config"),
          writeRoots: [...new Set([gitDirectory])],
        };
      } catch (error) {
        return { ok: false, reason: `unsafe Git metadata: ${filesystemErrorReason(error)}` };
      }
    }
    if (!details.isFile()) {
      return { ok: false, reason: "unsafe Git metadata pointer" };
    }

    let pointer: string | undefined;
    try {
      pointer = /^gitdir:\s*(.+?)\s*$/i.exec(await readFile(dotGit, "utf8"))?.[1];
    } catch (error) {
      return { ok: false, reason: `unsafe Git metadata: ${filesystemErrorReason(error)}` };
    }
    if (!pointer) {
      return { ok: false, reason: "unsafe Git metadata pointer" };
    }

    let gitDirectory: string;
    try {
      gitDirectory = await realpath(resolve(directory, pointer));
      if (isFilesystemRoot(gitDirectory) || !(await stat(gitDirectory)).isDirectory()) {
        return { ok: false, reason: "unsafe Git metadata path" };
      }
    } catch (error) {
      return { ok: false, reason: `unsafe Git metadata: ${filesystemErrorReason(error)}` };
    }

    if (await worktreeGitDirectoryPointsBack(gitDirectory, dotGit)) {
      if (!(await hasWorktreeGitDirectoryStructure(gitDirectory))) {
        return { ok: false, reason: "unsafe Git worktree metadata path" };
      }
      let commonDirectory: string;
      try {
        const common = (await readFile(join(gitDirectory, "commondir"), "utf8")).trim();
        commonDirectory = await realpath(resolve(gitDirectory, common));
      } catch (error) {
        return { ok: false, reason: `unsafe Git common metadata: ${filesystemErrorReason(error)}` };
      }
      if (
        commonDirectory === gitDirectory ||
        isFilesystemRoot(commonDirectory) ||
        !(await hasGitDirectoryStructure(commonDirectory))
      ) {
        return { ok: false, reason: "unsafe Git common metadata path" };
      }
      return {
        ok: true,
        configPath: join(commonDirectory, "config"),
        writeRoots: [...new Set([gitDirectory, commonDirectory])],
      };
    }
    if (await submoduleGitDirectoryBelongsToWorktree(gitDirectory, directory)) {
      return {
        ok: true,
        configPath: join(gitDirectory, "config"),
        writeRoots: [...new Set([gitDirectory])],
      };
    }
    return { ok: false, reason: "unsafe Git metadata ownership" };
  }
}

export async function readRepositoryRemoteHosts(configPath: string | undefined): Promise<string[]> {
  if (!configPath) return [];
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch {
    return [];
  }
  const hosts = new Set<string>();
  let inRemote = false;
  for (const line of contents.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(line)?.[1];
    if (section !== undefined) {
      inRemote = /^remote\s+"/i.test(section);
      continue;
    }
    if (!inRemote) continue;
    const value = /^\s*url\s*=\s*(.+?)\s*$/i.exec(line)?.[1];
    const host = value ? remoteHost(value) : undefined;
    if (host) hosts.add(host.toLowerCase());
  }
  return [...hosts];
}
