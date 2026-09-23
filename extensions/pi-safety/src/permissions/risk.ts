import { isIP } from "node:net";
import { basename, resolve } from "node:path";
import { defaultSafetyConfigPath, resolvePolicyPath } from "../filesystem-policy.ts";
import {
  isPublicNetworkHost,
  normalizeNetworkHost,
  parseGitRemoteTarget,
} from "../network-host.ts";
import { assignmentName, isDangerousWords } from "./dangerous-commands.ts";
import { isPathWithin } from "./paths.ts";
import type { CommandSegment, PermissionRequest } from "./rules.ts";

export type Risk = "LOW" | "REVIEW" | "HARD";
export type { CommandSegment, PermissionRequest } from "./rules.ts";
export { isPublicNetworkHost };

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
const shellExecutables = new Set(["bash", "sh", "zsh", "fish", "dash"]);
const gitNetworkSubcommands = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);
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
  let quote: "'" | '"' | undefined;
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
    if (character === "'" || character === '"') {
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
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const flush = (): void => {
    if (tokenStarted) words.push(current);
    current = "";
    tokenStarted = false;
  };
  for (const character of source) {
    if (escaped) {
      current += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      tokenStarted = true;
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else {
        current += character;
        tokenStarted = true;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      tokenStarted = true;
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    current += character;
    tokenStarted = true;
  }
  flush();
  return words;
}

interface ExecutableContext {
  index: number;
  safe: boolean;
  direct: boolean;
}

function isUnsafeGitContextVariable(name: string): boolean {
  return name === "PATH" || name.startsWith("GIT_");
}

function executableContext(words: readonly string[]): ExecutableContext {
  let index = 0;
  let safe = true;
  let direct = true;
  while (index < words.length) {
    const name = assignmentName(words[index] ?? "");
    if (!name) break;
    if (isUnsafeGitContextVariable(name)) safe = false;
    index += 1;
    direct = false;
  }
  while (index < words.length) {
    const wrapperToken = words[index] ?? "";
    const wrapper = basename(wrapperToken).toLowerCase();
    if (wrapper === "command" || wrapper === "builtin" || wrapper === "nohup") {
      safe = safe && isTrustedExecutableToken(wrapperToken, wrapper);
      index += 1;
      direct = false;
      while (index < words.length && words[index]?.startsWith("-")) {
        if (words[index] === "-p") safe = false;
        index += 1;
      }
      continue;
    }
    if (wrapper === "env") {
      safe = safe && isTrustedExecutableToken(wrapperToken, wrapper);
      index += 1;
      direct = false;
      while (index < words.length) {
        const token = words[index] ?? "";
        const name = assignmentName(token);
        if (name) {
          if (isUnsafeGitContextVariable(name)) safe = false;
          index += 1;
          continue;
        }
        if (token === "--") {
          index += 1;
          break;
        }
        if (token === "-u" || token === "--unset") {
          const unsetName = words[index + 1];
          if (!unsetName || isUnsafeGitContextVariable(unsetName)) safe = false;
          index += 2;
          continue;
        }
        if (token.startsWith("--unset=")) {
          if (isUnsafeGitContextVariable(token.slice("--unset=".length))) safe = false;
          index += 1;
          continue;
        }
        if (
          token === "-C" ||
          token === "--chdir" ||
          token.startsWith("--chdir=") ||
          token === "-i" ||
          token === "--ignore-environment"
        ) {
          safe = false;
          index += token === "-C" || token === "--chdir" ? 2 : 1;
          continue;
        }
        if (token.startsWith("-")) {
          safe = false;
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (wrapper !== "sudo") break;
    safe = safe && isTrustedExecutableToken(wrapperToken, wrapper);
    index += 1;
    direct = false;
    while (index < words.length) {
      const token = words[index] ?? "";
      if (token === "-u" || token === "-g" || token === "-h" || token === "-p") {
        index += 2;
        continue;
      }
      if (token === "-C" || token === "--chdir" || token.startsWith("--chdir=")) {
        safe = false;
        index += token === "-C" || token === "--chdir" ? 2 : 1;
        continue;
      }
      if (new Set(["-n", "-S", "-H", "-k", "-K", "-b"]).has(token)) {
        index += 1;
        continue;
      }
      if (token.startsWith("-")) {
        safe = false;
        index += 1;
        continue;
      }
      break;
    }
  }
  return { index, safe, direct };
}

function isTrustedExecutableToken(token: string, executable: string): boolean {
  return (
    token === executable || token === `/usr/bin/${executable}` || token === `/bin/${executable}`
  );
}

interface ShellSyntax {
  hasExecutableSubstitution: boolean;
  hasActiveRedirect: boolean;
  hasActiveControl: boolean;
}

function scanShellSyntax(source: string): ShellSyntax {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let hasExecutableSubstitution = false;
  let hasActiveRedirect = false;
  let hasActiveControl = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    const isBashAlternateCommandSubstitution =
      character === "$" &&
      source[index + 1] === "{" &&
      (/\s/.test(source[index + 2] ?? "") || source[index + 2] === "|");
    if (
      character === "`" ||
      (character === "$" && source[index + 1] === "(") ||
      isBashAlternateCommandSubstitution
    ) {
      hasExecutableSubstitution = true;
    }
    if (quote === undefined && (character === "<" || character === ">")) {
      hasActiveRedirect = true;
    }
    if (
      quote === undefined &&
      (character === "&" ||
        character === ";" ||
        character === "|" ||
        character === "\n" ||
        character === "(" ||
        character === ")")
    ) {
      hasActiveControl = true;
    }
  }
  return { hasExecutableSubstitution, hasActiveRedirect, hasActiveControl };
}

function parseCommandSegment(source: string): CommandSegment {
  const words = shellWords(source);
  const context = executableContext(words);
  const { index } = context;
  const executableToken = words[index] ?? "";
  const executable = basename(executableToken).toLowerCase();
  const args = words.slice(index + 1);
  const syntax = scanShellSyntax(source);
  const commandIndex = args.findIndex(
    (arg) => arg === "--command" || /^-[a-z]*c[a-z]*$/i.test(arg),
  );
  return {
    source,
    executableToken,
    executable,
    executableTrusted: context.safe && isTrustedExecutableToken(executableToken, executable),
    directExecutable: context.direct,
    args,
    hasRedirect: syntax.hasActiveRedirect,
    hasSubstitution: syntax.hasExecutableSubstitution,
    nestedShell: shellExecutables.has(executable) && commandIndex >= 0,
  };
}

export function parseCommandSegments(command: string): CommandSegment[] {
  const segments = splitShellSegments(command).map(parseCommandSegment);
  const nested = segments.flatMap((segment) => {
    if (!shellExecutables.has(segment.executable)) return [];
    const commandIndex = segment.args.findIndex(
      (arg) => arg === "--command" || /^-[a-z]*c[a-z]*$/i.test(arg),
    );
    const nestedCommand = commandIndex >= 0 ? segment.args[commandIndex + 1] : undefined;
    return nestedCommand ? parseCommandSegments(nestedCommand) : [];
  });
  return [...segments, ...nested];
}

function extractedPaths(input: Record<string, unknown>, cwd: string): string[] {
  return ["path", "filePath", "targetPath", "sourcePath"].flatMap((key) => {
    const value = input[key];
    return typeof value === "string" ? [resolvePolicyPath(value, cwd)] : [];
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

export function normalizeToolCall(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): PermissionRequest {
  const command = typeof input.command === "string" ? input.command : undefined;
  const lowerTool = tool.toLowerCase();
  const operation =
    lowerTool === "webfetch"
      ? "network"
      : new Set(["websearch", "read", "search", "grep", "find", "ls"]).has(lowerTool)
        ? "read"
        : ["write", "edit", "apply_patch"].includes(lowerTool)
          ? "write"
          : new Set(["bash", "powershell"]).has(lowerTool) && command
            ? "execute"
            : "external";
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

function normalizeHostToken(value: string): string | undefined {
  let token = value.trim().replace(/^['"]|['"],?$/g, "");
  if (!token) return undefined;
  try {
    if (/^https?:\/\//i.test(token)) return normalizeNetworkHost(new URL(token).hostname);
  } catch {
    return undefined;
  }
  token = token.replace(/^[^@]+@/, "");
  if (token.startsWith("[")) {
    return normalizeNetworkHost(/^\[([^\]]+)\]/.exec(token)?.[1] ?? "");
  }
  token = token.replace(/:.*$/, "");
  return normalizeNetworkHost(token);
}

type GitRemotePurpose = "fetch" | "push";

type ParsedGitRemote =
  | { kind: "implicit"; purpose: GitRemotePurpose }
  | { kind: "host"; purpose: GitRemotePurpose; host: string }
  | { kind: "local"; purpose: GitRemotePurpose }
  | { kind: "unsafe"; purpose: GitRemotePurpose; reason: string };

interface GitRemoteOptionGrammar {
  flags: ReadonlySet<string>;
  values: ReadonlySet<string>;
  optionalValues: ReadonlySet<string>;
}

function optionSet(options: string): ReadonlySet<string> {
  return new Set(options.split(/\s+/).filter(Boolean));
}

const gitRemoteOptionGrammar = new Map<string, GitRemoteOptionGrammar>([
  [
    "clone",
    {
      flags: optionSet(
        "--bare --dissociate --ipv4 --ipv6 --local --mirror --no-checkout --no-hardlinks --no-reject-shallow --no-single-branch --no-tags --progress --quiet --reject-shallow --shared --single-branch --sparse --verbose -4 -6 -n -q -s -v",
      ),
      values: optionSet(
        "--branch --config --depth --filter --jobs --origin --reference --reference-if-able --revision --separate-git-dir --server-option --shallow-exclude --shallow-since --template --upload-pack -b -c -j -o -u",
      ),
      optionalValues: optionSet("--recurse-submodules"),
    },
  ],
  [
    "fetch",
    {
      flags: optionSet(
        "--all --append --atomic --auto-maintenance --dry-run --force --ipv4 --ipv6 --keep --multiple --no-auto-maintenance --no-recurse-submodules --no-tags --prune --prune-tags --quiet --show-forced-updates --tags --update-head-ok --verbose --write-commit-graph -4 -6 -a -f -k -p -q -t -v",
      ),
      values: optionSet(
        "--deepen --depth --filter --jobs --negotiation-tip --refmap --server-option --shallow-exclude --shallow-since --submodule-prefix --upload-pack -j -o -u",
      ),
      optionalValues: optionSet("--recurse-submodules"),
    },
  ],
  [
    "pull",
    {
      flags: optionSet(
        "--all --autostash --ff --ff-only --force --no-autostash --no-commit --no-edit --no-ff --no-rebase --no-stat --no-tags --prune --quiet --signoff --stat --tags --verbose -f -n -q -r -s -v",
      ),
      values: optionSet(
        "--cleanup --depth --gpg-sign --jobs --server-option --strategy --strategy-option --upload-pack -j -S -s -u -X",
      ),
      optionalValues: optionSet("--rebase"),
    },
  ],
  [
    "push",
    {
      flags: optionSet(
        "--all --atomic --delete --dry-run --follow-tags --force --force-if-includes --ipv4 --ipv6 --mirror --no-thin --no-verify --porcelain --prune --quiet --set-upstream --tags --thin --verbose -4 -6 -f -n -q -u -v",
      ),
      values: optionSet("--exec --push-option --receive-pack --repo -o"),
      optionalValues: optionSet("--force-with-lease --signed"),
    },
  ],
  [
    "ls-remote",
    {
      flags: optionSet(
        "--branches --exit-code --get-url --heads --quiet --refs --symref --tags -q",
      ),
      values: optionSet("--sort --upload-pack -u"),
      optionalValues: new Set(),
    },
  ],
]);

const safeGitGlobalOptions = new Set([
  "--no-pager",
  "--paginate",
  "-p",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
  "--no-lazy-fetch",
  "--no-advice",
]);
const unsafeGitGlobalValueOptions = new Set([
  "-c",
  "-C",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);
const recognizedGitSubcommands = new Set([...gitNetworkSubcommands, "config", "submodule"]);

interface GitInvocation {
  segment: CommandSegment;
  kind: "git" | "gh";
  subcommand?: string;
  arguments: string[];
  globalOptionsSafe: boolean;
  trusted: boolean;
}

function relevantGitSubcommandIndex(args: readonly string[], start: number): number | undefined {
  for (let index = start; index < args.length; index += 1) {
    if (recognizedGitSubcommands.has((args[index] ?? "").toLowerCase())) return index;
  }
  return undefined;
}

function parseGitSubcommand(args: readonly string[]): {
  index?: number;
  safe: boolean;
} {
  let index = 0;
  let safe = true;
  while (index < args.length) {
    const token = args[index] ?? "";
    if (token === "--") {
      const candidate = args[index + 1];
      return candidate ? { index: index + 1, safe } : { safe: false };
    }
    if (!token.startsWith("-") || token === "-") return { index, safe };
    if (safeGitGlobalOptions.has(token)) {
      index += 1;
      continue;
    }
    const optionName = token.split("=", 1)[0] ?? token;
    if (
      unsafeGitGlobalValueOptions.has(optionName) ||
      token.startsWith("-c") ||
      token.startsWith("-C")
    ) {
      safe = false;
      const hasAttachedValue =
        token.includes("=") ||
        (token.length > 2 && (token.startsWith("-c") || token.startsWith("-C")));
      index += hasAttachedValue ? 1 : 2;
      continue;
    }
    safe = false;
    const candidate = relevantGitSubcommandIndex(args, index + 1);
    return candidate === undefined ? { safe } : { index: candidate, safe };
  }
  return { safe };
}

function parseGitInvocation(segment: CommandSegment): GitInvocation | undefined {
  if (segment.executable !== "git" && segment.executable !== "gh") return undefined;
  if (segment.executable === "gh") {
    const positional = segment.args.filter((argument) => !argument.startsWith("-"));
    return {
      segment,
      kind: "gh",
      subcommand: positional[0]?.toLowerCase(),
      arguments: positional.slice(1),
      globalOptionsSafe: true,
      trusted: segment.executableTrusted,
    };
  }
  const parsed = parseGitSubcommand(segment.args);
  const subcommand =
    parsed.index === undefined ? undefined : segment.args[parsed.index]?.toLowerCase();
  const commandArguments = parsed.index === undefined ? [] : segment.args.slice(parsed.index + 1);
  return {
    segment,
    kind: "git",
    subcommand,
    arguments: commandArguments,
    globalOptionsSafe: parsed.safe,
    trusted: segment.executableTrusted,
  };
}

function parsedGitInvocations(command: string): GitInvocation[] {
  return parseCommandSegments(command).flatMap((segment) => {
    const invocation = parseGitInvocation(segment);
    return invocation ? [invocation] : [];
  });
}

function gitInvocationUsesNetwork(invocation: GitInvocation): boolean {
  if (invocation.kind !== "git" || !invocation.subcommand) return false;
  return (
    gitNetworkSubcommands.has(invocation.subcommand) ||
    (invocation.subcommand === "submodule" &&
      invocation.arguments.some((argument) => argument === "add" || argument === "update"))
  );
}

function remotePurpose(invocation: GitInvocation): GitRemotePurpose {
  return invocation.subcommand === "push" ? "push" : "fetch";
}

function classifyGitRemoteOperand(operand: string, purpose: GitRemotePurpose): ParsedGitRemote {
  const explicit =
    operand.startsWith("/") ||
    operand.startsWith("./") ||
    operand.startsWith("../") ||
    operand.startsWith("~/") ||
    operand.includes("/") ||
    operand.includes(":");
  if (!explicit) return { kind: "implicit", purpose };
  const target = parseGitRemoteTarget(operand);
  if (target.kind === "host") return { kind: "host", purpose, host: target.host };
  if (target.kind === "local") return { kind: "local", purpose };
  return { kind: "unsafe", purpose, reason: target.reason };
}

const gitSubmoduleAddFlags = optionSet("--dissociate --force --progress --quiet -f -q");
const gitSubmoduleAddValueOptions = optionSet(
  "--branch --depth --name --reference --ref-format -b",
);

function parseGitSubmoduleAddRemote(
  args: readonly string[],
  purpose: GitRemotePurpose,
): ParsedGitRemote {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (token === "--") {
      const operand = args[index + 1];
      return operand
        ? classifyGitRemoteOperand(operand, purpose)
        : { kind: "unsafe", purpose, reason: "missing Git submodule remote operand" };
    }
    if (!token.startsWith("-") || token === "-") {
      return classifyGitRemoteOperand(token, purpose);
    }
    const equals = token.indexOf("=");
    const option = equals < 0 ? token : token.slice(0, equals);
    if (gitSubmoduleAddFlags.has(option)) {
      if (equals >= 0) {
        return { kind: "unsafe", purpose, reason: "malformed Git submodule option" };
      }
      continue;
    }
    if (gitSubmoduleAddValueOptions.has(option)) {
      const value = equals >= 0 ? token.slice(equals + 1) : args[index + 1];
      if (!value) {
        return { kind: "unsafe", purpose, reason: "missing Git submodule option value" };
      }
      if (equals < 0) index += 1;
      continue;
    }
    const shortOptionWithValue = [...gitSubmoduleAddValueOptions].find(
      (candidate) =>
        candidate.startsWith("-") &&
        !candidate.startsWith("--") &&
        token.startsWith(candidate) &&
        token.length > candidate.length,
    );
    if (shortOptionWithValue) continue;
    if (
      /^-[A-Za-z]+$/.test(token) &&
      [...token.slice(1)].every((character) => gitSubmoduleAddFlags.has(`-${character}`))
    ) {
      continue;
    }
    return { kind: "unsafe", purpose, reason: "unrecognized Git submodule option" };
  }
  return { kind: "unsafe", purpose, reason: "missing Git submodule remote operand" };
}

function parsedGitRemotes(invocation: GitInvocation): ParsedGitRemote[] {
  if (!gitInvocationUsesNetwork(invocation)) return [];
  const purpose = remotePurpose(invocation);
  if (!invocation.trusted) {
    return [{ kind: "unsafe", purpose, reason: "untrusted Git executable or wrapper context" }];
  }
  if (!invocation.globalOptionsSafe) {
    return [{ kind: "unsafe", purpose, reason: "unsafe Git global option" }];
  }
  const subcommand = invocation.subcommand ?? "";
  if (subcommand === "submodule") {
    const actionIndex = invocation.arguments.findIndex(
      (argument) => argument === "add" || argument === "update",
    );
    if (actionIndex < 0) return [];
    if (invocation.arguments[actionIndex] === "update") {
      return [{ kind: "implicit", purpose }];
    }
    return [parseGitSubmoduleAddRemote(invocation.arguments.slice(actionIndex + 1), purpose)];
  }

  const grammar = gitRemoteOptionGrammar.get(subcommand);
  const noValueOptions = grammar?.flags ?? new Set<string>();
  const valueOptions = grammar?.values ?? new Set<string>();
  const optionalValueOptions = grammar?.optionalValues ?? new Set<string>();
  let repositoryOption: string | undefined;
  let multipleFetch = false;
  const multipleFetchOperands: string[] = [];
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const token = invocation.arguments[index] ?? "";
    if (token === "--") {
      if (repositoryOption) return [classifyGitRemoteOperand(repositoryOption, purpose)];
      const operands = invocation.arguments.slice(index + 1);
      if (multipleFetch) {
        return operands.length > 0
          ? operands.map((operand) => classifyGitRemoteOperand(operand, purpose))
          : [{ kind: "unsafe", purpose, reason: "missing Git remote operand" }];
      }
      const operand = operands[0];
      return operand
        ? [classifyGitRemoteOperand(operand, purpose)]
        : [{ kind: "unsafe", purpose, reason: "missing Git remote operand" }];
    }
    if (!token.startsWith("-") || token === "-") {
      if (repositoryOption) return [classifyGitRemoteOperand(repositoryOption, purpose)];
      if (multipleFetch) {
        multipleFetchOperands.push(token);
        continue;
      }
      return [classifyGitRemoteOperand(token, purpose)];
    }
    const equals = token.indexOf("=");
    const option = equals < 0 ? token : token.slice(0, equals);
    if (optionalValueOptions.has(option)) {
      if (equals >= 0 && token.slice(equals + 1).length === 0) {
        return [{ kind: "unsafe", purpose, reason: "missing Git remote option value" }];
      }
      continue;
    }
    if (noValueOptions.has(option)) {
      if (equals >= 0) {
        return [{ kind: "unsafe", purpose, reason: "malformed Git remote option" }];
      }
      if (subcommand === "fetch" && option === "--multiple") multipleFetch = true;
      continue;
    }
    if (valueOptions.has(option)) {
      const value = equals >= 0 ? token.slice(equals + 1) : invocation.arguments[index + 1];
      if (!value) return [{ kind: "unsafe", purpose, reason: "missing Git remote option value" }];
      if (equals < 0) index += 1;
      if (option === "--repo") repositoryOption = value;
      continue;
    }
    const shortOptionWithValue = [...valueOptions].find(
      (candidate) =>
        candidate.startsWith("-") &&
        !candidate.startsWith("--") &&
        token.startsWith(candidate) &&
        token.length > candidate.length,
    );
    if (shortOptionWithValue) continue;
    if (
      /^-[A-Za-z]+$/.test(token) &&
      [...token.slice(1)].every((character) => noValueOptions.has(`-${character}`))
    ) {
      continue;
    }
    return [{ kind: "unsafe", purpose, reason: "unrecognized Git remote option" }];
  }
  if (repositoryOption) return [classifyGitRemoteOperand(repositoryOption, purpose)];
  if (multipleFetch) {
    return multipleFetchOperands.length > 0
      ? multipleFetchOperands.map((operand) => classifyGitRemoteOperand(operand, purpose))
      : [{ kind: "unsafe", purpose, reason: "missing Git remote operand" }];
  }
  if (subcommand === "push" || subcommand === "fetch" || subcommand === "pull") {
    return [{ kind: "implicit", purpose }];
  }
  return [{ kind: "unsafe", purpose, reason: "missing Git remote operand" }];
}

export interface ShellGitNetworkAnalysis {
  usesImplicitNetwork: boolean;
  directImplicitPurpose?: GitRemotePurpose;
  explicitHosts: string[];
  unsafeReason?: string;
}

export function analyzeShellGitNetwork(command: string): ShellGitNetworkAnalysis {
  const segments = parseCommandSegments(command);
  const syntax = scanShellSyntax(command);
  const remotes = parsedGitInvocations(command).flatMap((invocation) => {
    return parsedGitRemotes(invocation).map((remote) => ({ invocation, remote }));
  });
  const unsafeReason = remotes.find(({ remote }) => remote.kind === "unsafe")?.remote;
  const direct = remotes.length === 1 ? remotes[0] : undefined;
  const directImplicitPurpose =
    segments.length === 1 &&
    direct?.remote.kind === "implicit" &&
    !syntax.hasActiveControl &&
    !direct.invocation.segment.hasRedirect &&
    !direct.invocation.segment.hasSubstitution &&
    !direct.invocation.segment.nestedShell
      ? direct.remote.purpose
      : undefined;
  return {
    usesImplicitNetwork: remotes.some(({ remote }) => remote.kind === "implicit"),
    ...(directImplicitPurpose ? { directImplicitPurpose } : {}),
    explicitHosts: remotes.flatMap(({ remote }) => (remote.kind === "host" ? [remote.host] : [])),
    ...(unsafeReason?.kind === "unsafe" ? { unsafeReason: unsafeReason.reason } : {}),
  };
}

function invocationUsesNetwork(segment: CommandSegment): boolean {
  const args = segment.args.map((arg) => arg.toLowerCase());
  if (directNetworkExecutables.has(segment.executable)) {
    return !args.some((arg) => arg === "--version" || arg === "--help");
  }
  if (segment.executable === "gh") {
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    return (
      subcommand !== undefined &&
      !new Set(["alias", "completion", "config", "help", "version"]).has(subcommand)
    );
  }
  if (
    new Set(["node", "nodejs", "python", "python3", "ruby", "php", "deno"]).has(segment.executable)
  ) {
    return /\b(?:fetch|axios|https?\.request|requests\.|urllib|httpx|aiohttp|socket)\b/i.test(
      segment.source,
    );
  }
  if (segment.executable === "git") {
    const invocation = parseGitInvocation(segment);
    return invocation ? gitInvocationUsesNetwork(invocation) : false;
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
  return analyzeShellGitNetwork(command).usesImplicitNetwork;
}

export function shellCommandUsesDirectImplicitGitPush(command: string): boolean {
  return analyzeShellGitNetwork(command).directImplicitPurpose === "push";
}

export function extractShellNetworkHosts(command: string): string[] {
  const gitNetwork = analyzeShellGitNetwork(command);
  const hosts = new Set<string>(gitNetwork.explicitHosts);
  const segments = parseCommandSegments(command);
  for (const segment of segments) {
    if (
      !invocationUsesNetwork(segment) ||
      segment.executable === "git" ||
      segment.executable === "gh"
    )
      continue;
    for (const match of segment.source.matchAll(/https?:\/\/[^\s"'`<>]+/gi)) {
      const host = normalizeHostToken(match[0]);
      if (host) hosts.add(host.toLowerCase());
    }
  }

  for (const segment of segments) {
    if (!invocationUsesNetwork(segment)) continue;
    if (segment.executable === "git") continue;
    if (segment.executable === "gh") {
      hosts.add("api.github.com");
      hosts.add("github.com");
      hosts.add("uploads.github.com");
      continue;
    }
    if (new Set(["npm", "pnpm", "yarn", "bun", "npx", "pnpx", "bunx"]).has(segment.executable)) {
      hosts.add("registry.npmjs.org");
    }
    if (
      !directNetworkExecutables.has(segment.executable) &&
      segment.executable !== "git" &&
      segment.executable !== "gh"
    )
      continue;
    for (const token of segment.args) {
      if (token.startsWith("-")) continue;
      const remoteLike =
        /^https?:\/\//i.test(token) ||
        token.includes("@") ||
        (segment.executable === "scp" && token.includes(":")) ||
        token.includes(".") ||
        isIP(token.replace(/:.*$/, "")) !== 0;
      if (!remoteLike) continue;
      const host = normalizeHostToken(token);
      if (host) hosts.add(host.toLowerCase());
    }
    const positional = segment.args.filter((token) => !token.startsWith("-"));
    const implicitHost =
      segment.executable === "ssh" || segment.executable === "sftp"
        ? positional.at(-1)
        : segment.executable === "ftp" ||
            segment.executable === "nc" ||
            segment.executable === "ncat"
          ? positional[0]
          : undefined;
    const normalizedImplicitHost = implicitHost ? normalizeHostToken(implicitHost) : undefined;
    if (normalizedImplicitHost) hosts.add(normalizedImplicitHost.toLowerCase());
  }
  return [...hosts];
}

function webFetchRisk(request: PermissionRequest): Risk {
  const value = request.input.url;
  if (typeof value !== "string" || value.trim() === "" || request.networkTargets?.length !== 1)
    return "HARD";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "HARD";
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname)
    return "HARD";
  return isPublicNetworkHost(parsed.hostname) ? "LOW" : "HARD";
}

function writeRisk(
  request: PermissionRequest,
  approvedWriteRoots: string[],
  protectedWritePaths: readonly string[] = [defaultSafetyConfigPath()],
  workspaceWriteRoots: readonly string[] = [request.cwd],
): Risk {
  if (
    request.resolvedPaths.some((path) =>
      protectedWritePaths.some((control) => path === control || isPathWithin(path, control)),
    )
  ) {
    return "HARD";
  }
  const roots = [...workspaceWriteRoots, ...approvedWriteRoots];
  return request.resolvedPaths.length > 0 &&
    request.resolvedPaths.every((path) => roots.some((root) => isPathWithin(path, root)))
    ? "LOW"
    : "REVIEW";
}

/**
 * Shell reserved words: syntax, never real executables. A segment that begins
 * with one (e.g. `do rm -f /`, `then rm --force x`, `{ rm -f /`) has its real
 * command hidden behind control-flow / brace structure the char segmenter did
 * not reduce. Stripping these surfaces the hidden argv for the danger check
 * (approximating codex's AST descent into control-flow clauses) without over-matching,
 * since no binary is named `do`/`then`/`{`.
 */
const SHELL_RESERVED_WORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "for",
  "case",
  "esac",
  "select",
  "{",
  "}",
  "!",
  "time",
]);

/**
 * Codex-aligned dangerous-command check for one parsed segment. Leading
 * control-flow keywords and any assignment/wrapper hidden behind them are
 * reduced first, so the check always sees the real executable; `trap` actions
 * are shell code and are expanded and checked recursively. `bash -lc` bodies
 * are already expanded into their own segments by parseCommandSegments, so
 * nested `rm -f` is caught at the top level. Approximates codex's AST descent
 * into control-flow clauses via char segmentation + keyword reduction.
 */
function isDangerousSegment(segment: CommandSegment): boolean {
  // Reduce past leading control-flow keywords to the real argv first, so a
  // hidden `trap` or assignment/wrapper is judged on its real executable:
  // `do rm -f /` is `rm -f /`; `do trap 'rm -rf x' EXIT` is that trap.
  // Reserved words are never executables, so this cannot over-match; plain
  // sequencing (`cat a; pwd`) is untouched.
  const tokens = [segment.executable, ...segment.args];
  // Index scan (O(n)). The keyword can hide assignments/wrappers (`do FOO=1
  // rm -f x`, `do sudo rm -rf x`), so re-normalize exactly as
  // parseCommandSegment does before judging.
  let start = 0;
  while (start < tokens.length && SHELL_RESERVED_WORDS.has(tokens[start] ?? "")) start += 1;
  const { index } = executableContext(tokens.slice(start));
  const words = tokens.slice(start + index);
  const executable = basename(words[0] ?? "").toLowerCase();
  if (executable === "trap") {
    // words[0] is the `trap` itself, so the action starts at index 1.
    let actionIndex = 1;
    if ((words[actionIndex] ?? "") === "--") actionIndex += 1;
    const action = words[actionIndex];
    if (action === undefined || action.startsWith("-")) return false;
    return parseCommandSegments(action).some(isDangerousSegment);
  }
  return words.length > 0 && isDangerousWords([executable, ...words.slice(1)]);
}

/** Matches Codex's pre-sandbox dangerous-command gate. */
export function shellCommandIsDangerous(command: string): boolean {
  return parseCommandSegments(command).some(isDangerousSegment);
}

/** Deletion commands whose targets are checked against the sandbox write roots. */
export const deletionExecutables = new Set(["rm", "rmdir", "unlink", "shred", "truncate"]);

/**
 * Positional targets of a deletion command, honoring `--` (everything after
 * it is a target, even if it looks like an option).
 */
export function deletionTargets(segment: CommandSegment): string[] {
  const targets: string[] = [];
  let afterDashDash = false;
  for (const arg of segment.args) {
    if (arg === "--") {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && arg.startsWith("-")) continue;
    targets.push(arg);
  }
  return targets;
}

function invocationHasExternalSideEffect(segment: CommandSegment): boolean {
  const args = segment.args.map((arg) => arg.toLowerCase());
  if (segment.executable === "kubectl") {
    return args.some((arg) =>
      new Set(["apply", "create", "delete", "edit", "patch", "replace", "scale", "set"]).has(arg),
    );
  }
  if (segment.executable === "terraform" || segment.executable === "tofu") {
    return args.some((arg) =>
      new Set(["apply", "destroy", "import", "refresh", "taint", "untaint"]).has(arg),
    );
  }
  return new Set(["vercel", "netlify", "wrangler", "flyctl", "heroku"]).has(segment.executable);
}

export function classifyRisk(
  request: PermissionRequest,
  networkApproved = false,
  approvedWriteRoots: string[] = [],
  protectedWritePaths: readonly string[] = [defaultSafetyConfigPath()],
  workspaceWriteRoots: readonly string[] = [request.cwd],
): Risk {
  const lowerTool = request.tool.toLowerCase();
  if (lowerTool === "websearch") return "LOW";
  if (lowerTool === "webfetch") return webFetchRisk(request);
  if (request.operation === "write") {
    return writeRisk(request, approvedWriteRoots, protectedWritePaths, workspaceWriteRoots);
  }
  if (request.operation === "read") return "LOW";
  const command = typeof request.input.command === "string" ? request.input.command : undefined;
  if (!command) return "REVIEW";
  const segments = request.commandSegments ?? parseCommandSegments(command);
  if (!networkApproved && request.networkTargets?.length) return "HARD";
  if (
    segments.some(
      (segment) =>
        isDangerousSegment(segment) ||
        (!networkApproved && invocationUsesNetwork(segment)) ||
        invocationHasExternalSideEffect(segment),
    )
  )
    return "HARD";
  if (
    scanShellSyntax(command).hasExecutableSubstitution ||
    segments.some((segment) => segment.hasSubstitution)
  )
    return "REVIEW";
  return "LOW";
}
