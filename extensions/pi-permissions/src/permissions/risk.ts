import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { isIP } from "node:net";
import type { CommandSegment, PermissionRequest } from "./rules.ts";

export type Risk = "LOW" | "REVIEW" | "HARD";
export type { CommandSegment, PermissionRequest } from "./rules.ts";

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
    networkTargets: command ? extractShellNetworkHosts(command) : extractNetworkTargets(input),
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

export function isPublicNetworkHost(value: string): boolean {
  const host = value
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (
    !host
    || host === "localhost"
    || host.endsWith(".localhost")
    || host === "metadata.google.internal"
  ) return false;
  return !isSpecialIp(host);
}

function normalizeHostToken(value: string): string | undefined {
  let token = value.trim().replace(/^['"]|['"],?$/g, "");
  if (!token) return undefined;
  try {
    if (/^https?:\/\//i.test(token)) return new URL(token).hostname;
  } catch {
    return undefined;
  }
  token = token.replace(/^[^@]+@/, "");
  if (token.startsWith("[")) return /^\[([^\]]+)\]/.exec(token)?.[1];
  token = token.replace(/:.*$/, "");
  return /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/i.test(token) || isIP(token) !== 0
    ? token
    : undefined;
}

export function extractShellNetworkHosts(command: string): string[] {
  const hosts = new Set<string>();
  for (const match of command.matchAll(/https?:\/\/[^\s"'`<>]+/gi)) {
    const host = normalizeHostToken(match[0]);
    if (host) hosts.add(host.toLowerCase());
  }

  for (const match of command.matchAll(
    /(?:^|[;&|()\s])(curl|wget|ssh|scp|sftp|ftp|nc|ncat)\s+([^;&|()\n]+)/gi,
  )) {
    const executable = match[1]?.toLowerCase();
    const tokens = match[2]?.trim().split(/\s+/) ?? [];
    for (const token of tokens) {
      if (token.startsWith("-")) continue;
      const remoteLike = /^https?:\/\//i.test(token)
        || token.includes("@")
        || (executable === "scp" && token.includes(":"))
        || executable !== "scp";
      if (!remoteLike) continue;
      const host = normalizeHostToken(token);
      if (host) hosts.add(host.toLowerCase());
    }
  }
  return [...hosts];
}

function webFetchRisk(request: PermissionRequest): Risk {
  const value = request.input.url;
  if (typeof value !== "string" || value.trim() === "" || request.networkTargets?.length !== 1) return "HARD";
  let parsed: URL;
  try { parsed = new URL(value); } catch { return "HARD"; }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return "HARD";
  return isPublicNetworkHost(parsed.hostname) ? "LOW" : "HARD";
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

function containsExecutable(command: string, executables: Set<string>): boolean {
  return [...executables].some((executable) =>
    new RegExp(`(?:^|[;&|()\\s])${executable}(?:\\s|$)`, "i").test(command));
}

function hasExternalSideEffect(command: string): boolean {
  return /\bgit\s+push\b/i.test(command)
    || /\bgh\s+(?:api\b[^;\n]*(?:-X|--method)|pr\s+(?:create|merge|close)|issue\s+(?:create|close|delete)|release\s+(?:create|delete)|workflow\s+run|repo\s+delete)\b/i.test(command)
    || /\b(?:npm|pnpm|yarn|bun)\s+publish\b/i.test(command)
    || /\b(?:deploy|production|destroy)\b/i.test(command);
}

export function classifyRisk(request: PermissionRequest): Risk {
  if (request.tool === "WebSearch") return "LOW";
  if (request.tool === "WebFetch") return webFetchRisk(request);
  if (request.operation === "write") return writeRisk(request);
  if (request.operation === "read") return "LOW";
  const command = typeof request.input.command === "string" ? request.input.command : undefined;
  if (!command) return "REVIEW";
  if (
    containsExecutable(command, deleteExecutables)
    || containsExecutable(command, networkExecutables)
    || hasExternalSideEffect(command)
  ) return "HARD";
  return "LOW";
}
