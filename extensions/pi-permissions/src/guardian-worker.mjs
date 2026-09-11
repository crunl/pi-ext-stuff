import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, fstatSync, lstatSync, realpathSync, statSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, normalize, parse } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { MAX_FRAME_BYTES, MAX_REQUEST_BYTES, MAX_STDERR_BYTES } from "./guardian-worker-limits.mjs";

// This file is intentionally self-contained aside from guardian-worker-limits.mjs.
// Pi loads the extension through jiti, so a worker that imports the extension's
// TypeScript would not be a reliable process entry point for an installed package.

const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 128 * 1024;
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_STDOUT_BYTES = 5 * 1024 * 1024;
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
/** Cooperative retirement: parent nonce once shutdown starts. */
let shutdownNonce;
let retirementProposalSent = false;
let retirementAckReceived = false;
const queue = [];
const active = new Map();

// The client validates this wire vocabulary. Keep the worker self-contained;
// callers consume stage/code, never this error's human-readable message.
class WorkerInfrastructureError extends Error {
  constructor(error, stage, code) {
    super(error instanceof Error ? error.message : text(error));
    this.failure = Object.freeze({ stage, code });
  }
}

function infrastructureFailure(error, stage = "execution", code = "failed") {
  return error instanceof WorkerInfrastructureError
    ? error
    : new WorkerInfrastructureError(error, stage, code);
}

function cancellationFailure(state) {
  return infrastructureFailure(
    state.controller.signal.reason ?? "reviewer worker request aborted",
    "execution",
    "cancelled",
  );
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

// These are SRT's existing output/device exceptions, not ordinary write roots.
// stdout/stderr must be the worker's non-file output endpoints; the other
// exceptions must be actual, non-symlink character devices on a Unix platform.
function isOutputDevice(path) {
  if (process.platform !== "darwin" && process.platform !== "linux") return false;
  if (path === "/dev/stdout" || path === "/dev/stderr") {
    const target = statSync(path, { bigint: true });
    const fd = path === "/dev/stdout" ? 1 : 2;
    const output = fstatSync(fd, { bigint: true });
    // Darwin fdescfs stat and fstat report different device IDs for the
    // same socket. Require the exact OS fd alias and matching endpoint
    // identity/type instead; never exempt an ordinary redirected file.
    const sameDevice =
      process.platform === "darwin"
        ? realpathSync(path) === `/dev/fd/${fd}`
        : target.dev === output.dev;
    return (
      (output.isFIFO() || output.isSocket() || output.isCharacterDevice()) &&
      sameDevice &&
      target.ino === output.ino &&
      target.mode === output.mode &&
      target.rdev === output.rdev
    );
  }
  if (
    path !== "/dev/null" &&
    path !== "/dev/tty" &&
    !(
      process.platform === "darwin" &&
      (path === "/dev/dtracehelper" || path === "/dev/autofs_nowait")
    )
  )
    return false;
  try {
    return lstatSync(path).isCharacterDevice() && realpathSync(path) === path;
  } catch (error) {
    // A missing device is not an exception: deny its spelling against future
    // creation. Other identity failures make bootstrap unavailable.
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function publicMethod(name) {
  const descriptor = Object.getOwnPropertyDescriptor(SandboxManager, name);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") {
    throw new Error(`reviewer worker requires public ${name}`);
  }
  return descriptor.value.bind(SandboxManager);
}

function defaultWriteDenials() {
  const getConfig = publicMethod("getConfig");
  const assertFresh = () => {
    if (srtReady || srtPoisoned || getConfig() !== undefined) {
      throw new Error("reviewer worker requires a fresh sandbox singleton");
    }
  };
  assertFresh();
  const defaults = publicMethod("getFsWriteConfig")();
  assertFresh();
  if (
    !defaults ||
    typeof defaults !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(defaults)) ||
    Reflect.ownKeys(defaults).length !== 2
  )
    throw new Error("reviewer worker default write config is invalid");
  const lists = {};
  for (const key of ["allowOnly", "denyWithinAllow"]) {
    const descriptor = Object.getOwnPropertyDescriptor(defaults, key);
    const list = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (
      !Array.isArray(list) ||
      Object.getPrototypeOf(list) !== Array.prototype ||
      list.length > 256 ||
      Reflect.ownKeys(list).length !== list.length + 1
    )
      throw new Error("reviewer worker default write list is invalid");
    const copy = [];
    for (let index = 0; index < list.length; index += 1) {
      const entry = Object.getOwnPropertyDescriptor(list, String(index));
      const path = entry && "value" in entry ? entry.value : undefined;
      if (
        typeof path !== "string" ||
        !isAbsolute(path) ||
        path === parse(path).root ||
        normalize(path) !== path ||
        byteLength(path) > 4096 ||
        Buffer.from(path, "utf8").toString("utf8") !== path ||
        /[*?[\]{}\\~]/.test(path) ||
        [...path].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new Error("reviewer worker default write path is unrepresentable");
      copy.push(path);
    }
    lists[key] = copy;
  }
  if (
    lists.allowOnly.length === 0 ||
    lists.denyWithinAllow.length !== 0 ||
    byteLength(JSON.stringify(lists)) > 64 * 1024
  ) {
    throw new Error("reviewer worker default write config is not fresh or exceeds the bound");
  }
  // New public defaults are denied automatically. Never fall back to empty
  // denies on a missing API or unrepresentable policy, and never copy SRT's
  // private ordinary-path list. All derivation finishes before bootstrap ack.
  return Object.freeze([...new Set(lists.allowOnly.filter((path) => !isOutputDevice(path)))]);
}

async function bootstrap(request) {
  if (bootstrapStarted || evidenceScope || active.size > 0 || queue.length > 0 || shuttingDown) {
    throw infrastructureFailure(
      "reviewer worker evidence scope is already fixed",
      "bootstrap",
      "protocol",
    );
  }
  bootstrapStarted = true;
  if (byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) {
    throw infrastructureFailure(
      "reviewer worker bootstrap exceeds the bound",
      "bootstrap",
      "protocol",
    );
  }
  let scope;
  try {
    scope = validateEvidenceScope(request.evidenceScope);
  } catch (error) {
    throw infrastructureFailure(error, "bootstrap", "protocol");
  }
  const canonicalScopeCwd = await canonicalCwd(scope.cwd);
  const denyWrite = defaultWriteDenials();
  if (fatalStarted || shuttingDown) throw new Error("reviewer worker bootstrap interrupted");
  // This worker owns its own singleton and policy. Host TLS/network authority
  // never crosses bootstrap; feature detection selects stronger isolation only
  // where the public backend advertises it, retaining strict legacy elsewhere.
  const capabilities =
    typeof SandboxManager.getNetworkModeCapabilities === "function"
      ? SandboxManager.getNetworkModeCapabilities()
      : undefined;
  const restricted =
    capabilities?.apiVersion === 1 &&
    capabilities.platform === "macos" &&
    capabilities.modes.includes("restricted");
  readOnlySandboxConfig = Object.freeze({
    filesystem: Object.freeze({
      denyRead: Object.freeze([...scope.denyRead]),
      allowWrite: Object.freeze([]),
      denyWrite,
    }),
    network: Object.freeze({
      ...(restricted ? { mode: "restricted" } : {}),
      allowedDomains: Object.freeze([]),
      deniedDomains: Object.freeze(["*"]),
      allowLocalBinding: false,
    }),
  });
  evidenceScope = scope;
  evidenceScopeCwd = canonicalScopeCwd;
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
      error: "response is not serializable",
      failure: { stage: "transport", code: "protocol" },
    });
  }
  if (byteLength(encoded) + 1 > MAX_FRAME_BYTES) {
    encoded = JSON.stringify({
      type: "error",
      error: "worker response exceeds the frame bound",
      failure: { stage: "transport", code: "protocol" },
    });
  }
  return `${encoded}\n`;
}

function send(value) {
  if (!process.stdout.destroyed) process.stdout.write(jsonFrame(value));
}

function sendFailure(error, id) {
  send({
    type: "error",
    ...(id === undefined ? {} : { id }),
    error: errorMessage(error),
    failure: error.failure,
  });
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
  if (srtPoisoned) {
    throw infrastructureFailure(
      "reviewer worker sandbox is unavailable after cleanup failure",
      "initialization",
      "poisoned",
    );
  }
  if (srtReady) return;
  if (!evidenceScope || !readOnlySandboxConfig) {
    throw infrastructureFailure(
      "reviewer worker evidence scope is unavailable",
      "initialization",
      "protocol",
    );
  }
  try {
    if (!SandboxManager.isSupportedPlatform()) {
      throw infrastructureFailure(
        `reviewer worker sandbox is unsupported on ${process.platform}`,
        "initialization",
        "unsupported",
      );
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
    throw infrastructureFailure(error, "initialization");
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
    throw infrastructureFailure(
      `reviewer worker sandbox cleanup failed: ${errorMessage(cleanupError)}; reset failed: ${errorMessage(resetError)}`,
      "cleanup",
    );
  }
  if (cleanupError) throw infrastructureFailure(cleanupError, "cleanup");
  if (resetError) throw infrastructureFailure(resetError, "cleanup");
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
    let primaryError;
    let aborted = false;
    let settled = false;
    const timeout = boundedInteger(request.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      aborted = true;
      state.controller.abort(
        infrastructureFailure("reviewer worker request timed out", "execution", "timeout"),
      );
      killWorkerProcessTree(child);
    }, timeout);
    // Ownership stays until actual close. An `error` event is primary evidence
    // only; clearing state.child earlier lets cleanup race the close.
    const finishFromClose = (exitCode, signalCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.child = undefined;
      if (state.controller.signal.aborted || aborted) {
        reject(primaryError ?? cancellationFailure(state));
      } else if (outputError) {
        reject(outputError);
      } else if (primaryError) {
        reject(primaryError);
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
    child.once("error", (error) => {
      primaryError = primaryError ?? outputError ?? infrastructureFailure(error);
    });
    child.once("close", (exitCode, signalCode) => finishFromClose(exitCode, signalCode));
    if (state.controller.signal.aborted) {
      aborted = true;
      killWorkerProcessTree(child);
    }
  });
}

async function execute(request, state) {
  if (state.cancelled) throw cancellationFailure(state);
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
    throw infrastructureFailure(
      "reviewer worker execution scope drifted from bootstrap authority",
      "execution",
      "protocol",
    );
  }
  let program;
  try {
    program = validateProgram(request.program);
  } catch (error) {
    throw infrastructureFailure(error, "execution", "protocol");
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
      throw cancellationFailure(state);
    }
    result = await runWrapped(wrapped, request, state);
  } catch (error) {
    bodyError = state.controller.signal.aborted ? cancellationFailure(state) : error;
  }
  let cleanupError;
  try {
    SandboxManager.cleanupAfterCommand();
  } catch (error) {
    srtPoisoned = true;
    cleanupError = infrastructureFailure(
      `reviewer worker sandbox cleanup failed: ${errorMessage(error)}`,
      "cleanup",
    );
  }
  // Cleanup failure is authoritative and poisons the worker. Keep it outside
  // a finally block so it cannot accidentally mask the cancellation/error
  // control flow in a way that leaves the caller waiting.
  if (cleanupError) throw cleanupError;
  if (bodyError) throw bodyError;
  return result;
}

async function handleRequest(request, state) {
  const id = request?.id;
  const responseId =
    typeof id === "string" && id.length >= 1 && id.length <= MAX_ID_LENGTH ? id : undefined;
  try {
    if (typeof id !== "string" || id.length < 1 || id.length > MAX_ID_LENGTH) {
      throw new Error("invalid reviewer worker request id");
    }
    if (request.type !== "execute") throw new Error("unsupported reviewer worker request");
    if (state.cancelled) throw cancellationFailure(state);
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
    sendFailure(infrastructureFailure(error, "execution", "protocol"), responseId);
    // Restore SRT if possible, but stay alive so the parent can start
    // cooperative retirement with a nonce. Immediate self-exit would make
    // close() observe exit-zero without a handshake.
    try {
      await resetSrt();
    } catch (resetError) {
      sendFailure(infrastructureFailure(resetError, "cleanup"));
    }
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
        sendFailure(cancellationFailure(item.state), item.request.id);
        active.delete(item.request.id);
        continue;
      }
      await handleRequest(item.request, item.state);
    }
  } finally {
    pumping = false;
    // Cooperative shutdown is parent-driven via shutdown(nonce). Do not exit
    // here after a request error; the parent close() owns the handshake.
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
    // Wait for any still-owned wrapped children to close before proposing
    // retirement. Cancellation above already requested their teardown.
    for (const state of active.values()) {
      if (state.child && typeof state.child.once === "function") {
        await new Promise((resolve) => {
          if (state.child.exitCode !== null || state.child.signalCode !== null) {
            resolve();
            return;
          }
          state.child.once("close", () => resolve());
          setTimeout(resolve, 1_000);
        });
      }
    }
    await resetSrt();
  } catch (error) {
    finalExitCode = 1;
    sendFailure(infrastructureFailure(error, "cleanup"));
    process.stderr.write(`guardian worker sandbox reset failed: ${errorMessage(error)}`);
  }
  if (finalExitCode === 0 && shutdownNonce && !retirementProposalSent) {
    retirementProposalSent = true;
    send({ type: "retirement-proposal", nonce: shutdownNonce });
    // Wait for the parent ACK before self-signalling. Without an ACK this is
    // failed teardown, not successful cooperative retirement.
    const ackDeadline = Date.now() + 2_000;
    while (!retirementAckReceived && Date.now() < ackDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (retirementAckReceived) {
      if (!process.stdout.destroyed) {
        await new Promise((resolve) => process.stdout.write("", resolve));
      }
      // Successful cooperative retirement: the worker signals its own group.
      if (process.platform !== "win32" && process.pid > 0) {
        try {
          process.kill(-process.pid, "SIGKILL");
        } catch {
          process.kill(process.pid, "SIGKILL");
        }
      } else {
        process.kill(process.pid, "SIGKILL");
      }
      return;
    }
    finalExitCode = 1;
  }
  // Flush terminal metadata before exit. The parent's existing bounded close
  // deadline still owns termination if this pipe or SRT reset cannot drain.
  if (!process.stdout.destroyed) {
    await new Promise((resolve) => process.stdout.write("", resolve));
  }
  process.exit(finalExitCode);
}

async function fatalFailure(error) {
  if (fatalStarted) return;
  sendFailure(error);
  // Do not self-exit. The parent close() owns cooperative retirement so SRT
  // reset and the nonce handshake stay ordered. Emergency teardown is the
  // parent's deadline path.
  shuttingDown = true;
}

async function protocolFatal(message) {
  await fatalFailure(infrastructureFailure(message, "transport", "protocol"));
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
      void bootstrap(request).catch((error) =>
        fatalFailure(infrastructureFailure(error, "bootstrap")),
      );
    } else if (request.type === "cancel") {
      if (typeof request.id !== "string") {
        void protocolFatal("invalid cancellation request");
        return;
      }
      cancel(request.id);
    } else if (request.type === "shutdown") {
      shuttingDown = true;
      if (
        typeof request.nonce === "string" &&
        request.nonce.length > 0 &&
        request.nonce.length <= 64
      ) {
        shutdownNonce = request.nonce;
      }
      void pump().then(() => shutdown());
    } else if (request.type === "retirement-ack") {
      if (
        typeof request.nonce !== "string" ||
        !shutdownNonce ||
        request.nonce !== shutdownNonce ||
        !retirementProposalSent ||
        retirementAckReceived
      ) {
        void protocolFatal("invalid retirement ACK");
        return;
      }
      retirementAckReceived = true;
    } else if (request.type === "execute") {
      if (shuttingDown || fatalStarted) {
        void protocolFatal("execution request during retirement");
        return;
      }
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
  void pump().then(() => shutdown());
});
