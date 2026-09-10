import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
import {
  fingerprintValue,
  type NetworkAccess,
  validateNetworkAccess,
  validateNetworkPolicy,
} from "./config.ts";
import {
  createFilesystemPolicy,
  expandSymlinkAliases,
  hasGlobSyntax,
  resolveSandboxDenyPattern,
} from "./filesystem-policy.ts";
import { discoverGitMetadataProtectionRoots } from "./git-metadata.ts";
import { isNetworkPatternCoveredBy } from "./network-domain-pattern.ts";

/** An attempt's required network enforcement, not an authorization ledger. */
export type ExecutionNetwork =
  | { readonly kind: "restricted" }
  | { readonly kind: "proxy"; readonly inlineReview: boolean; readonly tls?: "system" }
  | { readonly kind: "direct" };

/** Pure projection of already-authorized policy, never a grant or a review decision. */
export function projectExecutionNetwork(policy: SandboxPolicy): ExecutionNetwork {
  const network = policy.network;
  const access = "access" in network ? validateNetworkAccess(network.access) : undefined;
  validateNetworkPolicy(network);
  const tls = network.macosTls === "system" ? { tls: "system" as const } : {};
  if (access?.kind !== "explicit")
    return Object.freeze({ kind: "proxy", inlineReview: true, ...tls });
  const hasAuthority =
    (network.enabled === true && !network.deniedDomains.includes("*")) ||
    network.allowedDomains.some(
      (allowed) =>
        !network.deniedDomains.some((denied) => isNetworkPatternCoveredBy(denied, allowed)),
    );
  if (!hasAuthority) return Object.freeze({ kind: "restricted" });
  if (access.transport === "direct") {
    if (network.enabled !== true)
      throw new Error("Direct requires whole-network authority, not a host grant");
    return Object.freeze({ kind: "direct" });
  }
  return Object.freeze({ kind: "proxy", inlineReview: false, ...tls });
}

/** Defensive derived evidence, shared by review and read-only status. Absent TLS means strict. */
export function describeExecutionNetwork(policy: SandboxPolicy) {
  const required = projectExecutionNetwork(policy);
  return {
    requestPath: policy.network.access?.kind ?? "inline-proxy",
    wholeNetwork: policy.network.enabled === true,
    hosts: [...policy.network.allowedDomains],
    denies: [...policy.network.deniedDomains],
    required,
    configuredTls: policy.network.macosTls ?? "strict",
    effectiveTls: required.kind === "proxy" && required.tls === "system" ? "system" : "strict",
    privateTargets:
      policy.network.allowPrivateTargets === true || policy.network.allowLocalBinding === true,
    localBindingAndInbound: policy.network.allowLocalBinding === true,
    helperEgressRisk: required.kind === "proxy" && required.tls === "system",
    delegated: policy.network.delegated === true,
    policyFingerprint: fingerprintValue(policy),
  };
}
export type NetworkPolicyView = ReturnType<typeof describeExecutionNetwork>;

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
  };
  network: {
    access?: NetworkAccess;
    enabled?: boolean;
    allowPrivateTargets?: boolean;
    macosTls?: "strict" | "system";
    /** Resolved finite child ceiling; never broad delegation consent. */
    delegated?: true;
    /** Engine-derived, immutable for this execution attempt; absent on base policies. */
    execution?: ExecutionNetwork;
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

/** An authoritative backend capability boundary, never inferred from diagnostic text. */
export type SandboxDenialCapability =
  | { kind: "filesystem"; operation: "write"; path: string }
  | { kind: "network"; host: string };

const SANDBOX_DENIAL_MARKERS =
  /operation not permitted|permission denied|read-only file system|sandbox denied|\bEPERM\b|\bEACCES\b|\bEROFS\b|connect tunnel failed/i;

/** Cheap failure pre-filter only; matching text is not proof of a sandbox denial. */
export function looksLikeSandboxDenial(text: string): boolean {
  return SANDBOX_DENIAL_MARKERS.test(text);
}

export interface SandboxBackendState {
  initialized: boolean;
  healthy: boolean;
  draining: boolean;
  fault?: string;
  networkSupport?: { apiVersion: number; platform: string; modes: readonly string[] };
  execution: "idle" | "active-lifecycle";
  requiredNetwork?: ExecutionNetwork;
  /** Public backend does not attest kernel installation or TLS success. */
  nativeEnforcement: "unknown";
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
  /** Live health of the backend process/coordinator, when available. */
  isHealthy?(): boolean;
  /** Wait for execution and detached cleanup/drain without mutation or fault recovery. */
  waitForIdle?(signal?: AbortSignal): Promise<void>;
  describeState?(): SandboxBackendState;
  reset(): Promise<void>;
  /**
   * After a failed execution, report the exact capability enforcement
   * denied for this invocation, only when the backend has authoritative
   * capability events. SRT diagnostics do not implement this seam, and a
   * capability fact alone never proves that a native action can safely replay.
   */
  classifyDenial?(commandId: string): Promise<SandboxDenialCapability | undefined>;
  /** Bounded observations for display only; never authorization or scope. */
  readFailureDiagnostics?(commandId: string): Promise<string | undefined>;
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
  return {
    ...config,
    filesystem: {
      ...config.filesystem,
      allowWrite: [...new Set([...config.filesystem.allowWrite, ...roots])],
    },
  };
}

export function createSandboxRuntimeConfig(
  config: PermissionsConfig["sandbox"],
  cwd: string,
  protectedWritePaths?: readonly string[],
  gitMetadataProtectionRoots: readonly string[] = [],
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
    ...new Set(gitMetadataProtectionRoots.flatMap((path) => expandSymlinkAliases(resolve(path)))),
  ];
  const metadataDenyWrite = metadataRoots.flatMap((root) => [
    root,
    join(root, "hooks"),
    join(root, "config"),
  ]);
  const finalDenyWrite = [...new Set([...denyWrite, ...gitAliases, ...metadataDenyWrite])];
  return {
    filesystem: {
      allowWrite: filesystem.allowWrite,
      denyRead,
      denyWrite: finalDenyWrite,
    },
    network: {
      ...("access" in config.network
        ? { access: validateNetworkAccess(config.network.access) }
        : {}),
      ...(config.network.enabled === undefined ? {} : { enabled: config.network.enabled }),
      ...(config.network.allowPrivateTargets === undefined
        ? {}
        : { allowPrivateTargets: config.network.allowPrivateTargets }),
      ...(config.network.macosTls === undefined ? {} : { macosTls: config.network.macosTls }),
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
  if (request.cwd === undefined) return manager.execute(request);
  const metadata = await discoverGitMetadataProtectionRoots(request.cwd);
  if (!metadata.ok) {
    throw new Error(`pi-permissions sandbox unavailable: ${metadata.reason}`);
  }
  const policy = policyWithGitMetadataProtection(request.policy, request.cwd, metadata.roots);
  return manager.execute(policy === request.policy ? request : { ...request, policy });
}

/** Add only current Git metadata deny rules to one execution's policy copy. */
function policyWithGitMetadataProtection(
  policy: SandboxPolicy,
  cwd: string,
  roots: readonly string[],
): SandboxPolicy {
  const metadataRoots = [...new Set(roots.flatMap((root) => expandSymlinkAliases(resolve(root))))];
  if (metadataRoots.length === 0) return policy;

  const denyWrite = [...policy.filesystem.denyWrite];
  const additions: string[] = [];
  for (const root of expandSymlinkAliases(resolve(cwd, ".git"))) {
    if (!denyWrite.includes(root)) additions.push(root);
  }
  for (const root of metadataRoots) {
    if (denyWrite.includes(root)) continue;
    additions.push(root, join(root, "hooks"), join(root, "config"));
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

export interface NativeFileOperationFailure {
  operation: "mkdir" | "write" | "read" | "access";
  path: string;
  cwd: string;
  contentWriteStarted: boolean;
  exitCode: number | null;
  error: string;
}

export type NativeFileOperationEvent =
  | ({ kind: "failed" } & NativeFileOperationFailure)
  | { kind: "started" | "succeeded" };

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

export type SandboxedFileOperations = WriteOperations & EditOperations;

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
