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
  return typeof input.url === "string" ? [input.url] : [];
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

function isSpecialIpv4(host: string): boolean {
  const [first, second, third] = host.split(".").map(Number);
  return first === 0
    || first === 10
    || first === 127
    || first === 100 && second >= 64 && second <= 127
    || first === 169 && second === 254
    || first === 172 && second >= 16 && second <= 31
    || first === 192 && (second === 0 || second === 88 || second === 168)
    || first === 198 && (second === 18 || second === 19 || second === 51 && third === 100)
    || first === 203 && second === 0 && third === 113
    || first >= 224;
}

function mappedIpv4(host: string): string | undefined {
  const tail = /^::ffff:(.+)$/i.exec(host)?.[1];
  if (!tail) return undefined;
  if (isIP(tail) === 4) return tail;
  const groups = tail.split(":");
  if (groups.length !== 2 || !groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return undefined;
  const [first, second] = groups.map((group) => Number.parseInt(group, 16));
  return `${first! >> 8}.${first! & 255}.${second! >> 8}.${second! & 255}`;
}

function isSpecialIp(host: string): boolean {
  const mapped = mappedIpv4(host);
  if (mapped) return isSpecialIpv4(mapped);
  if (isIP(host) === 4) return isSpecialIpv4(host);
  if (isIP(host) !== 6) return false;
  const firstHextet = Number.parseInt(host.split(":")[0] ?? "", 16);
  return host === "::"
    || host === "::1"
    || host.startsWith("fc")
    || host.startsWith("fd")
    || (firstHextet >= 0xfe80 && firstHextet <= 0xfebf)
    || host.startsWith("ff")
    || host.startsWith("2001:db8:")
    || host.startsWith("2001:2:");
}

function webFetchRisk(request: PermissionRequest): Risk {
  const value = request.input.url;
  if (typeof value !== "string" || value.trim() === "" || request.networkTargets?.length !== 1) return "HARD";
  let parsed: URL;
  try { parsed = new URL(value); } catch { return "HARD"; }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return "HARD";
  const host = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") return "HARD";
  return isSpecialIp(host) ? "HARD" : "LOW";
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

function parsePureArgv(command: string): CommandSegment | undefined {
  if (command.trim() !== command || !command || !/^[A-Za-z0-9._+\-/:=@%, ]+$/.test(command)) return undefined;
  const [executableToken = "", ...args] = command.split(/ +/);
  if (!/^[A-Za-z0-9._+\-]+$/.test(executableToken) || executableToken.includes("=")) return undefined;
  if (!args.every((arg) => /^[A-Za-z0-9._+\-/:=@%,]+$/.test(arg))) return undefined;
  return {
    source: command,
    executableToken,
    executable: executableToken,
    args,
    hasRedirect: false,
    hasSubstitution: false,
    nestedShell: false,
  };
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
  return false;
}

export function classifyRisk(request: PermissionRequest): Risk {
  if (request.tool === "WebSearch") return "LOW";
  if (request.tool === "WebFetch") return webFetchRisk(request);
  if (request.operation === "write") return writeRisk(request);
  if (request.operation === "read") return "LOW";
  const command = typeof request.input.command === "string" ? request.input.command : undefined;
  if (!command) return "REVIEW";
  const segment = parsePureArgv(command);
  if (!segment) return "HARD";
  if (isHardSimpleCommand(segment, command)) return "HARD";
  return isTrustedRead(segment) ? "LOW" : "REVIEW";
}
