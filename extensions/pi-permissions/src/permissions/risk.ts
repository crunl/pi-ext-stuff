import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { isIP } from "node:net";
import type { CommandSegment, PermissionRequest } from "./rules.ts";

export type Risk = "LOW" | "REVIEW" | "HARD";
export type { CommandSegment, PermissionRequest } from "./rules.ts";

const readOnlyCommands = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "rg", "grep"]);
const readOnlyGitSubcommands = new Set(["status", "diff", "log", "show", "branch", "rev-parse"]);
const shellExecutables = new Set(["bash", "sh", "zsh", "fish", "dash"]);
const networkExecutables = new Set(["curl", "wget", "ssh", "scp", "ftp", "nc", "ncat"]);

function splitCommand(command: string): string[] {
  return command.split(/(?:&&|\|\||;|\|)/).map((part) => part.trim()).filter(Boolean);
}

function parseSegment(source: string): CommandSegment {
  const tokens = source.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const executable = basename(tokens[0] ?? "");
  const args = tokens.slice(1);
  return {
    source,
    executable,
    args,
    hasRedirect: /(?:^|\s)\d?(?:>>?|<<?)/.test(source),
    hasSubstitution: /\$\(|`/.test(source),
    nestedShell: shellExecutables.has(executable) || /(?:^|\s)-c(?:\s|$)/.test(source),
  };
}

function extractedPaths(input: Record<string, unknown>, cwd: string): string[] {
  return ["path", "filePath", "targetPath", "sourcePath"].flatMap((key) => {
    const value = input[key];
    if (typeof value !== "string") return [];
    return [isAbsolute(value) ? resolve(value) : resolve(cwd, value)];
  });
}

function extractNetworkTargets(input: Record<string, unknown>): string[] {
  return ["url", "host", "hostname"].flatMap((key) => typeof input[key] === "string" ? [input[key]] : []);
}

export function normalizeToolCall(tool: string, input: Record<string, unknown>, cwd: string): PermissionRequest {
  const command = typeof input.command === "string" ? input.command : undefined;
  const commandSegments = command ? splitCommand(command).map(parseSegment) : undefined;
  const lowerTool = tool.toLowerCase();
  const operation = lowerTool === "webfetch" ? "network"
    : lowerTool === "websearch" ? "read"
    : ["write", "edit", "apply_patch"].includes(lowerTool) ? "write"
    : command ? "execute" : "external";
  return {
    tool,
    operation,
    input,
    cwd: resolve(cwd),
    resolvedPaths: extractedPaths(input, cwd),
    commandSegments,
    networkTargets: extractNetworkTargets(input),
  };
}

function isPrivateTarget(value: string): boolean {
  let host = value;
  try { host = new URL(value).hostname; } catch { host = value.replace(/^\[|\]$/g, ""); }
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower === "::1" || lower === "metadata.google.internal" || lower.endsWith(".localhost")) return true;
  if (isIP(lower) === 6) return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
  if (isIP(lower) !== 4) return false;
  const [first, second] = lower.split(".").map(Number);
  return first === 0 || first === 10 || first === 127 || first === 169 && second === 254 || first === 192 && second === 168 || first === 172 && second >= 16 && second <= 31;
}

function readOnlySegment(segment: CommandSegment): boolean {
  if (segment.hasRedirect || segment.hasSubstitution || segment.nestedShell) return false;
  if (readOnlyCommands.has(segment.executable)) return true;
  return segment.executable === "git" && readOnlyGitSubcommands.has(segment.args[0] ?? "");
}

function commandIsHard(request: PermissionRequest, segments: CommandSegment[]): boolean {
  const command = segments.map((segment) => segment.source).join(" ");
  if (/\bgit\s+push\b[^\n]*(?:--force|-f)\b[^\n]*\b(?:main|master)\b/.test(command)) return true;
  if (segments.some((segment) => {
    if (segment.executable !== "rm") return false;
    return segment.args
      .filter((argument) => !argument.startsWith("-"))
      .map((argument) => argument.replace(/^['"]|['"]$/g, ""))
      .some((target) => target === "/" || target === "~" || target === "." || resolve(request.cwd, target) === request.cwd);
  })) return true;
  if (/\b(?:kubectl|terraform)\b[^\n]*(?:destroy|delete)[^\n]*(?:prod|production)/i.test(command)) return true;
  if (/\b(?:cat|printenv)\b[^\n]*(?:\.env|\.ssh|\.aws|\.gnupg)[^\n]*\|\s*(?:curl|wget|ssh)\b/.test(command)) return true;
  return request.resolvedPaths.some((path) => path === "/" || path === request.cwd);
}

function isWithin(path: string, root: string): boolean {
  const remainder = relative(root, path);
  return remainder === "" || (!remainder.startsWith(`..${sep}`) && remainder !== "..");
}

function writeRisk(request: PermissionRequest): Risk {
  const projectConfig = resolve(request.cwd, ".pi/permissions.json");
  const globalConfig = resolve(homedir(), ".pi/agent/permissions.json");
  if (request.resolvedPaths.some((path) => path === projectConfig || path === globalConfig)) return "HARD";
  if (request.resolvedPaths.length === 0 || request.resolvedPaths.some((path) => !isWithin(path, request.cwd))) return "REVIEW";
  return "LOW";
}

export function classifyRisk(request: PermissionRequest): Risk {
  if (request.tool === "WebSearch") return "LOW";
  if (request.tool === "WebFetch") return request.networkTargets?.some(isPrivateTarget) ? "HARD" : "LOW";
  if (request.operation === "write") return writeRisk(request);
  if (request.commandSegments) {
    if (commandIsHard(request, request.commandSegments)) return "HARD";
    if (request.commandSegments.every(readOnlySegment)) return "LOW";
    return "REVIEW";
  }
  return "REVIEW";
}
