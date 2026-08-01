import { accessSync, constants, realpathSync, statSync } from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Tool as LlmTool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createReadOnlyTools,
  DEFAULT_MAX_BYTES,
  formatSize,
  getAgentDir,
  truncateHead,
  truncateLine,
  type FindToolInput,
  type GrepToolDetails,
  type GrepToolInput,
} from "@earendil-works/pi-coding-agent";
import {
  createSandboxedGuardianFileOperations,
  createSandboxedReadOnlyCommandRunner,
  type SandboxedCommandResult,
  type SandboxManagerLike,
} from "./sandbox.ts";

const GUARDIAN_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
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
const MAX_GREP_CONTEXT = 20;
const MAX_RG_ARGUMENT_LENGTH = 16_384;
const RG_UNAVAILABLE_MESSAGE =
  "ripgrep (rg) is not available; Guardian will not download tools";

const RUN_RESOLVED_RG_HELPER = `
const { execFile } = require("node:child_process");
const [encodedExecutable, encodedArgs, mode, recordLimitText] = process.argv.slice(1);
const executable = Buffer.from(encodedExecutable, "base64").toString("utf8");
const args = JSON.parse(Buffer.from(encodedArgs, "base64").toString("utf8"));
const recordLimit = Number(recordLimitText);
const maxRecordBytes = 64 * 1024;
const maxOutputBytes = 4 * 1024 * 1024;
const maxStderrBytes = 8 * 1024;
const records = [];
let outputBytes = 0;
let stderr = "";
let pending = "";
let limited = false;
let outputExceeded = false;
let settled = false;

if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
  throw new Error("invalid rg arguments");
}
if ((mode !== "grep" && mode !== "find") || !Number.isInteger(recordLimit) || recordLimit < 1) {
  throw new Error("invalid rg record limit");
}

const child = execFile(executable, args, { windowsHide: true });

function stopChild() {
  if (!child.killed) child.kill("SIGTERM");
}

function acceptRecord(line) {
  if (mode === "grep") {
    try {
      if (JSON.parse(line).type !== "match") return;
    } catch {
      return;
    }
  } else if (line.length === 0) {
    return;
  }

  const bytes = Buffer.byteLength(line);
  if (bytes > maxRecordBytes || outputBytes + bytes + 1 > maxOutputBytes) {
    outputExceeded = true;
    stopChild();
    return;
  }
  records.push(line);
  outputBytes += bytes + 1;
  if (records.length >= recordLimit) {
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
  pending += chunk.toString("utf8");
  if (Buffer.byteLength(pending) > maxRecordBytes) {
    outputExceeded = true;
    stopChild();
    return;
  }
  consumeLines();
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
  if (!limited && !outputExceeded && pending.length > 0) acceptRecord(pending.replace(/\\r$/, ""));
  if (records.length > 0) process.stdout.write(records.join("\\n") + "\\n");
  if (outputExceeded) {
    process.stderr.write("ripgrep output exceeded the Guardian bound");
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
  signal?: AbortSignal,
) => Promise<SandboxedCommandResult>;

export interface SandboxedGuardianToolRuntimeOptions {
  resolveRgPath?: () => string | undefined;
}

export type GuardianToolFactory = (cwd: string) => PiAgentTool[];

export interface GuardianToolRuntime {
  readonly tools: LlmTool[];
  execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResultMessage>;
}

function executableRgPath(candidate: string | undefined): string | undefined {
  if (!candidate || !isAbsolute(candidate)) return undefined;
  try {
    const resolved = realpathSync(candidate);
    if (!/^rg(?:\.exe)?$/i.test(basename(resolved)) || !statSync(resolved).isFile()) {
      return undefined;
    }
    accessSync(resolved, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return resolved;
  } catch {
    return undefined;
  }
}

function resolveExistingRgPath(): string | undefined {
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
  const candidates = [join(getAgentDir(), "bin", binaryName)];
  for (const entry of process.env.PATH?.split(delimiter) ?? []) {
    if (entry) candidates.push(join(entry, binaryName));
  }
  for (const candidate of candidates) {
    const resolved = executableRgPath(candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

function createSandboxedRgRunner(
  manager: SandboxManagerLike,
  resolvedRgPath: string,
): SandboxedRgRunner {
  const runNode = createSandboxedReadOnlyCommandRunner(manager, "node");
  const encodedExecutable = Buffer.from(resolvedRgPath).toString("base64");
  return (args, mode, recordLimit, signal) =>
    runNode(
      [
        "-e",
        RUN_RESOLVED_RG_HELPER,
        encodedExecutable,
        Buffer.from(JSON.stringify(args)).toString("base64"),
        mode,
        String(recordLimit),
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
    throw new Error(`${label} exceeds the Guardian argument bound`);
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

function displayMatchPath(filePath: string, searchPath: string, searchIsDirectory: boolean): string {
  const absolutePath = resolvedMatchPath(filePath, searchPath, searchIsDirectory);
  if (searchIsDirectory) {
    const pathFromRoot = relative(searchPath, absolutePath);
    if (pathFromRoot && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`)) {
      return toPosixPath(pathFromRoot);
    }
  }
  return basename(absolutePath);
}

function publicToolFromDefinition(
  definition: ReturnType<typeof createGrepToolDefinition> | ReturnType<typeof createFindToolDefinition>,
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

interface RgMatchRecord {
  type: "match";
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

function parseMatchRecords(stdout: Buffer, limit: number): RgMatchRecord[] {
  const matches: RgMatchRecord[] = [];
  for (const line of stdout.toString("utf8").split("\n")) {
    if (!line || matches.length >= limit) break;
    try {
      const event = JSON.parse(line) as RgMatchRecord;
      if (
        event.type === "match"
        && typeof event.data?.path?.text === "string"
        && typeof event.data.line_number === "number"
      ) {
        matches.push(event);
      }
    } catch {
      // Ignore malformed or non-match records from rg.
    }
  }
  return matches;
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
  } catch {
    throw new Error(`Path not found: ${searchPath}`);
  }

  const effectiveLimit = boundedLimit(input.limit, DEFAULT_GREP_LIMIT, MAX_GREP_LIMIT);
  const context = Math.min(
    MAX_GREP_CONTEXT,
    Math.max(0, Math.floor(input.context ?? 0)),
  );
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
  args.push(
    "--",
    boundedArgument(input.pattern, "grep pattern"),
    boundedArgument(searchPath, "grep path"),
  );

  const result = await runRg(args, "grep", effectiveLimit, signal);
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(
      result.stderr.toString("utf8").trim()
      || `ripgrep exited with code ${result.exitCode ?? "unknown"}`,
    );
  }

  const matches = parseMatchRecords(result.stdout, effectiveLimit);
  if (matches.length === 0) {
    return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
  }

  const outputLines: string[] = [];
  const fileCache = new Map<string, string[]>();
  let linesTruncated = false;
  for (const match of matches) {
    const rawPath = match.data?.path?.text;
    const lineNumber = match.data?.line_number;
    if (!rawPath || lineNumber === undefined) continue;
    const absolutePath = resolvedMatchPath(rawPath, searchPath, searchIsDirectory);
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

    let fileLines = fileCache.get(absolutePath);
    if (!fileLines) {
      try {
        fileLines = (await operations.grep.readFile(absolutePath))
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n")
          .split("\n");
      } catch {
        fileLines = [];
      }
      fileCache.set(absolutePath, fileLines);
    }
    if (fileLines.length === 0) {
      outputLines.push(`${displayedPath}:${lineNumber}: (unable to read file)`);
      continue;
    }
    const start = Math.max(1, lineNumber - context);
    const end = Math.min(fileLines.length, lineNumber + context);
    for (let current = start; current <= end; current++) {
      const truncated = truncateLine(fileLines[current - 1] ?? "");
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
        text: `Guardian tool failed: ${sanitizeErrorMessage(error)}`,
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
        throw new Error(`Guardian tool ${toolCall.name} is not available`);
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
  const operations = createSandboxedGuardianFileOperations(manager);
  const resolvedRgPath = executableRgPath(
    options.resolveRgPath ? options.resolveRgPath() : resolveExistingRgPath(),
  );
  const runRg = resolvedRgPath
    ? createSandboxedRgRunner(manager, resolvedRgPath)
    : undefined;

  const publicTools = createReadOnlyTools(cwd, {
    read: { operations: operations.read },
    ls: { operations: operations.ls },
  });
  const readTool = publicTools.find((tool) => tool.name === "read");
  const lsTool = publicTools.find((tool) => tool.name === "ls");
  if (!readTool || !lsTool) {
    throw new Error("Pi Agent read-only tool definitions are unavailable");
  }

  const grepDefinition = createGrepToolDefinition(cwd);
  const grepTool = publicToolFromDefinition(
    grepDefinition,
    async (_toolCallId, params, signal) =>
      executeSandboxedGrep(
        cwd,
        params as GrepToolInput,
        operations,
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
              signal,
            );
            if (result.exitCode !== 0 && result.exitCode !== 1) {
              throw new Error(
                result.stderr.toString("utf8").trim()
                || `ripgrep exited with code ${result.exitCode ?? "unknown"}`,
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

  return createGuardianToolRuntime(cwd, () => [readTool, grepTool, findTool, lsTool]);
}
