import { type ChildProcess, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import {
  type SandboxRuntimeConfig,
  SandboxManager as SrtManager,
} from "@anthropic-ai/sandbox-runtime";
import { effectiveNetworkAuthority, validateNetworkPolicy } from "../config.ts";
import { expandSymlinkAliases, hasGlobSyntax } from "../filesystem-policy.ts";
import { normalizeNetworkHost } from "../network-host.ts";
import {
  type ExecutionNetwork,
  projectExecutionNetwork,
  type SandboxBackendState,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxManagerLike,
  type SandboxPolicy,
} from "../sandbox-policy.ts";
import { errorMessage } from "../unknown-value.ts";
import { SandboxConnectGuard, shouldBypassParentProxy } from "./connect-guard.ts";
import { srtProcessCoordinator } from "./srt-coordinator.ts";

export const SRT_ACTIVATION_TIMEOUT_MS = 15_000;

const DEFAULT_STDOUT_BOUND = 16 * 1024 * 1024;
const DEFAULT_STDERR_BOUND = 1 * 1024 * 1024;
const POSIX_SHELL = "/bin/bash";

/** Bounded wait for asynchronously-delivered denial events after a failure. */
const DENIAL_DRAIN_TIMEOUT_MS = 1_000;
const DENIAL_DRAIN_POLL_MS = 100;

// SRT's manager is process-global. Keep one extension-owned parent guard next
// to that singleton so two registrations cannot start with different guards
// and then hand tickets to the wrong listener.
const processConnectGuard = new SandboxConnectGuard();

export type SrtRuntimeLike = Pick<
  typeof SrtManager,
  | "initialize"
  | "isSupportedPlatform"
  | "checkDependenciesAsync"
  | "wrapWithSandboxArgv"
  | "updateConfig"
  | "cleanupAfterCommand"
  | "reset"
  | "getSandboxViolationStore"
>;

/** State mirrors SRT's own process-global mutable singleton. */
const processSandboxState: {
  basePolicy?: SandboxPolicy;
  initialized: boolean;
  networkAuthorize?: SandboxExecutionRequest["networkAuthorize"];
  networkSignal?: AbortSignal;
  networkExecution?: { requiredNetwork: ExecutionNetwork };
  connectGuard?: SandboxConnectGuard;
} = { initialized: false };

function sandboxUnavailable(reason: string): Error {
  return new Error(`pi-permissions sandbox unavailable: ${reason}`);
}

function poisonedSandboxUnavailable(): Error {
  return sandboxUnavailable(srtProcessCoordinator.poisonedError().message);
}

function lifecycleFailure(stage: "cleanup" | "restore", afterCommandFailure: boolean): Error {
  return sandboxUnavailable(
    afterCommandFailure ? `SRT ${stage} failed after command failure` : `SRT ${stage} failed`,
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === "aborted";
}

function clearSandboxExecutionState(): void {
  processSandboxState.initialized = false;
  processSandboxState.basePolicy = undefined;
  processSandboxState.networkAuthorize = undefined;
  processSandboxState.networkSignal = undefined;
  processSandboxState.networkExecution = undefined;
}

export function assertSrtPolicySupported(
  policy: SandboxPolicy,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "linux") return;
  const unsupported = [...policy.filesystem.denyRead, ...policy.filesystem.denyWrite].filter(
    hasGlobSyntax,
  );
  if (unsupported.length > 0) {
    throw sandboxUnavailable(
      `Linux SRT cannot enforce glob deny rules: ${[...new Set(unsupported)].join(", ")}`,
    );
  }
}

/**
 * True only when the guard has a live listen port (`parentProxyUrl` is set
 * after successful `start()`). Unstarted guards stay `undefined` → no weaker
 * isolation, no parentProxy URL.
 */
function parentProxyActive(connectGuard?: SandboxConnectGuard): boolean {
  return connectGuard?.parentProxyUrl !== undefined;
}

/**
 * Native SRT config only — never network.mode (pristine 0.0.77).
 * When connect-guard supplies parentProxy, inject the public
 * enableWeakerNetworkIsolation so Go TLS (gh/gcloud/…) can reach trustd
 * inside the seatbelt; documented security tradeoff in AGENTS.md.
 */
function toSrtConfig(
  policy: SandboxPolicy,
  connectGuard?: SandboxConnectGuard,
): SandboxRuntimeConfig {
  assertSrtPolicySupported(policy);
  const authority = effectiveNetworkAuthority(policy.network);
  // Codex workspace-write treats $TMPDIR as a platform default write root
  // (FileSystemSpecialPath::Tmpdir), not a user writable_roots entry. Inject
  // it only at the SRT enforcement seam so Engine path checks and delegation
  // intersections keep seeing the user's own allowWrite list. Gated on a
  // non-empty user write set so read-only profiles and resolved-empty
  // delegation intersections stay zero-write.
  const allowWrite =
    policy.filesystem.allowWrite.length === 0
      ? [...policy.filesystem.allowWrite]
      : [...new Set([...policy.filesystem.allowWrite, ...expandSymlinkAliases(tmpdir())])];
  return {
    filesystem: {
      denyRead: [...policy.filesystem.denyRead],
      allowWrite,
      denyWrite: [...policy.filesystem.denyWrite],
    },
    network: {
      // The callback is the sole authorization seam in production. Keeping
      // SRT's own allow list empty forces every unlisted request through the
      // same Engine decision and lets the parent guard bind a DNS answer.
      allowedDomains: connectGuard ? [] : [...policy.network.allowedDomains],
      deniedDomains: [...policy.network.deniedDomains],
      ...(authority.localBinding ? { allowLocalBinding: true } : {}),
      ...(connectGuard?.parentProxyUrl
        ? {
            parentProxy: {
              http: connectGuard.parentProxyUrl,
              https: connectGuard.parentProxyUrl,
              noProxy: "",
            },
          }
        : {}),
    },
    ...(parentProxyActive(connectGuard) ? { enableWeakerNetworkIsolation: true } : {}),
  };
}

/** Per-wrap native customConfig; empty when no parentProxy seam. */
function wrapCustomConfig(connectGuard?: SandboxConnectGuard): Record<string, unknown> | undefined {
  return parentProxyActive(connectGuard) ? { enableWeakerNetworkIsolation: true } : undefined;
}

async function askNetwork(params: { host: string; port?: number }): Promise<boolean> {
  if (params.port === undefined || !Number.isInteger(params.port)) return false;
  const networkAuthorize = processSandboxState.networkAuthorize;
  const networkSignal = processSandboxState.networkSignal;
  const networkExecution = processSandboxState.networkExecution;
  const connectGuard = processSandboxState.connectGuard;
  if (!networkAuthorize || !networkExecution) return false;
  const authorization = await networkAuthorize({
    host: params.host,
    port: params.port,
    signal: networkSignal,
  });
  if (!authorization?.allowed || !authorization.endpoint) return false;
  if (
    networkSignal?.aborted ||
    processSandboxState.networkAuthorize !== networkAuthorize ||
    processSandboxState.networkSignal !== networkSignal ||
    processSandboxState.networkExecution !== networkExecution ||
    processSandboxState.connectGuard !== connectGuard
  ) {
    return false;
  }
  const requestedHost = normalizeNetworkHost(params.host);
  const endpointHost = normalizeNetworkHost(authorization.endpoint.host);
  if (
    !requestedHost ||
    !endpointHost ||
    requestedHost !== endpointHost ||
    authorization.endpoint.port !== params.port
  ) {
    return false;
  }
  // SRT's parent-proxy seam unconditionally bypasses its parent for loopback
  // destinations. The approved endpoint is still validated above (and
  // localhost is restricted to frozen loopback DNS answers by NetworkBoundary),
  // but no guard ticket can be consumed on this third-party runtime path.
  if (shouldBypassParentProxy(requestedHost, undefined)) return true;
  return connectGuard?.issue(authorization.endpoint) ?? false;
}

function clonePolicy(policy: SandboxPolicy): SandboxPolicy {
  return structuredClone(policy);
}

function samePolicy(left: SandboxPolicy, right: SandboxPolicy): boolean {
  const withoutProjection = (policy: SandboxPolicy) => {
    const { execution: _execution, ...network } = policy.network;
    return { ...policy, network };
  };
  return JSON.stringify(withoutProjection(left)) === JSON.stringify(withoutProjection(right));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function serializeProgram(
  program: SandboxExecutionRequest["program"],
  options: { forceProxyForLocalTargets?: boolean } = {},
): string {
  if (!isAbsolute(program.executable)) {
    throw sandboxUnavailable(`program executable must be absolute: ${program.executable}`);
  }
  const command = [program.executable, ...program.args].map(shellQuote).join(" ");
  // On POSIX, SRT bakes its private-target NO_PROXY list into the outer
  // sandbox command (`--setenv` on bwrap / env assignments on seatbelt).
  // A request.env override therefore cannot reach the actual tool. Prefix
  // the tool itself with empty assignments whenever the sandbox-owned
  // callback is active, so every local/private target (including the
  // explicit allowLocalBinding mode) traverses the authenticated parent
  // guard. Windows intentionally removes NO_PROXY from its child overlay,
  // so there is no equivalent prefix there.
  if (options.forceProxyForLocalTargets && process.platform !== "win32") {
    return `NO_PROXY="" no_proxy="" ${command}`;
  }
  return command;
}

/**
 * Signal a sandbox-owned child tree only while the parent still owns a live
 * identity. After observed exit/close the numeric PID/PGID may already have
 * been reused; those windows must not emit signals.
 */
function killProcessTree(
  child: ChildProcess,
  lifecycle?: { exitObserved?: boolean; closeObserved?: boolean },
): void {
  if (lifecycle?.closeObserved || lifecycle?.exitObserved) return;
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function executeWrappedArgv(
  wrapped: { argv: string[]; env: NodeJS.ProcessEnv },
  request: SandboxExecutionRequest,
  signal: AbortSignal,
): Promise<SandboxExecutionResult> {
  return new Promise((resolve, reject) => {
    if (wrapped.argv.length < 1 || !isAbsolute(wrapped.argv[0] ?? "")) {
      reject(sandboxUnavailable("SRT returned an invalid executable argv"));
      return;
    }
    const stdinMode = request.stdin === undefined || request.stdin === "ignore" ? "ignore" : "pipe";
    const child = spawn(wrapped.argv[0] as string, wrapped.argv.slice(1), {
      cwd: request.cwd,
      env:
        request.envMode === "replace"
          ? (request.env ?? {})
          : { ...wrapped.env, ...(request.env ?? {}) },
      detached: true,
      shell: false,
      stdio: [stdinMode, "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputError: Error | undefined;
    let childError: Error | undefined;
    let settled = false;
    let aborted = signal.aborted;
    let exitObserved = false;
    let closeObserved = false;
    const lifecycle = {
      get exitObserved() {
        return exitObserved;
      },
      get closeObserved() {
        return closeObserved;
      },
    };

    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      aborted = true;
      killProcessTree(child, lifecycle);
    };
    const ingest = (
      chunks: Buffer[],
      chunk: Buffer,
      currentBytes: number,
      maximumBytes: number | undefined,
      streamName: "stdout" | "stderr",
      onChunk?: (chunk: Buffer) => void,
    ): number => {
      if (aborted || signal.aborted) return currentBytes;
      onChunk?.(chunk);
      const nextBytes = currentBytes + chunk.length;
      const bound =
        maximumBytes ?? (streamName === "stdout" ? DEFAULT_STDOUT_BOUND : DEFAULT_STDERR_BOUND);
      if (nextBytes > bound) {
        outputError = new Error(`${streamName} exceeded the sandbox output bound`);
        killProcessTree(child, lifecycle);
        return bound;
      }
      chunks.push(chunk);
      return nextBytes;
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (aborted) onAbort();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes = ingest(
        stdout,
        chunk,
        stdoutBytes,
        request.maxStdoutBytes,
        "stdout",
        request.onStdout,
      );
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes = ingest(
        stderr,
        chunk,
        stderrBytes,
        request.maxStderrBytes,
        "stderr",
        request.onStderr,
      );
    });
    // Node emits `error` before `close` for spawn failures. Keep the error as
    // body evidence, but wait for `close` before releasing the SRT lease: an
    // error is not proof that the child and its stdio have fully terminated.
    child.once("error", (error) => {
      childError = error;
    });
    child.once("exit", () => {
      exitObserved = true;
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      exitObserved = true;
      closeObserved = true;
      cleanup();
      if (aborted || signal.aborted) {
        reject(new Error("aborted"));
      } else if (outputError) {
        reject(outputError);
      } else if (childError) {
        reject(childError);
      } else {
        resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode });
      }
    });
    if (stdinMode === "pipe" && child.stdin) {
      child.stdin.end(typeof request.stdin === "string" ? request.stdin : undefined);
    }
  });
}

function deadlineSignal(
  timeoutMs: number | undefined,
  callerSignal?: AbortSignal,
): {
  signal: AbortSignal;
  timedOut: () => boolean;
} {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return { signal: callerSignal ?? new AbortController().signal, timedOut: () => false };
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  return { signal, timedOut: () => timeout.aborted && !callerSignal?.aborted };
}

/**
 * Adapter around SRT's process-global mutable manager. The public seam is an
 * execution descriptor; only this module knows that SRT currently needs a
 * safely quoted command string before returning a spawn argv.
 */
export class SrtSandboxManager implements SandboxManagerLike {
  private readonly connectGuard: SandboxConnectGuard | undefined;

  constructor(
    private readonly runtime: SrtRuntimeLike = SrtManager,
    connectGuard?: SandboxConnectGuard,
  ) {
    // Test doubles may inject a guard to exercise the seam. The real SRT
    // singleton must always use the one process-owned guard: a second Pi
    // registration must not close or mint tickets for another registration's
    // listener while the coordinator serializes the shared runtime.
    this.connectGuard = runtime === SrtManager ? processConnectGuard : connectGuard;
  }

  async initialize(config: SandboxPolicy): Promise<void> {
    await this.activate(config);
  }

  isHealthy(): boolean {
    return (
      processSandboxState.initialized &&
      !srtProcessCoordinator.isPoisoned &&
      !srtProcessCoordinator.isDraining
    );
  }

  async activate(config: SandboxPolicy): Promise<void> {
    const snapshot = clonePolicy(config);
    const activation = deadlineSignal(SRT_ACTIVATION_TIMEOUT_MS);
    return srtProcessCoordinator.runExclusiveDetached(
      async () => {
        let failedStage: "reset" | undefined;
        try {
          try {
            await this.resetSrt();
          } catch (resetError) {
            failedStage = "reset";
            throw resetError;
          }
          if (activation.signal.aborted) throw new Error("aborted");
          if (!this.runtime.isSupportedPlatform()) {
            throw sandboxUnavailable(`unsupported platform: ${process.platform}`);
          }
          const dependency = await this.runtime.checkDependenciesAsync({
            command: process.execPath,
            args: ["-e", ""],
          });
          if (activation.signal.aborted) throw new Error("aborted");
          if (dependency.errors.length > 0) {
            throw sandboxUnavailable(dependency.errors.join("; "));
          }
          validateNetworkPolicy(snapshot.network);
          await this.connectGuard?.start();
          if (activation.signal.aborted) throw new Error("aborted");
          processSandboxState.connectGuard = this.connectGuard;
          await this.runtime.initialize(toSrtConfig(snapshot, this.connectGuard), askNetwork, true);
          if (activation.signal.aborted) {
            throw new Error("aborted");
          }
          processSandboxState.basePolicy = snapshot;
          processSandboxState.initialized = true;
          srtProcessCoordinator.clearPoison();
        } catch (error) {
          let resetFailed = false;
          try {
            await this.resetSrt();
          } catch {
            resetFailed = true;
          }
          if (processSandboxState.connectGuard === this.connectGuard) {
            processSandboxState.connectGuard = undefined;
          }
          clearSandboxExecutionState();
          const cancelled = activation.signal.aborted && isAbortError(error);
          if (resetFailed || failedStage === "reset") {
            srtProcessCoordinator.markPoisoned("reset");
            throw sandboxUnavailable("SRT reset failed");
          }
          if (!cancelled) srtProcessCoordinator.markPoisoned("initialization");
          throw error instanceof Error ? error : sandboxUnavailable(errorMessage(error));
        }
      },
      activation.signal,
      () => {
        clearSandboxExecutionState();
        return new Error(
          activation.timedOut() ? `timeout:${SRT_ACTIVATION_TIMEOUT_MS / 1000}` : "aborted",
        );
      },
      { allowPoisoned: true },
    );
  }

  async reset(): Promise<void> {
    const activation = deadlineSignal(SRT_ACTIVATION_TIMEOUT_MS);
    return srtProcessCoordinator.runExclusiveDetached(
      async () => {
        let failed = false;
        try {
          await this.resetSrt();
        } catch {
          failed = true;
        }
        if (processSandboxState.connectGuard === this.connectGuard) {
          processSandboxState.connectGuard = undefined;
        }
        clearSandboxExecutionState();
        if (failed) {
          srtProcessCoordinator.markPoisoned("reset");
          throw sandboxUnavailable("SRT reset failed");
        }
      },
      activation.signal,
      () => {
        clearSandboxExecutionState();
        return new Error(
          activation.timedOut() ? `timeout:${SRT_ACTIVATION_TIMEOUT_MS / 1000}` : "aborted",
        );
      },
      { allowPoisoned: true },
    );
  }

  async execute(input: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    // Capture before waiting for the process lease: callers cannot mutate a queued attempt.
    const request = { ...input, policy: clonePolicy(input.policy) };
    if (srtProcessCoordinator.isPoisoned) {
      throw poisonedSandboxUnavailable();
    }
    const { signal, timedOut } = deadlineSignal(request.timeoutMs, request.signal);
    return srtProcessCoordinator.runExclusiveDetached(
      async () => {
        if (srtProcessCoordinator.isPoisoned) {
          throw poisonedSandboxUnavailable();
        }
        if (signal.aborted) throw new Error("aborted");
        const previousNetworkAuthorize = processSandboxState.networkAuthorize;
        const previousNetworkSignal = processSandboxState.networkSignal;
        const networkExecution = { requiredNetwork: projectExecutionNetwork(request.policy) };
        processSandboxState.networkAuthorize = request.networkAuthorize;
        processSandboxState.networkSignal = signal;
        processSandboxState.networkExecution = networkExecution;
        let operationError: unknown;
        let operationFailed = false;
        let result: SandboxExecutionResult | undefined;
        try {
          const initialResetError = this.resetExecutionFailure();
          if (initialResetError) throw initialResetError;
          if (signal.aborted) throw new Error("aborted");
          let base = processSandboxState.basePolicy;
          if (!processSandboxState.initialized || !base) {
            try {
              await this.initializeSrt(request.policy, signal);
              if (signal.aborted) throw new Error("aborted");
            } catch (error) {
              let resetFailed = false;
              try {
                await this.resetSrt();
              } catch {
                resetFailed = true;
              }
              clearSandboxExecutionState();
              if (resetFailed) {
                srtProcessCoordinator.markPoisoned("reset");
                throw sandboxUnavailable("SRT reset failed");
              }
              if (!(signal.aborted && isAbortError(error))) {
                srtProcessCoordinator.markPoisoned("initialization");
              }
              throw error instanceof Error ? error : sandboxUnavailable(errorMessage(error));
            }
            base = clonePolicy(request.policy);
            processSandboxState.basePolicy = base;
            processSandboxState.initialized = true;
          }
          const derived = clonePolicy(request.policy);
          assertSrtPolicySupported(derived);
          const changed = !samePolicy(base, derived);
          let bodyError: unknown;
          let bodyFailed = false;
          let lifecycleStage: "cleanup" | "restore" | undefined;
          try {
            if (changed) this.runtime.updateConfig(toSrtConfig(derived, this.connectGuard));
            const command = serializeProgram(request.program, {
              // Native SRT has no network.mode. With connect-guard the egress
              // path is parentProxy; without it, keep serializeProgram defaults.
              forceProxyForLocalTargets: request.networkAuthorize !== undefined,
            });
            const wrapped = await this.runtime.wrapWithSandboxArgv(
              command,
              POSIX_SHELL,
              wrapCustomConfig(this.connectGuard),
              signal,
              request.cwd,
              {
                ...(request.commandId === undefined ? {} : { commandId: request.commandId }),
                ...(request.commandText === undefined ? {} : { commandText: request.commandText }),
              },
            );
            if (signal.aborted) throw new Error("aborted");
            result = await executeWrappedArgv(wrapped, request, signal);
          } catch (error) {
            bodyError = error;
            bodyFailed = true;
          } finally {
            // Cleanup and policy restoration are independent obligations. A
            // cleanup throw must not skip restore, and either failure poisons
            // the singleton for the next execution.
            try {
              this.runtime.cleanupAfterCommand();
            } catch {
              lifecycleStage = "cleanup";
              srtProcessCoordinator.markPoisoned("cleanup");
            }
            if (changed) {
              try {
                this.runtime.updateConfig(toSrtConfig(base, this.connectGuard));
              } catch {
                lifecycleStage ??= "restore";
                srtProcessCoordinator.markPoisoned("restore");
              }
            }
          }
          if (lifecycleStage) {
            throw lifecycleFailure(lifecycleStage, bodyFailed);
          }
          if (bodyFailed) {
            throw bodyError;
          }
          if (!result) throw sandboxUnavailable("SRT executor returned no result");
        } catch (error) {
          operationFailed = true;
          operationError = error;
        }
        // This cleanup is intentionally outside initialization and command
        // cleanup. It cannot be skipped by either initialize or restore.
        if (processSandboxState.networkExecution === networkExecution) {
          processSandboxState.networkAuthorize = previousNetworkAuthorize;
          processSandboxState.networkSignal = previousNetworkSignal;
          processSandboxState.networkExecution = undefined;
        }
        const finalResetError = this.resetExecutionFailure();
        if (finalResetError) throw finalResetError;
        if (operationFailed) throw operationError;
        if (!result) throw sandboxUnavailable("SRT executor returned no result");
        return result;
      },
      signal,
      () => {
        return new Error(timedOut() ? `timeout:${(request.timeoutMs ?? 0) / 1000}` : "aborted");
      },
    );
  }

  describeState(): SandboxBackendState {
    return structuredClone({
      initialized: processSandboxState.initialized,
      healthy: this.isHealthy(),
      draining: srtProcessCoordinator.isDraining,
      ...(srtProcessCoordinator.isPoisoned
        ? { fault: srtProcessCoordinator.poisonedError().message }
        : {}),
      networkSupport: undefined,
      execution: processSandboxState.networkExecution ? "active-lifecycle" : "idle",
      requiredNetwork: processSandboxState.networkExecution?.requiredNetwork,
      nativeEnforcement: "unknown",
    });
  }

  /** Observe real quiescence, including detached cancellation drain; never reset or clear poison. */
  async waitForIdle(signal?: AbortSignal): Promise<void> {
    await srtProcessCoordinator.runExclusive(async () => {}, signal);
  }

  async readFailureDiagnostics(commandId: string): Promise<string | undefined> {
    if (srtProcessCoordinator.isPoisoned) return undefined;
    try {
      const store = this.runtime.getSandboxViolationStore();
      const deadline = Date.now() + DENIAL_DRAIN_TIMEOUT_MS;
      for (;;) {
        const observations = store.getViolationsForCommand(commandId);
        if (observations.length > 0) {
          const label =
            "SRT diagnostic observations (potentially sanitized or unrelated; not authorization evidence):\n";
          const lines = observations
            .slice(0, 16)
            .map(({ line }) => JSON.stringify(line.slice(0, 4096)).slice(1, -1));
          const text = label + lines.join("\n");
          const truncated =
            observations.length > 16 ||
            observations.some(({ line }) => line.length > 4096) ||
            text.length > 4084;
          return truncated ? `${text.slice(0, 4084)}\n[truncated]` : text;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return undefined;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(DENIAL_DRAIN_POLL_MS, remaining)),
        );
      }
    } catch {
      // Diagnostics must never replace the original execution error.
      return undefined;
    }
  }

  private async initializeSrt(config: SandboxPolicy, signal?: AbortSignal): Promise<void> {
    // Pristine SRT has no network.mode. Network authority is the Engine lease
    // plus connect-guard tickets on native parentProxy + empty allowlist.
    validateNetworkPolicy(config.network);
    if (!this.runtime.isSupportedPlatform()) {
      throw sandboxUnavailable(`unsupported platform: ${process.platform}`);
    }
    const dependency = await this.runtime.checkDependenciesAsync({
      command: process.execPath,
      args: ["-e", ""],
    });
    if (dependency.errors.length > 0) {
      throw sandboxUnavailable(dependency.errors.join("; "));
    }
    if (signal?.aborted) throw new Error("aborted");
    await this.connectGuard?.start();
    if (signal?.aborted) throw new Error("aborted");
    processSandboxState.connectGuard = this.connectGuard;
    await this.runtime.initialize(toSrtConfig(config, this.connectGuard), askNetwork, true);
  }

  private resetExecutionFailure(): Error | undefined {
    try {
      this.connectGuard?.resetExecution();
      return undefined;
    } catch {
      srtProcessCoordinator.markPoisoned("cleanup");
      return lifecycleFailure("cleanup", false);
    }
  }

  private async resetSrt(): Promise<void> {
    let failed = false;
    let failure: unknown;
    try {
      this.runtime.cleanupAfterCommand();
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      await this.runtime.reset();
    } catch (error) {
      failed = true;
      failure ??= error;
    }
    try {
      await this.connectGuard?.close();
    } catch (error) {
      failed = true;
      failure ??= error;
    }
    if (processSandboxState.connectGuard === this.connectGuard) {
      processSandboxState.connectGuard = undefined;
    }
    if (failed) throw failure instanceof Error ? failure : new Error("SRT reset failed");
  }
}
