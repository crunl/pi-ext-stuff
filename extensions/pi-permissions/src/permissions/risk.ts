import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { isIP } from "node:net";
import type { CommandSegment, PermissionRequest } from "./rules.ts";

export type Risk = "LOW" | "REVIEW" | "HARD";
export type { CommandSegment, PermissionRequest } from "./rules.ts";

const readOnlyCommands = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "rg", "grep"]);
const readOnlyGitSubcommands = new Set(["status", "diff", "log", "show", "rev-parse"]);
const shellExecutables = new Set(["bash", "sh", "zsh", "fish", "dash"]);
const networkExecutables = new Set(["curl", "wget", "ssh", "scp", "ftp", "nc", "ncat"]);

function splitCommand(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  const push = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === "\\") {
      current += character;
      if (index + 1 < command.length) current += command[++index]!;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === ";" || character === "\n" || character === "|") {
      push();
      if (character === "|" && command[index + 1] === "|") index += 1;
      continue;
    }
    if (character === "&") {
      if (command[index + 1] === ">") {
        current += character;
        continue;
      }
      push();
      if (command[index + 1] === "&") index += 1;
      continue;
    }
    current += character;
  }
  push();
  return segments;
}

function hasUnquotedRedirect(source: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === ">" || character === "<") return true;
  }
  return false;
}

function parseSegment(source: string): CommandSegment {
  const tokens = source.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const executable = basename(tokens[0] ?? "");
  const args = tokens.slice(1);
  return {
    source,
    executable,
    args,
    hasRedirect: hasUnquotedRedirect(source),
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
    : new Set(["websearch", "read", "search", "grep", "find", "ls"]).has(lowerTool) ? "read"
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
  const lower = host.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (lower === "localhost" || lower === "::" || lower === "::1" || lower === "metadata.google.internal" || lower.endsWith(".localhost")) return true;
  const mapped = /^::ffff:(.+)$/i.exec(lower)?.[1];
  if (mapped) {
    if (mapped.includes(".")) return isPrivateTarget(mapped);
    const groups = mapped.split(":");
    if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) {
      const numeric = groups.map((group) => Number.parseInt(group, 16));
      return isPrivateTarget(`${numeric[0]! >> 8}.${numeric[0]! & 255}.${numeric[1]! >> 8}.${numeric[1]! & 255}`);
    }
  }
  if (isIP(lower) === 6) return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
  if (isIP(lower) !== 4) return false;
  const [first, second] = lower.split(".").map(Number);
  return first === 0 || first === 10 || first === 127 || first === 169 && second === 254 || first === 192 && second === 168 || first === 172 && second >= 16 && second <= 31;
}

function readOnlySegment(segment: CommandSegment): boolean {
  if (segment.hasRedirect || segment.hasSubstitution || segment.nestedShell) return false;
  if (readOnlyCommands.has(segment.executable)) return true;
  return segment.executable === "git"
    && readOnlyGitSubcommands.has(segment.args[0] ?? "")
    && !segment.args.some((argument) => argument === "-o" || argument.startsWith("--output"));
}

function removesBoundary(target: string, request: PermissionRequest): boolean {
  const unquoted = target.replace(/^(['"])(.*)\1$/, "$2");
  if (["/", "~", "~/", "$HOME", "${HOME}"].includes(unquoted)) return true;
  if ([".", "$PWD", "${PWD}"].includes(unquoted)) return true;
  return unquoted === homedir() || unquoted === request.cwd || resolve(request.cwd, unquoted) === request.cwd;
}

function isForcedPushToProtectedBranch(segments: CommandSegment[]): boolean {
  return segments.some((segment) => {
    if (segment.executable !== "git" || segment.args[0] !== "push") return false;
    const args = segment.args.slice(1);
    const forced = args.some((argument) => argument === "--force" || argument.startsWith("--force=") || argument.startsWith("--force-with-lease") || /^-[^-]*f/.test(argument) || argument.startsWith("+"));
    return forced && args.some((argument) => /(?:^|[:/])(main|master)$/.test(argument));
  });
}

function commandIsHard(request: PermissionRequest, segments: CommandSegment[]): boolean {
  const command = typeof request.input.command === "string" ? request.input.command : segments.map((segment) => segment.source).join(" ");
  if (isForcedPushToProtectedBranch(segments)) return true;
  if (segments.some((segment) => {
    if (segment.executable !== "rm") return false;
    return segment.args
      .filter((argument) => !argument.startsWith("-"))
      .some((target) => removesBoundary(target, request));
  })) return true;
  if (/\b(?:kubectl|terraform)\b[^\n]*(?:destroy|delete)[^\n]*(?:prod|production)/i.test(command)) return true;
  if (/\b(?:cat|printenv|env)\b[\s\S]*?(?:\.env|\.ssh|\.aws|\.gnupg)[\s\S]*?\b(?:curl|wget|ssh|scp|ftp|nc|ncat)\b/.test(command)) return true;
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
  if (request.operation === "read") return "LOW";
  if (request.commandSegments) {
    if (commandIsHard(request, request.commandSegments)) return "HARD";
    if (request.commandSegments.every(readOnlySegment)) return "LOW";
    return "REVIEW";
  }
  return "REVIEW";
}
