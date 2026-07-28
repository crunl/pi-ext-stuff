import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { isIP } from "node:net";
import type { CommandSegment, PermissionRequest } from "./rules.ts";

export type Risk = "LOW" | "REVIEW" | "HARD";
export type { CommandSegment, PermissionRequest } from "./rules.ts";

const directNetworkExecutables = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "ftp",
  "nc",
  "ncat",
  "sftp",
  "npx",
  "pnpx",
  "bunx",
]);
const deleteExecutables = new Set(["rm", "rmdir", "unlink", "shred", "truncate"]);
const shellExecutables = new Set(["bash", "sh", "zsh", "fish", "dash"]);
const gitNetworkSubcommands = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);
const gitMutationSubcommands = new Set([
  "add",
  "am",
  "bisect",
  "branch",
  "checkout",
  "cherry-pick",
  "commit",
  "fetch",
  "gc",
  "init",
  "maintenance",
  "merge",
  "mv",
  "notes",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "tag",
  "update-ref",
  "worktree",
]);
const packageNetworkSubcommands = new Set([
  "add",
  "audit",
  "ci",
  "dlx",
  "exec",
  "info",
  "install",
  "outdated",
  "publish",
  "search",
  "update",
  "upgrade",
  "view",
]);

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === "\"") {
      current += character;
      quote = character;
      continue;
    }
    if (/[;&|()\n]/.test(character)) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function shellWords(source: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  const flush = (): void => {
    if (current) words.push(current);
    current = "";
  };
  for (const character of source) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    current += character;
  }
  flush();
  return words;
}

function executableIndex(words: readonly string[]): number {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index += 1;
  while (index < words.length) {
    const wrapper = basename(words[index]!).toLowerCase();
    if (wrapper === "command" || wrapper === "builtin" || wrapper === "nohup") {
      index += 1;
      while (index < words.length && words[index]!.startsWith("-")) index += 1;
      continue;
    }
    if (wrapper === "env") {
      index += 1;
      while (index < words.length) {
        const token = words[index]!;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || token === "--") {
          index += 1;
          continue;
        }
        if (token === "-u" || token === "--unset" || token === "-C" || token === "--chdir") {
          index += 2;
          continue;
        }
        if (token.startsWith("-")) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (wrapper !== "sudo") break;
    index += 1;
    while (index < words.length) {
      const token = words[index]!;
      if (token === "-u" || token === "-g" || token === "-h" || token === "-p" || token === "-C") {
        index += 2;
        continue;
      }
      if (token.startsWith("-")) {
        index += 1;
        continue;
      }
      break;
    }
  }
  return index;
}

function parseCommandSegment(source: string): CommandSegment {
  const words = shellWords(source);
  const index = executableIndex(words);
  const executableToken = words[index] ?? "";
  return {
    source,
    executableToken,
    executable: basename(executableToken).toLowerCase(),
    args: words.slice(index + 1),
    hasRedirect: /[<>]/.test(source),
    hasSubstitution: /[$`]/.test(source),
    nestedShell: /\b(?:bash|sh|zsh|fish|dash)\b/.test(source),
  };
}

function parseCommandSegments(command: string): CommandSegment[] {
  const segments = splitShellSegments(command).map(parseCommandSegment);
  const nested = segments.flatMap((segment) => {
    if (!shellExecutables.has(segment.executable)) return [];
    const commandIndex = segment.args.findIndex((arg) =>
      arg === "--command" || /^-[a-z]*c[a-z]*$/i.test(arg));
    const nestedCommand = commandIndex >= 0 ? segment.args[commandIndex + 1] : undefined;
    return nestedCommand ? parseCommandSegments(nestedCommand) : [];
  });
  return [...segments, ...nested];
}

export function shellCommandUsesGitMutation(command: string): boolean {
  return parseCommandSegments(command).some((segment) => {
    const args = segment.args.map((arg) => arg.toLowerCase());
    if (segment.executable === "git") {
      const subcommand = args.find((arg) => !arg.startsWith("-"));
      if (!subcommand) return false;
      if (subcommand === "config") {
        return !args.some((arg) =>
          arg === "--global" || arg === "--system" || arg === "--file");
      }
      return gitMutationSubcommands.has(subcommand);
    }
    if (segment.executable !== "gh") return false;
    const positional = args.filter((arg) => !arg.startsWith("-"));
    return positional[0] === "pr" && positional[1] === "checkout";
  });
}

function extractedPaths(input: Record<string, unknown>, cwd: string): string[] {
  return ["path", "filePath", "targetPath", "sourcePath"].flatMap((key) => {
    const value = input[key];
    return typeof value === "string" ? [isAbsolute(value) ? resolve(value) : resolve(cwd, value)] : [];
  });
}

function extractNetworkTargets(input: Record<string, unknown>): string[] {
  const values = [
    ...(typeof input.url === "string" ? [input.url] : []),
    ...(Array.isArray(input.urls)
      ? input.urls.filter((value): value is string => typeof value === "string")
      : []),
  ];
  return values.map((value) => {
    try {
      return new URL(value).hostname;
    } catch {
      return value;
    }
  });
}

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
    commandSegments: command ? parseCommandSegments(command) : undefined,
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

function ipv6Groups(host: string): number[] | undefined {
  let normalized = host;
  if (host.includes(".")) {
    const separator = host.lastIndexOf(":");
    const ipv4 = host.slice(separator + 1);
    if (separator < 0 || isIP(ipv4) !== 4) return undefined;
    const octets = ipv4.split(".").map(Number);
    normalized = `${host.slice(0, separator)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const pieces = normalized.split("::");
  if (pieces.length > 2) return undefined;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces[1] ? pieces[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (pieces.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...left, ...Array(missing).fill("0"), ...right]
    .map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group))
    ? groups
    : undefined;
}

function ipv4FromGroups(groups: readonly number[], offset: number): string {
  return [
    groups[offset]! >> 8,
    groups[offset]! & 255,
    groups[offset + 1]! >> 8,
    groups[offset + 1]! & 255,
  ].join(".");
}

function isSpecialIp(host: string): boolean {
  if (isIP(host) === 4) return isSpecialIpv4(host);
  if (isIP(host) !== 6) return false;
  const groups = ipv6Groups(host);
  if (!groups) return true;
  const first = groups[0]!;
  const embeddedIpv4 = (
    groups.slice(0, 6).every((group) => group === 0)
    || groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
    || groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)
    || groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1
      && groups.slice(3, 6).every((group) => group === 0)
  ) ? ipv4FromGroups(groups, 6)
    : groups[0] === 0x2002 ? ipv4FromGroups(groups, 1)
      : undefined;
  return embeddedIpv4 ? isSpecialIpv4(embeddedIpv4)
    : groups.every((group) => group === 0)
      || groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1
      || (first & 0xfe00) === 0xfc00
      || (first & 0xffc0) === 0xfe80
      || (first & 0xff00) === 0xff00
      || groups[0] === 0x2001 && groups[1] === 0x0db8
      || groups[0] === 0x2001 && groups[1] === 0x0002;
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
  return /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/i.test(token) || isIP(token) !== 0
    ? token
    : undefined;
}

function invocationUsesNetwork(segment: CommandSegment): boolean {
  const args = segment.args.map((arg) => arg.toLowerCase());
  if (directNetworkExecutables.has(segment.executable)) {
    return !args.some((arg) => arg === "--version" || arg === "--help");
  }
  if (segment.executable === "gh") {
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    return subcommand !== undefined
      && !new Set(["alias", "completion", "config", "help", "version"]).has(subcommand);
  }
  if (
    new Set(["node", "nodejs", "python", "python3", "ruby", "php", "deno"]).has(segment.executable)
  ) {
    return /\b(?:fetch|axios|https?\.request|requests\.|urllib|httpx|aiohttp|socket)\b/i
      .test(segment.source);
  }
  if (segment.executable === "git") {
    return args.some((arg) => gitNetworkSubcommands.has(arg))
      || args.includes("submodule") && args.some((arg) => arg === "add" || arg === "update");
  }
  if (new Set(["npm", "pnpm", "yarn", "bun"]).has(segment.executable)) {
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    return subcommand !== undefined && packageNetworkSubcommands.has(subcommand);
  }
  if (segment.executable === "pip" || segment.executable === "pip3") {
    return args.some((arg) => new Set(["install", "uninstall", "download", "index"]).has(arg));
  }
  if (segment.executable === "cargo") {
    return args.some((arg) => new Set(["install", "publish", "search", "update"]).has(arg));
  }
  if (segment.executable === "go") {
    return args.some((arg) => arg === "get" || arg === "install");
  }
  return false;
}

export function shellCommandUsesImplicitGitNetwork(command: string): boolean {
  return parseCommandSegments(command).some((segment) =>
    segment.executable === "git"
    && invocationUsesNetwork(segment)
    && !segment.args.some((arg) =>
      /^https?:\/\//i.test(arg) || arg.includes("@") || /^[^\s/:]+:[^\s]+$/.test(arg)));
}

export function extractShellNetworkHosts(command: string): string[] {
  const hosts = new Set<string>();
  const segments = parseCommandSegments(command);
  for (const segment of segments) {
    if (!invocationUsesNetwork(segment) || segment.executable === "gh") continue;
    for (const match of segment.source.matchAll(/https?:\/\/[^\s"'`<>]+/gi)) {
      const host = normalizeHostToken(match[0]);
      if (host) hosts.add(host.toLowerCase());
    }
  }

  for (const segment of segments) {
    if (!invocationUsesNetwork(segment)) continue;
    if (segment.executable === "gh") {
      hosts.add("api.github.com");
      hosts.add("github.com");
      hosts.add("uploads.github.com");
      continue;
    }
    if (
      new Set(["npm", "pnpm", "yarn", "bun", "npx", "pnpx", "bunx"]).has(segment.executable)
    ) {
      hosts.add("registry.npmjs.org");
    }
    if (
      !directNetworkExecutables.has(segment.executable)
      && segment.executable !== "git"
      && segment.executable !== "gh"
    ) continue;
    for (const token of segment.args) {
      if (token.startsWith("-")) continue;
      const remoteLike = /^https?:\/\//i.test(token)
        || token.includes("@")
        || (segment.executable === "scp" && token.includes(":"))
        || token.includes(".")
        || isIP(token.replace(/:.*$/, "")) !== 0;
      if (!remoteLike) continue;
      const host = normalizeHostToken(token);
      if (host) hosts.add(host.toLowerCase());
    }
    const positional = segment.args.filter((token) => !token.startsWith("-"));
    const implicitHost = segment.executable === "ssh" || segment.executable === "sftp"
      ? positional.at(-1)
      : segment.executable === "ftp" || segment.executable === "nc" || segment.executable === "ncat"
        ? positional[0]
        : undefined;
    const normalizedImplicitHost = implicitHost ? normalizeHostToken(implicitHost) : undefined;
    if (normalizedImplicitHost) hosts.add(normalizedImplicitHost.toLowerCase());
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

function invocationHasExternalSideEffect(segment: CommandSegment): boolean {
  const args = segment.args.map((arg) => arg.toLowerCase());
  if (segment.executable === "kubectl") {
    return args.some((arg) =>
      new Set(["apply", "create", "delete", "edit", "patch", "replace", "scale", "set"]).has(arg));
  }
  if (segment.executable === "terraform" || segment.executable === "tofu") {
    return args.some((arg) =>
      new Set(["apply", "destroy", "import", "refresh", "taint", "untaint"]).has(arg));
  }
  return new Set(["vercel", "netlify", "wrangler", "flyctl", "heroku"]).has(segment.executable);
}

export function classifyRisk(request: PermissionRequest): Risk {
  const lowerTool = request.tool.toLowerCase();
  if (lowerTool === "websearch") return "LOW";
  if (lowerTool === "webfetch") return webFetchRisk(request);
  if (request.operation === "write") return writeRisk(request);
  if (request.operation === "read") return "LOW";
  const command = typeof request.input.command === "string" ? request.input.command : undefined;
  if (!command) return "REVIEW";
  const segments = request.commandSegments ?? parseCommandSegments(command);
  if (request.networkTargets?.length) return "HARD";
  if (segments.some((segment) =>
    deleteExecutables.has(segment.executable)
    || invocationUsesNetwork(segment)
    || invocationHasExternalSideEffect(segment)
  )) return "HARD";
  return "LOW";
}
