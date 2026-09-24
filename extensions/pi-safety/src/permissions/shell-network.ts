/**
 * Network-effect detection for shell commands and the host names a command
 * would contact. Authorization itself happens at the sandbox connection
 * boundary, not here.
 */
import { isIP } from "node:net";
import { normalizeNetworkHost } from "../network-host.ts";
import {
  analyzeShellGitNetwork,
  gitInvocationUsesNetwork,
  parseGitInvocation,
} from "./git-network.ts";
import type { CommandSegment } from "./rules.ts";
import { parseCommandSegments } from "./shell-segment.ts";

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

export function invocationUsesNetwork(segment: CommandSegment): boolean {
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
