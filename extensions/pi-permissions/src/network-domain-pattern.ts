import { isIP } from "node:net";
import { normalizeNetworkHost } from "./network-host.ts";

interface ParsedNetworkDomainPattern {
  readonly kind: "any" | "wildcard" | "exact";
  readonly host: string;
  readonly port?: number;
}

function parsePort(value: string): number | undefined {
  if (!/^:[1-9][0-9]{0,4}$/.test(value)) return undefined;
  const port = Number(value.slice(1));
  return port <= 65_535 ? port : undefined;
}

function parseHost(value: string): Omit<ParsedNetworkDomainPattern, "port"> | undefined {
  if (value === "*") return { kind: "any", host: "*" };
  if (value.startsWith("*.")) {
    const suffix = normalizeNetworkHost(value.slice(2));
    if (!suffix || isIP(suffix) === 6) return undefined;
    return { kind: "wildcard", host: suffix };
  }
  const host = normalizeNetworkHost(value);
  return host === undefined ? undefined : { kind: "exact", host };
}

/**
 * Parse the small SRT-compatible network pattern language used by this
 * extension. Invalid patterns are deliberately rejected so an unsupported
 * spelling can never widen an effective allow-list.
 */
function parseNetworkDomainPattern(pattern: string): ParsedNetworkDomainPattern | undefined {
  if (typeof pattern !== "string") return undefined;
  const value = pattern.trim();
  if (value.length === 0) return undefined;

  let hostText = value;
  let port: number | undefined;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0 || isIP(value.slice(1, close)) !== 6) return undefined;
    hostText = value.slice(1, close);
    const suffix = value.slice(close + 1);
    if (suffix !== "") {
      port = parsePort(suffix);
      if (port === undefined) return undefined;
    }
  } else {
    const firstColon = value.indexOf(":");
    if (firstColon >= 0 && value.indexOf(":", firstColon + 1) < 0) {
      const parsedPort = parsePort(value.slice(firstColon));
      if (parsedPort === undefined) return undefined;
      hostText = value.slice(0, firstColon);
      port = parsedPort;
    }
  }

  const host = parseHost(hostText);
  return host === undefined ? undefined : { ...host, ...(port === undefined ? {} : { port }) };
}

function formatNetworkDomainPattern(pattern: ParsedNetworkDomainPattern): string {
  const host = pattern.kind === "wildcard" ? `*.${pattern.host}` : pattern.host;
  if (isIP(host) === 6) {
    return pattern.port === undefined ? `[${host}]` : `[${host}]:${pattern.port}`;
  }
  return pattern.port === undefined ? host : `${host}:${pattern.port}`;
}

/** Return a canonical form, or undefined when the pattern is unsupported. */
export function normalizeNetworkDomainPattern(pattern: string): string | undefined {
  const parsed = parseNetworkDomainPattern(pattern);
  return parsed === undefined ? undefined : formatNetworkDomainPattern(parsed);
}

/**
 * Match a host and optional port using the same semantics as the sandbox
 * policy: wildcard entries exclude their apex and never match IP literals.
 */
export function matchesNetworkDomainPattern(pattern: string, host: string, port?: number): boolean {
  const parsed = parseNetworkDomainPattern(pattern);
  if (parsed === undefined) return false;
  if (parsed.port !== undefined && parsed.port !== port) return false;

  const candidate = normalizeNetworkHost(host);
  if (candidate === undefined) return false;
  if (parsed.kind === "any") return true;
  if (parsed.kind === "exact") return candidate === parsed.host;
  return isIP(candidate) === 0 && candidate.endsWith(`.${parsed.host}`);
}

function intersectPorts(
  parent: ParsedNetworkDomainPattern,
  requested: ParsedNetworkDomainPattern,
): number | undefined | false {
  if (parent.port !== undefined && requested.port !== undefined) {
    return parent.port === requested.port ? parent.port : false;
  }
  return parent.port ?? requested.port;
}

function wildcardMatchesExact(wildcard: string, exact: string): boolean {
  return isIP(exact) === 0 && exact.endsWith(`.${wildcard}`);
}

function intersectHosts(
  parent: ParsedNetworkDomainPattern,
  requested: ParsedNetworkDomainPattern,
): Omit<ParsedNetworkDomainPattern, "port"> | undefined {
  if (parent.kind === "any") return requested;
  if (requested.kind === "any") return parent;
  if (networkHostCovers(parent, requested)) return requested;
  if (networkHostCovers(requested, parent)) return parent;
  return undefined;
}

function parsePatterns(patterns: readonly string[]): ParsedNetworkDomainPattern[] {
  const parsed: ParsedNetworkDomainPattern[] = [];
  for (const pattern of patterns) {
    const value = parseNetworkDomainPattern(pattern);
    if (value !== undefined) parsed.push(value);
  }
  return parsed;
}

/**
 * Compute the semantic intersection of two allow-list unions. Empty input is
 * an empty grant, not an implicit wildcard. Unsupported entries are ignored
 * fail-closed; callers that validate configuration can reject them earlier.
 */
export function intersectNetworkPatterns(
  parent: readonly string[],
  requested: readonly string[],
): readonly string[] {
  const parentPatterns = parsePatterns(parent);
  const requestedPatterns = parsePatterns(requested);
  const result = new Set<string>();
  for (const parentPattern of parentPatterns) {
    for (const requestedPattern of requestedPatterns) {
      const port = intersectPorts(parentPattern, requestedPattern);
      if (port === false) continue;
      const host = intersectHosts(parentPattern, requestedPattern);
      if (host === undefined) continue;
      result.add(formatNetworkDomainPattern({ ...host, ...(port === undefined ? {} : { port }) }));
    }
  }
  return Object.freeze([...result].sort());
}

function networkPortCovers(parent: ParsedNetworkDomainPattern, child: ParsedNetworkDomainPattern) {
  return parent.port === undefined || parent.port === child.port;
}

function networkHostCovers(parent: ParsedNetworkDomainPattern, child: ParsedNetworkDomainPattern) {
  if (parent.kind === "any") return true;
  if (parent.kind === "exact") {
    return child.kind === "exact" && parent.host === child.host;
  }
  if (child.kind === "exact") return wildcardMatchesExact(parent.host, child.host);
  return (
    child.kind === "wildcard" &&
    (child.host === parent.host || child.host.endsWith(`.${parent.host}`))
  );
}

function patternCovers(parent: ParsedNetworkDomainPattern, child: ParsedNetworkDomainPattern) {
  return networkPortCovers(parent, child) && networkHostCovers(parent, child);
}

/** Return whether one pattern's full language is contained by another. */
export function isNetworkPatternCoveredBy(parent: string, child: string): boolean {
  const parentPattern = parseNetworkDomainPattern(parent);
  const childPattern = parseNetworkDomainPattern(child);
  return (
    parentPattern !== undefined &&
    childPattern !== undefined &&
    patternCovers(parentPattern, childPattern)
  );
}
