/**
 * Untrusted side of the sandbox seam: the operations the agent's own tools
 * run under, plus the shared manager-owned process seam both sides execute
 * through.
 *
 * Everything here runs under a policy the Engine granted for one invocation,
 * so every execution is additionally wrapped with Git-metadata deny roots.
 * The reviewer's read-only side is a different trust level with a different
 * policy, and it lives in `./sandbox-guardian.ts`; the two deliberately share
 * no constants and no helpers. `DEFAULT_FILE_OPERATION_TIMEOUT_MS` is this
 * side's budget and is not the reviewer's command budget even while the two
 * numbers agree.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  BashOperations,
  EditOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { expandSymlinkAliases } from "./filesystem-policy.ts";
import { discoverGitMetadataProtectionRoots } from "./git-metadata.ts";
import {
  createDefaultSandboxConfig,
  type NativeFileOperationEvent,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxManagerLike,
  type SandboxNetworkAuthorize,
  type SandboxPolicy,
  withAdditionalWriteRoots,
} from "./sandbox-policy.ts";

// Historical public seam: callers keep importing from sandbox.ts.
//
// Only this side's vocabulary crosses it. The reviewer's evidence scope and the
// three constructors over it are deliberately absent: they are the trusted
// side's policy, they are declared in `./sandbox-policy.ts`, and every caller
// that needs them reads them from there. Re-exporting them here made the module
// an agent tool depends on the public seam for a profile the agent must never
// be able to name.
export type {
  ExecutionNetwork,
  NativeFileOperationEvent,
  NativeFileOperationFailure,
  NetworkPolicyView,
  SandboxBackendState,
  SandboxDenialCapability,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxManagerLike,
  SandboxNetworkAuthorization,
  SandboxNetworkAuthorize,
  SandboxNetworkEndpoint,
  SandboxPolicy,
  SandboxProgram,
} from "./sandbox-policy.ts";
export {
  createDefaultSandboxConfig,
  createSandboxRuntimeConfig,
  describeExecutionNetwork,
  looksLikeSandboxDenial,
  projectExecutionNetwork,
  withAdditionalWriteRoots,
} from "./sandbox-policy.ts";

/** POSIX shell used as a program when the caller requested shell semantics. */
const WRAP_SHELL = "/bin/bash";

/** Default host-side deadline for a permissioned bash command. */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;

/** Default host-side deadline for a native sandboxed file operation. */
export const DEFAULT_FILE_OPERATION_TIMEOUT_MS = 30_000;

/**
 * Execute through the manager-owned process seam. Callers provide a program
 * descriptor; the manager owns wrapping, spawning, deadlines, and cleanup.
 */
async function executeSandboxProgram(
  manager: SandboxManagerLike,
  request: SandboxExecutionRequest,
): Promise<SandboxExecutionResult> {
  if (request.cwd === undefined) return manager.execute(request);
  const metadata = await discoverGitMetadataProtectionRoots(request.cwd);
  if (!metadata.ok) {
    throw new Error(`pi-safety sandbox unavailable: ${metadata.reason}`);
  }
  const policy = policyWithGitMetadataProtection(request.policy, request.cwd, metadata.roots);
  return manager.execute(policy === request.policy ? request : { ...request, policy });
}

/** Deny only the Git code-execution surfaces for one execution's policy copy.
 * History paths (objects/refs/index/logs) stay writable so the agent can
 * commit — see `createSandboxRuntimeConfig` for the same posture. */
function policyWithGitMetadataProtection(
  policy: SandboxPolicy,
  cwd: string,
  roots: readonly string[],
): SandboxPolicy {
  const metadataRoots = [...new Set(roots.flatMap((root) => expandSymlinkAliases(resolve(root))))];
  const denyWrite = [...policy.filesystem.denyWrite];
  const additions: string[] = [];
  for (const root of [...expandSymlinkAliases(resolve(cwd, ".git")), ...metadataRoots]) {
    for (const entry of [join(root, "hooks"), join(root, "config")]) {
      if (!denyWrite.includes(entry)) additions.push(entry);
    }
  }
  const uniqueAdditions = [...new Set(additions)].filter((path) => !denyWrite.includes(path));
  if (uniqueAdditions.length === 0) return policy;

  return {
    ...policy,
    filesystem: {
      ...policy.filesystem,
      allowWrite: [...policy.filesystem.allowWrite],
      denyRead: [...policy.filesystem.denyRead],
      denyWrite: [...denyWrite, ...uniqueAdditions],
    },
    network: {
      ...policy.network,
      ...(policy.network.access ? { access: { ...policy.network.access } } : {}),
      allowedDomains: [...policy.network.allowedDomains],
      deniedDomains: [...policy.network.deniedDomains],
      ...(policy.network.trustedFakeIpRanges === undefined
        ? {}
        : { trustedFakeIpRanges: [...policy.network.trustedFakeIpRanges] }),
    },
  };
}

export function createSandboxedBashOperations(
  manager: SandboxManagerLike,
  customConfig?: SandboxPolicy,
  options: {
    commandId?: string;
    networkAuthorize?: SandboxNetworkAuthorize;
  } = {},
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      const executionPolicy = customConfig ?? createDefaultSandboxConfig();
      // SRT injects a private-target NO_PROXY set by default. When the
      // sandbox-owned callback is active, local/private exceptions must still
      // pass through the authenticated parent guard so its exact ticket and
      // address binding remain authoritative. Preserve the caller's other
      // environment values; allowLocalBinding controls whether the boundary
      // approves those targets, not whether they bypass the guard. The SRT
      // adapter also repeats this override inside
      // the POSIX command because SRT bakes its own NO_PROXY values into the
      // sandbox argv after the spawn environment is assembled.
      const executionEnv = options.networkAuthorize
        ? { ...(env ?? {}), NO_PROXY: "", no_proxy: "" }
        : env;
      const result = await executeSandboxProgram(manager, {
        policy: executionPolicy,
        program: { executable: WRAP_SHELL, args: ["-c", command] },
        cwd,
        env: executionEnv,
        signal,
        stdin: "ignore",
        timeoutMs:
          timeout === undefined
            ? DEFAULT_BASH_TIMEOUT_MS
            : timeout > 0
              ? timeout * 1000
              : undefined,
        ...(options.commandId === undefined ? {} : { commandId: options.commandId }),
        ...(options.networkAuthorize === undefined
          ? {}
          : { networkAuthorize: options.networkAuthorize }),
        onStdout: onData,
        onStderr: onData,
      });
      return { exitCode: result.exitCode };
    },
  };
}

const FILE_OPERATION_HELPER = `
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const [operation, encodedPath] = process.argv.slice(1);
const path = Buffer.from(encodedPath, "base64").toString("utf8");
async function stdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function main() {
  if (operation === "mkdir") await fs.mkdir(path, { recursive: true });
  else if (operation === "write") await fs.writeFile(path, await stdin());
  else if (operation === "read") process.stdout.write(await fs.readFile(path));
  else if (operation === "access") await fs.access(path, constants.R_OK | constants.W_OK);
  else throw new Error("unsupported file operation");
}
main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`.trim();

function fileOperationConfig(
  baseConfig: SandboxPolicy,
  writePaths: readonly string[],
): SandboxPolicy {
  return writePaths.length === 0 ? baseConfig : withAdditionalWriteRoots(baseConfig, writePaths);
}

export interface SandboxedFileOperationOptions {
  /** Trusted parent-side evidence, scoped to this factory/attempt, never syscall identity. */
  observe?: (event: NativeFileOperationEvent) => void;
}

async function runSandboxedFileOperation(
  manager: SandboxManagerLike,
  config: SandboxPolicy,
  operation: "mkdir" | "write" | "read" | "access",
  path: string,
  input?: string,
  signal?: AbortSignal,
  commandId?: string,
  cwd?: string,
  failureContext?: {
    contentWriteStarted: boolean;
    observe?: SandboxedFileOperationOptions["observe"];
  },
): Promise<Buffer> {
  failureContext?.observe?.({ kind: "started" });
  const result = await executeSandboxProgram(manager, {
    policy: config,
    program: {
      executable: process.execPath,
      args: ["-e", FILE_OPERATION_HELPER, operation, Buffer.from(path).toString("base64")],
    },
    ...(cwd === undefined ? {} : { cwd }),
    signal,
    stdin: input === undefined ? "ignore" : input,
    timeoutMs: DEFAULT_FILE_OPERATION_TIMEOUT_MS,
    ...(commandId === undefined ? {} : { commandId }),
  });
  if (result.exitCode !== 0) {
    const error =
      result.stderr.toString("utf8") || `sandboxed file operation exited with ${result.exitCode}`;
    failureContext?.observe?.({
      kind: "failed",
      operation,
      path,
      cwd: cwd ?? process.cwd(),
      contentWriteStarted: failureContext.contentWriteStarted,
      exitCode: result.exitCode,
      error,
    });
    throw new Error(error);
  }
  failureContext?.observe?.({ kind: "succeeded" });
  return result.stdout;
}

type SandboxedFileOperations = WriteOperations & EditOperations;

export function createSandboxedFileOperations(
  manager: SandboxManagerLike,
  baseConfig: SandboxPolicy,
  writePaths: readonly string[] = [],
  signal?: AbortSignal,
  commandId?: string,
  cwd?: string,
  options: SandboxedFileOperationOptions = {},
): SandboxedFileOperations {
  const config = fileOperationConfig(baseConfig, writePaths);
  const failureContext = { contentWriteStarted: false, observe: options.observe };
  return {
    mkdir: async (path) => {
      await runSandboxedFileOperation(
        manager,
        config,
        "mkdir",
        path,
        undefined,
        signal,
        commandId,
        cwd,
        failureContext,
      );
    },
    writeFile: async (path, content) => {
      // writeFile can truncate before failing; this latch never resets in an attempt.
      failureContext.contentWriteStarted = true;
      await runSandboxedFileOperation(
        manager,
        config,
        "write",
        path,
        content,
        signal,
        commandId,
        cwd,
        failureContext,
      );
    },
    readFile: (path) =>
      runSandboxedFileOperation(
        manager,
        config,
        "read",
        path,
        undefined,
        signal,
        commandId,
        cwd,
        failureContext,
      ),
    access: async (path) => {
      await runSandboxedFileOperation(
        manager,
        config,
        "access",
        path,
        undefined,
        signal,
        commandId,
        cwd,
        failureContext,
      );
    },
  };
}
