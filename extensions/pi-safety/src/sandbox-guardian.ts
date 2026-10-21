/**
 * Trusted side of the sandbox seam: the read-only operations the reviewer
 * (Guardian) uses to inspect evidence.
 *
 * This module holds one trust level. Everything here runs under
 * `createGuardianReadOnlySandboxConfig` — zero write authority, zero network,
 * an explicit denyRead ceiling — and nothing here is reachable from a tool the
 * agent drives. The untrusted tool side lives in `./sandbox.ts`; the two
 * deliberately share no constants and no helpers, because a value that is the
 * same number at both levels is not the same policy. A reviewer command budget
 * and an agent file-operation budget are set by different questions, so they
 * are declared separately here even while they happen to agree.
 *
 * The evidence scope handed in is trusted parent-side data: it is copied on
 * entry so a caller cannot widen it after this module has read it, and it is
 * never placed in the model prompt.
 */
import { homedir, tmpdir } from "node:os";
import type {
  FindOperations,
  GrepOperations,
  LsOperations,
  ReadOperations,
} from "@earendil-works/pi-coding-agent";
import {
  copyGuardianEvidenceScope,
  createGuardianReadOnlySandboxConfig,
  type GuardianEvidenceScope,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxManagerLike,
} from "./sandbox-policy.ts";

/**
 * POSIX shell used for the reviewer's read-only command runner. Declared here,
 * not imported from the tool side: the reviewer's shell budget and environment
 * belong to the reviewer's trust level.
 */
const GUARDIAN_READ_ONLY_SHELL = "/bin/bash";

/** Reviewer command budget. Not the agent's file-operation budget, even when equal. */
const GUARDIAN_COMMAND_TIMEOUT_MS = 30_000;

const GUARDIAN_COMMAND_MAX_STDOUT_BYTES = 5 * 1024 * 1024;
const GUARDIAN_COMMAND_MAX_STDERR_BYTES = 64 * 1024;
const GUARDIAN_FILE_MAX_BYTES = 4 * 1024 * 1024;
const GUARDIAN_DIRECTORY_MAX_ENTRIES = 1_000;
const GUARDIAN_DIRECTORY_MAX_BYTES = 512 * 1024;

export interface SandboxedCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

type GuardianReadOnlyExecutable = "node" | "bash";

function guardianReadOnlyExecutablePath(executable: GuardianReadOnlyExecutable): string {
  if (executable === "node") return process.execPath;
  if (executable === "bash") return GUARDIAN_READ_ONLY_SHELL;
  throw new Error(`Unsupported reviewer read-only executable: ${executable}`);
}

function systemPath(): string {
  return process.platform === "win32"
    ? (process.env.SystemRoot ?? "")
    : "/usr/bin:/bin:/usr/sbin:/sbin";
}

/**
 * Reviewer environment, replaced wholesale on the child. The reviewer gets no
 * inherited PATH or home: `HOME` and `TMPDIR` both point at the temp dir so a
 * resolver cannot wander into the operator's real home.
 */
function guardianEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: systemPath(),
    HOME: tmpdir(),
    TMPDIR: tmpdir(),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
  };
}

/**
 * Reviewer executions go straight to the manager. The untrusted side wraps its
 * policy with Git-metadata deny roots; the reviewer has no write authority to
 * protect, so inheriting that wrapper would be sharing a rule across trust
 * levels rather than reusing a value.
 */
function executeReviewerProgram(
  manager: SandboxManagerLike,
  request: SandboxExecutionRequest,
): Promise<SandboxExecutionResult> {
  return manager.execute(request);
}

export function createSandboxedReadOnlyCommandRunner(
  manager: SandboxManagerLike,
  executable: GuardianReadOnlyExecutable,
  evidenceScope: GuardianEvidenceScope,
): (args: readonly string[], signal?: AbortSignal) => Promise<SandboxedCommandResult> {
  const resolvedExecutable = guardianReadOnlyExecutablePath(executable);
  const trustedScope = copyGuardianEvidenceScope(evidenceScope);
  return async (args, signal) => {
    if (signal?.aborted) throw new Error("aborted");
    return executeReviewerProgram(manager, {
      policy: createGuardianReadOnlySandboxConfig(trustedScope),
      program: { executable: resolvedExecutable, args },
      env: guardianEnvironment(),
      envMode: "replace",
      signal,
      stdin: "ignore",
      timeoutMs: GUARDIAN_COMMAND_TIMEOUT_MS,
      maxStdoutBytes: GUARDIAN_COMMAND_MAX_STDOUT_BYTES,
      maxStderrBytes: GUARDIAN_COMMAND_MAX_STDERR_BYTES,
    });
  };
}

const GUARDIAN_FILE_OPERATION_HELPER = `
const fs = require("node:fs/promises");
const { constants, createReadStream } = require("node:fs");
const nodePath = require("node:path");
const [encodedTrustedHome, operation, encodedPath, ...operationArgs] = process.argv.slice(1);
const trustedHome = Buffer.from(encodedTrustedHome, "base64").toString("utf8");
const path = Buffer.from(encodedPath, "base64").toString("utf8");
const maxFileBytes = ${GUARDIAN_FILE_MAX_BYTES};
const maxDirectoryEntries = ${GUARDIAN_DIRECTORY_MAX_ENTRIES};
const maxDirectoryBytes = ${GUARDIAN_DIRECTORY_MAX_BYTES};

async function readBounded(filePath) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.length;
    if (bytes > maxFileBytes) {
      throw new Error("file exceeds the reviewer byte bound");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function readPrefix(filePath, requestedBytes) {
  const maximumBytes = Math.min(64, Math.max(1, requestedBytes));
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maximumBytes);
    const { bytesRead } = await handle.read(buffer, 0, maximumBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readTextWindow(
  filePath,
  requestedOffset,
  requestedLimit,
  requestedMaxLines,
  requestedMaxBytes,
) {
  const startLine = Number.isFinite(requestedOffset)
    ? Math.max(1, Math.floor(requestedOffset))
    : 1;
  const userLimit = Number.isFinite(requestedLimit)
    ? Math.max(0, Math.floor(requestedLimit))
    : undefined;
  const maxLines = Math.max(1, Math.floor(requestedMaxLines));
  const maxBytes = Math.max(1, Math.floor(requestedMaxBytes));
  const lineLimit = Math.min(maxLines, userLimit ?? maxLines);
  const outputLines = [];
  let outputBytes = 0;
  let currentLine = 1;
  let currentLineChunks = [];
  let currentLineBytes = 0;
  let truncatedBy = null;
  let firstLineExceedsLimit = false;
  let userLimitReached = false;
  let hasMore = false;
  let reachedEnd = false;
  let stopped = false;

  function stopAtLineLimit() {
    hasMore = true;
    stopped = true;
    if (userLimit !== undefined && userLimit <= maxLines) userLimitReached = true;
    else truncatedBy = "lines";
  }

  function finishCurrentLine() {
    if (currentLine < startLine) return;
    if (outputLines.length >= lineLimit) {
      stopAtLineLimit();
      return;
    }
    let line = Buffer.concat(currentLineChunks, currentLineBytes);
    if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
    const separatorBytes = outputLines.length > 0 ? 1 : 0;
    if (outputBytes + separatorBytes + line.length > maxBytes) {
      firstLineExceedsLimit = outputLines.length === 0;
      truncatedBy = "bytes";
      hasMore = true;
      stopped = true;
      return;
    }
    outputLines.push(line);
    outputBytes += separatorBytes + line.length;
  }

  const handle = await fs.open(filePath, "r");
  const readBuffer = Buffer.alloc(64 * 1024);
  try {
    while (!stopped) {
      const { bytesRead } = await handle.read(readBuffer, 0, readBuffer.length, null);
      if (bytesRead === 0) {
        reachedEnd = true;
        break;
      }
      let cursor = 0;
      while (cursor < bytesRead && !stopped) {
        const newline = readBuffer.indexOf(0x0a, cursor);
        const end = newline < 0 || newline >= bytesRead ? bytesRead : newline;
        if (currentLine >= startLine) {
          if (outputLines.length >= lineLimit) {
            stopAtLineLimit();
            break;
          }
          const segment = readBuffer.subarray(cursor, end);
          currentLineBytes += segment.length;
          const separatorBytes = outputLines.length > 0 ? 1 : 0;
          if (outputBytes + separatorBytes + currentLineBytes > maxBytes) {
            firstLineExceedsLimit = outputLines.length === 0;
            truncatedBy = "bytes";
            hasMore = true;
            stopped = true;
            break;
          }
          if (segment.length > 0) currentLineChunks.push(Buffer.from(segment));
        }
        if (newline < 0 || newline >= bytesRead) break;
        finishCurrentLine();
        currentLine += 1;
        currentLineChunks = [];
        currentLineBytes = 0;
        cursor = newline + 1;
      }
    }
  } finally {
    await handle.close();
  }

  if (reachedEnd && !stopped) finishCurrentLine();
  return {
    content: Buffer.concat(outputLines).length === 0
      ? ""
      : outputLines.map((line) => line.toString("utf8")).join("\\n"),
    outputLines: outputLines.length,
    outputBytes,
    truncatedBy,
    firstLineExceedsLimit,
    userLimitReached,
    hasMore,
    offsetBeyondEnd: reachedEnd && startLine > currentLine,
    totalLines: reachedEnd ? currentLine : undefined,
  };
}

async function readDirectoryEntries(directoryPath) {
  const entries = [];
  let bytes = 0;
  const directory = await fs.opendir(directoryPath);
  try {
    for await (const entry of directory) {
      const entryBytes = Buffer.byteLength(entry.name) + 1;
      if (entries.length >= maxDirectoryEntries || bytes + entryBytes > maxDirectoryBytes) break;
      entries.push(entry.name);
      bytes += entryBytes;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return entries;
}

function resolveToCwd(rawPath, cwd) {
  let normalized = rawPath.replace(/^@/, "").replace(/\u00a0/g, " ");
  if (normalized === "~") normalized = trustedHome;
  else if (normalized.startsWith("~/")) normalized = nodePath.join(trustedHome, normalized.slice(2));
  return nodePath.resolve(cwd, normalized);
}

async function resolveReadPath(rawPath, cwd) {
  const resolved = resolveToCwd(rawPath, cwd);
  const variants = [
    resolved,
    resolved.replace(/ (AM|PM)./gi, "\u202f$1."),
    resolved.normalize("NFD"),
    resolved.replace(/'/g, "\u2019"),
    resolved.normalize("NFD").replace(/'/g, "\u2019"),
  ];
  for (const candidate of [...new Set(variants)]) {
    try {
      await fs.access(candidate, constants.F_OK);
      return candidate;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
  }
  return resolved;
}

async function listDirectory(directoryPath, requestedLimit) {
  const effectiveLimit = Math.min(
    maxDirectoryEntries,
    Math.max(1, Number.isInteger(requestedLimit) ? requestedLimit : 500),
  );
  const entries = [];
  let bytes = 0;
  let entryLimitReached = false;
  const directory = await fs.opendir(directoryPath);
  try {
    for await (const entry of directory) {
      if (entries.length >= effectiveLimit) {
        entryLimitReached = true;
        break;
      }
      let isDirectory;
      try {
        isDirectory = (await fs.stat(nodePath.join(directoryPath, entry.name))).isDirectory();
      } catch {
        continue;
      }
      const rendered = entry.name + (isDirectory ? "/" : "");
      const entryBytes = Buffer.byteLength(rendered) + 1;
      if (bytes + entryBytes > maxDirectoryBytes) {
        entryLimitReached = true;
        break;
      }
      entries.push(rendered);
      bytes += entryBytes;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return { entries, entryLimitReached };
}

async function main() {
  if (operation === "read") process.stdout.write(await readBounded(path));
  else if (operation === "readPrefix") {
    process.stdout.write(await readPrefix(path, Number(operationArgs[0])));
  }
  else if (operation === "readText") {
    process.stdout.write(JSON.stringify(await readTextWindow(
      path,
      Number(operationArgs[0]),
      operationArgs[1] === "" ? undefined : Number(operationArgs[1]),
      Number(operationArgs[2]),
      Number(operationArgs[3]),
    )));
  }
  else if (operation === "access") await fs.access(path, constants.R_OK);
  else if (operation === "resolveReadPath") {
    const cwd = Buffer.from(operationArgs[0], "base64").toString("utf8");
    process.stdout.write(await resolveReadPath(path, cwd));
  }
  else if (operation === "exists") {
    try {
      await fs.access(path, constants.F_OK);
      process.stdout.write("true");
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        process.stdout.write("false");
      } else throw error;
    }
  } else if (operation === "stat") {
    const stat = await fs.stat(path);
    process.stdout.write(JSON.stringify({ isDirectory: stat.isDirectory() }));
  } else if (operation === "readdir") {
    process.stdout.write(JSON.stringify(await readDirectoryEntries(path)));
  } else if (operation === "list") {
    process.stdout.write(JSON.stringify(await listDirectory(path, Number(operationArgs[0]))));
  } else throw new Error("unsupported reviewer file operation");
}
main().catch((error) => {
  process.stderr.write(JSON.stringify({
    code: error && typeof error === "object" ? error.code : undefined,
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
`.trim();

type GuardianFileOperation =
  | "read"
  | "readPrefix"
  | "readText"
  | "access"
  | "resolveReadPath"
  | "exists"
  | "stat"
  | "readdir"
  | "list";

interface SandboxedGuardianDirectoryListing {
  entries: string[];
  entryLimitReached: boolean;
}

interface SandboxedGuardianTextRead {
  content: string;
  outputLines: number;
  outputBytes: number;
  truncatedBy: "lines" | "bytes" | null;
  firstLineExceedsLimit: boolean;
  userLimitReached: boolean;
  hasMore: boolean;
  offsetBeyondEnd: boolean;
  totalLines?: number;
}

interface SandboxedGuardianFileOperations {
  read: ReadOperations;
  grep: GrepOperations;
  find: Pick<FindOperations, "exists">;
  ls: LsOperations;
  resolveReadPath(path: string, cwd: string): Promise<string>;
  readPrefix(path: string, bytes: number): Promise<Buffer>;
  readText(
    path: string,
    offset: number | undefined,
    limit: number | undefined,
    maxLines: number,
    maxBytes: number,
  ): Promise<SandboxedGuardianTextRead>;
  listDirectory(path: string, limit: number): Promise<SandboxedGuardianDirectoryListing>;
}

function parseJsonSafe<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `malformed sandboxed output: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function createSandboxedGuardianFileOperations(
  manager: SandboxManagerLike,
  evidenceScope: GuardianEvidenceScope,
  signal?: AbortSignal,
  trustedHome: string = homedir(),
): SandboxedGuardianFileOperations {
  const run = createSandboxedReadOnlyCommandRunner(manager, "node", evidenceScope);
  const runFileOperation = async (
    operation: GuardianFileOperation,
    path: string,
    operationArgs: readonly string[] = [],
  ): Promise<Buffer> => {
    const result = await run(
      [
        "-e",
        GUARDIAN_FILE_OPERATION_HELPER,
        Buffer.from(trustedHome).toString("base64"),
        operation,
        Buffer.from(path).toString("base64"),
        ...operationArgs,
      ],
      signal,
    );
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString("utf8");
      let message = stderr || `sandboxed reviewer file operation exited with ${result.exitCode}`;
      let code: string | undefined;
      try {
        const diagnostic = JSON.parse(stderr) as { code?: unknown; message?: unknown };
        if (typeof diagnostic.message === "string") message = diagnostic.message;
        if (typeof diagnostic.code === "string") code = diagnostic.code;
      } catch {
        // Preserve non-helper sandbox diagnostics as-is.
      }
      const error = new Error(message) as NodeJS.ErrnoException;
      if (code) error.code = code;
      throw error;
    }
    return result.stdout;
  };
  const exists = async (path: string): Promise<boolean> =>
    (await runFileOperation("exists", path)).toString("utf8") === "true";
  const stat = async (path: string): Promise<{ isDirectory: boolean }> =>
    parseJsonSafe<{ isDirectory: boolean }>(
      (await runFileOperation("stat", path)).toString("utf8"),
    );

  return {
    read: {
      readFile: (path) => runFileOperation("read", path),
      access: async (path) => {
        await runFileOperation("access", path);
      },
    },
    grep: {
      isDirectory: async (path) => (await stat(path)).isDirectory,
      readFile: async (path) => (await runFileOperation("read", path)).toString("utf8"),
    },
    find: { exists },
    ls: {
      exists,
      stat: async (path) => {
        const details = await stat(path);
        return { isDirectory: () => details.isDirectory };
      },
      readdir: async (path) =>
        parseJsonSafe<string[]>((await runFileOperation("readdir", path)).toString("utf8")),
    },
    resolveReadPath: (path, cwd) =>
      runFileOperation("resolveReadPath", path, [Buffer.from(cwd).toString("base64")]).then(
        (output) => output.toString("utf8"),
      ),
    readPrefix: (path, bytes) => runFileOperation("readPrefix", path, [String(bytes)]),
    readText: (path, offset, limit, maxLines, maxBytes) =>
      runFileOperation("readText", path, [
        String(offset ?? 1),
        limit === undefined ? "" : String(limit),
        String(maxLines),
        String(maxBytes),
      ]).then((output) => parseJsonSafe<SandboxedGuardianTextRead>(output.toString("utf8"))),
    listDirectory: (path, limit) =>
      runFileOperation("list", path, [String(limit)]).then((output) =>
        parseJsonSafe<SandboxedGuardianDirectoryListing>(output.toString("utf8")),
      ),
  };
}
