import type { Stats } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { parseGitRemoteTarget, unquoteGitConfigValue } from "./network-host.ts";

export type GitMetadataResult =
  | { ok: true; configPath: string; writeRoots: string[] }
  | { ok: false; reason: string };

export type GitMetadataProtectionResult =
  | { ok: true; roots: string[] }
  | { ok: false; reason: string };

type GitMetadataInspectionResult =
  | GitMetadataResult
  | { ok: false; reason: string; notFound: true };

function isFilesystemRoot(path: string): boolean {
  return path === parse(path).root;
}

async function hasGitDirectoryStructure(directory: string): Promise<boolean> {
  try {
    const [head, config, objects, refs] = await Promise.all([
      lstat(join(directory, "HEAD")),
      lstat(join(directory, "config")),
      lstat(join(directory, "objects")),
      lstat(join(directory, "refs")),
    ]);
    return (
      !head.isSymbolicLink() &&
      head.isFile() &&
      !config.isSymbolicLink() &&
      config.isFile() &&
      !objects.isSymbolicLink() &&
      objects.isDirectory() &&
      !refs.isSymbolicLink() &&
      refs.isDirectory()
    );
  } catch {
    return false;
  }
}

async function hasWorktreeGitDirectoryStructure(directory: string): Promise<boolean> {
  try {
    const head = await lstat(join(directory, "HEAD"));
    return !head.isSymbolicLink() && head.isFile();
  } catch {
    return false;
  }
}

async function canonicalConfigPath(directory: string): Promise<string | undefined> {
  try {
    const configPath = await realpath(join(directory, "config"));
    return dirname(configPath) === directory ? configPath : undefined;
  } catch {
    return undefined;
  }
}

function coreWorktree(config: string): string | undefined {
  let inCore = false;
  let worktree: string | undefined;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1];
    if (section) {
      inCore = section.toLowerCase() === "core";
      continue;
    }
    if (!inCore) continue;
    const value = /^\s*worktree\s*=\s*(.+?)\s*$/i.exec(line)?.[1];
    if (!value) continue;
    if (worktree !== undefined) return undefined;
    worktree = value.replace(/^"(.*)"$/, "$1");
  }
  return worktree;
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

async function inspectGitMetadata(
  cwd: string,
  searchParents: boolean,
): Promise<GitMetadataInspectionResult> {
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
      if (!searchParents || directory === root) {
        return {
          ok: false,
          reason: "unsafe Git metadata: repository not found",
          notFound: true,
        };
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
        const configPath = await canonicalConfigPath(gitDirectory);
        if (!configPath) return { ok: false, reason: "unsafe Git config path" };
        return {
          ok: true,
          configPath,
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
        dirname(gitDirectory) !== join(commonDirectory, "worktrees") ||
        !(await hasGitDirectoryStructure(commonDirectory))
      ) {
        return { ok: false, reason: "unsafe Git common metadata path" };
      }
      const configPath = await canonicalConfigPath(commonDirectory);
      if (!configPath) return { ok: false, reason: "unsafe Git config path" };
      return {
        ok: true,
        configPath,
        writeRoots: [...new Set([gitDirectory, commonDirectory])],
      };
    }
    if (await submoduleGitDirectoryBelongsToWorktree(gitDirectory, directory)) {
      const configPath = await canonicalConfigPath(gitDirectory);
      if (!configPath) return { ok: false, reason: "unsafe Git config path" };
      return {
        ok: true,
        configPath,
        writeRoots: [...new Set([gitDirectory])],
      };
    }
    return { ok: false, reason: "unsafe Git metadata ownership" };
  }
}

export async function inspectRepositoryGitMetadata(cwd: string): Promise<GitMetadataResult> {
  const result = await inspectGitMetadata(cwd, true);
  return result.ok ? result : { ok: false, reason: result.reason };
}

function isMissingPath(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

async function canonicalMetadataDirectory(path: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(path);
    if (isFilesystemRoot(canonical)) return undefined;
    const details = await lstat(canonical);
    return details.isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

async function discoverMetadataRoots(metadataRoot: string): Promise<GitMetadataProtectionResult> {
  const commondirPath = join(metadataRoot, "commondir");
  let commondirDetails: Stats;
  try {
    commondirDetails = await lstat(commondirPath);
  } catch (error) {
    if (isMissingPath(error)) return { ok: true, roots: [metadataRoot] };
    return { ok: false, reason: `unsafe Git common metadata: ${filesystemErrorReason(error)}` };
  }
  if (!commondirDetails.isFile() || commondirDetails.isSymbolicLink()) {
    return { ok: false, reason: "unsafe Git common metadata path" };
  }

  let commonPointer: string;
  try {
    commonPointer = (await readFile(commondirPath, "utf8")).trim();
  } catch (error) {
    return { ok: false, reason: `unsafe Git common metadata: ${filesystemErrorReason(error)}` };
  }
  if (!commonPointer) return { ok: false, reason: "unsafe Git common metadata path" };
  const commonRoot = await canonicalMetadataDirectory(resolve(metadataRoot, commonPointer));
  if (commonRoot === undefined) return { ok: false, reason: "unsafe Git common metadata path" };
  return { ok: true, roots: [...new Set([metadataRoot, commonRoot])] };
}

/**
 * Discover Git metadata roots that the base sandbox must keep read-only.
 *
 * This deliberately does less than inspectRepositoryGitMetadata(): activation
 * needs protection identities even when a repository is incomplete, external,
 * or not owned by the current worktree. Network remote parsing keeps using the
 * stricter inspector above. An existing metadata pointer that cannot be
 * canonicalized is an activation failure rather than an unprotected policy.
 */
export async function discoverGitMetadataProtectionRoots(
  cwd: string,
): Promise<GitMetadataProtectionResult> {
  let directory = resolve(cwd);
  const root = parse(directory).root;
  while (true) {
    const dotGit = join(directory, ".git");
    let details: Stats;
    try {
      details = await lstat(dotGit);
    } catch (error) {
      if (!isMissingPath(error)) {
        return { ok: false, reason: `unsafe Git metadata: ${filesystemErrorReason(error)}` };
      }
      if (directory === root) return { ok: true, roots: [] };
      directory = dirname(directory);
      continue;
    }

    if (details.isSymbolicLink()) {
      return { ok: false, reason: "unsafe Git metadata symlink" };
    }

    if (details.isDirectory()) {
      const metadataRoot = await canonicalMetadataDirectory(dotGit);
      if (metadataRoot === undefined) return { ok: false, reason: "unsafe Git metadata path" };
      return discoverMetadataRoots(metadataRoot);
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
    if (!pointer) return { ok: false, reason: "unsafe Git metadata pointer" };

    const metadataRoot = await canonicalMetadataDirectory(resolve(directory, pointer));
    if (metadataRoot === undefined) return { ok: false, reason: "unsafe Git metadata path" };
    return discoverMetadataRoots(metadataRoot);
  }
}

export type GitRemotePurpose = "fetch" | "push";

export type GitRemoteHostsResult = { ok: true; hosts: string[] } | { ok: false; reason: string };

export async function readRepositoryRemoteHosts(
  configPath: string | undefined,
  purpose: GitRemotePurpose,
): Promise<GitRemoteHostsResult> {
  if (!configPath) return { ok: true, hosts: [] };
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: `unsafe Git remote config: ${filesystemErrorReason(error)}`,
    };
  }
  const remotes = new Map<string, { urls: string[]; pushUrls: string[]; hasPushUrl: boolean }>();
  let remote: { urls: string[]; pushUrls: string[]; hasPushUrl: boolean } | undefined;
  for (const line of contents.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(line)?.[1];
    if (section !== undefined) {
      const name = /^remote\s+"([^"]+)"$/i.exec(section)?.[1];
      if (!name) {
        remote = undefined;
        continue;
      }
      remote = remotes.get(name) ?? { urls: [], pushUrls: [], hasPushUrl: false };
      remotes.set(name, remote);
      continue;
    }
    if (!remote) continue;
    const match = /^\s*(url|pushurl)\s*=\s*(.+?)\s*$/i.exec(line);
    if (!match && /^\s*(?:url|pushurl)\s*=/i.test(line)) {
      return { ok: false, reason: "unsafe Git remote config value" };
    }
    const isPushUrl = match?.[1]?.toLowerCase() === "pushurl";
    if (isPushUrl) remote.hasPushUrl = true;
    if (!match?.[2]) continue;
    const value = unquoteGitConfigValue(match[2]);
    if (value === undefined) {
      return { ok: false, reason: "unsafe quoted Git remote config value" };
    }
    const target = parseGitRemoteTarget(value);
    if (target.kind === "unsafe") {
      return { ok: false, reason: target.reason };
    }
    if (target.kind === "host") {
      (isPushUrl ? remote.pushUrls : remote.urls).push(target.host);
    }
  }
  const hosts = new Set<string>();
  for (const values of remotes.values()) {
    const selected = purpose === "push" && values.hasPushUrl ? values.pushUrls : values.urls;
    for (const host of selected) hosts.add(host);
  }
  return { ok: true, hosts: [...hosts] };
}
