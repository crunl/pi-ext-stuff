import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { isIP } from "node:net";
import type { CommandSegment, PermissionRequest } from "./rules.ts";

export type Risk = "LOW" | "REVIEW" | "HARD";
export type { CommandSegment, PermissionRequest } from "./rules.ts";

const trustedReadCommands = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "rg", "grep"]);
const networkExecutables = new Set(["curl", "wget", "ssh", "scp", "ftp", "nc", "ncat", "sftp"]);
const deleteExecutables = new Set(["rm", "rmdir", "unlink", "shred", "truncate"]);

function parseSimpleSegment(source: string): CommandSegment {
  const [executableToken = "", ...args] = source.trim().split(/\s+/);
  return {
    source,
    executableToken,
    executable: basename(executableToken),
    args,
    hasRedirect: /[<>]/.test(source),
    hasSubstitution: /[$`]/.test(source),
    nestedShell: /\b(?:bash|sh|zsh|fish|dash)\b/.test(source),
  };
}

function extractedPaths(input: Record<string, unknown>, cwd: string): string[] {
  return ["path", "filePath", "targetPath", "sourcePath"].flatMap((key) => {
    const value = input[key];
    return typeof value === "string" ? [isAbsolute(value) ? resolve(value) : resolve(cwd, value)] : [];
  });
}

function extractNetworkTargets(input: Record<string, unknown>): string[] {
  return ["url", "host", "hostname"].flatMap((key) => typeof input[key] === "string" ? [input[key]] : []);
}

/**
 * This is intentionally not a shell parser. Task 5 executes only through a
 * controlled PATH and revalidates the resolved executable immediately before
 * sandboxed execution.
 */
export function normalizeToolCall(tool: string, input: Record<string, unknown>, cwd: string): PermissionRequest {
  const command = typeof input.command === "string" ? input.command : undefined;
  const lowerTool = tool.toLowerCase();
  const operation = lowerTool === "webfetch" ? "network"
    : new Set(["websearch", "read", "search", "grep", "find", "ls"]).has(lowerTool) ? "read"
    : ["write", "edit", "apply_patch"].includes(lowerTool) ? "write"
    : command ? "execute" : "external";
  return {
    tool,
    operation,
    input,
    cwd: resolve(cwd),
    resolvedPaths: extractedPaths(input, cwd),
    commandSegments: command ? [parseSimpleSegment(command)] : undefined,
    networkTargets: extractNetworkTargets(input),
  };
}

function isPrivateTarget(value: string): boolean {
  let host = value;
  try { host = new URL(value).hostname; } catch { host = value.replace(/^\[|\]$/g, ""); }
  const normalized = host.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (["localhost", "::", "::1", "metadata.google.internal"].includes(normalized) || normalized.endsWith(".localhost")) return true;
  const mapped = /^::ffff:(.+)$/i.exec(normalized)?.[1];
  if (mapped) return isPrivateTarget(mapped);
  if (isIP(normalized) === 6) {
    const firstHextet = Number.parseInt(normalized.split(":")[0] ?? "", 16);
    return normalized.startsWith("fc") || normalized.startsWith("fd") || (firstHextet >= 0xfe80 && firstHextet <= 0xfebf);
  }
  if (isIP(normalized) !== 4) return false;
  const [first, second] = normalized.split(".").map(Number);
  return first === 0 || first === 10 || first === 127 || first === 169 && second === 254 || first === 192 && second === 168 || first === 172 && second >= 16 && second <= 31;
}

function isWithin(path: string, root: string): boolean {
  const remainder = relative(root, path);
  return remainder === "" || (!remainder.startsWith(`..${sep}`) && remainder !== "..");
}

function writeRisk(request: PermissionRequest): Risk {
  const projectConfig = resolve(request.cwd, ".pi/permissions.json");
  const globalConfig = resolve(homedir(), ".pi/agent/permissions.json");
  if (request.resolvedPaths.some((path) => path === projectConfig || path === globalConfig)) return "HARD";
  return request.resolvedPaths.length > 0 && request.resolvedPaths.every((path) => isWithin(path, request.cwd)) ? "LOW" : "REVIEW";
}

function hasComplexShellSyntax(command: string): boolean {
  return /[\\'"`$;\n<>|&]/.test(command);
}

function safeOptions(args: string[], allowed: Set<string>, compact?: RegExp): boolean {
  let pathsOnly = false;
  return args.every((arg) => {
    if (pathsOnly) return true;
    if (arg === "--") { pathsOnly = true; return true; }
    if (!arg.startsWith("-")) return true;
    return allowed.has(arg) || compact?.test(arg) === true;
  });
}

function isTrustedRead(segment: CommandSegment): boolean {
  if (!trustedReadCommands.has(segment.executable) || segment.executableToken.includes("/")) return false;
  if (segment.executable === "pwd") return safeOptions(segment.args, new Set(["-L", "-P", "--logical", "--physical"]));
  if (segment.executable === "rg") {
    if (segment.args[0] !== "--no-config") return false;
    return safeOptions(segment.args, new Set(["--no-config", "-n", "-i", "-F", "-E", "-G", "-v", "-w", "-x", "-l", "-c", "-o", "-S", "-s", "-u", "--files", "--hidden", "--no-ignore", "--line-number", "--ignore-case", "--fixed-strings", "--extended-regexp"]));
  }
  const options: Record<string, { allowed: Set<string>; compact?: RegExp }> = {
    cat: { allowed: new Set(["-n", "-b", "-s", "-A", "-e", "-E", "-T", "-v"]) },
    head: { allowed: new Set(["-q", "-v", "--quiet", "--verbose"]) },
    tail: { allowed: new Set(["-q", "-v", "-f", "--quiet", "--verbose", "--follow"]) },
    wc: { allowed: new Set(["-c", "-m", "-l", "-w", "-L"]) },
    ls: { allowed: new Set(["-a", "-A", "-l", "-h", "-t", "-r", "-S", "-R", "-d", "-1", "-C", "-x", "-F", "-p"]), compact: /^-[aAlhtrSRd1CxFp]+$/ },
    grep: { allowed: new Set(["-n", "-i", "-r", "-R", "-E", "-F", "-G", "-v", "-l", "-L", "-c", "-w", "-x", "-q", "-s", "-H", "-h"]), compact: /^-[niRrEFGvlLcwxsHh]+$/ },
  };
  const policy = options[segment.executable];
  return policy ? safeOptions(segment.args, policy.allowed, policy.compact) : false;
}

function isHardSimpleCommand(segment: CommandSegment, command: string): boolean {
  if (deleteExecutables.has(segment.executable) || networkExecutables.has(segment.executable)) return true;
  if (segment.executable === "git" && segment.args.includes("push")) return true;
  if (segment.args.includes("publish") || /\b(?:deploy|production|destroy)\b/i.test(command)) return true;
  return ["kubectl", "terraform", "helm", "ansible"].includes(segment.executable);
}

export function classifyRisk(request: PermissionRequest): Risk {
  if (request.tool === "WebSearch") return "LOW";
  if (request.tool === "WebFetch") return request.networkTargets?.some(isPrivateTarget) ? "HARD" : "LOW";
  if (request.operation === "write") return writeRisk(request);
  if (request.operation === "read") return "LOW";
  const command = typeof request.input.command === "string" ? request.input.command : undefined;
  if (!command) return "REVIEW";
  if (hasComplexShellSyntax(command)) return "HARD";
  const segment = request.commandSegments?.[0] ?? parseSimpleSegment(command);
  if (isHardSimpleCommand(segment, command)) return "HARD";
  return isTrustedRead(segment) ? "LOW" : "REVIEW";
}
