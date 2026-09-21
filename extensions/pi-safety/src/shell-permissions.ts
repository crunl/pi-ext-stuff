import { parse } from "node:path";
import { Type } from "typebox";
import type { SafetyConfig } from "./config.ts";
import { createFilesystemPolicy, hasGlobSyntax, resolvePolicyPath } from "./filesystem-policy.ts";
import { isPathAllowed } from "./permissions/paths.ts";
import { MAX_JUSTIFICATION_LENGTH, MAX_PATH_LENGTH } from "./request-limits.ts";
import { isRecord } from "./unknown-value.ts";

const additionalFileSystemPermissions = Type.Object(
  {
    write: Type.Array(
      Type.String({
        minLength: 1,
        description:
          "File or directory to make writable for this command; relative paths resolve from cwd",
      }),
      {
        minItems: 1,
        maxItems: 32,
      },
    ),
  },
  { additionalProperties: false },
);

const additionalPermissions = Type.Object(
  {
    file_system: Type.Object(
      {
        write: additionalFileSystemPermissions.properties.write,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const permissionedBashParameters = Type.Object(
  {
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(
      Type.Number({
        description:
          "Timeout in seconds (escalated commands default to 120 seconds; other modes keep their runtime default)",
      }),
    ),
    sandbox_permissions: Type.Optional(
      Type.Union(
        [
          Type.Literal("use_default"),
          Type.Literal("with_additional_permissions"),
          Type.Literal("require_escalated"),
        ],
        {
          description:
            "Use require_escalated only when this exact command must run outside the active sandbox; use with_additional_permissions for narrow sandbox writes",
        },
      ),
    ),
    additional_permissions: Type.Optional(additionalPermissions),
    justification: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_JUSTIFICATION_LENGTH,
        description: "Why the additional filesystem access or command escalation is required",
      }),
    ),
  },
  { additionalProperties: false },
);

export type AdditionalWriteRootsResult =
  | { ok: true; writeRoots: string[]; justification?: string }
  | { ok: false; reason: string };

export interface EscalatedCommandRequest {
  readonly requested: boolean;
  readonly justification?: string;
}

/**
 * Parse the command-level escalation intent without granting or selecting an
 * executor. The Engine remains the only authority that can turn this intent
 * into an effective lease.
 */
export function requestedEscalation(
  input: Record<string, unknown>,
): EscalatedCommandRequest | { error: string } {
  if (input.sandbox_permissions !== "require_escalated") {
    return { requested: false };
  }
  if (input.additional_permissions !== undefined) {
    return {
      error: "require_escalated cannot be combined with additional_permissions",
    };
  }
  if (
    typeof input.justification !== "string" ||
    input.justification.trim().length === 0 ||
    input.justification.length > MAX_JUSTIFICATION_LENGTH
  ) {
    return { error: "command escalation requires a justification" };
  }
  return { requested: true, justification: input.justification.trim() };
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function requestedWriteRoots(
  input: Record<string, unknown>,
): { roots: string[]; requested: boolean } | { error: string } {
  const mode = input.sandbox_permissions;
  const permissions = input.additional_permissions;
  if (mode === undefined && permissions === undefined) {
    return { roots: [], requested: false };
  }
  if (mode === "use_default" && permissions === undefined) {
    return { roots: [], requested: false };
  }
  if (mode === "require_escalated") {
    return { roots: [], requested: false };
  }
  if (mode !== "with_additional_permissions") {
    return {
      error: "additional_permissions requires sandbox_permissions=with_additional_permissions",
    };
  }
  if (!isRecord(permissions) || !hasOnlyKeys(permissions, ["file_system"])) {
    return { error: "additional_permissions must contain only file_system" };
  }
  const fileSystem = permissions.file_system;
  if (!isRecord(fileSystem) || !hasOnlyKeys(fileSystem, ["write"])) {
    return { error: "additional_permissions.file_system must contain only write" };
  }
  const write = fileSystem.write;
  if (
    !Array.isArray(write) ||
    write.length === 0 ||
    write.length > 32 ||
    !write.every(
      (path) =>
        typeof path === "string" &&
        path.trim().length > 0 &&
        path.length <= MAX_PATH_LENGTH &&
        !hasGlobSyntax(path),
    )
  ) {
    return { error: "additional_permissions.file_system.write contains invalid paths" };
  }
  if (
    typeof input.justification !== "string" ||
    input.justification.trim().length === 0 ||
    input.justification.length > MAX_JUSTIFICATION_LENGTH
  ) {
    return { error: "additional filesystem permissions require a justification" };
  }
  return { roots: write, requested: true };
}

export async function resolveAdditionalWriteRoots(
  input: Record<string, unknown>,
  cwd: string,
  config: SafetyConfig,
  protectedWritePaths: readonly string[],
): Promise<AdditionalWriteRootsResult> {
  const requested = requestedWriteRoots(input);
  if ("error" in requested) return { ok: false, reason: requested.error };
  if (!requested.requested) return { ok: true, writeRoots: [] };

  const filesystem = createFilesystemPolicy(config.sandbox, cwd, [...protectedWritePaths]);
  const writeRoots: string[] = [];
  for (const rawPath of requested.roots) {
    const absolutePath = resolvePolicyPath(rawPath, cwd);
    const decision = await isPathAllowed(absolutePath, {
      cwd,
      allowWrite: filesystem.allowWrite,
      denyRead: filesystem.denyRead,
      denyWrite: filesystem.denyWrite,
      protectedWritePaths: filesystem.protectedWritePaths,
      operation: "write",
    });
    if (
      absolutePath === parse(absolutePath).root ||
      decision.canonicalPath === parse(decision.canonicalPath).root
    ) {
      return {
        ok: false,
        reason: `additional write root cannot be the filesystem root: ${absolutePath}`,
      };
    }
    if (decision.allowed) continue;
    if (decision.reason !== "write path is outside allowed roots") {
      return {
        ok: false,
        reason: `additional write root is protected: ${absolutePath}`,
      };
    }
    writeRoots.push(decision.canonicalPath);
  }
  return {
    ok: true,
    writeRoots: [...new Set(writeRoots)],
    justification: typeof input.justification === "string" ? input.justification.trim() : undefined,
  };
}
