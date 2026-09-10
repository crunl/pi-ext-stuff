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
const MAX_ERROR_CHARACTERS = 2_000;

const FAILURE_STAGES = [
  "bootstrap",
  "initialization",
  "execution",
  "cleanup",
  "transport",
] as const;
const FAILURE_CODES = [
  "failed",
  "timeout",
  "poisoned",
  "protocol",
  "unsupported",
  "cancelled",
] as const;

export interface GuardianWorkerFailure {
  readonly stage: (typeof FAILURE_STAGES)[number];
  readonly code: (typeof FAILURE_CODES)[number];
}

function isWorkerFailure(value: unknown): value is GuardianWorkerFailure {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    FAILURE_STAGES.some((stage) => record.stage === stage) &&
    FAILURE_CODES.some((code) => record.code === code)
  );
}

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
  readonly failure: GuardianWorkerFailure;

  constructor(
    message: string,
    cause?: unknown,
    failure: GuardianWorkerFailure = { stage: "transport", code: "failed" },
  ) {
    super(message);
    this.name = "GuardianWorkerInfrastructureError";
    this.failure = Object.freeze({ stage: failure.stage, code: failure.code });
    if (cause !== undefined) Object.assign(this, { cause });
  }
}

export class GuardianWorkerTimeoutError extends GuardianWorkerInfrastructureError {
  constructor(timeoutMs: number, stage: GuardianWorkerFailure["stage"] = "transport") {
    super(`Guardian worker request timed out after ${timeoutMs}ms`, undefined, {
      stage,
      code: "timeout",
    });
    this.name = "GuardianWorkerTimeoutError";
  }
}

export class GuardianWorkerProtocolError extends GuardianWorkerInfrastructureError {
  constructor(message: string) {
    super(`Guardian worker protocol error: ${message}`, undefined, {
      stage: "transport",
      code: "protocol",
    });
    this.name = "GuardianWorkerProtocolError";
  }
}

type WorkerRequest = {
  type: "bootstrap" | "execute" | "cancel" | "shutdown" | "retirement-ack";
  id?: string;
  /** Cooperative retirement nonce for shutdown/retirement-ack. */
  nonce?: string;
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

type WorkerResponse =
  | {
      type: "result";
      id: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
    }
  | {
      type: "error";
      // Fatal protocol and shutdown failures do not belong to a live request.
      id?: string;
      error: string;
      failure: GuardianWorkerFailure;
    }
  | {
      type: "retirement-proposal";
      nonce: string;
    };

type ChildPhase = "starting" | "workload" | "retiring" | "closed";

/**
 * One owned worker child. The reference is released only after actual close.
 * Exit status alone is never treated as close or as a signal authority.
 */
interface ChildLifecycle {
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  phase: ChildPhase;
  exitObserved: boolean;
  closeObserved: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  primaryError?: GuardianWorkerInfrastructureError;
  retirementError?: GuardianWorkerInfrastructureError;
  expectedTerminalSignal?: NodeJS.Signals;
  retirementNonce?: string;
  retirementProposalReceived: boolean;
  retirementAcknowledged: boolean;
  emergencyTeardown: boolean;
  readonly closed: Promise<void>;
  readonly markClosed: () => void;
}

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

/**
 * Signal the worker's process group only while the parent still owns a live
 * identity. Never signal after observed exit/close: the numeric PID/PGID may
 * already belong to another process. A direct-child fallback is emergency-only
 * and does not establish group cleanup.
 */
function signalOwnedWorker(lifecycle: ChildLifecycle): { signalled: boolean; reason?: string } {
  if (lifecycle.closeObserved || lifecycle.exitObserved) {
    return { signalled: false, reason: "worker already exited" };
  }
  const child = lifecycle.child;
  if (!child.pid) return { signalled: false, reason: "worker has no pid" };
  if (process.platform === "win32") {
    try {
      child.kill("SIGKILL");
      return { signalled: true };
    } catch {
      return { signalled: false, reason: "direct worker kill failed" };
    }
  }
  try {
    process.kill(-child.pid, "SIGKILL");
    return { signalled: true };
  } catch {
    try {
      child.kill("SIGKILL");
      return { signalled: true, reason: "used direct-child fallback" };
    } catch {
      return { signalled: false, reason: "worker group kill failed" };
    }
  }
}

function createChildLifecycle(child: ChildProcess): ChildLifecycle {
  let markClosed = (): void => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  return {
    child,
    pid: child.pid,
    phase: "starting",
    exitObserved: false,
    closeObserved: false,
    exitCode: null,
    signalCode: null,
    retirementProposalReceived: false,
    retirementAcknowledged: false,
    emergencyTeardown: false,
    closed,
    markClosed,
  };
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
  if (record.type === "retirement-proposal") {
    return typeof record.nonce === "string" && record.nonce.length > 0 && record.nonce.length <= 64;
  }
  const validId =
    typeof record.id === "string" && record.id.length > 0 && record.id.length <= MAX_ID_LENGTH;
  if (record.type === "result") return validId;
  return (
    record.type === "error" &&
    (record.id === undefined || validId) &&
    typeof record.error === "string" &&
    record.error.length <= MAX_ERROR_CHARACTERS &&
    isWorkerFailure(record.failure)
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
  private lifecycle?: ChildLifecycle;
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
    if (this.lifecycle?.phase === "retiring" || this.lifecycle?.phase === "closed") {
      throw new GuardianWorkerProtocolError("client worker is retiring");
    }
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
    const lifecycle = this.lifecycle;
    if (!lifecycle || lifecycle.child !== child || lifecycle.phase !== "workload") {
      throw new GuardianWorkerProtocolError("client worker is not accepting executions");
    }
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
    // `startChild()` assigns the lifecycle before its bootstrap ACK arrives.
    // Share that pending promise first so concurrent first executions cannot
    // write an execute frame ahead of the fixed evidence scope.
    if (this.starting) return this.starting;
    if (this.lifecycle && this.lifecycle.phase === "workload" && !this.lifecycle.exitObserved) {
      return this.lifecycle.child;
    }
    // Retired, exited-but-not-closed, or never started: only a fresh client
    // may start another worker. A retiring lifecycle never replaces itself.
    if (this.lifecycle && this.lifecycle.phase !== "closed") {
      if (this.lifecycle.phase === "retiring") {
        throw new GuardianWorkerProtocolError("client worker is retiring");
      }
      // Exit without close still owns the old identity; wait for close.
      if (this.lifecycle.exitObserved && !this.lifecycle.closeObserved) {
        throw new GuardianWorkerInfrastructureError(
          "worker exited without close; replacement is not permitted",
          undefined,
          { stage: "transport", code: "failed" },
        );
      }
    }
    this.starting = this.startChild();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async startChild(): Promise<ChildProcess> {
    if (this.closed) throw new GuardianWorkerProtocolError("client is closed");
    if (this.lifecycle && this.lifecycle.phase !== "closed") {
      throw new GuardianWorkerProtocolError("client already owns a worker lifecycle");
    }
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
        { stage: "bootstrap", code: "failed" },
      );
    }
    const lifecycle = createChildLifecycle(child);
    this.lifecycle = lifecycle;
    this.output = "";
    this.stderrBytes = 0;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: string | Buffer) => this.onStderr(chunk));
    child.stdin?.once("error", (error) => {
      void this.terminate(new GuardianWorkerProtocolError(`worker stdin failed: ${error.message}`));
    });
    child.once("error", (error) => {
      lifecycle.primaryError = new GuardianWorkerInfrastructureError(
        `worker process failed: ${error.message}`,
        error,
        {
          stage: "bootstrap",
          code: "failed",
        },
      );
      // Error is not close. Keep the reference until the close event.
      if (!this.closed && !this.closing) {
        this.latchFailure(lifecycle.primaryError);
      }
    });
    child.once("exit", (exitCode, signalCode) => {
      if (this.lifecycle !== lifecycle) return;
      lifecycle.exitObserved = true;
      lifecycle.exitCode = exitCode;
      lifecycle.signalCode = signalCode;
    });
    child.once("close", (exitCode, signalCode) => {
      if (this.lifecycle !== lifecycle) return;
      lifecycle.exitObserved = true;
      lifecycle.closeObserved = true;
      lifecycle.phase = "closed";
      lifecycle.exitCode = exitCode;
      lifecycle.signalCode = signalCode;
      lifecycle.markClosed();
      // Never signal from the close handler: the numeric identity may already
      // have been reused. Unexpected close still fails the active review.
      if (this.closed || this.closing) return;
      if (lifecycle.phase === "closed" && lifecycle.retirementAcknowledged) return;
      const detail =
        signalCode === null
          ? exitCode === null
            ? "without an exit status"
            : `with exit code ${exitCode}`
          : `with signal ${signalCode}`;
      const failure =
        lifecycle.primaryError ??
        new GuardianWorkerInfrastructureError(`worker process exited unexpectedly ${detail}`);
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
        resolve: () => {
          lifecycle.phase = "workload";
          resolve();
        },
        reject,
        onAbort: () => undefined,
        maxStdoutBytes: 1,
        maxStderrBytes: 1,
      };
      pending.timer = setTimeout(() => {
        void this.cancelAndTerminate(
          id,
          new GuardianWorkerTimeoutError(this.timeoutMs, "bootstrap"),
        );
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
    if (lifecycle.phase === "starting") lifecycle.phase = "workload";
    return child;
  }

  private onStdout(chunk: string | Buffer): void {
    if (!this.lifecycle) return;
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
    const lifecycle = this.lifecycle;
    if (response.type === "retirement-proposal") {
      if (lifecycle?.phase !== "retiring") {
        void this.terminate(new GuardianWorkerProtocolError("unsolicited retirement proposal"));
        return;
      }
      if (
        lifecycle.retirementProposalReceived ||
        lifecycle.retirementNonce === undefined ||
        response.nonce !== lifecycle.retirementNonce
      ) {
        lifecycle.retirementError =
          lifecycle.retirementError ??
          new GuardianWorkerProtocolError("invalid retirement proposal");
        void this.terminate(lifecycle.retirementError);
        return;
      }
      if (lifecycle.exitObserved) {
        lifecycle.retirementError =
          lifecycle.retirementError ??
          new GuardianWorkerProtocolError("retirement proposal after exit");
        void this.terminate(lifecycle.retirementError);
        return;
      }
      lifecycle.retirementProposalReceived = true;
      lifecycle.expectedTerminalSignal = "SIGKILL";
      try {
        if (!lifecycle.child.stdin || lifecycle.child.stdin.destroyed) {
          throw new GuardianWorkerProtocolError("worker stdin is unavailable for retirement ACK");
        }
        lifecycle.child.stdin.write(
          frame({ type: "retirement-ack", nonce: lifecycle.retirementNonce }),
        );
        lifecycle.retirementAcknowledged = true;
      } catch (error) {
        lifecycle.retirementError =
          lifecycle.retirementError ??
          new GuardianWorkerInfrastructureError(
            `retirement ACK failed: ${error instanceof Error ? error.message : String(error)}`,
            error,
            { stage: "cleanup", code: "failed" },
          );
        void this.terminate(lifecycle.retirementError);
      }
      return;
    }
    if (response.type === "error") {
      if (response.id !== undefined && !this.pending.has(response.id)) {
        void this.terminate(
          new GuardianWorkerProtocolError("worker returned an unknown request id"),
        );
        return;
      }
      const failure = new GuardianWorkerInfrastructureError(
        response.error || "worker request failed",
        undefined,
        response.failure,
      );
      this.latchFailure(failure);
      this.rejectPending(failure);
      // The worker starts its own bounded shutdown/reset after an error.
      // Id-less errors also cover fatal protocol and shutdown/reset failures.
      void this.close().catch(() => undefined);
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      void this.terminate(new GuardianWorkerProtocolError("worker returned an unknown request id"));
      return;
    }
    this.pending.delete(response.id);
    this.cleanupPending(pending);
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
    // Cleanup remains authoritative over an earlier execution failure. Keep
    // its source metadata even if the request already reported the first error.
    if (error.failure.stage === "cleanup" && error !== this.terminalFailure) {
      this.terminalFailure = error;
      this.terminalFailureReported = false;
      return;
    }
    this.terminalFailure ??= error;
  }

  private async cancelAndTerminate(id: string, error: Error): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) return;
    const lifecycle = this.lifecycle;
    const child = lifecycle?.child;
    if (child?.stdin && !child.stdin.destroyed && lifecycle && !lifecycle.exitObserved) {
      try {
        child.stdin.write(frame({ type: "cancel", id }));
      } catch {
        // Termination below is the authoritative cancellation path.
      }
    }
    await this.terminate(error);
  }

  /**
   * Failure teardown. Enters RETIRING, may signal only a still-owned live
   * identity, and retains the child reference until actual close. A deadline
   * is failure evidence, never close evidence.
   */
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
    this.rejectPending(rejection);
    const lifecycle = this.lifecycle;
    if (!lifecycle) return;
    if (lifecycle.phase === "closed") return;
    if (lifecycle.phase !== "retiring") lifecycle.phase = "retiring";
    lifecycle.emergencyTeardown = true;
    const signalResult = signalOwnedWorker(lifecycle);
    if (!signalResult.signalled && !lifecycle.exitObserved && !lifecycle.closeObserved) {
      lifecycle.retirementError =
        lifecycle.retirementError ??
        new GuardianWorkerInfrastructureError(
          `failed to signal worker: ${signalResult.reason ?? "unknown"}`,
          undefined,
          { stage: "cleanup", code: "failed" },
        );
      this.latchFailure(lifecycle.retirementError);
    }
    const closeDeadline = new Promise<void>((resolve) => {
      setTimeout(resolve, WORKER_TERMINATE_WAIT_MS);
    });
    await Promise.race([lifecycle.closed, closeDeadline]);
    if (!lifecycle.closeObserved) {
      const timeoutFailure = new GuardianWorkerInfrastructureError(
        "worker did not close before the termination deadline",
        undefined,
        { stage: "cleanup", code: "timeout" },
      );
      lifecycle.retirementError = lifecycle.retirementError ?? timeoutFailure;
      this.latchFailure(timeoutFailure);
    }
  }

  /**
   * Cooperative retirement: shutdown(nonce) → proposal → ACK → worker
   * self-SIGKILL → actual close with the expected terminal signal.
   * Exit zero without the handshake is not a successful shutdown.
   */
  private async closeInternal(): Promise<void> {
    this.closed = true;
    const lifecycle = this.lifecycle;
    if (!lifecycle || lifecycle.phase === "closed") {
      this.rejectPending(
        this.terminalFailure ?? new GuardianWorkerAbortError("Guardian worker closed"),
      );
      if (this.terminalFailure && !this.terminalFailureReported) throw this.terminalFailure;
      return;
    }
    if (lifecycle.phase === "starting" || lifecycle.phase === "workload") {
      lifecycle.phase = "retiring";
    }
    // Emergency teardown already signalled, or the process already exited.
    // Wait for close and surface the original failure. A structured error
    // frame alone still prefers cooperative shutdown so the worker can finish
    // SRT reset before exit.
    if (
      lifecycle.emergencyTeardown ||
      (lifecycle.exitObserved && !lifecycle.retirementAcknowledged)
    ) {
      if (!lifecycle.exitObserved && !lifecycle.closeObserved) {
        const emergency = signalOwnedWorker(lifecycle);
        if (!emergency.signalled && !lifecycle.exitObserved) {
          lifecycle.retirementError =
            lifecycle.retirementError ??
            new GuardianWorkerInfrastructureError(
              `emergency worker signal failed: ${emergency.reason ?? "unknown"}`,
              undefined,
              { stage: "cleanup", code: "failed" },
            );
          this.latchFailure(lifecycle.retirementError);
        }
      }
      await Promise.race([
        lifecycle.closed,
        new Promise<void>((resolve) => setTimeout(resolve, WORKER_TERMINATE_WAIT_MS)),
      ]);
      this.rejectPending(new GuardianWorkerAbortError("Guardian worker closed"));
      const failure =
        this.terminalFailure ??
        lifecycle.retirementError ??
        lifecycle.primaryError ??
        new GuardianWorkerInfrastructureError("worker process exited unexpectedly");
      this.latchFailure(failure);
      // Cleanup remains visible on close even after the request already
      // reported the first execution error.
      if (!this.terminalFailureReported || failure.failure.stage === "cleanup") {
        throw failure;
      }
      return;
    }
    let closeError: GuardianWorkerInfrastructureError | undefined;
    const nonce = `r-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    lifecycle.retirementNonce = nonce;
    const stdin = lifecycle.child.stdin;
    if (!lifecycle.exitObserved && stdin && !stdin.destroyed) {
      try {
        stdin.write(frame({ type: "shutdown", nonce }));
      } catch {
        closeError = new GuardianWorkerInfrastructureError(
          "failed to start cooperative retirement",
          undefined,
          { stage: "cleanup", code: "failed" },
        );
      }
    } else if (!lifecycle.exitObserved) {
      closeError = new GuardianWorkerInfrastructureError(
        "worker stdin is unavailable for cooperative retirement",
        undefined,
        { stage: "cleanup", code: "failed" },
      );
    }
    if (!closeError) {
      const deadline = new Promise<"deadline">((resolve) => {
        setTimeout(() => resolve("deadline"), WORKER_SHUTDOWN_TIMEOUT_MS);
      });
      const outcome = await Promise.race([
        lifecycle.closed.then(() => "closed" as const),
        deadline,
      ]);
      if (outcome === "deadline") {
        closeError = new GuardianWorkerInfrastructureError(
          "worker did not shut down cleanly",
          undefined,
          { stage: "cleanup", code: "timeout" },
        );
        this.latchFailure(closeError);
        const emergency = signalOwnedWorker(lifecycle);
        if (!emergency.signalled && !lifecycle.exitObserved) {
          lifecycle.retirementError =
            lifecycle.retirementError ??
            new GuardianWorkerInfrastructureError(
              `emergency worker signal failed: ${emergency.reason ?? "unknown"}`,
              undefined,
              { stage: "cleanup", code: "failed" },
            );
          this.latchFailure(lifecycle.retirementError);
        }
        await Promise.race([
          lifecycle.closed,
          new Promise<void>((resolve) => setTimeout(resolve, WORKER_TERMINATE_WAIT_MS)),
        ]);
      } else if (lifecycle.retirementAcknowledged) {
        if (lifecycle.signalCode !== "SIGKILL" || lifecycle.exitCode !== null) {
          closeError = new GuardianWorkerInfrastructureError(
            `worker retirement ended with unexpected status signal=${String(lifecycle.signalCode)} exit=${String(lifecycle.exitCode)}`,
            undefined,
            { stage: "cleanup", code: "failed" },
          );
        } else if (this.terminalFailure?.failure.stage === "cleanup") {
          // Cleanup/reset remains authoritative on close even after a clean
          // cooperative retirement.
          closeError = this.terminalFailure;
        }
      } else if (this.terminalFailure) {
        closeError = this.terminalFailure;
      } else if (lifecycle.retirementError) {
        closeError = lifecycle.retirementError;
      } else if (lifecycle.primaryError) {
        closeError = lifecycle.primaryError;
      } else if (lifecycle.signalCode !== null) {
        closeError = new GuardianWorkerInfrastructureError(
          `worker shutdown failed with signal ${lifecycle.signalCode}`,
          undefined,
          { stage: "transport", code: "failed" },
        );
      } else if (lifecycle.exitCode !== null && lifecycle.exitCode !== 0) {
        closeError = new GuardianWorkerInfrastructureError(
          `worker shutdown failed with exit code ${lifecycle.exitCode}`,
          undefined,
          { stage: "transport", code: "failed" },
        );
      } else {
        closeError = new GuardianWorkerInfrastructureError(
          "worker exited without cooperative retirement handshake",
          undefined,
          { stage: "transport", code: "failed" },
        );
      }
    }
    this.rejectPending(new GuardianWorkerAbortError("Guardian worker closed"));
    if (closeError) {
      this.latchFailure(closeError);
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
