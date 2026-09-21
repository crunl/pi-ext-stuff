import { BlockList, isIP } from "node:net";

const LOOPBACK_V4 = new BlockList();
LOOPBACK_V4.addSubnet("127.0.0.0", 8, "ipv4");
const LOOPBACK_V6 = new BlockList();
LOOPBACK_V6.addAddress("::1", "ipv6");
// IPv4-mapped 127/8 addresses are represented in IPv6 as ::ffff:7f00:0/104.
LOOPBACK_V6.addSubnet("::ffff:7f00:0", 104, "ipv6");

export function isValidNetworkPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? LOOPBACK_V4.check(address, "ipv4")
    : family === 6 && LOOPBACK_V6.check(address, "ipv6");
}

export function isValidNetworkCidr(value: string): boolean {
  if (value.trim() !== value || /\s/.test(value)) return false;
  const slash = value.lastIndexOf("/");
  if (slash <= 0 || slash === value.length - 1) return false;
  const address = value.slice(0, slash);
  const prefixText = value.slice(slash + 1);
  if (!/^\d+$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  const family = isIP(address);
  const maximum = family === 4 ? 32 : family === 6 ? 128 : 0;
  return family !== 0 && Number.isInteger(prefix) && prefix >= 0 && prefix <= maximum;
}

export type GitRemoteTarget =
  | { kind: "host"; host: string }
  | { kind: "local" }
  | { kind: "unsafe"; reason: string };

export function normalizeNetworkHost(value: string): string | undefined {
  const host = value
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (!host || /\s/.test(host)) return undefined;
  const family = isIP(host);
  if (family === 4) return host;
  if (family === 6) {
    try {
      // URL implements RFC 5952-style IPv6 compression and gives us one
      // canonical identity for policy patterns, DNS answers, and tickets.
      return new URL(`http://[${host}]/`).hostname.slice(1, -1).toLowerCase();
    } catch {
      return undefined;
    }
  }
  if (/^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3}$/i.test(host)) {
    return host;
  }
  return /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/i.test(host) ? host : undefined;
}

function isSpecialIpv4(host: string): boolean {
  const [first, second, third] = host.split(".").map(Number);
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function ipv6Groups(host: string): number[] | undefined {
  let normalized = host;
  if (host.includes(".")) {
    const separator = host.lastIndexOf(":");
    const ipv4 = host.slice(separator + 1);
    if (separator < 0 || isIP(ipv4) !== 4) return undefined;
    const octets = ipv4.split(".").map(Number);
    normalized = `${host.slice(0, separator)}:${(((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16)}:${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`;
  }
  const pieces = normalized.split("::");
  if (pieces.length > 2) return undefined;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces[1] ? pieces[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (pieces.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...left, ...Array(missing).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
  return groups.length === 8 && groups.every((group) => Number.isInteger(group))
    ? groups
    : undefined;
}

function ipv4FromGroups(groups: readonly number[], offset: number): string {
  return [
    (groups[offset] ?? 0) >> 8,
    (groups[offset] ?? 0) & 255,
    (groups[offset + 1] ?? 0) >> 8,
    (groups[offset + 1] ?? 0) & 255,
  ].join(".");
}

function isSpecialIp(host: string): boolean {
  if (isIP(host) === 4) return isSpecialIpv4(host);
  if (isIP(host) !== 6) return false;
  const groups = ipv6Groups(host);
  if (!groups) return true;
  const first = groups[0] ?? 0;
  const embeddedIpv4 =
    groups.slice(0, 6).every((group) => group === 0) ||
    (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)
      ? ipv4FromGroups(groups, 6)
      : undefined;
  return embeddedIpv4
    ? isSpecialIpv4(embeddedIpv4)
    : groups.every((group) => group === 0) ||
        (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) ||
        (first & 0xfe00) === 0xfc00 ||
        (first & 0xffc0) === 0xfe80 ||
        (first & 0xff00) === 0xff00;
}

function looksLikeAmbiguousNumericIp(host: string): boolean {
  return isIP(host) === 0 && /^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3}$/i.test(host);
}

export function isPublicNetworkHost(value: string): boolean {
  const host = normalizeNetworkHost(value);
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal" ||
    looksLikeAmbiguousNumericIp(host)
  )
    return false;
  return !isSpecialIp(host);
}

export function unquoteGitConfigValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  if (trimmed.length < 2 || !trimmed.endsWith('"')) return undefined;
  let result = "";
  let escaped = false;
  for (const character of trimmed.slice(1, -1)) {
    if (escaped) {
      result +=
        character === "n" ? "\n" : character === "t" ? "\t" : character === "b" ? "\b" : character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    result += character;
  }
  return escaped ? undefined : result;
}

export function parseGitRemoteTarget(value: string): GitRemoteTarget {
  const remote = value.trim();
  if (!remote || /\s/.test(remote)) {
    return { kind: "unsafe", reason: "unsafe Git remote value" };
  }

  if (/^file:/i.test(remote)) {
    try {
      const parsed = new URL(remote);
      return !parsed.hostname || parsed.hostname === "localhost"
        ? { kind: "local" }
        : { kind: "unsafe", reason: "unsafe non-local file remote" };
    } catch {
      return { kind: "unsafe", reason: "unsafe Git file remote" };
    }
  }

  if (/^(?:https?|ssh|git):\/\//i.test(remote)) {
    try {
      const parsed = new URL(remote);
      if (!new Set(["http:", "https:", "ssh:", "git:"]).has(parsed.protocol)) {
        return { kind: "unsafe", reason: "unsupported Git remote protocol" };
      }
      const host = normalizeNetworkHost(parsed.hostname);
      return host ? { kind: "host", host } : { kind: "unsafe", reason: "unsafe Git remote host" };
    } catch {
      return { kind: "unsafe", reason: "unsafe Git remote URL" };
    }
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    return { kind: "unsafe", reason: "unsupported Git remote protocol" };
  }

  if (/^[A-Za-z]:[\\/]/.test(remote)) return { kind: "local" };

  if (/^[a-z][a-z0-9+.-]*::/i.test(remote)) {
    return { kind: "unsafe", reason: "unsupported Git remote helper syntax" };
  }

  const scp = /^(?:[^@\s/:]+@)?(\[[^\]]+\]|[^:/\s]+):(.+)$/.exec(remote);
  if (scp) {
    const host = normalizeNetworkHost(scp[1] ?? "");
    return host
      ? { kind: "host", host }
      : { kind: "unsafe", reason: "unsafe Git SCP-like remote host" };
  }

  if (!remote.includes(":")) return { kind: "local" };
  return { kind: "unsafe", reason: "unsafe Git remote syntax" };
}
