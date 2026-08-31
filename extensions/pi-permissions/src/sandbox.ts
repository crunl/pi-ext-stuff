import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  GrepOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { PermissionsConfig } from "./config.ts";
import { fingerprintValue } from "./config.ts";
import type { GitInitExecutionPlan } from "./execution-plan.ts";
import {
  createFilesystemPolicy,
  expandSymlinkAliases,
  hasGlobSyntax,
  resolveSandboxDenyPattern,
} from "./filesystem-policy.ts";
import { resolveTrustedSystemGitExecutable } from "./git-executable.ts";
import { inspectRepositoryGitMetadata } from "./git-metadata.ts";

/**
 * Our own sandbox policy — the complete description of what a sandboxed
 * process may touch. Deliberately plain data so it can be derived from
 * grants and rendered into any enforcer's flags.
 */
export interface SandboxPolicy {
  filesystem: {
    allowWrite: string[];
    denyRead: string[];
    denyWrite: string[];
    /**
     * Deny entries that may be removed by an exact, explicitly approved
     * filesystem write capability. The entries remain in denyWrite on the
     * baseline policy; this is identity metadata for the Engine only.
     */
    grantableDenyWrite?: string[];
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    trustedFakeIpRanges?: string[];
    allowLocalBinding?: boolean;
  };
}

/**
 * Trusted, immutable evidence authority for one Guardian review.
 *
 * It deliberately carries only the part of the parent policy that remains
 * meaningful after intersecting it with Guardian's fixed read-only,
 * zero-write, zero-network profile. It is never included in the model prompt.
 */
export interface GuardianEvidenceScope {
  readonly cwd: string;
  readonly denyRead: readonly string[];
  readonly authorityFingerprint: string;
}

function guardianAuthorityFingerprint(cwd: string, denyRead: readonly string[]): string {
  return fingerprintValue({
    cwd,
    denyRead,
    allowWrite: [],
    network: "denied",
  });
}

function normalizedGuardianDenyRead(denyRead: readonly string[]): string[] {
  if (!Array.isArray(denyRead)) throw new Error("Guardian evidence denyRead must be an array");
  const normalized = denyRead.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || !isAbsolute(entry)) {
      throw new Error("Guardian evidence denyRead entries must be non-empty absolute paths");
    }
    return entry;
  });
  if (process.platform === "linux" && normalized.some(hasGlobSyntax)) {
    throw new Error("Guardian evidence cannot enforce glob denyRead entries on Linux");
  }
  return [...new Set(normalized)].sort();
}

/** Derive Guardian authority from the exact parent lease, never from a grant. */
export function createGuardianEvidenceScope(
  cwd: string,
  parentPolicy: SandboxPolicy,
): GuardianEvidenceScope {
  if (!parentPolicy || typeof parentPolicy !== "object") {
    throw new Error("Guardian evidence requires an exact parent sandbox policy");
  }
  const resolvedCwd = resolve(cwd);
  const denyRead = Object.freeze(normalizedGuardianDenyRead(parentPolicy.filesystem.denyRead));
  return Object.freeze({
    cwd: resolvedCwd,
    denyRead,
    authorityFingerprint: guardianAuthorityFingerprint(resolvedCwd, denyRead),
  });
}

/**
 * Evidence ceiling for host-admission reviews when the main sandbox is
 * disabled. Host tools are not given a synthetic execution sandbox; this
 * policy only records the least-authority Guardian profile (zero writes and
 * zero network) while preserving the parent process's unrestricted read
 * authority through an empty denyRead set.
 */
export function createGuardianEvidencePolicyCeiling(): SandboxPolicy {
  return {
    filesystem: {
      allowWrite: [],
      denyRead: [],
      denyWrite: [],
    },
    network: {
      allowedDomains: [],
      deniedDomains: ["*"],
      trustedFakeIpRanges: [],
      allowLocalBinding: false,
    },
  };
}

/** Validate and defensively copy authority received across an internal seam. */
export function copyGuardianEvidenceScope(scope: GuardianEvidenceScope): GuardianEvidenceScope {
  if (!scope || typeof scope !== "object" || !isAbsolute(scope.cwd)) {
    throw new Error("Guardian evidence scope is invalid");
  }
  const cwd = resolve(scope.cwd);
  const denyRead = Object.freeze(normalizedGuardianDenyRead(scope.denyRead));
  const authorityFingerprint = guardianAuthorityFingerprint(cwd, denyRead);
  if (scope.authorityFingerprint !== authorityFingerprint) {
    throw new Error("Guardian evidence authority fingerprint does not match its scope");
  }
  return Object.freeze({ cwd, denyRead, authorityFingerprint });
}

export interface SandboxNetworkEndpoint {
  readonly host: string;
  readonly port: number;
  /**
   * DNS answers frozen by the parent boundary. The guard must try only these
   * literals and must never resolve `host` again after authorization.
   */
  readonly addresses: readonly string[];
}

export interface SandboxNetworkAuthorization {
  readonly allowed: boolean;
  readonly endpoint?: SandboxNetworkEndpoint;
  readonly reason?: string;
}

/** Authorization is evaluated by the Engine; the sandbox only transports it. */
export type SandboxNetworkAuthorize = (input: {
  host: string;
  port: number;
  signal?: AbortSignal;
}) => Promise<SandboxNetworkAuthorization>;

export interface SandboxProgram {
  executable: string;
  args: readonly string[];
}

export interface SandboxExecutionRequest {
  policy: SandboxPolicy;
  program: SandboxProgram;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Replace the inherited host environment instead of overlaying it. */
  envMode?: "inherit" | "replace";
  /** Only the validated structured git-init plan may enable Git config writes. */
  allowGitConfig?: boolean;
  signal?: AbortSignal;
  stdin?: "ignore" | string;
  timeoutMs?: number;
  commandId?: string;
  commandText?: string;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** Per-command inline network authorization seam. */
  networkAuthorize?: SandboxNetworkAuthorize;
}

export interface SandboxExecutionResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

/** The exact capability enforcement denied at runtime, when recoverable. */
export type SandboxDenialCapability =
  | { kind: "filesystem"; operation: "write"; path: string }
  | { kind: "network"; host: string };

const SANDBOX_DENIAL_MARKERS =
  /operation not permitted|permission denied|read-only file system|sandbox denied|\bEPERM\b|\bEACCES\b|\bEROFS\b|connect tunnel failed/i;

/** Cheap pre-filter only; the enforcement adapter's verdict is authoritative. */
export function looksLikeSandboxDenial(text: string): boolean {
  return SANDBOX_DENIAL_MARKERS.test(text);
}

export interface SandboxManagerLike {
  initialize(config: SandboxPolicy): Promise<void>;
  /**
   * Execute a program under the active policy. The implementation owns the
   * sandbox wrapper, child process, deadlines, and cleanup lifecycle.
   */
  execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
  /** Atomically reset and install a new process-global sandbox policy. */
  activate?(config: SandboxPolicy): Promise<void>;
  reset(): Promise<void>;
  /**
   * After a failed execution, report the exact capability enforcement
   * denied for this invocation, when the backend tracks authoritative
   * denial events. Absence means no escalation is possible.
   */
  classifyDenial?(commandId: string): Promise<SandboxDenialCapability | undefined>;
}

export function createGuardianReadOnlySandboxConfig(scope: GuardianEvidenceScope): SandboxPolicy {
  const trustedScope = copyGuardianEvidenceScope(scope);
  return {
    filesystem: {
      allowWrite: [],
      denyRead: [...trustedScope.denyRead],
      denyWrite: [],
    },
    network: {
      allowedDomains: [],
      deniedDomains: ["*"],
      trustedFakeIpRanges: [],
      allowLocalBinding: false,
    },
  };
}

/** Conservative fallback used only when a caller omits an explicit policy. */
function createDefaultSandboxConfig(): SandboxPolicy {
  return {
    filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
    network: {
      allowedDomains: [],
      deniedDomains: ["*"],
      trustedFakeIpRanges: [],
      allowLocalBinding: false,
    },
  };
}

export function withAdditionalWriteRoots(
  config: SandboxPolicy,
  writeRoots: readonly string[],
): SandboxPolicy {
  const roots = [...new Set(writeRoots.flatMap(expandSymlinkAliases))];
  if (roots.length === 0) return config;
  const grantable = new Set(config.filesystem.grantableDenyWrite ?? []);
  const released = new Set(
    config.filesystem.denyWrite.filter((path) => grantable.has(path) && roots.includes(path)),
  );
  return {
    ...config,
    filesystem: {
      ...config.filesystem,
      allowWrite: [...new Set([...config.filesystem.allowWrite, ...roots])],
      denyWrite: config.filesystem.denyWrite.filter((path) => !released.has(path)),
      grantableDenyWrite: (config.filesystem.grantableDenyWrite ?? []).filter(
        (path) => !released.has(path),
      ),
    },
  };
}

export function createSandboxRuntimeConfig(
  config: PermissionsConfig["sandbox"],
  cwd: string,
  protectedWritePaths?: readonly string[],
  gitMetadataWriteRoots: readonly string[] = [],
): SandboxPolicy {
  const filesystem = createFilesystemPolicy(
    config,
    cwd,
    protectedWritePaths ? [...protectedWritePaths] : undefined,
  );
  const denyRead = filesystem.denyRead.flatMap((pattern) =>
    expandSymlinkAliases(resolveSandboxDenyPattern(pattern, cwd)),
  );
  const denyWrite = filesystem.denyWrite.flatMap((pattern) =>
    expandSymlinkAliases(resolveSandboxDenyPattern(pattern, cwd)),
  );
  const gitRoot = resolve(cwd, ".git");
  const gitAliases = new Set(expandSymlinkAliases(gitRoot));
  const metadataRoots = [
    ...new Set(gitMetadataWriteRoots.flatMap((path) => expandSymlinkAliases(resolve(path)))),
  ];
  const protectedMetadataRoots = [...new Set([...metadataRoots, ...gitAliases])];
  const metadataDenyWrite = protectedMetadataRoots.flatMap((root) => [
    root,
    join(root, "hooks"),
    join(root, "config"),
  ]);
  const finalDenyWrite = [...new Set([...denyWrite, ...metadataDenyWrite])];
  const grantableDenyWrite = [
    ...new Set(
      [...filesystem.protectedWritePaths, ...metadataRoots]
        .flatMap((pattern) => expandSymlinkAliases(resolveSandboxDenyPattern(pattern, cwd)))
        .filter(
          (path) =>
            (gitAliases.has(path) || metadataRoots.includes(path)) && finalDenyWrite.includes(path),
        ),
    ),
  ];
  return {
    filesystem: {
      allowWrite: filesystem.allowWrite,
      denyRead,
      denyWrite: finalDenyWrite,
      ...(grantableDenyWrite.length > 0 ? { grantableDenyWrite } : {}),
    },
    network: {
      allowedDomains: [...config.network.allowedDomains],
      deniedDomains: [...config.network.deniedDomains],
      trustedFakeIpRanges: [...config.network.trustedFakeIpRanges],
      allowLocalBinding: config.network.allowLocalBinding,
    },
  };
}

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
  return manager.execute(request);
}

function pathWithin(root: string, candidate: string): boolean {
  const remainder = relative(resolve(root), resolve(candidate));
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

function isMissingPath(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function filesystemError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PreparedGitInit {
  policy: SandboxPolicy;
  environment: NodeJS.ProcessEnv;
  cleanup(succeeded: boolean): Promise<void>;
}

async function removeOwnedEmptyGitRoot(gitRoot: string): Promise<void> {
  try {
    await rmdir(gitRoot);
  } catch (error) {
    if (isMissingPath(error)) return;
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOTEMPTY"
    ) {
      throw new Error("partial Git metadata was retained after failed initialization");
    }
    throw error;
  }
}

/**
 * Prepare the one sealed Git-init execution. SRT cannot permit creation of a
 * future path below a mandatory hooks deny, so the host creates only the
 * exact `.git` directory and verifies its identity before the child starts.
 * The child still receives a hard hooks deny; only exact config deny entries
 * are released for this typed plan.
 */
async function prepareGitInit(cwd: string, policy: SandboxPolicy): Promise<PreparedGitInit> {
  const lexicalCwd = resolve(cwd);
  const physicalCwd = await realpath(cwd).catch((error: unknown) => {
    throw new Error(`pi-permissions: cannot resolve Git init cwd: ${filesystemError(error)}`);
  });
  const gitRoots = [
    ...new Set([
      ...expandSymlinkAliases(join(lexicalCwd, ".git")),
      ...expandSymlinkAliases(join(physicalCwd, ".git")),
    ]),
  ];
  const gitRoot = join(physicalCwd, ".git");
  const hookPaths = gitRoots.flatMap((root) => expandSymlinkAliases(join(root, "hooks")));
  const configPaths = new Set(
    gitRoots.flatMap((root) => expandSymlinkAliases(join(root, "config"))),
  );
  const denyWrite = policy.filesystem.denyWrite;
  if (gitRoots.some((root) => denyWrite.includes(root))) {
    throw new Error("pi-permissions: Git init metadata root was not released exactly");
  }
  if (!hookPaths.every((path) => denyWrite.includes(path))) {
    throw new Error("pi-permissions: Git init hooks must remain hard-denied");
  }
  const allowed = gitRoots.some((root) =>
    policy.filesystem.allowWrite.some((writeRoot) => pathWithin(writeRoot, root)),
  );
  if (!allowed) {
    throw new Error("pi-permissions: Git init metadata root is outside the write lease");
  }

  let createdGitRoot = false;
  let runtimeDirectory: string | undefined;
  let templateDirectory: string | undefined;
  try {
    let details: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      details = await lstat(gitRoot);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
    if (details) {
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error("pi-permissions: existing .git must be a real directory");
      }
      if ((await readdir(gitRoot)).length > 0) {
        const metadata = await inspectRepositoryGitMetadata(cwd);
        if (!metadata.ok || !metadata.writeRoots.some((root) => root === gitRoot)) {
          throw new Error("pi-permissions: existing .git metadata is not trusted");
        }
      }
    } else {
      await mkdir(gitRoot, { mode: 0o700 });
      createdGitRoot = true;
    }
    const verifiedRoot = await lstat(gitRoot);
    if (verifiedRoot.isSymbolicLink() || !verifiedRoot.isDirectory()) {
      throw new Error("pi-permissions: .git identity changed during preparation");
    }

    const preparedRuntimeDirectory = await mkdtemp(join(tmpdir(), "pi-permissions-git-home-"));
    runtimeDirectory = preparedRuntimeDirectory;
    const preparedTemplateDirectory = await mkdtemp(join(tmpdir(), "pi-permissions-git-template-"));
    templateDirectory = preparedTemplateDirectory;
    await chmod(preparedTemplateDirectory, 0o555);
    const verifiedTemplate = await lstat(preparedTemplateDirectory);
    if (verifiedTemplate.isSymbolicLink() || !verifiedTemplate.isDirectory()) {
      throw new Error("pi-permissions: Git template directory is not trusted");
    }
    const preparedPolicy: SandboxPolicy = {
      ...policy,
      filesystem: {
        ...policy.filesystem,
        // Exact config identities are released only for the sealed helper;
        // broad/glob entries and the hooks deny are intentionally untouched.
        denyWrite: denyWrite.filter((path) => !configPaths.has(path)),
        grantableDenyWrite: (policy.filesystem.grantableDenyWrite ?? []).filter(
          (path) => !configPaths.has(path),
        ),
      },
    };
    return {
      policy: preparedPolicy,
      environment: gitInitializationEnvironment(
        preparedRuntimeDirectory,
        preparedTemplateDirectory,
      ),
      cleanup: async (succeeded) => {
        let cleanupError: unknown;
        try {
          await rm(preparedTemplateDirectory, { recursive: true, force: true });
        } catch (error) {
          cleanupError = error;
        }
        try {
          await rm(preparedRuntimeDirectory, { recursive: true, force: true });
        } catch (error) {
          cleanupError ??= error;
        }
        if (!succeeded && createdGitRoot) {
          try {
            const current = await lstat(gitRoot);
            if (current.isSymbolicLink() || !current.isDirectory()) {
              throw new Error(".git identity changed before cleanup");
            }
            await removeOwnedEmptyGitRoot(gitRoot);
          } catch (error) {
            cleanupError ??= error;
          }
        }
        if (cleanupError) {
          throw new Error(
            `pi-permissions: Git init cleanup failed: ${filesystemError(cleanupError)}`,
          );
        }
      },
    };
  } catch (error) {
    let cleanupError: unknown;
    if (templateDirectory) {
      try {
        await rm(templateDirectory, { recursive: true, force: true });
      } catch (error) {
        cleanupError = error;
      }
    }
    if (runtimeDirectory) {
      try {
        await rm(runtimeDirectory, { recursive: true, force: true });
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (createdGitRoot) {
      try {
        await removeOwnedEmptyGitRoot(gitRoot);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    const message = `pi-permissions: Git init preparation failed: ${filesystemError(error)}`;
    throw new Error(cleanupError ? `${message}; ${filesystemError(cleanupError)}` : message);
  }
}

export function createSandboxedBashOperations(
  manager: SandboxManagerLike,
  customConfig?: SandboxPolicy,
  options: {
    gitInitPlan?: GitInitExecutionPlan;
    commandId?: string;
    networkAuthorize?: SandboxNetworkAuthorize;
  } = {},
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      const gitInitPlan = options.gitInitPlan;
      if (gitInitPlan && resolve(cwd) !== gitInitPlan.cwd) {
        throw new Error("pi-permissions: structured git init cwd does not match execution cwd");
      }
      if (gitInitPlan) {
        const trustedExecutable = resolveTrustedSystemGitExecutable(gitInitPlan.executable);
        const fixedArgs =
          (gitInitPlan.args.length === 1 && gitInitPlan.args[0] === "init") ||
          (gitInitPlan.args.length === 2 &&
            gitInitPlan.args[0] === "init" &&
            gitInitPlan.args[1] === ".");
        if (trustedExecutable !== gitInitPlan.executable || !fixedArgs) {
          throw new Error("pi-permissions: structured Git init plan is not trusted");
        }
      }

      const preparation = gitInitPlan
        ? await prepareGitInit(cwd, customConfig ?? createDefaultSandboxConfig())
        : undefined;
      const executionPolicy = preparation?.policy ?? customConfig ?? createDefaultSandboxConfig();
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
      try {
        const result = await executeSandboxProgram(manager, {
          policy: executionPolicy,
          program: gitInitPlan
            ? { executable: gitInitPlan.executable, args: gitInitPlan.args }
            : { executable: WRAP_SHELL, args: ["-c", command] },
          cwd,
          ...(gitInitPlan
            ? {
                env: preparation?.environment,
                envMode: "replace" as const,
                allowGitConfig: true,
              }
            : { env: executionEnv }),
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
        await preparation?.cleanup(result.exitCode === 0);
        return { exitCode: result.exitCode };
      } catch (error) {
        if (preparation) {
          try {
            await preparation.cleanup(false);
          } catch (cleanupError) {
            throw new Error(`${filesystemError(error)}; ${filesystemError(cleanupError)}`);
          }
        }
        throw error;
      }
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

function parseJsonSafe<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `malformed sandboxed output: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface SandboxedCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

export type GuardianReadOnlyExecutable = "node" | "bash";

const GUARDIAN_COMMAND_MAX_STDOUT_BYTES = 5 * 1024 * 1024;
const GUARDIAN_COMMAND_MAX_STDERR_BYTES = 64 * 1024;
const GUARDIAN_FILE_MAX_BYTES = 4 * 1024 * 1024;
const GUARDIAN_DIRECTORY_MAX_ENTRIES = 1_000;
const GUARDIAN_DIRECTORY_MAX_BYTES = 512 * 1024;

function guardianReadOnlyExecutablePath(executable: GuardianReadOnlyExecutable): string {
  if (executable === "node") return process.execPath;
  if (executable === "bash") return WRAP_SHELL;
  throw new Error(`Unsupported reviewer read-only executable: ${executable}`);
}

function systemPath(): string {
  return process.platform === "win32"
    ? (process.env.SystemRoot ?? "")
    : "/usr/bin:/bin:/usr/sbin:/sbin";
}

function guardianEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: systemPath(),
    HOME: tmpdir(),
    TMPDIR: tmpdir(),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
  };
}

/**
 * The only command allowed to opt into Git's repository-local config writes.
 * Every value is fixed or temporary; in particular no caller-provided loader,
 * proxy, credential, Git directory, or global config variable is inherited.
 */
export function gitInitializationEnvironment(
  homeDirectory: string,
  templateDirectory: string,
): NodeJS.ProcessEnv {
  return {
    PATH: systemPath(),
    HOME: homeDirectory,
    XDG_CONFIG_HOME: homeDirectory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TEMPLATE_DIR: templateDirectory,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
  };
}

export function createSandboxedReadOnlyCommandRunner(
  manager: SandboxManagerLike,
  executable: GuardianReadOnlyExecutable,
  evidenceScope: GuardianEvidenceScope,
): (args: readonly string[], signal?: AbortSignal) => Promise<SandboxedCommandResult> {
  const resolvedExecutable = guardianReadOnlyExecutablePath(executable);
  const trustedScope = copyGuardianEvidenceScope(evidenceScope);
  return async (args, signal) => {
    if (signal?.aborted) throw new Error("aborted");
    return executeSandboxProgram(manager, {
      policy: createGuardianReadOnlySandboxConfig(trustedScope),
      program: { executable: resolvedExecutable, args },
      env: guardianEnvironment(),
      envMode: "replace",
      signal,
      stdin: "ignore",
      timeoutMs: DEFAULT_FILE_OPERATION_TIMEOUT_MS,
      maxStdoutBytes: GUARDIAN_COMMAND_MAX_STDOUT_BYTES,
      maxStderrBytes: GUARDIAN_COMMAND_MAX_STDERR_BYTES,
    });
  };
}

const GUARDIAN_FILE_OPERATION_HELPER = `
const fs = require("node:fs/promises");
const { constants, createReadStream } = require("node:fs");
const nodePath = require("node:path");
const [encodedTrustedHome, operation, encodedPath, ...operationArgs] = process.argv.slice(1);
const trustedHome = Buffer.from(encodedTrustedHome, "base64").toString("utf8");
const path = Buffer.from(encodedPath, "base64").toString("utf8");
const maxFileBytes = ${GUARDIAN_FILE_MAX_BYTES};
const maxDirectoryEntries = ${GUARDIAN_DIRECTORY_MAX_ENTRIES};
const maxDirectoryBytes = ${GUARDIAN_DIRECTORY_MAX_BYTES};

async function readBounded(filePath) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.length;
    if (bytes > maxFileBytes) {
      throw new Error("file exceeds the reviewer byte bound");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function readPrefix(filePath, requestedBytes) {
  const maximumBytes = Math.min(64, Math.max(1, requestedBytes));
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maximumBytes);
    const { bytesRead } = await handle.read(buffer, 0, maximumBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readTextWindow(
  filePath,
  requestedOffset,
  requestedLimit,
  requestedMaxLines,
  requestedMaxBytes,
) {
  const startLine = Number.isFinite(requestedOffset)
    ? Math.max(1, Math.floor(requestedOffset))
    : 1;
  const userLimit = Number.isFinite(requestedLimit)
    ? Math.max(0, Math.floor(requestedLimit))
    : undefined;
  const maxLines = Math.max(1, Math.floor(requestedMaxLines));
  const maxBytes = Math.max(1, Math.floor(requestedMaxBytes));
  const lineLimit = Math.min(maxLines, userLimit ?? maxLines);
  const outputLines = [];
  let outputBytes = 0;
  let currentLine = 1;
  let currentLineChunks = [];
  let currentLineBytes = 0;
  let truncatedBy = null;
  let firstLineExceedsLimit = false;
  let userLimitReached = false;
  let hasMore = false;
  let reachedEnd = false;
  let stopped = false;

  function stopAtLineLimit() {
    hasMore = true;
    stopped = true;
    if (userLimit !== undefined && userLimit <= maxLines) userLimitReached = true;
    else truncatedBy = "lines";
  }

  function finishCurrentLine() {
    if (currentLine < startLine) return;
    if (outputLines.length >= lineLimit) {
      stopAtLineLimit();
      return;
    }
    let line = Buffer.concat(currentLineChunks, currentLineBytes);
    if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
    const separatorBytes = outputLines.length > 0 ? 1 : 0;
    if (outputBytes + separatorBytes + line.length > maxBytes) {
      firstLineExceedsLimit = outputLines.length === 0;
      truncatedBy = "bytes";
      hasMore = true;
      stopped = true;
      return;
    }
    outputLines.push(line);
    outputBytes += separatorBytes + line.length;
  }

  const handle = await fs.open(filePath, "r");
  const readBuffer = Buffer.alloc(64 * 1024);
  try {
    while (!stopped) {
      const { bytesRead } = await handle.read(readBuffer, 0, readBuffer.length, null);
      if (bytesRead === 0) {
        reachedEnd = true;
        break;
      }
      let cursor = 0;
      while (cursor < bytesRead && !stopped) {
        const newline = readBuffer.indexOf(0x0a, cursor);
        const end = newline < 0 || newline >= bytesRead ? bytesRead : newline;
        if (currentLine >= startLine) {
          if (outputLines.length >= lineLimit) {
            stopAtLineLimit();
            break;
          }
          const segment = readBuffer.subarray(cursor, end);
          currentLineBytes += segment.length;
          const separatorBytes = outputLines.length > 0 ? 1 : 0;
          if (outputBytes + separatorBytes + currentLineBytes > maxBytes) {
            firstLineExceedsLimit = outputLines.length === 0;
            truncatedBy = "bytes";
            hasMore = true;
            stopped = true;
            break;
          }
          if (segment.length > 0) currentLineChunks.push(Buffer.from(segment));
        }
        if (newline < 0 || newline >= bytesRead) break;
        finishCurrentLine();
        currentLine += 1;
        currentLineChunks = [];
        currentLineBytes = 0;
        cursor = newline + 1;
      }
    }
  } finally {
    await handle.close();
  }

  if (reachedEnd && !stopped) finishCurrentLine();
  return {
    content: Buffer.concat(outputLines).length === 0
      ? ""
      : outputLines.map((line) => line.toString("utf8")).join("\\n"),
    outputLines: outputLines.length,
    outputBytes,
    truncatedBy,
    firstLineExceedsLimit,
    userLimitReached,
    hasMore,
    offsetBeyondEnd: reachedEnd && startLine > currentLine,
    totalLines: reachedEnd ? currentLine : undefined,
  };
}

async function readDirectoryEntries(directoryPath) {
  const entries = [];
  let bytes = 0;
  const directory = await fs.opendir(directoryPath);
  try {
    for await (const entry of directory) {
      const entryBytes = Buffer.byteLength(entry.name) + 1;
      if (entries.length >= maxDirectoryEntries || bytes + entryBytes > maxDirectoryBytes) break;
      entries.push(entry.name);
      bytes += entryBytes;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return entries;
}

function resolveToCwd(rawPath, cwd) {
  let normalized = rawPath.replace(/^@/, "").replace(/\u00a0/g, " ");
  if (normalized === "~") normalized = trustedHome;
  else if (normalized.startsWith("~/")) normalized = nodePath.join(trustedHome, normalized.slice(2));
  return nodePath.resolve(cwd, normalized);
}

async function resolveReadPath(rawPath, cwd) {
  const resolved = resolveToCwd(rawPath, cwd);
  const variants = [
    resolved,
    resolved.replace(/ (AM|PM)./gi, "\u202f$1."),
    resolved.normalize("NFD"),
    resolved.replace(/'/g, "\u2019"),
    resolved.normalize("NFD").replace(/'/g, "\u2019"),
  ];
  for (const candidate of [...new Set(variants)]) {
    try {
      await fs.access(candidate, constants.F_OK);
      return candidate;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
  }
  return resolved;
}

async function listDirectory(directoryPath, requestedLimit) {
  const effectiveLimit = Math.min(
    maxDirectoryEntries,
    Math.max(1, Number.isInteger(requestedLimit) ? requestedLimit : 500),
  );
  const entries = [];
  let bytes = 0;
  let entryLimitReached = false;
  const directory = await fs.opendir(directoryPath);
  try {
    for await (const entry of directory) {
      if (entries.length >= effectiveLimit) {
        entryLimitReached = true;
        break;
      }
      let isDirectory;
      try {
        isDirectory = (await fs.stat(nodePath.join(directoryPath, entry.name))).isDirectory();
      } catch {
        continue;
      }
      const rendered = entry.name + (isDirectory ? "/" : "");
      const entryBytes = Buffer.byteLength(rendered) + 1;
      if (bytes + entryBytes > maxDirectoryBytes) {
        entryLimitReached = true;
        break;
      }
      entries.push(rendered);
      bytes += entryBytes;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return { entries, entryLimitReached };
}

async function main() {
  if (operation === "read") process.stdout.write(await readBounded(path));
  else if (operation === "readPrefix") {
    process.stdout.write(await readPrefix(path, Number(operationArgs[0])));
  }
  else if (operation === "readText") {
    process.stdout.write(JSON.stringify(await readTextWindow(
      path,
      Number(operationArgs[0]),
      operationArgs[1] === "" ? undefined : Number(operationArgs[1]),
      Number(operationArgs[2]),
      Number(operationArgs[3]),
    )));
  }
  else if (operation === "access") await fs.access(path, constants.R_OK);
  else if (operation === "resolveReadPath") {
    const cwd = Buffer.from(operationArgs[0], "base64").toString("utf8");
    process.stdout.write(await resolveReadPath(path, cwd));
  }
  else if (operation === "exists") {
    try {
      await fs.access(path, constants.F_OK);
      process.stdout.write("true");
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        process.stdout.write("false");
      } else throw error;
    }
  } else if (operation === "stat") {
    const stat = await fs.stat(path);
    process.stdout.write(JSON.stringify({ isDirectory: stat.isDirectory() }));
  } else if (operation === "readdir") {
    process.stdout.write(JSON.stringify(await readDirectoryEntries(path)));
  } else if (operation === "list") {
    process.stdout.write(JSON.stringify(await listDirectory(path, Number(operationArgs[0]))));
  } else throw new Error("unsupported reviewer file operation");
}
main().catch((error) => {
  process.stderr.write(JSON.stringify({
    code: error && typeof error === "object" ? error.code : undefined,
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
`.trim();

type GuardianFileOperation =
  | "read"
  | "readPrefix"
  | "readText"
  | "access"
  | "resolveReadPath"
  | "exists"
  | "stat"
  | "readdir"
  | "list";

export interface SandboxedGuardianDirectoryListing {
  entries: string[];
  entryLimitReached: boolean;
}

export interface SandboxedGuardianTextRead {
  content: string;
  outputLines: number;
  outputBytes: number;
  truncatedBy: "lines" | "bytes" | null;
  firstLineExceedsLimit: boolean;
  userLimitReached: boolean;
  hasMore: boolean;
  offsetBeyondEnd: boolean;
  totalLines?: number;
}

export interface SandboxedGuardianFileOperations {
  read: ReadOperations;
  grep: GrepOperations;
  find: Pick<FindOperations, "exists">;
  ls: LsOperations;
  resolveReadPath(path: string, cwd: string): Promise<string>;
  readPrefix(path: string, bytes: number): Promise<Buffer>;
  readText(
    path: string,
    offset: number | undefined,
    limit: number | undefined,
    maxLines: number,
    maxBytes: number,
  ): Promise<SandboxedGuardianTextRead>;
  listDirectory(path: string, limit: number): Promise<SandboxedGuardianDirectoryListing>;
}

export function createSandboxedGuardianFileOperations(
  manager: SandboxManagerLike,
  evidenceScope: GuardianEvidenceScope,
  signal?: AbortSignal,
  trustedHome: string = homedir(),
): SandboxedGuardianFileOperations {
  const run = createSandboxedReadOnlyCommandRunner(manager, "node", evidenceScope);
  const runFileOperation = async (
    operation: GuardianFileOperation,
    path: string,
    operationArgs: readonly string[] = [],
  ): Promise<Buffer> => {
    const result = await run(
      [
        "-e",
        GUARDIAN_FILE_OPERATION_HELPER,
        Buffer.from(trustedHome).toString("base64"),
        operation,
        Buffer.from(path).toString("base64"),
        ...operationArgs,
      ],
      signal,
    );
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString("utf8");
      let message = stderr || `sandboxed reviewer file operation exited with ${result.exitCode}`;
      let code: string | undefined;
      try {
        const diagnostic = JSON.parse(stderr) as { code?: unknown; message?: unknown };
        if (typeof diagnostic.message === "string") message = diagnostic.message;
        if (typeof diagnostic.code === "string") code = diagnostic.code;
      } catch {
        // Preserve non-helper sandbox diagnostics as-is.
      }
      const error = new Error(message) as NodeJS.ErrnoException;
      if (code) error.code = code;
      throw error;
    }
    return result.stdout;
  };
  const exists = async (path: string): Promise<boolean> =>
    (await runFileOperation("exists", path)).toString("utf8") === "true";
  const stat = async (path: string): Promise<{ isDirectory: boolean }> =>
    parseJsonSafe<{ isDirectory: boolean }>(
      (await runFileOperation("stat", path)).toString("utf8"),
    );

  return {
    read: {
      readFile: (path) => runFileOperation("read", path),
      access: async (path) => {
        await runFileOperation("access", path);
      },
    },
    grep: {
      isDirectory: async (path) => (await stat(path)).isDirectory,
      readFile: async (path) => (await runFileOperation("read", path)).toString("utf8"),
    },
    find: { exists },
    ls: {
      exists,
      stat: async (path) => {
        const details = await stat(path);
        return { isDirectory: () => details.isDirectory };
      },
      readdir: async (path) =>
        parseJsonSafe<string[]>((await runFileOperation("readdir", path)).toString("utf8")),
    },
    resolveReadPath: (path, cwd) =>
      runFileOperation("resolveReadPath", path, [Buffer.from(cwd).toString("base64")]).then(
        (output) => output.toString("utf8"),
      ),
    readPrefix: (path, bytes) => runFileOperation("readPrefix", path, [String(bytes)]),
    readText: (path, offset, limit, maxLines, maxBytes) =>
      runFileOperation("readText", path, [
        String(offset ?? 1),
        limit === undefined ? "" : String(limit),
        String(maxLines),
        String(maxBytes),
      ]).then((output) => parseJsonSafe<SandboxedGuardianTextRead>(output.toString("utf8"))),
    listDirectory: (path, limit) =>
      runFileOperation("list", path, [String(limit)]).then((output) =>
        parseJsonSafe<SandboxedGuardianDirectoryListing>(output.toString("utf8")),
      ),
  };
}

function fileOperationConfig(
  baseConfig: SandboxPolicy,
  writePaths: readonly string[],
): SandboxPolicy {
  return writePaths.length === 0 ? baseConfig : withAdditionalWriteRoots(baseConfig, writePaths);
}

async function runSandboxedFileOperation(
  manager: SandboxManagerLike,
  config: SandboxPolicy,
  operation: "mkdir" | "write" | "read" | "access",
  path: string,
  input?: string,
  signal?: AbortSignal,
  commandId?: string,
): Promise<Buffer> {
  const result = await executeSandboxProgram(manager, {
    policy: config,
    program: {
      executable: process.execPath,
      args: ["-e", FILE_OPERATION_HELPER, operation, Buffer.from(path).toString("base64")],
    },
    signal,
    stdin: input === undefined ? "ignore" : input,
    timeoutMs: DEFAULT_FILE_OPERATION_TIMEOUT_MS,
    ...(commandId === undefined ? {} : { commandId }),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.toString("utf8") || `sandboxed file operation exited with ${result.exitCode}`,
    );
  }
  return result.stdout;
}

export type SandboxedFileOperations = WriteOperations & EditOperations;

export function createSandboxedFileOperations(
  manager: SandboxManagerLike,
  baseConfig: SandboxPolicy,
  writePaths: readonly string[] = [],
  signal?: AbortSignal,
  commandId?: string,
): SandboxedFileOperations {
  const config = fileOperationConfig(baseConfig, writePaths);
  return {
    mkdir: async (path) => {
      await runSandboxedFileOperation(manager, config, "mkdir", path, undefined, signal, commandId);
    },
    writeFile: async (path, content) => {
      await runSandboxedFileOperation(manager, config, "write", path, content, signal, commandId);
    },
    readFile: (path) =>
      runSandboxedFileOperation(manager, config, "read", path, undefined, signal, commandId),
    access: async (path) => {
      await runSandboxedFileOperation(
        manager,
        config,
        "access",
        path,
        undefined,
        signal,
        commandId,
      );
    },
  };
}
