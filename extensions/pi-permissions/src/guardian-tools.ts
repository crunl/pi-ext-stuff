import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Tool as LlmTool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadOnlyTools,
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type FindToolInput,
  formatSize,
  type GrepToolDetails,
  type GrepToolInput,
  getAgentDir,
  type LsToolDetails,
  type LsToolInput,
  type ReadToolDetails,
  type ReadToolInput,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createGuardianWorkerClient,
  type GuardianWorkerClientOptions,
} from "./guardian-worker-client.ts";
import {
  createSandboxedGuardianFileOperations,
  createSandboxedReadOnlyCommandRunner,
  type SandboxExecutionRequest,
  type SandboxedCommandResult,
  type SandboxManagerLike,
} from "./sandbox.ts";

const GUARDIAN_TOOL_NAMES = new Set(["read", "grep", "find", "ls", "inspect"]);
const SENSITIVE_ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/\b(authorization|x-api-key|api-key)\s*[:=]\s*[^,\s]+/gi, "$1: [redacted]"],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\bbasic\s+[A-Za-z0-9._~+/=-]+/gi, "Basic [redacted]"],
];

type PiAgentTool = ReturnType<typeof createReadOnlyTools>[number];

const DEFAULT_GREP_LIMIT = 100;
const MAX_GREP_LIMIT = 1_000;
const DEFAULT_FIND_LIMIT = 1_000;
const MAX_FIND_LIMIT = 5_000;
const DEFAULT_LS_LIMIT = 500;
const MAX_LS_LIMIT = 1_000;
const MAX_GREP_CONTEXT = 20;
const MAX_RG_ARGUMENT_LENGTH = 16_384;
const RG_UNAVAILABLE_MESSAGE =
  "ripgrep (rg) is not available; the reviewer will not download tools";

const RUN_RESOLVED_RG_HELPER = `
const { execFile } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const fs = require("node:fs");
const nodePath = require("node:path");
const [encodedExecutables, encodedArgs, mode, recordLimitText, contextLineCountText] = process.argv.slice(1);
const executableCandidates = JSON.parse(Buffer.from(encodedExecutables, "base64").toString("utf8"));
const args = JSON.parse(Buffer.from(encodedArgs, "base64").toString("utf8"));
const recordLimit = Number(recordLimitText);
const contextLineCount = Number(contextLineCountText);
const maxRecordBytes = 64 * 1024;
const maxOutputBytes = 4 * 1024 * 1024;
const maxStderrBytes = 8 * 1024;
const records = [];
const stdoutDecoder = new StringDecoder("utf8");
let outputBytes = 0;
let stderr = "";
let pending = "";
let limited = false;
let outputExceeded = false;
let settled = false;
let matchCount = 0;
let trailingContextPath;
let trailingContextThrough = 0;

if (
  !Array.isArray(executableCandidates)
  || !executableCandidates.every((candidate) => typeof candidate === "string")
  || !Array.isArray(args)
  || !args.every((arg) => typeof arg === "string")
) {
  throw new Error("invalid rg arguments");
}
if (
  (mode !== "grep" && mode !== "find")
  || !Number.isInteger(recordLimit)
  || recordLimit < 1
  || !Number.isInteger(contextLineCount)
  || contextLineCount < 0
) {
  throw new Error("invalid rg record limit");
}

let executable;
for (const candidate of executableCandidates) {
  if (!nodePath.isAbsolute(candidate) || !/^rg(?:\\.exe)?$/i.test(nodePath.basename(candidate))) {
    continue;
  }
  try {
    const resolved = fs.realpathSync(candidate);
    if (!/^rg(?:\\.exe)?$/i.test(nodePath.basename(resolved)) || !fs.statSync(resolved).isFile()) {
      continue;
    }
    fs.accessSync(resolved, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    executable = resolved;
    break;
  } catch {
    // Try the next fixed candidate inside the Guardian sandbox.
  }
}
if (!executable) {
  process.stderr.write("${RG_UNAVAILABLE_MESSAGE}");
  process.exit(127);
}

const child = execFile(executable, args, {
  windowsHide: true,
  maxBuffer: maxOutputBytes + maxRecordBytes,
});

function stopChild() {
  if (!child.killed) child.kill("SIGTERM");
}

function storeRecord(line) {
  const bytes = Buffer.byteLength(line);
  if (bytes > maxRecordBytes || outputBytes + bytes + 1 > maxOutputBytes) {
    outputExceeded = true;
    stopChild();
    return;
  }
  records.push(line);
  outputBytes += bytes + 1;
}

function finishLimit() {
  limited = true;
  stopChild();
}

function acceptGrepRecord(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }

  if (event.type === "end" && matchCount >= recordLimit) {
    finishLimit();
    return;
  }
  if (event.type !== "match" && event.type !== "context") return;
  const path = event.data?.path?.text;
  const lineNumber = event.data?.line_number;
  if (typeof path !== "string" || typeof lineNumber !== "number") return;

  if (event.type === "match") {
    if (matchCount < recordLimit) {
      matchCount++;
      storeRecord(line);
      if (outputExceeded) return;
      if (matchCount >= recordLimit) {
        trailingContextPath = path;
        trailingContextThrough = lineNumber + contextLineCount;
        if (contextLineCount === 0) finishLimit();
      }
      return;
    }
    if (path === trailingContextPath && lineNumber <= trailingContextThrough) {
      storeRecord(JSON.stringify({ ...event, type: "context" }));
      if (lineNumber >= trailingContextThrough && !outputExceeded) finishLimit();
      return;
    }
    finishLimit();
    return;
  }

  if (contextLineCount === 0) return;
  if (matchCount < recordLimit) {
    storeRecord(line);
    return;
  }
  if (path === trailingContextPath && lineNumber <= trailingContextThrough) {
    storeRecord(line);
    if (lineNumber >= trailingContextThrough && !outputExceeded) finishLimit();
    return;
  }
  finishLimit();
}

function acceptRecord(line) {
  if (mode === "grep") {
    acceptGrepRecord(line);
    return;
  }
  if (line.length === 0) return;
  storeRecord(line);
  if (!outputExceeded && records.length >= recordLimit) {
    limited = true;
    stopChild();
  }
}

function consumeLines() {
  for (;;) {
    const newline = pending.indexOf("\\n");
    if (newline < 0 || limited || outputExceeded) return;
    const line = pending.slice(0, newline).replace(/\\r$/, "");
    pending = pending.slice(newline + 1);
    acceptRecord(line);
  }
}

child.stdout.on("data", (chunk) => {
  if (limited || outputExceeded) return;
  pending += stdoutDecoder.write(chunk);
  consumeLines();
  if (Buffer.byteLength(pending) > maxRecordBytes) {
    outputExceeded = true;
    stopChild();
  }
});
child.stderr.on("data", (chunk) => {
  if (Buffer.byteLength(stderr) >= maxStderrBytes) return;
  stderr += chunk.toString("utf8").slice(0, maxStderrBytes - Buffer.byteLength(stderr));
});
child.once("error", (error) => {
  if (settled) return;
  settled = true;
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
child.once("close", (code) => {
  if (settled) return;
  settled = true;
  if (!limited && !outputExceeded) {
    pending += stdoutDecoder.end();
    consumeLines();
    if (!limited && !outputExceeded && pending.length > 0) {
      acceptRecord(pending.replace(/\\r$/, ""));
    }
  }
  if (records.length > 0) process.stdout.write(records.join("\\n") + "\\n");
  if (outputExceeded) {
    process.stderr.write("ripgrep output exceeded the reviewer bound");
    process.exitCode = 2;
  } else if (limited) {
    process.exitCode = 0;
  } else {
    if (stderr) process.stderr.write(stderr);
    process.exitCode = code === null ? 2 : code;
  }
});
`.trim();

type SandboxedRgMode = "grep" | "find";
type SandboxedRgRunner = (
  args: readonly string[],
  mode: SandboxedRgMode,
  recordLimit: number,
  contextLineCount: number,
  signal?: AbortSignal,
) => Promise<SandboxedCommandResult>;

export interface SandboxedGuardianToolRuntimeOptions {
  resolveRgPath?: () => string | undefined;
  /** Trusted host home used only for resolving Guardian's `~` paths. */
  trustedHome?: string;
}

export type GuardianToolFactory = (cwd: string) => PiAgentTool[];

export interface GuardianToolRuntime {
  readonly tools: LlmTool[];
  execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResultMessage>;
  /** Release the isolated evidence worker, if this runtime owns one. */
  close?(): Promise<void>;
}

function executableRgPath(candidate: string | undefined): string | undefined {
  if (!candidate || !isAbsolute(candidate)) return undefined;
  if (!/^rg(?:\.exe)?$/i.test(basename(candidate))) return undefined;
  try {
    const entry = lstatSync(candidate);
    if (!entry.isFile() && !entry.isSymbolicLink()) return undefined;
    const canonical = realpathSync(candidate);
    if (!/^rg(?:\.exe)?$/i.test(basename(canonical))) return undefined;
    if (!lstatSync(canonical).isFile()) return undefined;
    accessSync(canonical, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return canonical;
  } catch {
    return undefined;
  }
}

function resolveExistingRgPaths(): string[] {
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
  const candidates = [join(getAgentDir(), "bin", binaryName)];
  for (const entry of process.env.PATH?.split(delimiter) ?? []) {
    if (entry) candidates.push(join(entry, binaryName));
  }
  return candidates.flatMap((candidate) => {
    const trusted = executableRgPath(candidate);
    return trusted ? [trusted] : [];
  });
}

function createSandboxedRgRunner(
  manager: SandboxManagerLike,
  resolvedRgPaths: readonly string[],
): SandboxedRgRunner {
  const runNode = createSandboxedReadOnlyCommandRunner(manager, "node");
  const encodedExecutables = Buffer.from(JSON.stringify(resolvedRgPaths)).toString("base64");
  return (args, mode, recordLimit, contextLineCount, signal) =>
    runNode(
      [
        "-e",
        RUN_RESOLVED_RG_HELPER,
        encodedExecutables,
        Buffer.from(JSON.stringify(args)).toString("base64"),
        mode,
        String(recordLimit),
        String(contextLineCount),
      ],
      signal,
    );
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function boundedArgument(value: string, label: string): string {
  if (Buffer.byteLength(value) > MAX_RG_ARGUMENT_LENGTH) {
    throw new Error(`${label} exceeds the reviewer argument bound`);
  }
  return value;
}

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

function resolvedMatchPath(
  filePath: string,
  searchPath: string,
  searchIsDirectory: boolean,
): string {
  if (isAbsolute(filePath)) return filePath;
  return resolve(searchIsDirectory ? searchPath : dirname(searchPath), filePath);
}

function displayMatchPath(
  filePath: string,
  searchPath: string,
  searchIsDirectory: boolean,
): string {
  const absolutePath = resolvedMatchPath(filePath, searchPath, searchIsDirectory);
  if (searchIsDirectory) {
    const pathFromRoot = relative(searchPath, absolutePath);
    if (pathFromRoot && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`)) {
      return toPosixPath(pathFromRoot);
    }
  }
  return basename(absolutePath);
}

type PublicGuardianToolDefinition =
  | ReturnType<typeof createReadToolDefinition>
  | ReturnType<typeof createGrepToolDefinition>
  | ReturnType<typeof createFindToolDefinition>
  | ReturnType<typeof createLsToolDefinition>;

function publicToolFromDefinition(
  definition: PublicGuardianToolDefinition,
  execute: PiAgentTool["execute"],
): PiAgentTool {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: definition.constrainedSampling }),
    execute,
  } as PiAgentTool;
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      /\bENOENT\b|no such file or directory/i.test(error.message))
  );
}

function supportedImageMimeType(buffer: Buffer): string | undefined {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  const header = buffer.subarray(0, 12).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";
  if (header.startsWith("BM")) return "image/bmp";
  return undefined;
}

async function executeSandboxedRead(
  cwd: string,
  input: ReadToolInput,
  operations: ReturnType<typeof createSandboxedGuardianFileOperations>,
) {
  const absolutePath = await operations.resolveReadPath(input.path, cwd);
  await operations.read.access(absolutePath);
  const mimeType = supportedImageMimeType(await operations.readPrefix(absolutePath, 16));
  if (mimeType) {
    const buffer = await operations.read.readFile(absolutePath);
    return {
      content: [
        { type: "text" as const, text: `Read image file [${mimeType}]` },
        { type: "image" as const, data: buffer.toString("base64"), mimeType },
      ],
      details: undefined,
    };
  }

  const startLine = input.offset ? Math.max(1, Math.floor(input.offset)) : 1;
  const window = await operations.readText(
    absolutePath,
    startLine,
    input.limit,
    DEFAULT_MAX_LINES,
    DEFAULT_MAX_BYTES,
  );
  if (window.offsetBeyondEnd) {
    throw new Error(
      `Offset ${input.offset} is beyond end of file (${window.totalLines ?? 0} lines total)`,
    );
  }

  let outputText = window.content;
  if (window.firstLineExceedsLimit) {
    outputText = `[Line ${startLine} exceeds the ${formatSize(DEFAULT_MAX_BYTES)} reviewer read limit]`;
  } else if (window.truncatedBy) {
    const endLineDisplay = startLine + window.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    outputText += `\n\n[Showing lines ${startLine}-${endLineDisplay} (${window.truncatedBy === "bytes" ? `${formatSize(DEFAULT_MAX_BYTES)} byte` : `${DEFAULT_MAX_LINES} line`} limit). Use offset=${nextOffset} to continue.]`;
  } else if (window.userLimitReached || (input.limit !== undefined && window.hasMore)) {
    const nextOffset = startLine + window.outputLines;
    const remaining =
      window.totalLines === undefined
        ? "More lines"
        : `${Math.max(0, window.totalLines - nextOffset + 1)} more lines`;
    outputText += `\n\n[${remaining} in file. Use offset=${nextOffset} to continue.]`;
  }

  return {
    content: [{ type: "text" as const, text: outputText }],
    details: undefined as ReadToolDetails | undefined,
  };
}

async function executeSandboxedLs(
  cwd: string,
  input: LsToolInput,
  operations: ReturnType<typeof createSandboxedGuardianFileOperations>,
) {
  const requestedPath = input.path || ".";
  const directoryPath = await operations.resolveReadPath(requestedPath, cwd);
  const effectiveLimit = boundedLimit(input.limit, DEFAULT_LS_LIMIT, MAX_LS_LIMIT);
  let listing: Awaited<ReturnType<typeof operations.listDirectory>>;
  try {
    listing = await operations.listDirectory(directoryPath, effectiveLimit);
  } catch (error) {
    if (isNotFoundError(error)) throw new Error(`Path not found: ${directoryPath}`);
    if (
      error instanceof Error &&
      ((error as NodeJS.ErrnoException).code === "ENOTDIR" ||
        /not a directory/i.test(error.message))
    ) {
      throw new Error(`Not a directory: ${directoryPath}`);
    }
    throw error;
  }

  listing.entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  if (listing.entries.length === 0) {
    return {
      content: [{ type: "text" as const, text: "(empty directory)" }],
      details: undefined,
    };
  }

  const truncation = truncateHead(listing.entries.join("\n"), {
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  let output = truncation.content;
  const details: LsToolDetails = {};
  const notices: string[] = [];
  if (listing.entryLimitReached) {
    details.entryLimitReached = effectiveLimit;
    notices.push(`${effectiveLimit} entries limit reached`);
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

  return {
    content: [{ type: "text" as const, text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

interface RgGrepRecord {
  type: "match" | "context";
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

function parseGrepRecords(stdout: Buffer): RgGrepRecord[] {
  const records: RgGrepRecord[] = [];
  for (const line of stdout.toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as RgGrepRecord;
      if (
        (event.type === "match" || event.type === "context") &&
        typeof event.data?.path?.text === "string" &&
        typeof event.data.line_number === "number"
      ) {
        records.push(event);
      }
    } catch {
      // Ignore malformed or non-evidence records from rg.
    }
  }
  return records;
}

async function executeSandboxedGrep(
  cwd: string,
  input: GrepToolInput,
  operations: ReturnType<typeof createSandboxedGuardianFileOperations>,
  runRg: SandboxedRgRunner | undefined,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new Error("Operation aborted");
  if (!runRg) throw new Error(RG_UNAVAILABLE_MESSAGE);

  const searchPath = resolve(cwd, input.path || ".");
  let searchIsDirectory: boolean;
  try {
    searchIsDirectory = await operations.grep.isDirectory(searchPath);
  } catch (error) {
    if (isNotFoundError(error)) throw new Error(`Path not found: ${searchPath}`);
    throw error;
  }

  const effectiveLimit = boundedLimit(input.limit, DEFAULT_GREP_LIMIT, MAX_GREP_LIMIT);
  const context = Math.min(MAX_GREP_CONTEXT, Math.max(0, Math.floor(input.context ?? 0)));
  const args = [
    "--json",
    "--line-number",
    "--color=never",
    "--hidden",
    "--max-columns=500",
    "--max-columns-preview",
  ];
  if (input.ignoreCase) args.push("--ignore-case");
  if (input.literal) args.push("--fixed-strings");
  if (input.glob) args.push("--glob", boundedArgument(input.glob, "grep glob"));
  if (context > 0) args.push("--context", String(context));
  args.push(
    "--",
    boundedArgument(input.pattern, "grep pattern"),
    boundedArgument(searchPath, "grep path"),
  );

  const result = await runRg(args, "grep", effectiveLimit, context, signal);
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(
      result.stderr.toString("utf8").trim() ||
        `ripgrep exited with code ${result.exitCode ?? "unknown"}`,
    );
  }

  const records = parseGrepRecords(result.stdout);
  const matches = records.filter((record) => record.type === "match").slice(0, effectiveLimit);
  if (matches.length === 0) {
    return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
  }

  const outputLines: string[] = [];
  const recordsByPath = new Map<string, Map<number, RgGrepRecord>>();
  for (const record of records) {
    const path = record.data?.path?.text;
    const lineNumber = record.data?.line_number;
    if (!path || lineNumber === undefined) continue;
    let recordsByLine = recordsByPath.get(path);
    if (!recordsByLine) {
      recordsByLine = new Map();
      recordsByPath.set(path, recordsByLine);
    }
    recordsByLine.set(lineNumber, record);
  }
  let linesTruncated = false;
  for (const match of matches) {
    const rawPath = match.data?.path?.text;
    const lineNumber = match.data?.line_number;
    if (!rawPath || lineNumber === undefined) continue;
    const displayedPath = displayMatchPath(rawPath, searchPath, searchIsDirectory);
    if (context === 0) {
      const lineText = (match.data?.lines?.text ?? "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "")
        .replace(/\n$/, "");
      const truncated = truncateLine(lineText);
      if (truncated.wasTruncated) linesTruncated = true;
      outputLines.push(`${displayedPath}:${lineNumber}: ${truncated.text}`);
      continue;
    }

    const recordsByLine = recordsByPath.get(rawPath);
    const start = Math.max(1, lineNumber - context);
    const end = lineNumber + context;
    for (let current = start; current <= end; current++) {
      const evidence = recordsByLine?.get(current);
      if (!evidence) continue;
      const lineText = (evidence.data?.lines?.text ?? "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "")
        .replace(/\n$/, "");
      const truncated = truncateLine(lineText);
      if (truncated.wasTruncated) linesTruncated = true;
      outputLines.push(
        current === lineNumber
          ? `${displayedPath}:${current}: ${truncated.text}`
          : `${displayedPath}-${current}- ${truncated.text}`,
      );
    }
  }

  const truncation = truncateHead(outputLines.join("\n"), {
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  let output = truncation.content;
  const details: GrepToolDetails = {};
  const notices: string[] = [];
  if (matches.length >= effectiveLimit) {
    details.matchLimitReached = effectiveLimit;
    notices.push(`${effectiveLimit} matches limit reached`);
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  if (linesTruncated) {
    details.linesTruncated = true;
    notices.push("some lines truncated");
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

  return {
    content: [{ type: "text" as const, text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

function projectTool(tool: PiAgentTool): LlmTool {
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: tool.constrainedSampling }),
  });
}

function sanitizeErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [pattern, replacement] of SENSITIVE_ERROR_PATTERNS) {
    message = message.replace(pattern, replacement);
  }
  return message.slice(0, 2_000);
}

function toolErrorResult(toolCall: ToolCall, error: unknown): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [
      {
        type: "text",
        text: `Reviewer tool failed: ${sanitizeErrorMessage(error)}`,
      },
    ],
    isError: true,
    timestamp: Date.now(),
  };
}

export function createGuardianToolRuntime(
  cwd: string,
  toolFactory: GuardianToolFactory = createReadOnlyTools,
): GuardianToolRuntime {
  const runtimeTools = toolFactory(cwd).filter((tool) => GUARDIAN_TOOL_NAMES.has(tool.name));
  const toolsByName = new Map(runtimeTools.map((tool) => [tool.name, tool]));
  const exposedTools = runtimeTools.map(projectTool);
  Object.freeze(exposedTools);

  return Object.freeze({
    tools: exposedTools,
    async execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResultMessage> {
      const tool = toolsByName.get(toolCall.name);
      if (!tool) {
        throw new Error(`Reviewer tool ${toolCall.name} is not available`);
      }

      try {
        const result = await tool.execute(toolCall.id, toolCall.arguments, signal, undefined);
        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: result.content,
          ...(result.details === undefined ? {} : { details: result.details }),
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          isError: "isError" in result && result.isError === true,
          timestamp: Date.now(),
        };
      } catch (error) {
        return toolErrorResult(toolCall, error);
      }
    },
  });
}

export function createSandboxedGuardianToolRuntime(
  cwd: string,
  manager: SandboxManagerLike,
  options: SandboxedGuardianToolRuntimeOptions = {},
): GuardianToolRuntime {
  const trustedHome = options.trustedHome ?? homedir();
  const resolvedRgPaths = options.resolveRgPath
    ? [executableRgPath(options.resolveRgPath())].filter((path): path is string => Boolean(path))
    : resolveExistingRgPaths();
  const runRg =
    resolvedRgPaths.length > 0 ? createSandboxedRgRunner(manager, resolvedRgPaths) : undefined;

  const readDefinition = createReadToolDefinition(cwd);
  const readTool = publicToolFromDefinition(readDefinition, async (_toolCallId, params, signal) =>
    executeSandboxedRead(
      cwd,
      params as ReadToolInput,
      createSandboxedGuardianFileOperations(manager, signal, trustedHome),
    ),
  );

  const grepDefinition = createGrepToolDefinition(cwd);
  const grepTool = publicToolFromDefinition(grepDefinition, async (_toolCallId, params, signal) =>
    executeSandboxedGrep(
      cwd,
      params as GrepToolInput,
      createSandboxedGuardianFileOperations(manager, signal, trustedHome),
      runRg,
      signal,
    ),
  );

  const findDefinition = createFindToolDefinition(cwd);
  const findTool = publicToolFromDefinition(
    findDefinition,
    async (toolCallId, params, signal, onUpdate) => {
      const input = params as FindToolInput;
      const effectiveLimit = boundedLimit(input.limit, DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT);
      const operations = createSandboxedGuardianFileOperations(manager, signal, trustedHome);
      const sandboxedDefinition = createFindToolDefinition(cwd, {
        operations: {
          exists: operations.find.exists,
          glob: async (pattern, searchRoot, { ignore, limit }) => {
            if (!runRg) throw new Error(RG_UNAVAILABLE_MESSAGE);
            const args = [
              "--files",
              "--hidden",
              "--glob",
              boundedArgument(pattern, "find pattern"),
            ];
            for (const ignoredPattern of ignore) {
              args.push("--glob", `!${boundedArgument(ignoredPattern, "find ignore")}`);
            }
            args.push("--", boundedArgument(searchRoot, "find path"));
            const result = await runRg(
              args,
              "find",
              boundedLimit(limit, effectiveLimit, MAX_FIND_LIMIT),
              0,
              signal,
            );
            if (result.exitCode !== 0 && result.exitCode !== 1) {
              throw new Error(
                result.stderr.toString("utf8").trim() ||
                  `ripgrep exited with code ${result.exitCode ?? "unknown"}`,
              );
            }
            return result.stdout
              .toString("utf8")
              .split("\n")
              .map((line) => line.replace(/\r$/, ""))
              .filter((line) => line.length > 0)
              .slice(0, effectiveLimit);
          },
        },
      });
      return sandboxedDefinition.execute(
        toolCallId,
        { ...input, limit: effectiveLimit },
        signal,
        onUpdate,
        undefined as never,
      );
    },
  );

  const lsDefinition = createLsToolDefinition(cwd);
  const lsTool = publicToolFromDefinition(lsDefinition, async (_toolCallId, params, signal) =>
    executeSandboxedLs(
      cwd,
      params as LsToolInput,
      createSandboxedGuardianFileOperations(manager, signal, trustedHome),
    ),
  );

  const runInspect = createSandboxedReadOnlyCommandRunner(manager, "bash");
  const inspectTool = {
    name: "inspect",
    label: "inspect",
    description:
      "Run a bounded inspection command in the reviewer OS sandbox. Workspace and user-data writes are denied; network access is denied; temporary scratch follows sandbox defaults. Use only to gather evidence that would flip an allow/deny decision.",
    parameters: Type.Object({
      command: Type.String({
        minLength: 1,
        description: "Shell command to run for local inspection",
      }),
    }),
    async execute(_toolCallId, params: unknown, signal) {
      const command =
        typeof params === "object" &&
        params !== null &&
        "command" in params &&
        typeof params.command === "string"
          ? params.command
          : "";
      const trimmed = command.trim();
      if (trimmed.length === 0) throw new Error("inspect requires a command");
      if (Buffer.byteLength(trimmed) > MAX_RG_ARGUMENT_LENGTH) {
        throw new Error("inspect command exceeds the reviewer argument bound");
      }
      const result = await runInspect(["-c", trimmed], signal);
      const stdout = result.stdout.toString("utf8");
      const stderr = result.stderr.toString("utf8");
      const text = [stdout, stderr, `exit ${result.exitCode ?? "null"}`]
        .filter((part) => part.length > 0)
        .join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: undefined,
        isError: result.exitCode !== 0 && result.exitCode !== null,
      };
    },
  } as PiAgentTool;

  return createGuardianToolRuntime(cwd, () => [readTool, grepTool, findTool, lsTool, inspectTool]);
}

export interface IsolatedGuardianToolRuntimeOptions extends GuardianWorkerClientOptions {
  resolveRgPath?: () => string | undefined;
  /** Trusted host home used only for resolving Guardian's `~` paths. */
  trustedHome?: string;
}

/**
 * Build the same Guardian evidence surface behind an OS process boundary.
 *
 * The in-process SRT manager is a process-global singleton. An inline network
 * approval can therefore call a Guardian while the main invocation owns SRT's
 * coordinator and deadlock. This adapter gives the existing, bounded
 * Guardian implementation a manager whose only execution path is the
 * self-contained worker process; no SRT API is touched in the host process.
 */
export function createIsolatedGuardianToolRuntime(
  cwd: string,
  options: IsolatedGuardianToolRuntimeOptions = {},
): GuardianToolRuntime {
  const client = createGuardianWorkerClient(options);
  const workerManager: SandboxManagerLike = {
    initialize: async () => undefined,
    reset: () => client.close(),
    execute: (request: SandboxExecutionRequest) =>
      client.execute({
        program: request.program,
        cwd: request.cwd ?? cwd,
        signal: request.signal,
        timeoutMs: request.timeoutMs,
        commandId: request.commandId,
        commandText: request.commandText,
        maxStdoutBytes: request.maxStdoutBytes,
        maxStderrBytes: request.maxStderrBytes,
      }),
  };
  const runtime = createSandboxedGuardianToolRuntime(cwd, workerManager, {
    resolveRgPath: options.resolveRgPath,
    trustedHome: options.trustedHome,
  });
  return Object.freeze({
    ...runtime,
    close: async (): Promise<void> => {
      await client.close();
    },
  });
}
