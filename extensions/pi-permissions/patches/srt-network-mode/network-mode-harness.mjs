// Parent-run ONLY: macOS, local synthetic fixtures, replacement environment.
// No CLI targets/policy, public endpoints, inherited credentials, or live user files.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { context, options, owned, verifyCopies, verifyPackage } from "./artifacts.mjs";
import { terminateOnCancellation } from "./cooperative-cancellation.mjs";

const workerKind = process.argv[2]?.endsWith("worker") ? process.argv[2] : undefined;
const selection = options(workerKind ? process.argv.slice(4) : process.argv.slice(2));
const ctx = context(selection.root, selection.selection);
verifyCopies(ctx);
verifyPackage(ctx);
const SCRATCH = ctx.root;
const PACKAGE = ctx.packagePath;
const SELF = fileURLToPath(import.meta.url);
const WORKLOAD = path.join(SCRATCH, "network-mode-workload.mjs");
const cleanEnv = (root) => ({
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: root,
  TMPDIR: root,
  CLAUDE_CODE_TMPDIR: root,
  LANG: "C",
  LC_ALL: "C",
  TERM: "dumb",
  SRT_SYNTHETIC_DENY: "synthetic-not-a-credential",
  // SRT may invoke local `npm root -g` discovery; never consult real npmrcs or update.
  npm_config_userconfig: `${root}/npm-user-config`,
  npm_config_globalconfig: `${root}/npm-global-config`,
  npm_config_offline: "true",
  npm_config_update_notifier: "false",
});
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
async function assertListenerGone(port) {
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("listener disappearance deadline"));
    }, 500);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("listener survived reset"));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
}
// Diagnostics carry only bounded phase/error identity and owned process IDs.
function diagnostic(state, kind, phase, error) {
  process.stderr.write(
    `${JSON.stringify({
      kind,
      phase,
      pid: state.pid,
      pgid: state.pgid,
      uid: process.getuid(),
      code: String(error?.code ?? "NO_CODE").slice(0, 64),
      name: String(error?.name ?? "Error").slice(0, 64),
    })}\n`,
  );
}
function primaryFailure(state, phase, error) {
  if (!state.primary) {
    state.primary = error;
    diagnostic(state, "primary-failure", phase, error);
  }
}
async function cleanupStep(state, phase, action) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error("cleanup deadline"), { code: "CLEANUP_TIMEOUT" })),
          2000,
        );
      }),
    ]);
    return true;
  } catch (error) {
    state.errors.push(error);
    diagnostic(state, "cleanup-failure", phase, error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
function assertProcessGone(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
  throw Object.assign(new Error("owned process/group still present"), {
    code: "OWNED_PROCESS_PRESENT",
  });
}
function finish(state) {
  if (state.primary) throw state.primary; // Never replace the triggering error with cleanup noise.
  if (state.errors.length) throw new AggregateError(state.errors, "harness cleanup failed");
}
assert.equal(process.platform, "darwin", "This harness is macOS-only");
if (!workerKind) {
  const root = await realpath(await mkdtemp(`${SCRATCH}/nm-`));
  const state = { pid: process.pid, pgid: undefined, primary: undefined, errors: [] };
  const records = [];
  let current, timer, stopWaiting;
  let containmentRequested = false;
  const reports = [];
  function signalOwnedLiveWorker(phase) {
    if (!current || current.gone || !Number.isInteger(current.pid) || current.pid <= 1) return;
    // Once the leader exits, live group ownership is no longer proven. Do not
    // signal a potentially reused group; diagnose/retain for parent investigation.
    if (current.exited) return;
    try {
      process.kill(-current.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") {
        state.errors.push(error);
        diagnostic(state, "cleanup-failure", phase, error);
      }
    }
  }
  function contain(phase, error) {
    if (containmentRequested) return;
    containmentRequested = true;
    primaryFailure(state, phase, error);
    signalOwnedLiveWorker(`${phase}-group-signal`);
    stopWaiting?.({ abandoned: true }); // Signal failure cannot leave the observer waiting forever.
  }
  const interrupt = () =>
    contain("interruption", new Error("forced containment; not reset evidence"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    async function runWorker(kind) {
      const worker = spawn(
        process.execPath,
        [SELF, kind, root, "--root", ctx.root, "--package", ctx.selection],
        {
          cwd: root,
          env: cleanEnv(root),
          detached: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      const record = { worker, pid: worker.pid, exited: false, gone: false, cleanExit: false };
      current = record;
      if (Number.isInteger(record.pid) && record.pid > 1) records.push(record);
      state.pgid = record.pid;
      process.stderr.write(
        `${JSON.stringify({ kind: "owned-worker", phase: kind, pid: record.pid, pgid: record.pid, observerPid: process.pid, uid: process.getuid() })}\n`,
      );
      worker.once("exit", () => {
        record.exited = true;
      });
      worker.on("error", (error) => contain("worker-error", error));
      worker.on("message", (message) => {
        if (message.kind === "cancel-ready" && worker.connected)
          worker.send({ kind: "cancel" }, (error) => {
            if (error) contain("cancel-request", error);
          });
        if (message.kind === "reset-complete") reports.push(message);
      });
      const abandoned = new Promise((resolve) => {
        stopWaiting = resolve;
      });
      timer = setTimeout(
        () =>
          contain(
            "worker-deadline",
            new Error("forced containment deadline; SIGKILL cannot run reset/finally"),
          ),
        kind === "--cancel-worker" ? 10000 : 60000,
      );
      let bytes = 0;
      for (const [stream, output] of [
        [worker.stdout, process.stdout],
        [worker.stderr, process.stderr],
      ]) {
        stream.on("error", (error) => contain("worker-output", error));
        stream.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 65_536) contain("output-limit", new Error("64KiB output limit"));
          else output.write(chunk);
        });
      }
      const closed = new Promise((resolve) =>
        worker.once("close", (code, signal) => resolve({ code, signal })),
      );
      const status = await Promise.race([closed, abandoned]);
      clearTimeout(timer);
      stopWaiting = undefined;
      record.cleanExit = status.code === 0;
      if (state.primary) throw state.primary;
      assert.equal(
        status.code,
        0,
        `native harness worker failed (${status.signal ?? status.code})`,
      );
      assertProcessGone(record.pid);
      assertProcessGone(-record.pid);
      record.gone = true;
      const completedResets = reports.splice(0);
      assert.ok(completedResets.length > 0, "worker must report completed reset, not just exit");
      if (kind === "--cancel-worker") {
        assert.equal(completedResets.length, 1);
        assert.ok(Number.isInteger(completedResets[0].childPid) && completedResets[0].childPid > 1);
      }
      for (const report of completedResets) {
        if (report.childPid) assertProcessGone(report.childPid);
        await assertListenerGone(report.port);
      }
    }
    await runWorker("--worker");
    await runWorker("--cancel-worker");
  } catch (error) {
    primaryFailure(state, "worker-run", error);
  } finally {
    clearTimeout(timer);
    signalOwnedLiveWorker("final-group-signal");
    // Failure of any step must not suppress the remaining safe cleanup steps.
    for (const record of records) {
      if (!record.gone)
        await cleanupStep(state, "group-disappearance", () => {
          assertProcessGone(record.pid);
          assertProcessGone(-record.pid);
          record.gone = true;
        });
      await cleanupStep(state, "observer-ipc", () => {
        if (record.worker.connected) record.worker.disconnect();
      });
      await cleanupStep(state, "observer-stdout", () => record.worker.stdout.destroy());
      await cleanupStep(state, "observer-stderr", () => record.worker.stderr.destroy());
      await cleanupStep(state, "observer-unref", () => record.worker.unref());
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    let removed = false;
    if (records.every((record) => record.gone && record.cleanExit) && state.errors.length === 0) {
      removed = await cleanupStep(state, "owned-fixture-removal", async () => {
        owned(root, true);
        assert.equal(await realpath(root), root);
        await rm(root, { recursive: true, force: true });
      });
    }
    if (!removed)
      process.stderr.write(
        `${JSON.stringify({ kind: "fixtures-retained", phase: "cleanup-unproven", fixture: path.basename(root), pid: state.pid, pgid: state.pgid })}\n`,
      );
  }
  finish(state);
} else {
  assert.ok(["--worker", "--cancel-worker"].includes(workerKind));
  const root = process.argv[3];
  assert.match(root.slice((await realpath(SCRATCH)).length), /^\/nm-[A-Za-z0-9]+$/);
  assert.equal(await realpath(root), root);
  owned(root, true);
  assert.equal(process.env.HOME, root);
  // Independent last resort if the observer cannot signal this owned worker.
  // Self-exit is forced containment, never successful reset or native acceptance.
  setTimeout(
    () => {
      process.stderr.write(
        `${JSON.stringify({ kind: "forced-self-exit", phase: workerKind, pid: process.pid })}\n`,
      );
      process.exit(124);
    },
    workerKind === "--cancel-worker" ? 15000 : 75000,
  ).unref();
  let pkg;
  try {
    pkg = JSON.parse(await readFile(`${PACKAGE}/package.json`, "utf8"));
  } catch (error) {
    diagnostic(
      { pid: process.pid, pgid: process.pid },
      "primary-failure",
      "package-metadata",
      error,
    );
    throw error;
  }
  assert.equal(pkg.name, "@anthropic-ai/sandbox-runtime");
  assert.equal(pkg.version, "0.0.74");
  // Resolve the declared public entry point; no unexported SRT internals.
  const {
    SandboxManager: manager,
    SandboxRuntimeConfigSchema: schema,
    generateCa,
  } = await import(new URL(pkg.main, pathToFileURL(`${PACKAGE}/`)).href);
  assert.equal(manager.getNetworkModeCapabilities?.().apiVersion, 1);
  assert.deepEqual(manager.getNetworkModeCapabilities().modes, ["proxy", "restricted", "direct"]);
  const workerState = { pid: process.pid, pgid: process.pid, primary: undefined, errors: [] };
  if (workerKind === "--cancel-worker") {
    const config = {
      filesystem: { allowWrite: [root], denyRead: [], denyWrite: [] },
      network: { mode: "restricted", allowedDomains: [], deniedDomains: ["*"] },
    };
    let child;
    let port;
    try {
      await manager.initialize(config, undefined, false);
      port = manager.getProxyPort();
      const cancelled = new Promise((resolve) =>
        process.once("message", (message) => {
          assert.equal(message.kind, "cancel");
          resolve();
        }),
      );
      const command = [
        process.execPath,
        "-e",
        'process.stdout.write("ready\\n");setTimeout(()=>process.exit(124),8000)',
      ]
        .map(quote)
        .join(" ");
      const descriptor = await manager.wrapWithSandboxArgv(command, "/bin/bash", {
        network: { mode: undefined },
      });
      child = spawn(descriptor.argv[0], descriptor.argv.slice(1), {
        cwd: root,
        env: cleanEnv(root),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      process.stderr.write(
        `${JSON.stringify({ kind: "owned-workload", phase: "cooperative", pid: child.pid, pgid: process.pid, uid: process.getuid() })}\n`,
      );
      child.on("error", (error) => primaryFailure(workerState, "cooperative-child-error", error));
      const closed = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      await new Promise((resolve, reject) => {
        child.stdout.once("data", (data) => {
          assert.equal(data.toString(), "ready\n");
          resolve();
        });
        child.once("error", reject);
      });
      process.send({ kind: "cancel-ready" });
      const status = await terminateOnCancellation(child, cancelled, closed);
      assert.equal(status.signal, "SIGTERM");
      manager.cleanupAfterCommand();
      await manager.reset();
      assert.equal(await manager.waitForNetworkInitialization(), false);
      await assertListenerGone(port);
      process.send({ kind: "reset-complete", port, childPid: child.pid });
      process.stdout.write(
        "PASS: cooperative host cancellation, child reaped and awaited SRT reset; not forced teardown\n",
      );
    } catch (error) {
      primaryFailure(workerState, "cooperative-worker", error);
    } finally {
      await cleanupStep(workerState, "cooperative-child-signal", () => {
        if (
          child &&
          Number.isInteger(child.pid) &&
          child.pid > 1 &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          if (!child.kill("SIGKILL")) {
            throw Object.assign(new Error("Cooperative cleanup signal was not delivered"), {
              code: "COOPERATIVE_SIGNAL_FAILED",
            });
          }
        }
      });
      await cleanupStep(workerState, "cooperative-reset", () => manager.reset());
      await cleanupStep(workerState, "cooperative-ipc-close", () => {
        if (process.connected) process.disconnect();
      });
    }
  } else {
    const counts = { tcp4: 0, tcp6: 0, guard: 0, unixAllowed: 0, unixBlocked: 0, udp4: 0, udp6: 0 };
    const servers = [],
      datagrams = [],
      sockets = new Set();
    let callbackCount = 0;
    let expectedPeerResets = 0;
    async function tcpServer(key, address) {
      const server = net.createServer((socket) => {
        counts[key]++;
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", (error) => {
          if (error.code === "ECONNRESET") expectedPeerResets++;
          else primaryFailure(workerState, "sentinel-peer-error", error);
          socket.destroy();
        });
        // Connectivity-only clients intentionally destroy immediately after connect.
        // Send FIN only, never an unnecessary payload that races their close.
        socket.end();
      });
      servers.push(server);
      server.on("error", (error) => primaryFailure(workerState, "sentinel-server-error", error));
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(address, resolve);
      });
      return typeof server.address() === "object" ? server.address().port : server.address();
    }
    async function udpServer(key, host) {
      const socket = dgram.createSocket(key);
      datagrams.push(socket);
      socket.on("message", (data, peer) => {
        assert.equal(data.toString(), "synthetic-ping");
        assert.equal(peer.address, host);
        counts[key]++;
        socket.send("synthetic-ack", peer.port, peer.address);
      });
      await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(0, host, resolve);
      });
      return socket.address().port;
    }
    const protectedFiles = [
      "allowed/locked.txt",
      "outside.txt",
      "allowed/.git/config",
      "allowed/.git/hooks/pre-commit",
    ];
    async function restore() {
      for (const name of protectedFiles) await writeFile(`${root}/${name}`, "unchanged");
    }
    async function verifyFiles() {
      for (const name of protectedFiles)
        assert.equal(await readFile(`${root}/${name}`, "utf8"), "unchanged", name);
      assert.equal(await readFile(`${root}/allowed/ok.txt`, "utf8"), "synthetic-write");
      assert.equal(await readFile(`${root}/allowed/secret.txt`, "utf8"), "synthetic-secret");
    }
    async function execute(descriptor) {
      const child = spawn(descriptor.argv[0], descriptor.argv.slice(1), {
        cwd: root,
        env: cleanEnv(root),
        detached: false,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      process.stderr.write(
        `${JSON.stringify({ kind: "owned-workload", phase: "native-case", pid: child.pid, pgid: process.pid, uid: process.getuid() })}\n`,
      );
      child.on("error", (error) => primaryFailure(workerState, "native-child-error", error));
      let stdout = "",
        stderr = "",
        pending = "",
        finalResult,
        failed = false;
      const inbound = [];
      const timer = setTimeout(() => {
        failed = true;
        child.kill("SIGKILL");
      }, 6000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        pending += chunk;
        if (stdout.length > 16_384) {
          failed = true;
          child.kill("SIGKILL");
          return;
        }
        while (pending.includes("\n")) {
          const end = pending.indexOf("\n");
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          let value;
          try {
            value = JSON.parse(line);
          } catch (error) {
            failed = true;
            primaryFailure(workerState, "invalid-workload-json", error);
            child.kill("SIGKILL");
            return;
          }
          if (!value.listen) {
            finalResult = value;
            continue;
          }
          assert.ok(["127.0.0.1", "::1"].includes(value.listen.host));
          assert.ok(
            Number.isInteger(value.listen.port) &&
              value.listen.port > 0 &&
              value.listen.port < 65536,
          );
          // Only the synthetic child may announce a loopback listener. Exercise
          // actual host -> sandbox inbound, not just the ability to call bind().
          inbound.push(
            new Promise((resolve) => {
              const socket = net.connect(value.listen);
              sockets.add(socket);
              socket.once("close", () => sockets.delete(socket));
              const timeout = setTimeout(() => {
                failed = true;
                socket.destroy();
                resolve();
              }, 1000);
              socket.once("data", (data) => {
                if (data.toString() !== "synthetic-inbound-ack") failed = true;
                clearTimeout(timeout);
                socket.destroy();
                resolve();
              });
              socket.once("error", () => {
                failed = true;
                clearTimeout(timeout);
                socket.destroy();
                resolve();
              });
            }),
          );
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stderr.length > 16_384) {
          failed = true;
          child.kill("SIGKILL");
        }
      });
      try {
        const code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        await Promise.all(inbound);
        assert.equal(failed, false, "workload deadline/output/inbound bound");
        assert.equal(code, 0, `workload exited ${code}: ${stderr.slice(0, 2048)}`);
        assert.ok(finalResult, "workload returned a final result");
        if (workerState.primary) throw workerState.primary;
      } catch (error) {
        primaryFailure(workerState, "workload", error);
        throw error;
      } finally {
        clearTimeout(timer);
        await cleanupStep(workerState, "after-command", () => manager.cleanupAfterCommand());
      }
      finish(workerState);
      return finalResult;
    }
    function assertOutcome(result, key, expected) {
      assert.equal(result[key].ok, expected, `${key}: ${JSON.stringify(result[key])}`);
      // A refused listener, unreachable endpoint or timeout is NOT native-denial proof.
      if (!expected)
        assert.ok(
          ["EPERM", "EACCES"].includes(result[key].code),
          `${key} lacks a native permission denial`,
        );
    }
    function assertCounts(before, expected) {
      for (const key of Object.keys(counts))
        assert.equal(
          counts[key] - before[key],
          expected[key] ?? 0,
          `${key} received unexpected connections/datagrams`,
        );
    }
    try {
      await mkdir(`${root}/allowed/.git/hooks`, { recursive: true });
      await mkdir(`${root}/ipc`);
      await writeFile(`${root}/allowed/secret.txt`, "synthetic-secret");
      await restore();
      const spec = {
        root,
        tcp4: await tcpServer("tcp4", { port: 0, host: "127.0.0.1" }),
        tcp6: await tcpServer("tcp6", { port: 0, host: "::1", ipv6Only: true }),
        guard: await tcpServer("guard", { port: 0, host: "127.0.0.1" }),
        udp4: await udpServer("udp4", "127.0.0.1"),
        udp6: await udpServer("udp6", "::1"),
      };
      await tcpServer("unixAllowed", `${root}/ipc/allowed.sock`);
      await tcpServer("unixBlocked", `${root}/blocked.sock`);
      const base = {
        filesystem: {
          allowWrite: [`${root}/allowed`, `${root}/ipc`],
          denyRead: [`${root}/allowed/secret.txt`],
          denyWrite: [`${root}/allowed/locked.txt`],
        },
        network: {
          allowedDomains: [],
          deniedDomains: ["*"],
          allowLocalBinding: false,
          parentProxy: {
            http: `http://127.0.0.1:${spec.guard}`,
            https: `http://127.0.0.1:${spec.guard}`,
            noProxy: "",
          },
        },
        credentials: { envVars: [{ name: "SRT_SYNTHETIC_DENY", mode: "deny" }] },
      };
      assert.equal(schema.safeParse(base).success, true);
      const deps = await manager.checkDependenciesAsync();
      assert.deepEqual(deps.errors, []);
      await manager.initialize(
        base,
        async () => {
          callbackCount++;
          return false;
        },
        false,
      );
      assert.equal(await manager.waitForNetworkInitialization(), true);
      spec.proxy = manager.getProxyPort();
      assert.ok(Number.isInteger(spec.proxy));
      let program, command;
      function refreshProgram() {
        spec.proxy = manager.getProxyPort();
        program = [process.execPath, WORKLOAD, JSON.stringify(spec)];
        command = program.map(quote).join(" ");
      }
      refreshProgram();
      const wrap = (network) =>
        manager.wrapWithSandboxArgv(
          command,
          "/bin/bash",
          network ? { network } : undefined,
          undefined,
          root,
          { commandId: "synthetic-network-mode" },
        );
      async function control(label) {
        const before = { ...counts };
        const result = await execute({ argv: program });
        for (const key of Object.keys(result).filter((key) => typeof result[key] === "object"))
          assertOutcome(result, key, true);
        assert.equal(result.proxyEnvironment, false);
        assert.equal(result.agentEnvironment, false);
        assert.equal(result.caEnvironment, false);
        assert.equal(result.credentialDenied, false);
        assertCounts(before, {
          tcp4: 2,
          tcp6: 1,
          guard: 1,
          udp4: 1,
          udp6: 1,
          unixAllowed: 1,
          unixBlocked: 1,
        });
        await restore();
        process.stdout.write(`${JSON.stringify({ case: label, positiveFixtures: true })}\n`);
      }
      async function run(
        label,
        descriptor,
        { proxy = false, direct = false, binding = false, unix = false, ca = false } = {},
      ) {
        const before = { ...counts };
        const result = await execute(descriptor);
        for (const key of ["tcp4", "tcp6", "tcpMapped", "guard"])
          assertOutcome(result, key, direct);
        assertOutcome(result, "proxy", proxy || direct);
        for (const key of ["udp4", "udp6", "bind4", "bind6"]) assertOutcome(result, key, binding);
        for (const key of ["unixAllowed", "bindUnix"]) assertOutcome(result, key, unix);
        assertOutcome(result, "unixBlocked", false);
        assertOutcome(result, "allowedWrite", true);
        for (const key of ["denyRead", "denyWrite", "outsideWrite", "gitConfig", "gitHook"])
          assertOutcome(result, key, false);
        assert.equal(result.proxyEnvironment, proxy);
        assert.equal(result.caEnvironment, ca);
        if (spec.caPath) {
          assertOutcome(result, "caRead", proxy);
          assertOutcome(result, "agentRead", proxy);
          assert.equal(result.agentEnvironment, proxy);
        }
        if (!proxy) assert.equal(result.agentEnvironment, false);
        assert.equal(result.credentialDenied, true);
        assert.equal(callbackCount, 0);
        assertCounts(before, {
          tcp4: direct ? 2 : 0,
          tcp6: direct ? 1 : 0,
          guard: direct ? 1 : 0,
          udp4: binding ? 1 : 0,
          udp6: binding ? 1 : 0,
          unixAllowed: unix ? 1 : 0,
        });
        await verifyFiles();
        process.stdout.write(
          `${JSON.stringify({
            case: label,
            nativeAndFilesystemControls: true,
            callbackCount,
            result,
          })}\n`,
        );
      }
      await control("positive-before");
      await run(
        "restricted-with-initialized-guard-and-hard-deny",
        await wrap({ mode: "restricted" }),
      );
      await run("explicit-proxy", await wrap({ mode: "proxy" }), { proxy: true });
      await run("legacy-absent-mode", await wrap(), { proxy: true });
      await assert.rejects(wrap({ mode: "direct" }), { code: "NETWORK_MODE_INCOMPATIBLE" });
      for (const permission of [
        { allowLocalBinding: true },
        { allowAllUnixSockets: true },
        { allowUnixSockets: [`${root}/ipc`] },
        { allowMachLookup: ["*"] },
      ]) {
        await assert.rejects(wrap({ mode: "restricted", ...permission }), {
          code: "NETWORK_MODE_INCOMPATIBLE",
        });
      }
      // Freeze a wrapped descriptor, update host policy, THEN launch A and B.
      // This does not exercise an already-running A across the update.
      const frozenA = await wrap({ mode: "restricted" });
      const directBase = { ...base, network: { ...base.network, deniedDomains: [] } };
      manager.updateConfig(directBase);
      await run("prewrapped-restricted-A-launched-after-host-update", frozenA);
      await run("direct-B-no-bind-no-unix", await wrap({ mode: "direct" }), { direct: true });
      await run(
        "direct-with-explicit-IP-bind-inbound",
        await wrap({ mode: "direct", allowLocalBinding: true }),
        { direct: true, binding: true },
      );
      await run(
        "direct-with-narrow-unix-opt-in",
        await wrap({ mode: "direct", allowLocalBinding: true, allowUnixSockets: [`${root}/ipc`] }),
        { direct: true, binding: true, unix: true },
      );
      manager.updateConfig(base); // Mirrors coordinator policy restore, no reinitialization.
      await run("restricted-after-policy-restore", await wrap({ mode: "restricted" }));
      await control("positive-after");
      await manager.reset();
      assert.equal(manager.isSandboxingEnabled(), true);
      assert.equal(await manager.waitForNetworkInitialization(), false);
      for (const mode of ["proxy", "restricted"])
        await assert.rejects(wrap({ mode }), { code: "NETWORK_MODE_NOT_READY" });
      await assertListenerGone(spec.proxy);
      process.send({ kind: "reset-complete", port: spec.proxy });
      // Genuine external failure seam: nonexistent TMPDIR prevents the mux Unix
      // backend from binding after construction. No SRT/Engine implementation mock.
      const originalTmp = process.env.TMPDIR;
      const missingParent = `${root}/missing-parent`;
      await assert.rejects(lstat(missingParent), { code: "ENOENT" });
      process.env.TMPDIR = missingParent;
      try {
        // The separate no-SRT macOS control returns EACCES for this Unix bind,
        // while lstat reports ENOENT. Match the operation and owned address too.
        await assert.rejects(manager.initialize(base, undefined, false), (error) => {
          assert.equal(error.code, "EACCES");
          assert.equal(error.syscall, "listen");
          assert.equal(path.dirname(error.address), missingParent);
          assert.match(
            path.basename(error.address),
            new RegExp(`^srt-mux-${process.pid}-[0-9]+\\.sock$`),
          );
          return true;
        });
      } finally {
        process.env.TMPDIR = originalTmp;
        await manager.reset();
      }
      assert.equal(await manager.waitForNetworkInitialization(), false);
      assert.equal(manager.getProxyPort(), undefined);
      await manager.initialize(base, undefined, false);
      refreshProgram();
      await run(
        "fresh-initialize-after-partial-network-failure",
        await wrap({ mode: "restricted" }),
      );
      const freshPort = manager.getProxyPort();
      await manager.reset();
      await assertListenerGone(freshPort);
      process.send({ kind: "reset-complete", port: freshPort });
      // Real valid synthetic CA and actual vendored agent file: host infrastructure
      // stays initialized while restricted/direct suppress env and read exceptions.
      const ca = generateCa({ cn: "synthetic-local-only", validityDays: 1 });
      spec.caPath = `${root}/ca.pem`;
      spec.agentPath = `${root}/agent.jar`;
      const keyPath = `${root}/ca-key.pem`;
      await writeFile(spec.caPath, ca.certPem);
      await writeFile(keyPath, ca.keyPem, { mode: 0o600 });
      await copyFile(
        path.join(PACKAGE, "vendor/java-proxy-agent/srt-proxy-agent.jar"),
        spec.agentPath,
      );
      const tlsBase = {
        ...base,
        javaAgentJarPath: spec.agentPath,
        filesystem: {
          ...base.filesystem,
          denyRead: [...base.filesystem.denyRead, spec.caPath, keyPath, spec.agentPath],
        },
        network: {
          ...base.network,
          mode: "restricted",
          tlsTerminate: { caCertPath: spec.caPath, caKeyPath: keyPath },
        },
      };
      await manager.initialize(tlsBase, undefined, false);
      refreshProgram();
      await run("healthy-global-restricted-absent-override-with-CA-agent", await wrap());
      await run("healthy-global-restricted-undefined-override", await wrap({ mode: undefined }));
      await run(
        "healthy-undefined-credentials-inherits-deny",
        await manager.wrapWithSandboxArgv(command, "/bin/bash", {
          network: { mode: undefined },
          credentials: undefined,
        }),
      );
      await assert.rejects(
        manager.wrapWithSandboxArgv(command, "/bin/bash", {
          network: { mode: undefined },
          filesystem: { ...base.filesystem, disabled: true },
        }),
        { code: "NETWORK_MODE_INCOMPATIBLE" },
      );
      for (const mode of [null, "unknown"])
        await assert.rejects(wrap({ mode }), { code: "NETWORK_MODE_INVALID" });
      const masked = {
        ...tlsBase,
        network: {
          ...tlsBase.network,
          mode: "proxy",
          allowedDomains: ["example.test"],
          deniedDomains: [],
        },
        credentials: { envVars: [{ name: "SRT_SYNTHETIC_DENY", mode: "mask" }] },
      };
      manager.updateConfig(masked);
      await assert.rejects(
        manager.wrapWithSandboxArgv(command, "/bin/bash", {
          network: { mode: "restricted" },
          credentials: undefined,
        }),
        { code: "NETWORK_MODE_INCOMPATIBLE" },
      );
      for (const option of ["allowAppleEvents", "enableWeakerNetworkIsolation"]) {
        manager.updateConfig({
          ...tlsBase,
          [option]: true,
          network: { ...tlsBase.network, mode: "proxy" },
        });
        await assert.rejects(
          manager.wrapWithSandboxArgv(command, "/bin/bash", {
            network: { mode: "restricted" },
            [option]: undefined,
          }),
          { code: "NETWORK_MODE_INCOMPATIBLE" },
        );
      }
      manager.updateConfig({
        ...tlsBase,
        network: { ...tlsBase.network, mode: "proxy", allowLocalBinding: true },
      });
      await assert.rejects(wrap({ mode: "restricted", allowLocalBinding: undefined }), {
        code: "NETWORK_MODE_INCOMPATIBLE",
      });
      manager.updateConfig(tlsBase);
      await run("healthy-proxy-CA-agent-positive", await wrap({ mode: "proxy" }), {
        proxy: true,
        ca: true,
      });
      manager.updateConfig({
        ...tlsBase,
        network: { ...tlsBase.network, mode: "direct", deniedDomains: [] },
      });
      await run("healthy-direct-CA-agent-suppression", await wrap({ mode: undefined }), {
        direct: true,
      });
      const tlsPort = manager.getProxyPort();
      await manager.reset();
      await assertListenerGone(tlsPort);
      process.send({ kind: "reset-complete", port: tlsPort });
      // Failed initialization must not turn retained config into readiness.
      const badCa = `${root}/not-a-cert.pem`;
      await writeFile(badCa, "synthetic-invalid-cert");
      await assert.rejects(
        manager.initialize(
          {
            ...base,
            network: { ...base.network, tlsTerminate: { caCertPath: badCa, caKeyPath: badCa } },
          },
          undefined,
          false,
        ),
      );
      await assert.rejects(wrap({ mode: "restricted" }), { code: "NETWORK_MODE_NOT_READY" });
      if (workerState.primary) throw workerState.primary;
      process.stdout.write(
        `${JSON.stringify({ kind: "sentinel-close-accounting", expectedPeerResets })}\n`,
      );
      process.stdout.write(
        "PASS: native cases (not in-flight Engine/TLS/full Goal proof); cleanup still must complete\n",
      );
    } catch (error) {
      primaryFailure(workerState, "native-cases", error);
    } finally {
      for (const socket of sockets)
        await cleanupStep(workerState, "sentinel-socket-close", () => socket.destroy());
      for (const socket of datagrams)
        await cleanupStep(
          workerState,
          "sentinel-datagram-close",
          () =>
            new Promise((resolve, reject) => {
              try {
                socket.close(resolve);
              } catch (error) {
                if (error.code === "ERR_SOCKET_DGRAM_NOT_RUNNING") resolve();
                else reject(error);
              }
            }),
        );
      for (const server of servers)
        await cleanupStep(
          workerState,
          "sentinel-server-close",
          () =>
            new Promise((resolve, reject) =>
              server.close((error) => {
                if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
                else resolve();
              }),
            ),
        );
      await cleanupStep(workerState, "native-manager-reset", () => manager.reset());
      await cleanupStep(workerState, "native-ipc-close", () => {
        if (process.connected) process.disconnect();
      });
    }
  }
  finish(workerState);
}
