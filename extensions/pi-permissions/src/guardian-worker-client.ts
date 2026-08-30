import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

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
const WORKER_SHUTDOWN_TIMEOUT_MS = 1_000;
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

export class GuardianWorkerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Guardian worker request timed out after ${timeoutMs}ms`);
    this.name = "GuardianWorkerTimeoutError";
  }
}

export class GuardianWorkerProtocolError extends Error {
  constructor(message: string) {
    super(`Guardian worker protocol error: ${message}`);
    this.name = "GuardianWorkerProtocolError";
  }
}

type WorkerRequest = {
  type: "execute" | "cancel" | "shutdown";
  id?: string;
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
  private readonly workerPath: string;
  private readonly timeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly spawnProcess: GuardianWorkerSpawn;
  private child?: ChildProcess;
  private output = "";
  private stderrBytes = 0;
  private sequence = 0;
  private closed = false;
  private closing?: Promise<void>;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(options: GuardianWorkerClientOptions = {}) {
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
    if (
      this.child &&
      !this.child.killed &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      return this.child;
    }
    const child = this.spawnProcess(process.execPath, [this.workerPath], {
      cwd: dirname(this.workerPath),
      detached: true,
      shell: false,
      env: workerEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
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
    child.once("close", () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.rejectPending(new GuardianWorkerProtocolError("worker process exited"));
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
      pending.reject(new GuardianWorkerProtocolError(response.error || "worker request failed"));
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
      pending.reject(error);
      void this.terminate(error);
    }
  }

  private cleanupPending(pending: PendingRequest): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
  }

  private rejectPending(error: unknown): void {
    for (const pending of this.pending.values()) {
      this.cleanupPending(pending);
      pending.reject(error);
    }
    this.pending.clear();
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
    const child = this.child;
    if (!child) {
      this.rejectPending(error);
      return;
    }
    this.child = undefined;
    this.rejectPending(error);
    killProcessGroup(child);
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("close", () => resolve());
      setTimeout(resolve, WORKER_SHUTDOWN_TIMEOUT_MS);
    });
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child) {
      this.rejectPending(new GuardianWorkerAbortError("Guardian worker closed"));
      return;
    }
    await new Promise<void>((resolve) => {
      let finished = false;
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        child.removeListener("close", finish);
        resolve();
      };
      child.once("close", finish);
      fallbackTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null || this.child !== child) {
          finish();
          return;
        }
        this.child = undefined;
        this.rejectPending(new GuardianWorkerAbortError("Guardian worker closed"));
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
    this.child = undefined;
    this.rejectPending(new GuardianWorkerAbortError("Guardian worker closed"));
  }
}

export function createGuardianWorkerClient(
  options: GuardianWorkerClientOptions = {},
): GuardianWorkerClient {
  return new GuardianWorkerClient(options);
}
