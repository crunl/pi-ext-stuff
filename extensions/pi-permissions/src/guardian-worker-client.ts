import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { copyGuardianEvidenceScope, type GuardianEvidenceScope } from "./sandbox.ts";

/**
 * The Guardian worker is deliberately a process boundary.  In particular,
 * callers must not replace this with the in-process SRT singleton: SRT's
 * manager and coordinator are process-global, and a Guardian request can be
 * made while the main tool is holding that coordinator.
 */

export const DEFAULT_GUARDIAN_WORKER_TIMEOUT_MS = 30_000;
export const GUARDIAN_WORKER_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const GUARDIAN_WORKER_MAX_REQUEST_BYTES = 256 * 1024;
export const GUARDIAN_WORKER_MAX_STDERR_BYTES = 64 * 1024;

const DEFAULT_WORKER_PATH = fileURLToPath(new URL("./guardian-worker.mjs", import.meta.url));
const WORKER_TERMINATE_WAIT_MS = 1_000;
// SRT 0.0.74's reset bridge may take up to 1.5s. Keep graceful shutdown
// separate from hard request cancellation and leave bounded recovery margin.
const WORKER_SHUTDOWN_TIMEOUT_MS = 3_000;
const MAX_ID_LENGTH = 128;

export interface GuardianWorkerProgram {
  executable: string;
  args: readonly string[];
}

export interface GuardianWorkerExecutionRequest {
  program: GuardianWorkerProgram;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  commandId?: string;
  commandText?: string;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface GuardianWorkerExecutionResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

export interface GuardianWorkerClientOptions {
  workerPath?: string;
  timeoutMs?: number;
  maxFrameBytes?: number;
  spawnProcess?: GuardianWorkerSpawn;
}

export type GuardianWorkerSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export class GuardianWorkerAbortError extends Error {
  constructor(message = "Guardian worker request aborted") {
    super(message);
    this.name = "GuardianWorkerAbortError";
  }
}

/** A worker/transport/SRT lifecycle failure that must abort the review. */
export class GuardianWorkerInfrastructureError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "GuardianWorkerInfrastructureError";
    if (cause !== undefined) Object.assign(this, { cause });
  }
}

export class GuardianWorkerTimeoutError extends GuardianWorkerInfrastructureError {
  constructor(timeoutMs: number) {
    super(`Guardian worker request timed out after ${timeoutMs}ms`);
    this.name = "GuardianWorkerTimeoutError";
  }
}

export class GuardianWorkerProtocolError extends GuardianWorkerInfrastructureError {
  constructor(message: string) {
    super(`Guardian worker protocol error: ${message}`);
    this.name = "GuardianWorkerProtocolError";
  }
}

type WorkerRequest = {
  type: "bootstrap" | "execute" | "cancel" | "shutdown";
  id?: string;
  evidenceScope?: GuardianEvidenceScope;
  authorityFingerprint?: string;
  cwd?: string;
  program?: GuardianWorkerProgram;
  timeoutMs?: number;
  commandId?: string;
  commandText?: string;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
};

type WorkerResponse = {
  type: "result" | "error";
  id: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  error?: string;
};

interface PendingRequest {
  readonly resolve: (result: GuardianWorkerExecutionResult) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  readonly onAbort: () => void;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  timer?: ReturnType<typeof setTimeout>;
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.platform === "win32" ? (process.env.Path ?? "") : "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: tmpdir(),
    TMPDIR: tmpdir(),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
  };
  // Windows' sandbox launcher needs these names to locate system components.
  // They are not credentials and are copied only when present.
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "ComSpec"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function killProcessGroup(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // The isolated Guardian evidence surface is intentionally not exposed on
    // Windows until the worker -> runner tree can be proven safe to kill.
    // Keep this direct fallback for defensive cleanup if a worker is already
    // present (for example, a future caller bypasses that platform gate).
    try {
      child.kill("SIGKILL");
    } catch {
      // The worker already exited.
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The worker already exited.
    }
  }
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(120_000, Math.floor(value));
}

function boundedOutput(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(8 * 1024 * 1024, Math.floor(value));
}

function canonicalAbsolute(value: string, label: string): string {
  if (!isAbsolute(value)) throw new GuardianWorkerProtocolError(`${label} must be absolute`);
  try {
    return realpathSync(value);
  } catch {
    throw new GuardianWorkerProtocolError(`${label} is unavailable`);
  }
}

function frame(value: WorkerRequest): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new GuardianWorkerProtocolError("request is not serializable");
  }
  return `${encoded}\n`;
}

function decodeBase64(value: string | undefined, label: string): Buffer {
  if (typeof value !== "string") throw new GuardianWorkerProtocolError(`missing ${label}`);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new GuardianWorkerProtocolError(`invalid ${label}`);
  }
  return Buffer.from(value, "base64");
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.type === "result" || record.type === "error") &&
    typeof record.id === "string" &&
    record.id.length > 0 &&
    record.id.length <= MAX_ID_LENGTH
  );
}

/**
 * A small, bounded JSON-lines RPC client.  The client owns the worker
 * lifecycle; cancellation and protocol failures terminate the entire worker
 * so no detached SRT child or pending request can survive the review.
 */
export class GuardianWorkerClient {
  private readonly evidenceScope: GuardianEvidenceScope;
  private readonly workerPath: string;
  private readonly timeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly spawnProcess: GuardianWorkerSpawn;
  private child?: ChildProcess;
  private starting?: Promise<ChildProcess>;
  private output = "";
  private stderrBytes = 0;
  private sequence = 0;
  private closed = false;
  private closing?: Promise<void>;
  private terminalFailure?: GuardianWorkerInfrastructureError;
  private terminalFailureReported = false;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(evidenceScope: GuardianEvidenceScope, options: GuardianWorkerClientOptions = {}) {
    this.evidenceScope = copyGuardianEvidenceScope(evidenceScope);
    this.workerPath = options.workerPath ?? DEFAULT_WORKER_PATH;
    this.timeoutMs = boundedTimeout(options.timeoutMs, DEFAULT_GUARDIAN_WORKER_TIMEOUT_MS);
    this.maxFrameBytes = Math.min(
      GUARDIAN_WORKER_MAX_FRAME_BYTES,
      Math.max(4 * 1024, Math.floor(options.maxFrameBytes ?? GUARDIAN_WORKER_MAX_FRAME_BYTES)),
    );
    this.spawnProcess =
      options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  }

  async execute(request: GuardianWorkerExecutionRequest): Promise<GuardianWorkerExecutionResult> {
    if (this.closed) throw new GuardianWorkerProtocolError("client is closed");
    if (this.terminalFailure) throw this.terminalFailure;
    if (request.signal?.aborted) throw new GuardianWorkerAbortError();
    if (!request.cwd || typeof request.cwd !== "string") {
      throw new GuardianWorkerProtocolError("missing working directory");
    }
    if (
      !request.program ||
      typeof request.program.executable !== "string" ||
      !Array.isArray(request.program.args)
    ) {
      throw new GuardianWorkerProtocolError("invalid program");
    }
    if (
      request.program.args.length > 64 ||
      request.program.args.some((arg) => typeof arg !== "string")
    ) {
      throw new GuardianWorkerProtocolError("invalid program arguments");
    }
    const canonicalCwd = canonicalAbsolute(request.cwd, "working directory");
    const canonicalExecutable = canonicalAbsolute(
      request.program.executable,
      "reviewer worker executable",
    );

    const id = `g-${++this.sequence}`;
    if (id.length > MAX_ID_LENGTH) throw new GuardianWorkerProtocolError("request id overflow");
    const maxStdoutBytes = boundedOutput(request.maxStdoutBytes, 5 * 1024 * 1024);
    const maxStderrBytes = boundedOutput(request.maxStderrBytes, GUARDIAN_WORKER_MAX_STDERR_BYTES);
    const requestFrame = frame({
      type: "execute",
      id,
      cwd: canonicalCwd,
      program: {
        executable: canonicalExecutable,
        args: [...request.program.args],
      },
      timeoutMs: boundedTimeout(request.timeoutMs, this.timeoutMs),
      ...(request.commandId === undefined ? {} : { commandId: request.commandId }),
      ...(request.commandText === undefined ? {} : { commandText: request.commandText }),
      authorityFingerprint: this.evidenceScope.authorityFingerprint,
      maxStdoutBytes,
      maxStderrBytes,
    });
    if (
      Buffer.byteLength(requestFrame) >
      Math.min(this.maxFrameBytes, GUARDIAN_WORKER_MAX_REQUEST_BYTES)
    ) {
      throw new GuardianWorkerProtocolError("request exceeds the Guardian worker bound");
    }

    const child = await this.ensureChild();
    return new Promise<GuardianWorkerExecutionResult>((resolve, reject) => {
      const timeout = boundedTimeout(request.timeoutMs, this.timeoutMs);
      const onAbort = (): void => {
        void this.cancelAndTerminate(id, new GuardianWorkerAbortError());
      };
      const pending: PendingRequest = {
        resolve,
        reject,
        signal: request.signal,
        onAbort,
        maxStdoutBytes,
        maxStderrBytes,
      };
      pending.timer = setTimeout(() => {
        void this.cancelAndTerminate(id, new GuardianWorkerTimeoutError(timeout));
      }, timeout);
      this.pending.set(id, pending);
      request.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (!child.stdin || child.stdin.destroyed)
          throw new GuardianWorkerProtocolError("worker stdin is unavailable");
        child.stdin.write(requestFrame);
      } catch (error) {
        // Keep the request visible until terminate() rejects it. Otherwise a
        // synchronous EPIPE/write failure can leave its Promise pending.
        void this.terminate(
          error instanceof Error ? error : new GuardianWorkerProtocolError(String(error)),
        );
      }
      if (request.signal?.aborted) onAbort();
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.closeInternal();
    return this.closing;
  }

  private async ensureChild(): Promise<ChildProcess> {
    // `startChild()` assigns `this.child` before its bootstrap ACK arrives.
    // Share that pending promise first so concurrent first executions cannot
    // write an execute frame ahead of the fixed evidence scope.
    if (this.starting) return this.starting;
    if (
      this.child &&
      !this.child.killed &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      return this.child;
    }
    this.starting = this.startChild();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async startChild(): Promise<ChildProcess> {
    let child: ChildProcess;
    try {
      child = this.spawnProcess(process.execPath, [this.workerPath], {
        cwd: dirname(this.workerPath),
        detached: true,
        shell: false,
        env: workerEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new GuardianWorkerInfrastructureError(
        `worker process failed to start: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    this.child = child;
    this.output = "";
    this.stderrBytes = 0;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: string | Buffer) => this.onStderr(chunk));
    child.stdin?.once("error", (error) => {
      void this.terminate(new GuardianWorkerProtocolError(`worker stdin failed: ${error.message}`));
    });
    child.once("error", (error) => {
      void this.terminate(
        new GuardianWorkerProtocolError(`worker process failed: ${error.message}`),
      );
    });
    child.once("close", (exitCode, signalCode) => {
      if (this.child !== child) return;
      // The close event is the last safe point at which the detached PGID is
      // known. Kill it before forgetting the ChildProcess so descendants
      // cannot outlive an unexpected worker crash.
      killProcessGroup(child);
      this.child = undefined;
      // closeInternal() marks the client closed before writing the shutdown
      // frame. A test double (or a very fast child) may emit `close`
      // synchronously before the close() promise has been assigned.
      if (this.closed || this.closing) return;
      const detail =
        signalCode === null
          ? exitCode === null
            ? "without an exit status"
            : `with exit code ${exitCode}`
          : `with signal ${signalCode}`;
      const failure = new GuardianWorkerInfrastructureError(
        `worker process exited unexpectedly ${detail}`,
      );
      this.latchFailure(failure);
      this.rejectPending(failure);
    });
    const id = `b-${++this.sequence}`;
    const requestFrame = frame({
      type: "bootstrap",
      id,
      evidenceScope: this.evidenceScope,
    });
    if (
      Buffer.byteLength(requestFrame) >
      Math.min(this.maxFrameBytes, GUARDIAN_WORKER_MAX_REQUEST_BYTES)
    ) {
      const error = new GuardianWorkerProtocolError("bootstrap exceeds the worker bound");
      await this.terminate(error);
      throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: () => resolve(),
        reject,
        onAbort: () => undefined,
        maxStdoutBytes: 1,
        maxStderrBytes: 1,
      };
      pending.timer = setTimeout(() => {
        void this.cancelAndTerminate(id, new GuardianWorkerTimeoutError(this.timeoutMs));
      }, this.timeoutMs);
      this.pending.set(id, pending);
      try {
        if (!child.stdin || child.stdin.destroyed) {
          throw new GuardianWorkerProtocolError("worker stdin is unavailable");
        }
        child.stdin.write(requestFrame);
      } catch (error) {
        void this.terminate(
          error instanceof Error ? error : new GuardianWorkerProtocolError(String(error)),
        );
      }
    });
    return child;
  }

  private onStdout(chunk: string | Buffer): void {
    if (!this.child) return;
    this.output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(this.output) > this.maxFrameBytes) {
      void this.terminate(
        new GuardianWorkerProtocolError("worker response exceeds the frame bound"),
      );
      return;
    }
    for (;;) {
      const newline = this.output.indexOf("\n");
      if (newline < 0) return;
      const line = this.output.slice(0, newline).replace(/\r$/, "");
      this.output = this.output.slice(newline + 1);
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        void this.terminate(new GuardianWorkerProtocolError("worker returned malformed JSON"));
        return;
      }
      if (!isWorkerResponse(value)) {
        void this.terminate(new GuardianWorkerProtocolError("worker returned an invalid response"));
        return;
      }
      this.resolveResponse(value);
    }
  }

  private onStderr(chunk: string | Buffer): void {
    this.stderrBytes += Buffer.byteLength(chunk.toString());
    if (this.stderrBytes > GUARDIAN_WORKER_MAX_STDERR_BYTES) {
      void this.terminate(new GuardianWorkerProtocolError("worker stderr exceeds the bound"));
    }
  }

  private resolveResponse(response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      void this.terminate(new GuardianWorkerProtocolError("worker returned an unknown request id"));
      return;
    }
    this.pending.delete(response.id);
    this.cleanupPending(pending);
    if (response.type === "error") {
      const failure = new GuardianWorkerInfrastructureError(
        response.error || "worker request failed",
      );
      this.latchFailure(failure);
      pending.reject(failure);
      this.terminalFailureReported = true;
      // The worker has already started its own bounded shutdown/reset after
      // reporting an infrastructure error. Give that reset a chance to run;
      // closeInternal() still force-kills the detached process group if it
      // hangs or exits unsuccessfully.
      this.rejectPending(failure);
      void this.close().catch(() => undefined);
      return;
    }
    try {
      const stdout = decodeBase64(response.stdout, "stdout");
      const stderr = decodeBase64(response.stderr, "stderr");
      if (stdout.byteLength > pending.maxStdoutBytes) {
        throw new GuardianWorkerProtocolError("worker stdout exceeds the requested bound");
      }
      if (stderr.byteLength > pending.maxStderrBytes) {
        throw new GuardianWorkerProtocolError("worker stderr exceeds the requested bound");
      }
      if (stdout.byteLength + stderr.byteLength > 8 * 1024 * 1024) {
        throw new GuardianWorkerProtocolError("worker result exceeds the output bound");
      }
      if (response.exitCode !== null && typeof response.exitCode !== "number") {
        throw new GuardianWorkerProtocolError("invalid worker exit code");
      }
      pending.resolve({ stdout, stderr, exitCode: response.exitCode ?? null });
    } catch (error) {
      this.terminalFailureReported = true;
      pending.reject(error);
      void this.terminate(error);
    }
  }

  private cleanupPending(pending: PendingRequest): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
  }

  private rejectPending(error: unknown): void {
    if (this.terminalFailure && error === this.terminalFailure && this.pending.size > 0) {
      this.terminalFailureReported = true;
    }
    for (const pending of this.pending.values()) {
      this.cleanupPending(pending);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private latchFailure(error: GuardianWorkerInfrastructureError): void {
    this.terminalFailure ??= error;
  }

  private async cancelAndTerminate(id: string, error: Error): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) return;
    const child = this.child;
    if (child?.stdin && !child.stdin.destroyed) {
      try {
        child.stdin.write(frame({ type: "cancel", id }));
      } catch {
        // Termination below is the authoritative cancellation path.
      }
    }
    await this.terminate(error);
  }

  private async terminate(error: unknown): Promise<void> {
    const failure =
      error instanceof GuardianWorkerInfrastructureError
        ? error
        : new GuardianWorkerInfrastructureError(
            error instanceof Error ? error.message : String(error),
            error,
          );
    // Caller cancellation is an expected end of a review, not a poisoned
    // worker state. Timeouts and every transport/protocol failure remain
    // terminal because the worker process has been killed.
    if (!(error instanceof GuardianWorkerAbortError)) this.latchFailure(failure);
    const rejection =
      error instanceof GuardianWorkerAbortError || error instanceof GuardianWorkerTimeoutError
        ? error
        : failure;
    if (this.pending.size > 0 && rejection === error) this.terminalFailureReported = true;
    const child = this.child;
    if (!child) {
      this.rejectPending(rejection);
      return;
    }
    this.child = undefined;
    this.rejectPending(rejection);
    killProcessGroup(child);
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("close", () => resolve());
      setTimeout(resolve, WORKER_TERMINATE_WAIT_MS);
    });
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child) {
      this.rejectPending(
        this.terminalFailure ?? new GuardianWorkerAbortError("Guardian worker closed"),
      );
      if (this.terminalFailure && !this.terminalFailureReported) throw this.terminalFailure;
      return;
    }
    let closeError: Error | undefined;
    await new Promise<void>((resolve) => {
      let finished = false;
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
      let onClose:
        | ((exitCode: number | null, signalCode: NodeJS.Signals | null) => void)
        | undefined;
      const finish = (
        exitCode: number | null = child.exitCode,
        signalCode: NodeJS.Signals | null = child.signalCode,
      ): void => {
        if (finished) return;
        finished = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (onClose) child.removeListener("close", onClose);
        if (signalCode !== null) {
          closeError = new GuardianWorkerInfrastructureError(
            `worker shutdown failed with signal ${signalCode}`,
          );
        } else if (exitCode !== null && exitCode !== 0) {
          closeError = new GuardianWorkerInfrastructureError(
            `worker shutdown failed with exit code ${exitCode}`,
          );
        }
        resolve();
      };
      onClose = (exitCode, signalCode): void => finish(exitCode, signalCode);
      child.once("close", onClose);
      fallbackTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null || this.child !== child) {
          finish();
          return;
        }
        this.child = undefined;
        this.rejectPending(new GuardianWorkerAbortError("Guardian worker closed"));
        closeError = new GuardianWorkerInfrastructureError("worker did not shut down cleanly");
        this.latchFailure(new GuardianWorkerInfrastructureError(closeError.message, closeError));
        finish();
        killProcessGroup(child);
      }, WORKER_SHUTDOWN_TIMEOUT_MS);
      // Install the listener before asking the worker to exit. The child can
      // close synchronously in tests and some spawn implementations, so also
      // observe the already-exited state after listener installation.
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      if (child.stdin && !child.stdin.destroyed) {
        try {
          child.stdin.write(frame({ type: "shutdown" }));
        } catch {
          // Fall through to the bounded force-close timer.
        }
      }
    });
    // If the process reported an exit code but its `close` event has not
    // arrived yet, the startChild listener may have intentionally deferred
    // cleanup. Retain the identity check and kill the group before dropping
    // it; never use a stale PID after the child reference is gone.
    if (this.child === child) {
      killProcessGroup(child);
      this.child = undefined;
    }
    this.rejectPending(new GuardianWorkerAbortError("Guardian worker closed"));
    if (closeError) {
      this.latchFailure(
        closeError instanceof GuardianWorkerInfrastructureError
          ? closeError
          : new GuardianWorkerInfrastructureError(closeError.message, closeError),
      );
      throw closeError;
    }
    if (this.terminalFailure && !this.terminalFailureReported) throw this.terminalFailure;
  }
}

export function createGuardianWorkerClient(
  evidenceScope: GuardianEvidenceScope,
  options: GuardianWorkerClientOptions = {},
): GuardianWorkerClient {
  return new GuardianWorkerClient(evidenceScope, options);
}
