import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

// This file is intentionally self-contained. Pi loads the extension through
// jiti, so a worker that imports the extension's TypeScript would not be a
// reliable process entry point for an installed package.

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 128 * 1024;
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_STDOUT_BYTES = 5 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_PENDING_REQUESTS = 16;
const MAX_ID_LENGTH = 128;

const workerEnvironment = {
  PATH: process.platform === "win32" ? (process.env.Path ?? "") : "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: tmpdir(),
  TMPDIR: tmpdir(),
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TERM: "dumb",
};
for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "ComSpec"]) {
  if (process.env[name] !== undefined) workerEnvironment[name] = process.env[name];
}

let srtReady = false;
let srtPoisoned = false;
let evidenceScope;
let evidenceScopeCwd;
let readOnlySandboxConfig;
let bootstrapStarted = false;
let input = "";
let fatalStarted = false;
let shuttingDown = false;
let pumping = false;
const queue = [];
const active = new Map();

function infrastructureFailure(error) {
  return new Error(error instanceof Error ? error.message : text(error));
}

function text(value) {
  return typeof value === "string" ? value : String(value);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function authorityFingerprint(cwd, denyRead) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        allowWrite: [],
        cwd,
        denyRead,
        network: "denied",
      }),
    )
    .digest("hex");
}

function validateEvidenceScope(value) {
  if (!value || typeof value !== "object" || typeof value.cwd !== "string") {
    throw new Error("reviewer worker evidence scope is invalid");
  }
  if (!isAbsolute(value.cwd) || !Array.isArray(value.denyRead)) {
    throw new Error("reviewer worker evidence scope is invalid");
  }
  if (
    value.denyRead.some(
      (entry) => typeof entry !== "string" || entry.length === 0 || !isAbsolute(entry),
    )
  ) {
    throw new Error("reviewer worker denyRead entries must be absolute paths");
  }
  const denyRead = [...new Set(value.denyRead)].sort();
  if (process.platform === "linux" && denyRead.some((entry) => /[*?[\]]/.test(entry))) {
    throw new Error("reviewer worker cannot enforce glob denyRead entries on Linux");
  }
  const fingerprint = authorityFingerprint(value.cwd, denyRead);
  if (value.authorityFingerprint !== fingerprint) {
    throw new Error("reviewer worker evidence authority fingerprint mismatch");
  }
  return Object.freeze({
    cwd: value.cwd,
    denyRead: Object.freeze(denyRead),
    authorityFingerprint: fingerprint,
  });
}

async function bootstrap(request) {
  if (bootstrapStarted || evidenceScope || active.size > 0 || queue.length > 0 || shuttingDown) {
    throw new Error("reviewer worker evidence scope is already fixed");
  }
  bootstrapStarted = true;
  if (byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) {
    throw new Error("reviewer worker bootstrap exceeds the bound");
  }
  const scope = validateEvidenceScope(request.evidenceScope);
  const canonicalScopeCwd = await canonicalCwd(scope.cwd);
  evidenceScope = scope;
  evidenceScopeCwd = canonicalScopeCwd;
  readOnlySandboxConfig = Object.freeze({
    filesystem: Object.freeze({
      denyRead: Object.freeze([...scope.denyRead]),
      allowWrite: Object.freeze([]),
      denyWrite: Object.freeze([]),
    }),
    network: Object.freeze({
      allowedDomains: Object.freeze([]),
      deniedDomains: Object.freeze(["*"]),
      allowLocalBinding: false,
    }),
  });
  send({ type: "result", id: request.id, stdout: "", stderr: "", exitCode: 0 });
}

function boundedInteger(value, fallback, maximum) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(maximum, Math.floor(value));
}

function jsonFrame(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    encoded = JSON.stringify({
      type: "error",
      id: "unknown",
      error: "response is not serializable",
    });
  }
  if (byteLength(encoded) + 1 > MAX_FRAME_BYTES) {
    encoded = JSON.stringify({
      type: "error",
      id: value.id ?? "unknown",
      error: "worker response exceeds the frame bound",
    });
  }
  return `${encoded}\n`;
}

function send(value) {
  if (!process.stdout.destroyed) process.stdout.write(jsonFrame(value));
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : text(error);
  return message.slice(0, 2_000);
}

// The client starts this worker with `detached: true`, making the worker the
// process-group leader. Wrapped commands intentionally stay attached to that
// group, so the worker's PID is the only reliable tree-kill boundary. A
// wrapped child's PID is not a process-group ID when `detached` is false.
function killWorkerProcessTree(child) {
  // A state without a wrapped child has no owned descendant to kill. In
  // particular, never turn that case into `kill(-process.pid)`: shutdown must
  // get a chance to reset SRT before the worker exits.
  if (!child?.pid) return;
  if (process.platform === "win32") {
    // The Windows isolated evidence surface is disabled until the complete
    // worker -> runner process-tree boundary is proven safe to kill.
    try {
      child.kill("SIGKILL");
    } catch {
      // The child has already exited.
    }
    return;
  }
  if (process.platform !== "win32" && process.pid > 0) {
    try {
      process.kill(-process.pid, "SIGKILL");
      return;
    } catch {
      // If the process group is unavailable, retain the direct-child fallback
      // below. The normal client launch always establishes the group.
    }
  }
  if (!child?.pid) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // The child has already exited.
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function serializedProgram(program) {
  if (!program || typeof program.executable !== "string" || !Array.isArray(program.args)) {
    throw new Error("invalid reviewer worker program");
  }
  if (!isAbsolute(program.executable) || program.args.length > MAX_ARGUMENTS) {
    throw new Error("reviewer worker program is not allowed");
  }
  if (program.args.some((arg) => typeof arg !== "string")) {
    throw new Error("reviewer worker program arguments are invalid");
  }
  const argumentBytes = program.args.reduce((total, arg) => total + byteLength(arg), 0);
  if (argumentBytes > MAX_ARGUMENT_BYTES)
    throw new Error("reviewer worker arguments exceed the bound");
  return [program.executable, ...program.args].map(shellQuote).join(" ");
}

async function canonicalCwd(value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error("reviewer worker cwd must be absolute");
  }
  const resolved = await realpath(value);
  const details = await stat(resolved);
  if (!details.isDirectory()) throw new Error("reviewer worker cwd is not a directory");
  await access(resolved, constants.R_OK | constants.X_OK);
  return resolved;
}

function canonicalExecutable(value) {
  try {
    return realpathSync(value);
  } catch {
    throw new Error("reviewer worker executable is unavailable");
  }
}

function validateProgram(program) {
  const serialized = serializedProgram(program);
  const executable = canonicalExecutable(program.executable);
  const nodeExecutable = canonicalExecutable(process.execPath);
  const bashExecutable =
    process.platform === "win32" ? undefined : canonicalExecutable("/bin/bash");
  const isNode = executable === nodeExecutable;
  const isBash = bashExecutable !== undefined && executable === bashExecutable;
  if (!isNode && !isBash) throw new Error("reviewer worker executable is not allowed");
  if (isBash && (program.args.length !== 2 || program.args[0] !== "-c")) {
    throw new Error("reviewer inspect command is not allowed");
  }
  if (isBash && byteLength(program.args[1] ?? "") > MAX_COMMAND_BYTES) {
    throw new Error("reviewer inspect command exceeds the bound");
  }
  return { serialized, executable };
}

function outputLimit(value, fallback, maximum) {
  return boundedInteger(value, fallback, maximum);
}

async function ensureSrt() {
  if (srtPoisoned) throw new Error("reviewer worker sandbox is unavailable after cleanup failure");
  if (srtReady) return;
  if (!evidenceScope || !readOnlySandboxConfig) {
    throw new Error("reviewer worker evidence scope is unavailable");
  }
  try {
    if (!SandboxManager.isSupportedPlatform()) {
      throw new Error(`reviewer worker sandbox is unsupported on ${process.platform}`);
    }
    const dependency = await SandboxManager.checkDependenciesAsync({
      command: process.execPath,
      args: ["-e", ""],
    });
    if (dependency.errors.length > 0) {
      throw new Error(
        `reviewer worker sandbox dependencies unavailable: ${dependency.errors.join("; ")}`,
      );
    }
    await SandboxManager.initialize(readOnlySandboxConfig, undefined, true);
    srtReady = true;
  } catch (error) {
    srtPoisoned = true;
    try {
      await cleanupAndResetSrt();
    } catch {
      // The worker is already poisoned; process teardown remains fail-closed.
    }
    throw error;
  }
}

async function cleanupAndResetSrt() {
  let cleanupError;
  try {
    SandboxManager.cleanupAfterCommand();
  } catch (error) {
    cleanupError = error;
  }
  let resetError;
  try {
    await SandboxManager.reset();
  } catch (error) {
    resetError = error;
  }
  srtReady = false;
  if (cleanupError && resetError) {
    throw new Error(
      `reviewer worker sandbox cleanup failed: ${errorMessage(cleanupError)}; reset failed: ${errorMessage(resetError)}`,
    );
  }
  if (cleanupError) throw cleanupError;
  if (resetError) throw resetError;
}

async function resetSrt() {
  if (!srtReady) return;
  await cleanupAndResetSrt();
}

function runWrapped(wrapped, request, state) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(wrapped?.argv) || wrapped.argv.length < 1 || !isAbsolute(wrapped.argv[0])) {
      reject(infrastructureFailure("reviewer worker sandbox returned an invalid executable"));
      return;
    }
    let child;
    try {
      child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
        cwd: request.cwd,
        // SRT's returned environment carries its proxy/command variables. The
        // worker itself was started with a minimal environment, so this does
        // not reintroduce the host process's secrets.
        env: wrapped.env && typeof wrapped.env === "object" ? wrapped.env : workerEnvironment,
        // Keep the wrapped command in the worker's process group. The client
        // may have to kill the worker before a cancellation message is handled;
        // sharing the group makes that fallback cover the wrapped child too.
        detached: false,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(infrastructureFailure(error));
      return;
    }
    state.child = child;
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputError;
    let aborted = false;
    let settled = false;
    const timeout = boundedInteger(request.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      aborted = true;
      state.controller.abort(new Error("reviewer worker request timed out"));
      killWorkerProcessTree(child);
    }, timeout);
    const cleanup = () => {
      clearTimeout(timer);
      state.child = undefined;
    };
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const collect = (chunks, chunk, current, limit, streamName) => {
      if (outputError) return current;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const next = current + buffer.byteLength;
      if (next > limit) {
        outputError = infrastructureFailure(`${streamName} exceeded the reviewer worker bound`);
        killWorkerProcessTree(child);
        return next;
      }
      chunks.push(buffer);
      return next;
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes = collect(
        stdout,
        chunk,
        stdoutBytes,
        outputLimit(request.maxStdoutBytes, MAX_STDOUT_BYTES, MAX_STDOUT_BYTES),
        "stdout",
      );
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = collect(
        stderr,
        chunk,
        stderrBytes,
        outputLimit(request.maxStderrBytes, MAX_STDERR_BYTES, MAX_STDERR_BYTES),
        "stderr",
      );
    });
    child.once("error", (error) => finishError(outputError ?? infrastructureFailure(error)));
    child.once("close", (exitCode, signalCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (state.controller.signal.aborted || aborted) {
        reject(infrastructureFailure("reviewer worker request aborted"));
      } else if (outputError) {
        reject(outputError);
      } else if (signalCode !== null) {
        reject(infrastructureFailure(`reviewer inspect command terminated by ${signalCode}`));
      } else if (exitCode === null) {
        reject(infrastructureFailure("reviewer inspect command exited without a status"));
      } else {
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode,
        });
      }
    });
    if (state.controller.signal.aborted) {
      aborted = true;
      killWorkerProcessTree(child);
    }
  });
}

async function execute(request, state) {
  if (state.cancelled) throw infrastructureFailure("reviewer worker request aborted");
  let canonicalRequestCwd;
  try {
    canonicalRequestCwd = await canonicalCwd(request.cwd);
  } catch (error) {
    throw infrastructureFailure(error);
  }
  request.cwd = canonicalRequestCwd;
  if (
    !evidenceScope ||
    request.authorityFingerprint !== evidenceScope.authorityFingerprint ||
    request.cwd !== evidenceScopeCwd
  ) {
    throw infrastructureFailure("reviewer worker execution scope drifted from bootstrap authority");
  }
  let program;
  try {
    program = validateProgram(request.program);
  } catch (error) {
    throw infrastructureFailure(error);
  }
  try {
    await ensureSrt();
  } catch (error) {
    throw infrastructureFailure(error);
  }
  let result;
  let bodyError;
  try {
    let wrapped;
    try {
      wrapped = await SandboxManager.wrapWithSandboxArgv(
        program.serialized,
        "/bin/bash",
        undefined,
        state.controller.signal,
        request.cwd,
        {
          ...(typeof request.commandId === "string" ? { commandId: request.commandId } : {}),
          ...(typeof request.commandText === "string" ? { commandText: request.commandText } : {}),
        },
      );
    } catch (error) {
      throw infrastructureFailure(error);
    }
    if (state.controller.signal.aborted) {
      throw infrastructureFailure("reviewer worker request aborted");
    }
    result = await runWrapped(wrapped, request, state);
  } catch (error) {
    bodyError = state.controller.signal.aborted ? infrastructureFailure(error) : error;
  }
  let cleanupError;
  try {
    SandboxManager.cleanupAfterCommand();
  } catch (error) {
    srtPoisoned = true;
    cleanupError = new Error(`reviewer worker sandbox cleanup failed: ${errorMessage(error)}`);
  }
  // Cleanup failure is authoritative and poisons the worker. Keep it outside
  // a finally block so it cannot accidentally mask the cancellation/error
  // control flow in a way that leaves the caller waiting.
  if (cleanupError) throw infrastructureFailure(cleanupError);
  if (bodyError) throw bodyError;
  return result;
}

async function handleRequest(request, state) {
  const id = request?.id;
  const responseId =
    typeof id === "string" && id.length >= 1 && id.length <= MAX_ID_LENGTH ? id : "unknown";
  try {
    if (typeof id !== "string" || id.length < 1 || id.length > MAX_ID_LENGTH) {
      throw new Error("invalid reviewer worker request id");
    }
    if (request.type !== "execute") throw new Error("unsupported reviewer worker request");
    if (state.cancelled) throw new Error("reviewer worker request aborted");
    if (byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) {
      throw new Error("reviewer worker request exceeds the bound");
    }
    const result = await execute({ ...request }, state);
    send({
      type: "result",
      id,
      stdout: result.stdout.toString("base64"),
      stderr: result.stderr.toString("base64"),
      exitCode: result.exitCode,
    });
  } catch (error) {
    // Every RPC error is an infrastructure failure. Expected evidence
    // failures (ENOENT, EACCES, and child non-zero exits) are transported as
    // ordinary result frames and converted to tool evidence by the caller.
    send({ type: "error", id: responseId, error: errorMessage(error) });
    // A worker-reported infrastructure error is already delivered to the
    // client. Exit cleanly when reset succeeds; shutdown itself upgrades the
    // exit to 1 if cleanup/reset cannot restore the SRT boundary.
    await shutdown();
  } finally {
    active.delete(id);
  }
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;
      if (item.state.cancelled) {
        send({
          type: "error",
          id: item.request.id,
          error: "reviewer worker request aborted",
        });
        active.delete(item.request.id);
        continue;
      }
      await handleRequest(item.request, item.state);
    }
  } finally {
    pumping = false;
    if (shuttingDown && queue.length === 0 && active.size === 0) await shutdown();
  }
}

function cancel(id) {
  const state = active.get(id);
  if (!state) {
    const queued = queue.find((item) => item.request.id === id);
    if (queued) queued.state.cancelled = true;
    return;
  }
  state.cancelled = true;
  state.controller.abort(new Error("reviewer worker request aborted"));
  killWorkerProcessTree(state.child);
}

async function shutdown(exitCode = 0) {
  if (fatalStarted) return;
  fatalStarted = true;
  for (const state of active.values()) {
    state.cancelled = true;
    state.controller.abort(new Error("reviewer worker shutting down"));
    killWorkerProcessTree(state.child);
  }
  queue.length = 0;
  let finalExitCode = exitCode;
  try {
    await resetSrt();
  } catch (error) {
    finalExitCode = 1;
    process.stderr.write(`guardian worker sandbox reset failed: ${errorMessage(error)}`);
  }
  process.exit(finalExitCode);
}

async function protocolFatal(message) {
  if (fatalStarted) return;
  process.stderr.write(`guardian worker protocol failure: ${message}`);
  await shutdown(1);
}

function parseInput(chunk) {
  input += chunk.toString();
  if (byteLength(input) > MAX_FRAME_BYTES) {
    void protocolFatal("input frame exceeds the bound");
    return;
  }
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    const line = input.slice(0, newline).replace(/\r$/, "");
    input = input.slice(newline + 1);
    if (!line) continue;
    if (byteLength(line) > MAX_FRAME_BYTES) {
      void protocolFatal("input frame exceeds the bound");
      return;
    }
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      void protocolFatal("malformed JSON request");
      return;
    }
    if (!request || typeof request !== "object") {
      void protocolFatal("invalid request");
      return;
    }
    if (request.type === "bootstrap") {
      if (
        typeof request.id !== "string" ||
        request.id.length < 1 ||
        request.id.length > MAX_ID_LENGTH
      ) {
        void protocolFatal("invalid bootstrap request");
        return;
      }
      void bootstrap(request).catch((error) => protocolFatal(errorMessage(error)));
    } else if (request.type === "cancel") {
      if (typeof request.id !== "string") {
        void protocolFatal("invalid cancellation request");
        return;
      }
      cancel(request.id);
    } else if (request.type === "shutdown") {
      shuttingDown = true;
      void pump();
    } else if (request.type === "execute") {
      if (
        typeof request.id !== "string" ||
        request.id.length < 1 ||
        request.id.length > MAX_ID_LENGTH
      ) {
        void protocolFatal("invalid execution request");
        return;
      }
      if (active.has(request.id)) {
        void protocolFatal("duplicate execution request id");
        return;
      }
      if (!evidenceScope || request.authorityFingerprint !== evidenceScope.authorityFingerprint) {
        void protocolFatal("execution authority differs from bootstrap scope");
        return;
      }
      if (active.size >= MAX_PENDING_REQUESTS) {
        void protocolFatal("too many pending reviewer worker requests");
        return;
      }
      const state = {
        controller: new AbortController(),
        child: undefined,
        cancelled: false,
      };
      active.set(request.id, state);
      queue.push({ request, state });
      void pump();
    } else {
      void protocolFatal("unsupported request type");
      return;
    }
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", parseInput);
process.stdin.on("end", () => {
  shuttingDown = true;
  void pump();
});
