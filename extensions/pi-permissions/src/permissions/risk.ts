import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { isIP } from "node:net";
import type { CommandSegment, PermissionRequest } from "./rules.ts";

export type Risk = "LOW" | "REVIEW" | "HARD";
export type { CommandSegment, PermissionRequest } from "./rules.ts";

const readOnlyGitSubcommands = new Set(["status", "diff", "log", "show", "rev-parse"]);
const shellExecutables = new Set(["bash", "sh", "zsh", "fish", "dash"]);
const networkExecutables = new Set(["curl", "wget", "ssh", "scp", "ftp", "nc", "ncat"]);

interface ShellScan {
  segments: string[];
  ambiguous: boolean;
}

function splitCommand(command: string): ShellScan {
  const segments: string[] = [];
  let current = "";
  let quote: "single" | "double" | "ansi" | undefined;
  let ambiguous = false;
  const push = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote === "single") {
      current += character;
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === "ansi") {
      current += character;
      if (character === "\\" && index + 1 < command.length) current += command[++index]!;
      else if (character === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      current += character;
      if (character === '"') quote = undefined;
      else if (character === "\\" && ["$", "`", '"', "\\", "\n"].includes(command[index + 1] ?? "")) current += command[++index]!;
      continue;
    }
    if (character === "\\") {
      current += character;
      if (index + 1 < command.length) current += command[++index]!;
      else ambiguous = true;
      continue;
    }
    if (character === "$" && command[index + 1] === "'") {
      quote = "ansi";
      ambiguous = true;
      current += "'";
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character === "'" ? "single" : "double";
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
  return { segments, ambiguous: ambiguous || quote !== undefined };
}

function hasUnquotedRedirect(source: string): boolean {
  let quote: "single" | "double" | "ansi" | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote === "single") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === "ansi") {
      if (character === "\\") index += 1;
      else if (character === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = undefined;
      else if (character === "\\" && ["$", "`", '"', "\\", "\n"].includes(source[index + 1] ?? "")) index += 1;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "$" && source[index + 1] === "'") { quote = "ansi"; index += 1; continue; }
    if (character === "'" || character === '"') {
      quote = character === "'" ? "single" : "double";
      continue;
    }
    if (character === ">" || character === "<") return true;
  }
  return false;
}

function tokenizeCookedWords(source: string): { words: string[]; ambiguous: boolean } {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "single" | "double" | "ansi" | undefined;
  let ambiguous = false;
  const push = () => {
    if (inWord) words.push(current);
    current = "";
    inWord = false;
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else current += character;
      continue;
    }
    if (quote === "ansi") {
      if (character === "'") quote = undefined;
      else if (character === "\\" && index + 1 < source.length) current += source[++index]!;
      else current += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = undefined;
      else if (character === "\\" && ["$", "`", '"', "\\", "\n"].includes(source[index + 1] ?? "")) current += source[++index]!;
      else {
        if (character === "$") ambiguous = true;
        current += character;
      }
      continue;
    }
    if (/\s/.test(character)) {
      push();
      continue;
    }
    inWord = true;
    if (character === "\\") {
      if (index + 1 >= source.length) ambiguous = true;
      else current += source[++index]!;
      continue;
    }
    if (character === "$" && source[index + 1] === "'") {
      quote = "ansi";
      ambiguous = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character === "'" ? "single" : "double";
      continue;
    }
    if (character === "$") ambiguous = true;
    current += character;
  }
  push();
  return { words, ambiguous: ambiguous || quote !== undefined };
}

function parseSegment(source: string, ambiguous = false): CommandSegment {
  const cooked = tokenizeCookedWords(source);
  const executable = basename(cooked.words[0] ?? "");
  const args = cooked.words.slice(1);
  return {
    source,
    executable,
    args,
    hasRedirect: hasUnquotedRedirect(source),
    hasSubstitution: /\$\(|`/.test(source),
    nestedShell: ambiguous || cooked.ambiguous || shellExecutables.has(executable) || /(?:^|\s)-c(?:\s|$)/.test(source),
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
  const scan = command ? splitCommand(command) : undefined;
  const commandSegments = scan?.segments.map((segment) => parseSegment(segment, scan.ambiguous));
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
  if (isIP(lower) === 6) {
    const firstHextet = Number.parseInt(lower.split(":")[0] ?? "", 16);
    return lower.startsWith("fc") || lower.startsWith("fd") || (firstHextet >= 0xfe80 && firstHextet <= 0xfebf);
  }
  if (isIP(lower) !== 4) return false;
  const [first, second] = lower.split(".").map(Number);
  return first === 0 || first === 10 || first === 127 || first === 169 && second === 254 || first === 192 && second === 168 || first === 172 && second >= 16 && second <= 31;
}

function isSafeGitArgument(subcommand: string, argument: string, index: number): boolean {
  const value = argument;
  if (!value.startsWith("-")) return true;
  if (["--ext-diff", "--textconv", "--no-pager"].includes(value)) return value === "--no-pager";
  if (/helper|filter|pager/i.test(value)) return false;
  const shared = new Set(["--", "--stat", "--name-only", "--name-status", "--summary", "--patch", "-p", "--no-patch", "-s", "--cached", "--staged", "--quiet", "--exit-code", "--check"]);
  if (shared.has(value)) return true;
  if (subcommand === "status") return ["--short", "-s", "--branch", "-b", "--ignored", "--untracked-files", "--no-renames", "--porcelain"].includes(value) || value.startsWith("--porcelain=") || value.startsWith("--untracked-files=");
  if (subcommand === "log") return ["--oneline", "--decorate", "--graph", "--all", "-n"].includes(value) || /^-\d+$/.test(value) || value.startsWith("--max-count=") || value.startsWith("--since=") || value.startsWith("--until=") || value.startsWith("--author=");
  if (subcommand === "rev-parse") return ["--show-toplevel", "--is-inside-work-tree", "--git-dir", "--abbrev-ref", "--verify"].includes(value) || (index > 0 && !value.startsWith("--"));
  return false;
}

function hasOnlySafeOptions(args: string[], safeOptions: Set<string>, safePrefixes: string[] = [], shortOptionPattern?: RegExp): boolean {
  let pathsOnly = false;
  return args.every((argument) => {
    if (pathsOnly) return true;
    if (argument === "--") {
      pathsOnly = true;
      return true;
    }
    if (!argument.startsWith("-")) return true;
    return safeOptions.has(argument) || safePrefixes.some((prefix) => argument.startsWith(prefix)) || shortOptionPattern?.test(argument) === true;
  });
}

function isSafeRg(args: string[]): boolean {
  if (!args.includes("--no-config")) return false;
  const safeOptions = new Set(["--no-config", "-n", "-i", "-F", "-E", "-G", "-v", "-w", "-x", "-l", "-c", "-o", "-S", "-s", "-u", "--files", "--hidden", "--no-ignore", "--line-number", "--ignore-case", "--fixed-strings", "--extended-regexp", "--glob-case-insensitive"]);
  return hasOnlySafeOptions(args, safeOptions, ["--glob=", "--type="]);
}

function isSafeReadOnlyCommand(segment: CommandSegment): boolean {
  const options: Record<string, { allowed: Set<string>; prefixes?: string[]; shortOptionPattern?: RegExp }> = {
    cat: { allowed: new Set(["-n", "-b", "-s", "-A", "-e", "-E", "-T", "-v", "--number", "--number-nonblank", "--squeeze-blank", "--show-all", "--show-ends", "--show-tabs", "--show-nonprinting"]) },
    head: { allowed: new Set(["-q", "-v", "--quiet", "--verbose"]), prefixes: ["-n", "-c", "--lines=", "--bytes="] },
    tail: { allowed: new Set(["-q", "-v", "-f", "--quiet", "--verbose", "--follow"]), prefixes: ["-n", "-c", "--lines=", "--bytes="] },
    wc: { allowed: new Set(["-c", "-m", "-l", "-w", "-L", "--bytes", "--chars", "--lines", "--words", "--max-line-length"]) },
    ls: { allowed: new Set(["-a", "-A", "-l", "-h", "-t", "-r", "-S", "-R", "-d", "-1", "-C", "-x", "-F", "-p", "--all", "--almost-all", "--long", "--human-readable", "--recursive", "--directory", "--classify", "--indicator-style=classify"]), prefixes: ["--color="], shortOptionPattern: /^-[aAlhtrSRd1CxFp]+$/ },
    grep: { allowed: new Set(["-n", "-i", "-r", "-R", "-E", "-F", "-G", "-v", "-l", "-L", "-c", "-w", "-x", "-q", "-s", "-H", "-h", "--line-number", "--ignore-case", "--recursive", "--dereference-recursive", "--extended-regexp", "--fixed-strings", "--basic-regexp", "--invert-match", "--files-with-matches", "--files-without-match", "--count", "--word-regexp", "--line-regexp", "--quiet", "--no-messages"]), prefixes: ["--include=", "--exclude=", "--color="], shortOptionPattern: /^-[niRrEFGvlLcwxsHh]+$/ },
  };
  if (segment.executable === "pwd") return segment.args.length === 0 || hasOnlySafeOptions(segment.args, new Set(["-L", "-P", "--logical", "--physical"]));
  if (segment.executable === "rg") return isSafeRg(segment.args);
  const policy = options[segment.executable];
  return policy ? hasOnlySafeOptions(segment.args, policy.allowed, policy.prefixes, policy.shortOptionPattern) : false;
}

function readOnlySegment(segment: CommandSegment): boolean {
  if (segment.hasRedirect || segment.hasSubstitution || segment.nestedShell) return false;
  if (isSafeReadOnlyCommand(segment)) return true;
  return segment.executable === "git"
    && readOnlyGitSubcommands.has(segment.args[0] ?? "")
    && segment.args.slice(1).every((argument, index) => isSafeGitArgument(segment.args[0]!, argument, index));
}

function isSecretPath(value: string): boolean {
  const path = value.replace(/^@/, "");
  const parts = path.split(/[\\/]/);
  const name = parts.at(-1) ?? "";
  return name.startsWith(".env") || name.endsWith(".pem") || name.endsWith(".key") || parts.some((part) => [".ssh", ".aws", ".gnupg"].includes(part));
}

function secretRedirectSource(source: string): boolean {
  return [...source.matchAll(/<\s*("[^"]*"|'[^']*'|[^\s;|&]+)/g)].some((match) => isSecretPath(tokenizeCookedWords(match[1] ?? "").words[0] ?? ""));
}

function isNetworkSink(segment: CommandSegment): boolean {
  return networkExecutables.has(segment.executable);
}

function exfiltratesSecret(segments: CommandSegment[]): boolean {
  const secretSegment = (segment: CommandSegment) => segment.args.some(isSecretPath) || secretRedirectSource(segment.source);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (isNetworkSink(segment) && secretSegment(segment)) return true;
    if (secretSegment(segment) && segments.slice(index + 1).some(isNetworkSink)) return true;
  }
  return false;
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
    return forced && args.some((argument) => /(?:^|[:/+])(main|master)$/.test(argument));
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
  if (exfiltratesSecret(segments)) return true;
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
