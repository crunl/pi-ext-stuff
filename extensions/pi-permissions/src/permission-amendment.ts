import { expandSymlinkAliases, resolvePolicyPath } from "./filesystem-policy.ts";
import { isExactLocalNetworkAllowed } from "./network-domain-pattern.ts";
import { isPublicNetworkHost, normalizeNetworkHost } from "./network-host.ts";
import { isPathAllowed } from "./permissions/paths.ts";

export interface PermissionAmendment {
  networkHosts: string[];
  writeRoots: string[];
}

export type NormalizePermissionAmendmentResult =
  | { ok: true; amendment: PermissionAmendment }
  | { ok: false; reason: string };

/** Normalize and validate the explicit filesystem/network request. */
export async function normalizePermissionAmendment(
  input: {
    hosts?: readonly string[];
    writeRoots?: readonly string[];
    allowPrivateTargets?: boolean;
    allowedDomains?: readonly string[];
  },
  cwd: string,
  protectedWritePaths: readonly string[],
): Promise<NormalizePermissionAmendmentResult> {
  const networkHosts: string[] = [];
  for (const raw of input.hosts ?? []) {
    const host = normalizeNetworkHost(raw);
    if (
      !host ||
      (!input.allowPrivateTargets &&
        !isPublicNetworkHost(host) &&
        !isExactLocalNetworkAllowed(input.allowedDomains ?? [], host))
    ) {
      return { ok: false, reason: `Private or special-use network target is blocked: ${raw}` };
    }
    if (!networkHosts.includes(host)) networkHosts.push(host);
  }

  const writeRoots: string[] = [];
  for (const raw of input.writeRoots ?? []) {
    if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > 4096) {
      return { ok: false, reason: "request_permissions write root is invalid" };
    }
    if (/[*?[\]]/.test(raw)) {
      return { ok: false, reason: "request_permissions write roots cannot contain globs" };
    }
    const resolved = resolvePolicyPath(raw.trim(), cwd);
    const decision = await isPathAllowed(resolved, {
      cwd,
      allowWrite: [resolved],
      denyRead: [],
      denyWrite: [],
      protectedWritePaths: [...protectedWritePaths],
      operation: "write",
    });
    if (!decision.allowed && decision.reason === "permission control path is protected") {
      return { ok: false, reason: "permission control path is protected" };
    }
    for (const path of expandSymlinkAliases(resolved)) {
      if (!writeRoots.includes(path)) writeRoots.push(path);
    }
  }

  return { ok: true, amendment: { networkHosts, writeRoots } };
}
