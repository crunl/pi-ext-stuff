import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  GrepOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { PermissionsConfig } from "./config.ts";
import {
  createFilesystemPolicy,
  expandSymlinkAliases,
  resolveSandboxDenyPattern,
} from "./filesystem-policy.ts";
import { filterFeasibleAllowPaths } from "./sandbox/feasible-allow.ts";

/**
 * Our own sandbox policy — the complete description of what a sandboxed
 * process may touch. Deliberately plain data so it can be derived from
 * grants and rendered into any enforcer's flags.
 */
export interface SandboxPolicy {
  filesystem: {
    allowWrite: string[];
    denyRead: string[];
    denyWrite: string[];
    /**
     * Deny entries that may be removed by an exact, explicitly approved
     * filesystem write capability. The entries remain in denyWrite on the
     * baseline policy; this is identity metadata for the Engine only.
     */
    grantableDenyWrite?: string[];
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
  };
}

export interface SandboxManagerLike {
  initialize(config: SandboxPolicy): Promise<void>;
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxPolicy>,
    abortSignal?: AbortSignal,
  ): Promise<string>;
  reset(): Promise<void>;
}

export function createGuardianReadOnlySandboxConfig(): SandboxPolicy {
  return {
    filesystem: {
      allowWrite: [],
      denyRead: [],
      denyWrite: [],
    },
    network: {
      allowedDomains: [],
      deniedDomains: [],
    },
  };
}

export function withAdditionalWriteRoots(
  config: SandboxPolicy,
  writeRoots: readonly string[],
): SandboxPolicy {
  const roots = filterFeasibleAllowPaths(writeRoots.flatMap(expandSymlinkAliases));
  if (roots.length === 0) return config;
  const grantable = new Set(config.filesystem.grantableDenyWrite ?? []);
  const released = new Set(
    config.filesystem.denyWrite.filter((path) => grantable.has(path) && roots.includes(path)),
  );
  return {
    ...config,
    filesystem: {
      ...config.filesystem,
      allowWrite: [...new Set([...config.filesystem.allowWrite, ...roots])],
      denyWrite: config.filesystem.denyWrite.filter((path) => !released.has(path)),
      grantableDenyWrite: (config.filesystem.grantableDenyWrite ?? []).filter(
        (path) => !released.has(path),
      ),
    },
  };
}

export function createSandboxRuntimeConfig(
  config: PermissionsConfig["sandbox"],
  cwd: string,
  protectedWritePaths?: readonly string[],
): SandboxPolicy {
  const filesystem = createFilesystemPolicy(
    config,
    cwd,
    protectedWritePaths ? [...protectedWritePaths] : undefined,
  );
  const denyRead = filesystem.denyRead.flatMap((pattern) =>
    expandSymlinkAliases(resolveSandboxDenyPattern(pattern, cwd)),
  );
  const denyWrite = filesystem.denyWrite.flatMap((pattern) =>
    expandSymlinkAliases(resolveSandboxDenyPattern(pattern, cwd)),
  );
  const gitRoot = resolve(cwd, ".git");
  const gitAliases = new Set(expandSymlinkAliases(gitRoot));
  const grantableDenyWrite = [
    ...new Set(
      filesystem.protectedWritePaths
        .flatMap((pattern) => expandSymlinkAliases(resolveSandboxDenyPattern(pattern, cwd)))
        .filter((path) => gitAliases.has(path) && denyWrite.includes(path)),
    ),
  ];
  return {
    filesystem: {
      allowWrite: filesystem.allowWrite,
      denyRead,
      denyWrite,
      ...(grantableDenyWrite.length > 0 ? { grantableDenyWrite } : {}),
    },
    network: {
      allowedDomains: [...config.network.allowedDomains],
      deniedDomains: [...config.network.deniedDomains],
    },
  };
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Outer shell that runs a command already wrapped by `wrapWithSandbox`. */
const WRAP_SHELL = "/bin/bash";

/** Default host-side deadline for a permissioned bash command. */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;

/** Default host-side deadline for a native sandboxed file operation. */
export const DEFAULT_FILE_OPERATION_TIMEOUT_MS = 30_000;

interface WrappedSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stdin?: "ignore" | string;
  timeoutMs?: number;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

function spawnWrappedCommand(
  wrappedCommand: string,
  options: WrappedSpawnOptions = {},
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const stdinMode = options.stdin === undefined || options.stdin === "ignore" ? "ignore" : "pipe";
    const child = spawn(WRAP_SHELL, ["-c", wrappedCommand], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: [stdinMode, "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputError: Error | undefined;
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const collectStreams = options.onStdout === undefined && options.onStderr === undefined;

    const cleanup = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
      if (timeoutHandle) clearTimeout(timeoutHandle);
    };
    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => killProcessTree(child);
    const ingest = (
      chunks: Buffer[],
      chunk: Buffer,
      currentBytes: number,
      maximumBytes: number | undefined,
      streamName: "stdout" | "stderr",
      onChunk?: (chunk: Buffer) => void,
    ): number => {
      onChunk?.(chunk);
      if (!collectStreams && maximumBytes === undefined) return currentBytes;
      if (outputError) return currentBytes;
      if (maximumBytes === undefined) {
        chunks.push(chunk);
        return currentBytes + chunk.length;
      }
      const remaining = maximumBytes - currentBytes;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      const nextBytes = currentBytes + chunk.length;
      if (nextBytes > maximumBytes) {
        outputError = new Error(`${streamName} exceeded the Guardian bound`);
        killProcessTree(child);
      }
      return Math.min(nextBytes, maximumBytes);
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, options.timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes = ingest(
        stdout,
        chunk,
        stdoutBytes,
        options.maxStdoutBytes,
        "stdout",
        options.onStdout,
      );
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes = ingest(
        stderr,
        chunk,
        stderrBytes,
        options.maxStderrBytes,
        "stderr",
        options.onStderr,
      );
    });
    child.once("error", (error) => finishError(outputError ?? error));
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (options.signal?.aborted) {
        reject(new Error("aborted"));
      } else if (timedOut) {
        reject(new Error(`timeout:${(options.timeoutMs ?? 0) / 1000}`));
      } else if (outputError) {
        reject(outputError);
      } else {
        resolvePromise({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode,
        });
      }
    });
    if (stdinMode === "pipe" && child.stdin) {
      if (typeof options.stdin === "string") child.stdin.end(options.stdin);
      else child.stdin.end();
    }
  });
}

export function createSandboxedBashOperations(
  manager: SandboxManagerLike,
  customConfig?: SandboxPolicy,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      const wrappedCommand = await manager.wrapWithSandbox(
        command,
        undefined,
        customConfig,
        signal,
      );

      const result = await spawnWrappedCommand(wrappedCommand, {
        cwd,
        env,
        signal,
        stdin: "ignore",
        timeoutMs:
          timeout === undefined
            ? DEFAULT_BASH_TIMEOUT_MS
            : timeout > 0
              ? timeout * 1000
              : undefined,
        onStdout: onData,
        onStderr: onData,
      });
      return { exitCode: result.exitCode };
    },
  };
}

const FILE_OPERATION_HELPER = `
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const [operation, encodedPath] = process.argv.slice(1);
const path = Buffer.from(encodedPath, "base64").toString("utf8");
async function stdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function main() {
  if (operation === "mkdir") await fs.mkdir(path, { recursive: true });
  else if (operation === "write") await fs.writeFile(path, await stdin());
  else if (operation === "read") process.stdout.write(await fs.readFile(path));
  else if (operation === "access") await fs.access(path, constants.R_OK | constants.W_OK);
  else throw new Error("unsupported file operation");
}
main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`.trim();

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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

export interface SandboxedCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

export type GuardianReadOnlyExecutable = "node" | "bash";

const GUARDIAN_COMMAND_MAX_STDOUT_BYTES = 5 * 1024 * 1024;
const GUARDIAN_COMMAND_MAX_STDERR_BYTES = 64 * 1024;
const GUARDIAN_FILE_MAX_BYTES = 4 * 1024 * 1024;
const GUARDIAN_DIRECTORY_MAX_ENTRIES = 1_000;
const GUARDIAN_DIRECTORY_MAX_BYTES = 512 * 1024;

function guardianReadOnlyExecutablePath(executable: GuardianReadOnlyExecutable): string {
  if (executable === "node") return process.execPath;
  if (executable === "bash") return WRAP_SHELL;
  throw new Error(`Unsupported Guardian read-only executable: ${executable}`);
}

export function createSandboxedReadOnlyCommandRunner(
  manager: SandboxManagerLike,
  executable: GuardianReadOnlyExecutable,
): (args: readonly string[], signal?: AbortSignal) => Promise<SandboxedCommandResult> {
  const resolvedExecutable = guardianReadOnlyExecutablePath(executable);
  return async (args, signal) => {
    if (signal?.aborted) throw new Error("aborted");
    const command = [resolvedExecutable, ...args].map(shellQuote).join(" ");
    const wrappedCommand = await manager.wrapWithSandbox(
      command,
      undefined,
      createGuardianReadOnlySandboxConfig(),
      signal,
    );
    if (signal?.aborted) throw new Error("aborted");

    return spawnWrappedCommand(wrappedCommand, {
      signal,
      stdin: "ignore",
      timeoutMs: DEFAULT_FILE_OPERATION_TIMEOUT_MS,
      maxStdoutBytes: GUARDIAN_COMMAND_MAX_STDOUT_BYTES,
      maxStderrBytes: GUARDIAN_COMMAND_MAX_STDERR_BYTES,
    });
  };
}

const GUARDIAN_FILE_OPERATION_HELPER = `
const fs = require("node:fs/promises");
const { constants, createReadStream } = require("node:fs");
const os = require("node:os");
const nodePath = require("node:path");
const [operation, encodedPath, ...operationArgs] = process.argv.slice(1);
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
      throw new Error("file exceeds the Guardian byte bound");
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
  if (normalized === "~") normalized = os.homedir();
  else if (normalized.startsWith("~/")) normalized = nodePath.join(os.homedir(), normalized.slice(2));
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
  } else throw new Error("unsupported Guardian file operation");
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

export interface SandboxedGuardianDirectoryListing {
  entries: string[];
  entryLimitReached: boolean;
}

export interface SandboxedGuardianTextRead {
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

export interface SandboxedGuardianFileOperations {
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

export function createSandboxedGuardianFileOperations(
  manager: SandboxManagerLike,
  signal?: AbortSignal,
): SandboxedGuardianFileOperations {
  const run = createSandboxedReadOnlyCommandRunner(manager, "node");
  const runFileOperation = async (
    operation: GuardianFileOperation,
    path: string,
    operationArgs: readonly string[] = [],
  ): Promise<Buffer> => {
    const result = await run(
      [
        "-e",
        GUARDIAN_FILE_OPERATION_HELPER,
        operation,
        Buffer.from(path).toString("base64"),
        ...operationArgs,
      ],
      signal,
    );
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString("utf8");
      let message = stderr || `sandboxed Guardian file operation exited with ${result.exitCode}`;
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

function fileOperationConfig(
  baseConfig: SandboxPolicy,
  writePaths: readonly string[],
): SandboxPolicy {
  return writePaths.length === 0 ? baseConfig : withAdditionalWriteRoots(baseConfig, writePaths);
}

async function runSandboxedFileOperation(
  manager: SandboxManagerLike,
  config: SandboxPolicy,
  operation: "mkdir" | "write" | "read" | "access",
  path: string,
  input?: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const command = [
    process.execPath,
    "-e",
    FILE_OPERATION_HELPER,
    operation,
    Buffer.from(path).toString("base64"),
  ]
    .map(shellQuote)
    .join(" ");
  const wrappedCommand = await manager.wrapWithSandbox(command, undefined, config, signal);
  const result = await spawnWrappedCommand(wrappedCommand, {
    signal,
    stdin: input === undefined ? "ignore" : input,
    timeoutMs: DEFAULT_FILE_OPERATION_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.toString("utf8") || `sandboxed file operation exited with ${result.exitCode}`,
    );
  }
  return result.stdout;
}

export type SandboxedFileOperations = WriteOperations & EditOperations;

export function createSandboxedFileOperations(
  manager: SandboxManagerLike,
  baseConfig: SandboxPolicy,
  writePaths: readonly string[] = [],
  signal?: AbortSignal,
): SandboxedFileOperations {
  const config = fileOperationConfig(baseConfig, writePaths);
  return {
    mkdir: async (path) => {
      await runSandboxedFileOperation(manager, config, "mkdir", path, undefined, signal);
    },
    writeFile: async (path, content) => {
      await runSandboxedFileOperation(manager, config, "write", path, content, signal);
    },
    readFile: (path) => runSandboxedFileOperation(manager, config, "read", path, undefined, signal),
    access: async (path) => {
      await runSandboxedFileOperation(manager, config, "access", path, undefined, signal);
    },
  };
}
