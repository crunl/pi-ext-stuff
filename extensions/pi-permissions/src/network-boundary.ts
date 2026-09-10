import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { fingerprintValue } from "./config.ts";
import { isPublicNetworkHost, normalizeNetworkHost } from "./network-host.ts";
import type { SandboxNetworkEndpoint } from "./sandbox.ts";

/** Codex's network runtime gives DNS resolution a two-second budget. */
export const DEFAULT_NETWORK_RESOLUTION_TIMEOUT_MS = 2_000;

const LOOPBACK_V4 = new BlockList();
LOOPBACK_V4.addSubnet("127.0.0.0", 8, "ipv4");
const LOOPBACK_V6 = new BlockList();
LOOPBACK_V6.addAddress("::1", "ipv6");
LOOPBACK_V6.addSubnet("::ffff:7f00:0", 104, "ipv6");

export type NetworkEndpointDecision =
  | { readonly kind: "allow"; readonly endpoint: SandboxNetworkEndpoint }
  | { readonly kind: "deny"; readonly reason: string };

export interface NetworkBoundaryOptions {
  resolveHost?: (host: string) => Promise<readonly string[]>;
  resolutionTimeoutMs?: number;
}

export interface NetworkEndpointResolutionOptions {
  /** Explicit high-privilege Codex-compatible local/private allowance. */
  allowLocalBinding?: boolean;
  /** Independent outbound private/special eligibility; no bind/inbound authority. */
  allowPrivateTargets?: boolean;
  /** An exact static allow for a raw local address or `localhost`. */
  allowExactLocalAllow?: boolean;
}

function endpointKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function parseTrustedRanges(ranges: readonly string[]): BlockList {
  const blockList = new BlockList();
  for (const value of ranges) {
    const slash = value.lastIndexOf("/");
    if (slash <= 0) continue;
    const address = value.slice(0, slash).trim();
    const prefix = Number(value.slice(slash + 1));
    const family = isIP(address);
    const maximum = family === 4 ? 32 : family === 6 ? 128 : 0;
    if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > maximum) continue;
    try {
      blockList.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
    } catch {
      // Invalid user configuration simply does not trust that range. The
      // resolver remains fail-closed instead of guessing at CIDR syntax.
    }
  }
  return blockList;
}

export function isTrustedFakeIp(address: string, ranges: readonly string[]): boolean {
  const family = isIP(address);
  if (!family) return false;
  return parseTrustedRanges(ranges).check(address, family === 4 ? "ipv4" : "ipv6");
}

function normalizeAddress(address: string): string | undefined {
  const normalized = normalizeNetworkHost(address);
  return normalized && isIP(normalized) !== 0 ? normalized : undefined;
}

function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? LOOPBACK_V4.check(address, "ipv4")
    : family === 6 && LOOPBACK_V6.check(address, "ipv6");
}

function endpoint(
  host: string,
  port: number,
  addresses: readonly string[],
): SandboxNetworkEndpoint {
  return Object.freeze({
    host,
    port,
    addresses: Object.freeze([...new Set(addresses)]),
  });
}

async function defaultResolveHost(host: string): Promise<readonly string[]> {
  const answers = await lookup(host, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

function withAbortAndTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("DNS resolution timed out"));
    }, timeoutMs);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal?.reason ?? new Error("network authorization aborted"));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Parent-side DNS boundary. It produces an address-bound endpoint for the
 * authenticated connect guard. The guard must dial only these frozen answers
 * rather than resolving the user-supplied hostname again, which closes the
 * rebinding window between approval and the actual socket connection.
 */
export class NetworkBoundary {
  private readonly pending = new Map<string, Promise<NetworkEndpointDecision>>();
  private readonly resolveHost: (host: string) => Promise<readonly string[]>;
  private readonly resolutionTimeoutMs: number;

  constructor(options: NetworkBoundaryOptions = {}) {
    this.resolveHost = options.resolveHost ?? defaultResolveHost;
    this.resolutionTimeoutMs = Math.max(
      1,
      options.resolutionTimeoutMs ?? DEFAULT_NETWORK_RESOLUTION_TIMEOUT_MS,
    );
  }

  resolveEndpoint(
    hostInput: string,
    port: number,
    trustedFakeIpRanges: readonly string[] = [],
    signal?: AbortSignal,
    options: NetworkEndpointResolutionOptions = {},
  ): Promise<NetworkEndpointDecision> {
    const host = normalizeNetworkHost(hostInput);
    if (!host || !validPort(port)) {
      return Promise.resolve({ kind: "deny", reason: "Malformed network endpoint" });
    }

    const allowLocalBinding =
      options.allowLocalBinding === true || options.allowPrivateTargets === true;
    const allowExactLocalAllow = options.allowExactLocalAllow === true;
    const allowPrivateTarget = allowLocalBinding || allowExactLocalAllow;

    // Raw literals are never exempted by trustedFakeIpRanges. That option is
    // exclusively for DNS answers produced by a user-managed TUN resolver.
    if (isIP(host) !== 0) {
      return Promise.resolve(
        isPublicNetworkHost(host) || allowPrivateTarget
          ? { kind: "allow", endpoint: endpoint(host, port, [host]) }
          : { kind: "deny", reason: "Private or special-use network target is blocked" },
      );
    }

    const key = `${endpointKey(host, port)}:${fingerprintValue({
      trustedFakeIpRanges: [...trustedFakeIpRanges],
      allowLocalBinding,
      allowExactLocalAllow,
    })}`;
    const existing = this.pending.get(key);
    if (existing) return this.waitForCaller(existing, signal);
    // The shared DNS lookup intentionally has no caller signal. One aborted
    // SRT request must not cancel another request coalesced on this endpoint.
    const pending = this.resolveHostname(
      host,
      port,
      trustedFakeIpRanges,
      allowLocalBinding,
      allowExactLocalAllow && host === "localhost",
    );
    this.pending.set(key, pending);
    void pending.then(
      () => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      },
      () => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      },
    );
    return this.waitForCaller(pending, signal);
  }

  private waitForCaller(
    pending: Promise<NetworkEndpointDecision>,
    signal?: AbortSignal,
  ): Promise<NetworkEndpointDecision> {
    if (!signal) return pending;
    return new Promise<NetworkEndpointDecision>((resolve, reject) => {
      if (signal.aborted) {
        resolve({
          kind: "deny",
          reason:
            signal.reason instanceof Error
              ? signal.reason.message
              : "network authorization aborted",
        });
        return;
      }
      const onAbort = (): void => {
        cleanup();
        resolve({
          kind: "deny",
          reason:
            signal.reason instanceof Error
              ? signal.reason.message
              : "network authorization aborted",
        });
      };
      const cleanup = (): void => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  private async resolveHostname(
    host: string,
    port: number,
    trustedFakeIpRanges: readonly string[],
    allowLocalBinding: boolean,
    allowExactLocalhost: boolean,
  ): Promise<NetworkEndpointDecision> {
    let answers: readonly string[];
    try {
      answers = await withAbortAndTimeout(this.resolveHost(host), this.resolutionTimeoutMs);
    } catch (error) {
      return {
        kind: "deny",
        reason: `DNS resolution failed for ${host}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const normalized = answers.map(normalizeAddress);
    if (normalized.length === 0 || normalized.some((address) => address === undefined)) {
      return {
        kind: "deny",
        reason: `DNS resolution returned no usable public address for ${host}`,
      };
    }
    const addresses = [...new Set(normalized as string[])];
    // Without the explicit broad local-binding mode, a hostname with any
    // private/special answer is rejected, even if another answer is public.
    // Otherwise a resolver can steer the same approved name to an internal
    // address on the next lookup. Trusted TUN answers are the narrow exception.
    const allSafe = addresses.every((address) =>
      allowLocalBinding
        ? true
        : allowExactLocalhost
          ? isLoopbackAddress(address)
          : isPublicNetworkHost(address) || isTrustedFakeIp(address, trustedFakeIpRanges),
    );
    if (!allSafe) {
      return {
        kind: "deny",
        reason: `DNS answer for ${host} includes a private or special-use address`,
      };
    }
    const candidates = allowLocalBinding
      ? addresses
      : allowExactLocalhost
        ? addresses.filter(isLoopbackAddress)
        : addresses.filter(
            (address) =>
              isPublicNetworkHost(address) || isTrustedFakeIp(address, trustedFakeIpRanges),
          );
    if (candidates.length === 0) {
      return { kind: "deny", reason: `DNS answer for ${host} is not trusted` };
    }
    return { kind: "allow", endpoint: endpoint(host, port, candidates) };
  }
}
