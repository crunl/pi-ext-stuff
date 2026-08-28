import { type ChildProcess, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  type SandboxRuntimeConfig,
  SandboxManager as SrtManager,
} from "@anthropic-ai/sandbox-runtime";
import { hasGlobSyntax } from "../filesystem-policy.ts";
import type {
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxManagerLike,
  SandboxPolicy,
} from "../sandbox.ts";
import { errorMessage } from "../unknown-value.ts";
import { srtProcessCoordinator } from "./srt-coordinator.ts";

export const SRT_ACTIVATION_TIMEOUT_MS = 15_000;

const DEFAULT_STDOUT_BOUND = 16 * 1024 * 1024;
const DEFAULT_STDERR_BOUND = 1 * 1024 * 1024;
const POSIX_SHELL = "/bin/bash";

export type SrtRuntimeLike = Pick<
  typeof SrtManager,
  | "initialize"
  | "isSupportedPlatform"
  | "checkDependenciesAsync"
  | "wrapWithSandboxArgv"
  | "updateConfig"
  | "cleanupAfterCommand"
  | "reset"
>;

/** State mirrors SRT's own process-global mutable singleton. */
const processSandboxState: {
  basePolicy?: SandboxPolicy;
  initialized: boolean;
} = { initialized: false };

function sandboxUnavailable(reason: string): Error {
  return new Error(`pi-permissions sandbox unavailable: ${reason}`);
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

function toSrtConfig(policy: SandboxPolicy, allowGitConfig = false): SandboxRuntimeConfig {
  assertSrtPolicySupported(policy);
  return {
    filesystem: {
      denyRead: [...policy.filesystem.denyRead],
      allowWrite: [...policy.filesystem.allowWrite],
      denyWrite: [...policy.filesystem.denyWrite],
      ...(allowGitConfig ? { allowGitConfig: true } : {}),
    },
    network: {
      allowedDomains: [...policy.network.allowedDomains],
      deniedDomains: [...policy.network.deniedDomains],
    },
  };
}

function clonePolicy(policy: SandboxPolicy): SandboxPolicy {
  return structuredClone(policy);
}

function samePolicy(left: SandboxPolicy, right: SandboxPolicy): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function serializeProgram(program: SandboxExecutionRequest["program"]): string {
  if (!isAbsolute(program.executable)) {
    throw sandboxUnavailable(`program executable must be absolute: ${program.executable}`);
  }
  return [program.executable, ...program.args].map(shellQuote).join(" ");
}

function killProcessTree(child: ChildProcess): void {
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
    let settled = false;
    let aborted = signal.aborted;

    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      aborted = true;
      killProcessTree(child);
    };
    const ingest = (
      chunks: Buffer[],
      chunk: Buffer,
      currentBytes: number,
      maximumBytes: number | undefined,
      streamName: "stdout" | "stderr",
      onChunk?: (chunk: Buffer) => void,
    ): number => {
      onChunk?.(chunk);
      const nextBytes = currentBytes + chunk.length;
      const bound =
        maximumBytes ?? (streamName === "stdout" ? DEFAULT_STDOUT_BOUND : DEFAULT_STDERR_BOUND);
      if (nextBytes > bound) {
        outputError = new Error(`${streamName} exceeded the sandbox output bound`);
        killProcessTree(child);
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
    child.once("error", (error) => finishError(outputError ?? error));
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted || signal.aborted) {
        reject(new Error("aborted"));
      } else if (outputError) {
        reject(outputError);
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
  constructor(private readonly runtime: SrtRuntimeLike = SrtManager) {}

  async initialize(config: SandboxPolicy): Promise<void> {
    await this.activate(config);
  }

  async activate(config: SandboxPolicy): Promise<void> {
    const snapshot = clonePolicy(config);
    const activation = deadlineSignal(SRT_ACTIVATION_TIMEOUT_MS);
    return srtProcessCoordinator.runExclusiveDetached(
      async () => {
        try {
          await this.resetSrt();
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
          await this.runtime.initialize(toSrtConfig(snapshot));
          if (activation.signal.aborted) {
            await this.resetSrt();
            throw new Error("aborted");
          }
          processSandboxState.basePolicy = snapshot;
          processSandboxState.initialized = true;
          srtProcessCoordinator.clearPoison();
        } catch (error) {
          processSandboxState.initialized = false;
          processSandboxState.basePolicy = undefined;
          srtProcessCoordinator.markPoisoned();
          throw error instanceof Error ? error : sandboxUnavailable(errorMessage(error));
        }
      },
      activation.signal,
      () => {
        processSandboxState.initialized = false;
        processSandboxState.basePolicy = undefined;
        srtProcessCoordinator.markPoisoned();
        return new Error(
          activation.timedOut() ? `timeout:${SRT_ACTIVATION_TIMEOUT_MS / 1000}` : "aborted",
        );
      },
    );
  }

  async reset(): Promise<void> {
    const activation = deadlineSignal(SRT_ACTIVATION_TIMEOUT_MS);
    return srtProcessCoordinator.runExclusiveDetached(
      async () => {
        try {
          await this.resetSrt();
        } catch (error) {
          srtProcessCoordinator.markPoisoned();
          throw sandboxUnavailable(errorMessage(error));
        } finally {
          processSandboxState.initialized = false;
          processSandboxState.basePolicy = undefined;
        }
      },
      activation.signal,
      () => {
        srtProcessCoordinator.markPoisoned();
        processSandboxState.initialized = false;
        processSandboxState.basePolicy = undefined;
        return new Error(
          activation.timedOut() ? `timeout:${SRT_ACTIVATION_TIMEOUT_MS / 1000}` : "aborted",
        );
      },
    );
  }

  async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    if (srtProcessCoordinator.isPoisoned) {
      throw sandboxUnavailable("executor is poisoned after a previous cleanup failure");
    }
    const { signal, timedOut } = deadlineSignal(request.timeoutMs, request.signal);
    return srtProcessCoordinator.runExclusiveDetached(
      async () => {
        if (srtProcessCoordinator.isPoisoned) {
          throw sandboxUnavailable("executor is poisoned after a previous cleanup failure");
        }
        let base = processSandboxState.basePolicy;
        if (!processSandboxState.initialized || !base) {
          try {
            await this.initializeSrt(request.policy, signal);
            if (signal.aborted) {
              processSandboxState.initialized = false;
              processSandboxState.basePolicy = undefined;
              await this.resetSrt();
              throw new Error("aborted");
            }
          } catch (error) {
            srtProcessCoordinator.markPoisoned();
            throw error instanceof Error ? error : sandboxUnavailable(errorMessage(error));
          }
          base = clonePolicy(request.policy);
          processSandboxState.basePolicy = base;
          processSandboxState.initialized = true;
        }
        if (signal.aborted) throw new Error("aborted");
        const derived = clonePolicy(request.policy);
        assertSrtPolicySupported(derived);
        const changed = !samePolicy(base, derived);
        let bodyError: unknown;
        let bodyFailed = false;
        let result: SandboxExecutionResult | undefined;
        let lifecycleError: unknown;
        try {
          if (changed || request.allowGitConfig) {
            this.runtime.updateConfig(toSrtConfig(derived, request.allowGitConfig === true));
          }
          const command = serializeProgram(request.program);
          const wrapped = await this.runtime.wrapWithSandboxArgv(
            command,
            POSIX_SHELL,
            undefined,
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
          try {
            this.runtime.cleanupAfterCommand();
            if (changed || request.allowGitConfig) this.runtime.updateConfig(toSrtConfig(base));
          } catch (error) {
            lifecycleError = error;
            srtProcessCoordinator.markPoisoned();
          }
        }
        if (lifecycleError && !bodyFailed) {
          throw sandboxUnavailable(`SRT cleanup failed: ${errorMessage(lifecycleError)}`);
        }
        if (lifecycleError && bodyFailed) {
          throw sandboxUnavailable(
            `SRT cleanup failed after command failure: ${errorMessage(lifecycleError)}`,
          );
        }
        if (bodyFailed) {
          throw bodyError;
        }
        if (!result) throw sandboxUnavailable("SRT executor returned no result");
        return result;
      },
      signal,
      () => {
        srtProcessCoordinator.markPoisoned();
        return new Error(timedOut() ? `timeout:${(request.timeoutMs ?? 0) / 1000}` : "aborted");
      },
    );
  }

  private async initializeSrt(config: SandboxPolicy, signal?: AbortSignal): Promise<void> {
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
    await this.runtime.initialize(toSrtConfig(config));
  }

  private async resetSrt(): Promise<void> {
    this.runtime.cleanupAfterCommand();
    await this.runtime.reset();
  }
}
