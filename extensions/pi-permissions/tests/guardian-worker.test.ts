import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIsolatedGuardianToolRuntime } from "../src/guardian-tools.ts";
import {
  GuardianWorkerAbortError,
  GuardianWorkerClient,
  GuardianWorkerInfrastructureError,
  GuardianWorkerProtocolError,
  GuardianWorkerTimeoutError,
} from "../src/guardian-worker-client.ts";
import { createGuardianEvidenceScope } from "../src/sandbox.ts";

const temporaryDirectories: string[] = [];

function guardianEvidenceScope(cwd: string, denyRead: readonly string[] = []) {
  return createGuardianEvidenceScope(cwd, {
    filesystem: { allowWrite: [cwd], denyRead: [...denyRead], denyWrite: [] },
    network: { allowedDomains: [], deniedDomains: [] },
  });
}

async function fixtureWorker(
  mode:
    | "roundtrip"
    | "roundtrip-with-child"
    | "hang"
    | "hang-bootstrap"
    | "hang-shutdown"
    | "crash-on-shutdown"
    | "hang-with-child"
    | "exit"
    | "exit-after-result"
    | "malformed"
    | "error"
    | "error-without-id"
    | "oversized",
  errorFrame: Record<string, unknown> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-guardian-worker-test-"));
  temporaryDirectories.push(directory);
  const marker = join(directory, "pid");
  const childMarker = join(directory, "child-pid");
  const childProgram = `const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(childMarker)}, String(process.pid));
setInterval(() => {}, 1_000);`;
  await writeFile(
    join(directory, "worker.mjs"),
    `import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const mode = ${JSON.stringify(mode)};
const errorFrame = ${JSON.stringify(errorFrame)};
const marker = ${JSON.stringify(marker)};
const childProgram = ${JSON.stringify(childProgram)};
writeFileSync(marker, String(process.pid));
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf("\\n");
    if (newline < 0) return;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    const request = JSON.parse(line);
    if (request.type === "shutdown") {
      if (mode === "hang-shutdown") continue;
      if (mode === "crash-on-shutdown") process.exit(23);
      // Cooperative retirement: propose, wait for ACK, then self-SIGKILL.
      const nonce = typeof request.nonce === "string" ? request.nonce : undefined;
      if (!nonce) {
        process.exit(1);
      }
      process.stdout.write(JSON.stringify({ type: "retirement-proposal", nonce }) + "\\n");
      // The ACK arrives as a retirement-ack frame on stdin; pump continues.
      continue;
    }
    if (request.type === "retirement-ack") {
      if (request.nonce && typeof request.nonce === "string") {
        try {
          process.kill(-process.pid, "SIGKILL");
        } catch {
          process.kill(process.pid, "SIGKILL");
        }
      } else {
        process.exit(1);
      }
      continue;
    }
    if (request.type === "bootstrap") {
      if (mode === "hang-bootstrap") continue;
      process.stdout.write(JSON.stringify({ type: "result", id: request.id, stdout: "", stderr: "", exitCode: 0 }) + "\\n");
      continue;
    }
    if (request.type !== "execute") continue;
    if (mode === "exit") process.exit(23);
    if (mode === "hang") continue;
    if (mode === "error" || mode === "error-without-id") {
      process.stdout.write(JSON.stringify({
        type: "error",
        ...(mode === "error" ? { id: request.id } : {}),
        error: "sandbox initialization cleanup timed out",
        ...errorFrame,
      }) + "\\n");
      continue;
    }
    if (mode === "hang-with-child") {
      const child = spawn(process.execPath, ["-e", childProgram], {
        detached: false,
        shell: false,
        stdio: "ignore",
      });
      child.unref();
      continue;
    }
    if (mode === "roundtrip-with-child") {
      const child = spawn(process.execPath, ["-e", childProgram], {
        detached: false,
        shell: false,
        stdio: "ignore",
      });
      child.unref();
    }
    if (mode === "malformed") {
      process.stdout.write("not-json\\n");
      continue;
    }
    if (mode === "oversized") {
      process.stdout.write(JSON.stringify({ type: "result", id: request.id, stdout: Buffer.from("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx").toString("base64"), stderr: "", exitCode: 0 }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ type: "result", id: request.id, stdout: Buffer.from("roundtrip").toString("base64"), stderr: "", exitCode: 0 }) + "\\n");
    if (mode === "exit-after-result") setTimeout(() => process.exit(23), 10);
  }
});
`,
  );
  return { directory, workerPath: join(directory, "worker.mjs"), marker, childMarker };
}

async function waitForMarker(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pid = Number(await readFile(path, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // The fixture has not started yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("worker fixture did not start");
}

async function waitForText(path: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await readFile(path, "utf8")) === expected) return;
    } catch {
      // The worker has not written the marker yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`worker fixture did not write ${path}`);
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`worker fixture ${pid} did not exit`);
}

type SettledOutcome<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

function captureSettled<T>(promise: Promise<T>): Promise<SettledOutcome<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

async function sourceWorkerWithFakeSandbox(
  options: {
    cleanupFails?: boolean;
    resetFails?: boolean;
    resetDelayMs?: number;
    wrapFails?: boolean;
    wrapUntilCancelled?: boolean;
    initializeFails?: boolean;
    supported?: boolean;
    restrictedMode?: boolean;
    errorMessage?: string;
    defaultsSource?: string;
    freshSource?: string;
    deviceSource?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-guardian-worker-source-test-"));
  temporaryDirectories.push(directory);
  const workerPath = join(directory, "worker.mjs");
  const sandboxPath = join(directory, "fake-sandbox.mjs");
  const childMarker = join(directory, "child-pid");
  const configMarker = join(directory, "sandbox-config.json");
  const resetMarker = join(directory, "sandbox-reset");
  const source = await readFile(new URL("../src/guardian-worker.mjs", import.meta.url), "utf8");
  await copyFile(
    new URL("../src/guardian-worker-limits.mjs", import.meta.url),
    join(directory, "guardian-worker-limits.mjs"),
  );
  const sandboxImport = 'import { SandboxManager } from "@anthropic-ai/sandbox-runtime";';
  const fsImport =
    'import { constants, fstatSync, lstatSync, realpathSync, statSync } from "node:fs";';
  await writeFile(
    join(directory, "fake-fs.mjs"),
    `
import * as fs from "node:fs";
export const constants = fs.constants;
const mode = ${JSON.stringify(options.deviceSource)};
if (mode === "wrong-alias") Object.defineProperty(process, "platform", { value: "darwin" });
if (mode === "windows") Object.defineProperty(process, "platform", { value: "win32" });
export const realpathSync = (path, ...args) => mode === "wrong-alias" && path === "/dev/stdout" ? "/ordinary/alias" : fs.realpathSync(path, ...args);
export const lstatSync = (path, ...args) => mode === "ordinary-device" && path === "/dev/null" ? fs.statSync(${JSON.stringify(workerPath)}, ...args) : fs.lstatSync(path, ...args);
export const fstatSync = (fd, ...args) => mode === "ordinary-output" ? fs.statSync(${JSON.stringify(workerPath)}, ...args) : fs.fstatSync(fd, ...args);
export const statSync = (path, ...args) => {
  if ((mode === "ordinary-output" || mode === "wrong-type") && path === "/dev/stdout") return fs.statSync(${JSON.stringify(workerPath)}, ...args);
  const value = fs.statSync(path, ...args);
  if (mode === "mismatch" && path === "/dev/stdout") value.ino += 1n;
  return value;
};
`,
  );
  if (!source.includes(sandboxImport)) throw new Error("guardian worker sandbox import changed");
  if (!source.includes(fsImport)) throw new Error("guardian worker filesystem import changed");
  await writeFile(
    sandboxPath,
    `import { writeFileSync } from "node:fs";
let returnedDefaults;
export const SandboxManager = {
  ${options.restrictedMode ? 'getNetworkModeCapabilities: () => ({ apiVersion: 1, platform: "macos", modes: ["restricted", "proxy", "direct"] }),' : ""}
  getConfig: () => ${options.freshSource ?? "undefined"},
  ${options.defaultsSource ?? `getFsWriteConfig: () => (returnedDefaults = { allowOnly: ["/dev/stdout", "/dev/stderr", "/dev/null", ${JSON.stringify(join(directory, "ordinary-default"))}], denyWithinAllow: [] }),`}
  isSupportedPlatform: () => ${JSON.stringify(options.supported ?? true)},
  checkDependenciesAsync: async () => { returnedDefaults?.allowOnly.push("/mutated-after-bootstrap"); return { errors: [] }; },
  initialize: async (config) => {
    if (![config, config.filesystem, config.filesystem.denyWrite, config.filesystem.allowWrite, config.filesystem.denyRead, config.network, config.network.allowedDomains, config.network.deniedDomains].every(Object.isFrozen)) throw new Error("policy not frozen");
    if (${JSON.stringify(options.initializeFails === true)}) throw new Error(${JSON.stringify(options.errorMessage ?? "forced initialization failure")});
    writeFileSync(${JSON.stringify(configMarker)}, JSON.stringify(config));
  },
  wrapWithSandboxArgv: async (command, _shell, _config, signal) => {
    if (${JSON.stringify(options.wrapUntilCancelled === true)}) {
      writeFileSync(${JSON.stringify(childMarker)}, "wrapping");
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
    if (${JSON.stringify(options.wrapFails === true)}) throw new Error(${JSON.stringify(options.errorMessage ?? "forced wrap failure")});
    return { argv: ["/bin/bash", "-c", command], env: process.env };
  },
  cleanupAfterCommand: () => {
    if (${JSON.stringify(options.cleanupFails === true)}) throw new Error(${JSON.stringify(options.errorMessage ?? "forced cleanup failure")});
      },
      reset: async () => {
        if (${JSON.stringify(options.resetDelayMs ?? 0)} > 0) {
          await new Promise((resolve) => setTimeout(resolve, ${JSON.stringify(options.resetDelayMs ?? 0)}));
        }
        writeFileSync(${JSON.stringify(resetMarker)}, "reset");
    if (${JSON.stringify(options.resetFails === true)}) throw new Error("forced reset failure");
  },
};
`,
  );
  await writeFile(
    workerPath,
    source
      .replace(sandboxImport, 'import { SandboxManager } from "./fake-sandbox.mjs";')
      .replace(
        fsImport,
        options.deviceSource ? fsImport.replace('"node:fs"', '"./fake-fs.mjs"') : fsImport,
      ),
  );
  return { directory, workerPath, childMarker, configMarker, resetMarker };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("GuardianWorkerClient", () => {
  it.each([
    ["missing", ""],
    [
      "missing fresh lifecycle",
      'getConfig: undefined, getFsWriteConfig: () => ({ allowOnly: ["/tmp/log"], denyWithinAllow: [] }),',
    ],
    [
      "fresh lifecycle accessor",
      'get getConfig() { throw new Error("lifecycle accessor"); }, getFsWriteConfig: () => ({ allowOnly: ["/tmp/log"], denyWithinAllow: [] }),',
    ],
    [
      "invalid Unicode",
      'getFsWriteConfig: () => ({ allowOnly: ["/tmp/" + String.fromCharCode(0xD800)], denyWithinAllow: [] }),',
    ],
    ["getter", 'get getFsWriteConfig() { throw new Error("accessor"); },'],
    ["null", "getFsWriteConfig: () => null,"],
    ["empty defaults", "getFsWriteConfig: () => ({ allowOnly: [], denyWithinAllow: [] }),"],
    ["throwing method", 'getFsWriteConfig: () => { throw new Error("getter failure"); },'],
    [
      "config getter",
      'getFsWriteConfig: () => ({ get allowOnly() { throw new Error("list getter"); }, denyWithinAllow: [] }),',
    ],
    [
      "unknown key",
      'getFsWriteConfig: () => ({ allowOnly: ["/tmp/log"], denyWithinAllow: [], unknown: true }),',
    ],
    ["symbol path", "getFsWriteConfig: () => ({ allowOnly: [Symbol()], denyWithinAllow: [] }),"],
    [
      "total bound",
      'getFsWriteConfig: () => ({ allowOnly: Array(32).fill("/" + "x".repeat(3000)), denyWithinAllow: [] }),',
    ],
    [
      "control path",
      'getFsWriteConfig: () => ({ allowOnly: ["/tmp/" + String.fromCharCode(0)], denyWithinAllow: [] }),',
    ],
    [
      "custom list prototype",
      'getFsWriteConfig: () => ({ allowOnly: Object.setPrototypeOf(["/tmp/log"], null), denyWithinAllow: [] }),',
    ],
    ["root", 'getFsWriteConfig: () => ({ allowOnly: ["/"], denyWithinAllow: [] }),'],
    ["glob", 'getFsWriteConfig: () => ({ allowOnly: ["/tmp/*"], denyWithinAllow: [] }),'],
    ["relative", 'getFsWriteConfig: () => ({ allowOnly: ["tmp/log"], denyWithinAllow: [] }),'],
    [
      "symbol",
      'getFsWriteConfig: () => ({ allowOnly: ["/tmp/log"], denyWithinAllow: [], [Symbol()]: true }),',
    ],
    [
      "path getter",
      'getFsWriteConfig: () => ({ allowOnly: Object.defineProperty([], "0", { get() { throw new Error("path accessor"); } }), denyWithinAllow: [] }),',
    ],
    ["sparse", "getFsWriteConfig: () => ({ allowOnly: new Array(1), denyWithinAllow: [] }),"],
    [
      "list symbol",
      'getFsWriteConfig: () => ({ allowOnly: Object.assign(["/tmp/log"], { [Symbol()]: true }), denyWithinAllow: [] }),',
    ],
    [
      "existing denies",
      'getFsWriteConfig: () => ({ allowOnly: [], denyWithinAllow: ["/tmp/log"] }),',
    ],
    [
      "too many",
      'getFsWriteConfig: () => ({ allowOnly: Array(257).fill("/tmp/log"), denyWithinAllow: [] }),',
    ],
    [
      "too long",
      'getFsWriteConfig: () => ({ allowOnly: ["/" + "x".repeat(4097)], denyWithinAllow: [] }),',
    ],
    ["dot alias", 'getFsWriteConfig: () => ({ allowOnly: ["/tmp/../dev"], denyWithinAllow: [] }),'],
  ])("fails bootstrap closed for %s public defaults", async (_name, defaultsSource) => {
    const fixture = await sourceWorkerWithFakeSandbox({ defaultsSource });
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });
    try {
      await expect(
        client.execute({
          cwd: fixture.directory,
          program: { executable: process.execPath, args: ["-e", ""] },
        }),
      ).rejects.toMatchObject({ failure: { stage: "bootstrap", code: "failed" } });
      expect(existsSync(fixture.configMarker)).toBe(false);
      expect(existsSync(fixture.resetMarker)).toBe(false);
    } finally {
      await client.close();
    }
  });

  it.each([
    "ordinary-output",
    "ordinary-device",
    "wrong-type",
    "wrong-alias",
    "mismatch",
    "windows",
  ])("does not exempt an unsafe output/device identity: %s", async (deviceSource) => {
    const fixture = await sourceWorkerWithFakeSandbox({ deviceSource });
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });
    try {
      await client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      });
      const config = JSON.parse(await readFile(fixture.configMarker, "utf8"));
      expect(config.filesystem.denyWrite).toContain(
        deviceSource === "ordinary-device" ? "/dev/null" : "/dev/stdout",
      );
      expect(config.filesystem.denyWrite).toContain(join(fixture.directory, "ordinary-default"));
      if (deviceSource === "windows")
        expect(config.filesystem.denyWrite).toEqual([
          "/dev/stdout",
          "/dev/stderr",
          "/dev/null",
          join(fixture.directory, "ordinary-default"),
        ]);
    } finally {
      await client.close();
    }
  });

  it("keeps copied default denials across repeated output and expected command failure then resets", async () => {
    const fixture = await sourceWorkerWithFakeSandbox({
      defaultsSource:
        'getFsWriteConfig: () => ({ allowOnly: ["/dev/stdout", "/dev/stderr", "/dev/null", "/dev/future-ordinary", "/future/ordinary-root"], denyWithinAllow: [] }),',
    });
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });
    try {
      for (const exitCode of [0, 7, 0]) {
        await expect(
          client.execute({
            cwd: fixture.directory,
            program: {
              executable: "/bin/bash",
              args: ["-c", `printf output; printf error >&2; exit ${exitCode}`],
            },
          }),
        ).resolves.toEqual({
          stdout: Buffer.from("output"),
          stderr: Buffer.from("error"),
          exitCode,
        });
      }
      expect(JSON.parse(await readFile(fixture.configMarker, "utf8")).filesystem).toEqual({
        allowWrite: [],
        denyRead: [],
        denyWrite: ["/dev/future-ordinary", "/future/ordinary-root"],
      });
    } finally {
      await client.close();
    }
    expect(await readFile(fixture.resetMarker, "utf8")).toBe("reset");
  });

  it("cancels the real source worker during external wrap without launching or automatically retrying", async () => {
    const fixture = await sourceWorkerWithFakeSandbox({ wrapUntilCancelled: true });
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });
    const controller = new AbortController();
    try {
      const result = captureSettled(
        client.execute({
          cwd: fixture.directory,
          signal: controller.signal,
          program: {
            executable: process.execPath,
            args: [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(join(fixture.directory, "must-not-launch"))}, "no")`,
            ],
          },
        }),
      );
      await waitForText(fixture.childMarker, "wrapping");
      controller.abort();
      expect(await result).toMatchObject({
        status: "rejected",
        reason: { name: "GuardianWorkerAbortError" },
      });
      expect(existsSync(join(fixture.directory, "must-not-launch"))).toBe(false);
      expect(JSON.parse(await readFile(fixture.configMarker, "utf8")).filesystem.denyWrite).toEqual(
        [join(fixture.directory, "ordinary-default")],
      );
    } finally {
      controller.abort();
      await client.close();
    }
    // Client cancellation owns process termination, not a promise of graceful
    // reset. Normal reset and cleanup poison are tested separately below.
  });

  it.each([false, true])(
    "rejects a non-fresh public singleton without reset or execution (changed during getter=%s)",
    async (changesDuringGetter) => {
      const fixture = await sourceWorkerWithFakeSandbox(
        changesDuringGetter
          ? {
              freshSource: "globalThis.singletonChanged ? {} : undefined",
              defaultsSource:
                'getFsWriteConfig: () => { globalThis.singletonChanged = true; return { allowOnly: ["/tmp/log"], denyWithinAllow: [] }; },',
            }
          : { freshSource: "({})" },
      );
      const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
        workerPath: fixture.workerPath,
      });
      try {
        await expect(
          client.execute({
            cwd: fixture.directory,
            program: { executable: process.execPath, args: ["-e", ""] },
          }),
        ).rejects.toMatchObject({ failure: { stage: "bootstrap", code: "failed" } });
        expect(existsSync(fixture.configMarker)).toBe(false);
        expect(existsSync(fixture.resetMarker)).toBe(false);
      } finally {
        await client.close();
      }
    },
  );

  it("independently constructs strict restricted evidence policy on the public capable backend", async () => {
    const fixture = await sourceWorkerWithFakeSandbox({ restrictedMode: true });
    const client = new GuardianWorkerClient(
      guardianEvidenceScope(fixture.directory, [join(fixture.directory, "denied")]),
      { workerPath: fixture.workerPath },
    );
    try {
      await client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      });
      const config = JSON.parse(await readFile(fixture.configMarker, "utf8")) as {
        network?: Record<string, unknown>;
      };
      expect(config).toEqual({
        filesystem: {
          allowWrite: [],
          denyWrite: [join(fixture.directory, "ordinary-default")],
          denyRead: [join(fixture.directory, "denied")],
        },
        network: {
          allowedDomains: [],
          deniedDomains: ["*"],
          allowLocalBinding: false,
        },
      });
      // Guardian evidence SRT must stay offline even when host uses parentProxy
      // weaker isolation for owned bash.
      expect(config.network).not.toHaveProperty("enableWeakerNetworkIsolation");
      expect(config.network).not.toHaveProperty("parentProxy");
      expect(config.network).not.toHaveProperty("mode");
    } finally {
      await client.close();
    }
  });

  it("round-trips a bounded execution result and shuts down the worker", async () => {
    const fixture = await fixtureWorker("roundtrip");
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });

    await expect(
      client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      }),
    ).resolves.toEqual({
      stdout: Buffer.from("roundtrip"),
      stderr: Buffer.alloc(0),
      exitCode: 0,
    });
    const pid = await waitForMarker(fixture.marker);
    await client.close();
    await waitForExit(pid);
    expect(existsSync(fixture.marker)).toBe(true);
  });

  it("completes cooperative retirement without a post-close group kill", async () => {
    const fixture = await fixtureWorker("roundtrip");
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });
    await client.execute({
      cwd: fixture.directory,
      program: { executable: process.execPath, args: ["-e", ""] },
    });
    const pid = await waitForMarker(fixture.marker);
    const killSpy = vi.spyOn(process, "kill");

    await expect(client.close()).resolves.toBeUndefined();
    await waitForExit(pid);

    // Successful retirement is the worker self-SIGKILL after ACK. The parent
    // must not signal a numeric identity after the close event.
    const postCloseSignals = killSpy.mock.calls.filter(
      ([target, signal]) => signal === "SIGKILL" && (target === -pid || target === pid),
    );
    // The worker's own self-signal may appear; the parent must not add a
    // second stale-identity kill after close. Allow the worker's one kill.
    expect(postCloseSignals.length).toBeLessThanOrEqual(1);
    killSpy.mockRestore();
  });

  it("allows the pinned SRT reset to finish within the graceful close budget", async () => {
    const fixture = await sourceWorkerWithFakeSandbox({ resetDelayMs: 1_200 });
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });

    await client.execute({
      cwd: fixture.directory,
      program: { executable: process.execPath, args: ["-e", ""] },
    });

    await expect(client.close()).resolves.toBeUndefined();
    await expect(readFile(fixture.resetMarker, "utf8")).resolves.toBe("reset");
  });

  it.skipIf(process.platform === "win32")(
    "cleans a background descendant after a clean worker shutdown",
    async () => {
      const fixture = await fixtureWorker("roundtrip-with-child");
      const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
        workerPath: fixture.workerPath,
      });
      await client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      });
      const workerPid = await waitForMarker(fixture.marker);
      const childPid = await waitForMarker(fixture.childMarker);

      await client.close();
      await waitForExit(workerPid);
      await waitForExit(childPid);
    },
  );

  it("shares one bootstrap when first executions start concurrently", async () => {
    const fixture = await fixtureWorker("roundtrip");
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });

    await expect(
      Promise.all([
        client.execute({
          cwd: fixture.directory,
          program: { executable: process.execPath, args: ["-e", ""] },
        }),
        client.execute({
          cwd: fixture.directory,
          program: { executable: process.execPath, args: ["-e", ""] },
        }),
      ]),
    ).resolves.toHaveLength(2);
    await client.close();
  });

  it("brands synchronous worker spawn failures as infrastructure errors", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-guardian-worker-spawn-failure-"));
    temporaryDirectories.push(cwd);
    const client = new GuardianWorkerClient(guardianEvidenceScope(cwd), {
      spawnProcess: () => {
        throw new Error("forced synchronous spawn failure");
      },
    });

    await expect(
      client.execute({
        cwd,
        program: { executable: process.execPath, args: ["-e", ""] },
      }),
    ).rejects.toMatchObject({ failure: { stage: "bootstrap", code: "failed" } });
    await client.close();
  });

  it("terminates a pending worker on caller cancellation", async () => {
    const fixture = await fixtureWorker("hang");
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
      timeoutMs: 10_000,
    });
    const controller = new AbortController();
    try {
      const settled = captureSettled(
        client.execute({
          cwd: fixture.directory,
          program: { executable: process.execPath, args: ["-e", ""] },
          signal: controller.signal,
        }),
      );
      const pid = await waitForMarker(fixture.marker);
      controller.abort();

      const outcome = await settled;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "fulfilled") throw new Error("expected worker cancellation");
      expect(outcome.reason).toBeInstanceOf(GuardianWorkerAbortError);
      await waitForExit(pid);
    } finally {
      await client.close();
    }
  });

  it("terminates a pending worker when the per-call deadline expires", async () => {
    const fixture = await fixtureWorker("hang");
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
      timeoutMs: 10_000,
    });
    try {
      const settled = captureSettled(
        client.execute({
          cwd: fixture.directory,
          program: { executable: process.execPath, args: ["-e", ""] },
          timeoutMs: 1_000,
        }),
      );
      const pid = await waitForMarker(fixture.marker);

      const outcome = await settled;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "fulfilled") throw new Error("expected worker timeout");
      expect(outcome.reason).toBeInstanceOf(GuardianWorkerTimeoutError);
      expect(outcome.reason).toMatchObject({ failure: { stage: "transport", code: "timeout" } });
      await waitForExit(pid);
    } finally {
      await client.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "terminates descendants in the worker process group on timeout",
    async () => {
      const fixture = await fixtureWorker("hang-with-child");
      const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
        workerPath: fixture.workerPath,
        timeoutMs: 10_000,
      });
      try {
        const settled = captureSettled(
          client.execute({
            cwd: fixture.directory,
            program: { executable: process.execPath, args: ["-e", ""] },
            timeoutMs: 2_000,
          }),
        );
        const workerPid = await waitForMarker(fixture.marker);
        const childPid = await waitForMarker(fixture.childMarker);

        const outcome = await settled;
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "fulfilled") throw new Error("expected worker timeout");
        expect(outcome.reason).toBeInstanceOf(GuardianWorkerTimeoutError);
        await waitForExit(workerPid);
        await waitForExit(childPid);
      } finally {
        await client.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "uses the worker process group for wrapped-child output-limit termination",
    async () => {
      const fixture = await sourceWorkerWithFakeSandbox();
      const deniedEvidence = join(fixture.directory, "secret.txt");
      const client = new GuardianWorkerClient(
        guardianEvidenceScope(fixture.directory, [deniedEvidence]),
        {
          workerPath: fixture.workerPath,
          timeoutMs: 10_000,
        },
      );
      const descendantProgram = `const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(fixture.childMarker)}, String(process.pid));
setInterval(() => {}, 1_000);`;
      const releaseMarker = join(fixture.directory, "overflow-release");
      const command = `const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantProgram)}], {
  detached: false,
  shell: false,
  stdio: "ignore",
});
child.unref();
const releasePoll = setInterval(() => {
  if (!existsSync(${JSON.stringify(releaseMarker)})) return;
  clearInterval(releasePoll);
  process.stdout.write("x".repeat(128));
}, 10);
setInterval(() => {}, 1_000);`;

      try {
        const settled = captureSettled(
          client.execute({
            cwd: fixture.directory,
            program: { executable: process.execPath, args: ["-e", command] },
            maxStdoutBytes: 8,
            timeoutMs: 10_000,
          }),
        );
        const descendantPid = await waitForMarker(fixture.childMarker);
        await writeFile(releaseMarker, "release");

        const outcome = await settled;
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "fulfilled") throw new Error("expected output-limit failure");
        expect(outcome.reason).toBeInstanceOf(GuardianWorkerInfrastructureError);
        expect(outcome.reason).toMatchObject({
          failure: { stage: "transport", code: "failed" },
        });
        await expect(readFile(fixture.configMarker, "utf8")).resolves.toBe(
          JSON.stringify({
            filesystem: {
              denyRead: [deniedEvidence],
              allowWrite: [],
              denyWrite: [join(fixture.directory, "ordinary-default")],
            },
            network: {
              allowedDomains: [],
              deniedDomains: ["*"],
              allowLocalBinding: false,
            },
          }),
        );
        await waitForExit(descendantPid);
      } finally {
        await client.close();
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "fails closed before worker startup when the platform cannot enforce a denyRead glob",
    () => {
      const directory = process.cwd();
      expect(() => guardianEvidenceScope(directory, [join(directory, "**/.env")])).toThrow(
        /cannot enforce glob denyRead/i,
      );
    },
  );

  it("reports a sandbox reset failure during worker shutdown", async () => {
    const fixture = await sourceWorkerWithFakeSandbox({ resetFails: true });
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });

    await expect(
      client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    // Structured cleanup/reset failure from the worker is authoritative over
    // a generic shutdown-status message.
    await expect(client.close()).rejects.toThrow(/reset failure|shutdown failed/i);
    await expect(client.close()).rejects.toMatchObject({
      failure: { stage: "cleanup", code: "failed" },
    });
  });

  it("resets SRT after a worker-reported infrastructure failure", async () => {
    const fixture = await sourceWorkerWithFakeSandbox({ wrapFails: true });
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });

    await expect(
      client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      }),
    ).rejects.toThrow(/forced wrap failure/i);
    await waitForText(fixture.resetMarker, "reset");
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("retains a reported reset failure after an earlier execution failure", async () => {
    const fixture = await sourceWorkerWithFakeSandbox({ wrapFails: true, resetFails: true });
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });
    await expect(
      client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      }),
    ).rejects.toMatchObject({ failure: { stage: "execution", code: "failed" } });
    await expect(client.close()).rejects.toMatchObject({
      failure: { stage: "cleanup", code: "failed" },
    });
  });

  it("attempts reset even when SRT cleanup itself fails", async () => {
    const fixture = await sourceWorkerWithFakeSandbox({ cleanupFails: true });
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });

    await expect(
      client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      }),
    ).rejects.toThrow(/forced cleanup failure/i);
    await waitForText(fixture.resetMarker, "reset");
    await expect(client.close()).rejects.toThrow(/forced cleanup failure|shutdown failed/i);
  });

  it.each(["exit", "malformed"] as const)("fails closed on worker %s", async (mode) => {
    const fixture = await fixtureWorker(mode);
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });

    await expect(
      client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      }),
    ).rejects.toMatchObject({
      failure: { stage: "transport", code: mode === "malformed" ? "protocol" : "failed" },
    });
    await client.close();
  });

  it.each([
    [{ initializeFails: true }, { stage: "initialization", code: "failed" }],
    [{ supported: false }, { stage: "initialization", code: "unsupported" }],
    [{ wrapFails: true }, { stage: "execution", code: "failed" }],
    [{ cleanupFails: true }, { stage: "cleanup", code: "failed" }],
    [
      { cleanupFails: true, wrapFails: true },
      { stage: "cleanup", code: "failed" },
    ],
  ] as const)("preserves source SRT failure metadata for %j", async (options, failure) => {
    const fixture = await sourceWorkerWithFakeSandbox({
      ...options,
      errorMessage: "initialization protocol cleanup operation timed out",
    });
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });
    try {
      await expect(
        client.execute({
          cwd: fixture.directory,
          program: { executable: process.execPath, args: ["-e", ""] },
        }),
      ).rejects.toMatchObject({ failure });
    } finally {
      if ("cleanupFails" in options) {
        await expect(client.close()).rejects.toMatchObject({
          failure: { stage: "cleanup", code: "failed" },
        });
      } else {
        await expect(client.close()).resolves.toBeUndefined();
      }
    }
  });

  it.each(["error", "error-without-id"] as const)("accepts structured %s frames", async (mode) => {
    const failure = { stage: "initialization", code: "poisoned" };
    const fixture = await fixtureWorker(mode, { failure });
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });
    await expect(
      client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      }),
    ).rejects.toMatchObject({ failure });
    await expect(client.close()).resolves.toBeUndefined();
  });

  it.each([
    undefined,
    null,
    { stage: "invented", code: "failed" },
    { stage: "cleanup", code: "invented" },
    { stage: "cleanup", code: "failed", secret: "not-allowed" },
  ])("rejects invalid wire failure metadata %j", async (failure) => {
    const fixture = await fixtureWorker("error", { failure });
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });
    await expect(
      client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      }),
    ).rejects.toBeInstanceOf(GuardianWorkerProtocolError);
    await client.close();
  });

  it("reports a bootstrap deadline separately from an execution deadline", async () => {
    const fixture = await fixtureWorker("hang-bootstrap");
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
      timeoutMs: 200,
    });
    await expect(
      client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      }),
    ).rejects.toMatchObject({ failure: { stage: "bootstrap", code: "timeout" } });
    await client.close();
  });

  it("reports an owned shutdown deadline as cleanup/timeout", async () => {
    const fixture = await fixtureWorker("hang-shutdown");
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });
    await client.execute({
      cwd: fixture.directory,
      program: { executable: process.execPath, args: ["-e", ""] },
    });
    await expect(client.close()).rejects.toMatchObject({
      failure: { stage: "cleanup", code: "timeout" },
    });
    await waitForExit(await waitForMarker(fixture.marker));
  });

  it("does not infer a cleanup failure from an unexplained shutdown exit", async () => {
    const fixture = await fixtureWorker("crash-on-shutdown");
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });
    await client.execute({
      cwd: fixture.directory,
      program: { executable: process.execPath, args: ["-e", ""] },
    });
    await expect(client.close()).rejects.toMatchObject({
      failure: { stage: "transport", code: "failed" },
    });
  });

  it("does not lose an asynchronous worker failure before close", async () => {
    const fixture = await fixtureWorker("exit-after-result");
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });

    await expect(
      client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    const pid = await waitForMarker(fixture.marker);
    await waitForExit(pid);
    await expect(client.close()).rejects.toThrow(/exited unexpectedly/i);
  });

  it("does not signal a worker identity after observed exit", async () => {
    const fixture = await fixtureWorker("exit-after-result");
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });
    await expect(
      client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    const pid = await waitForMarker(fixture.marker);
    await waitForExit(pid);
    const killSpy = vi.spyOn(process, "kill");
    try {
      await expect(client.close()).rejects.toThrow(/exited unexpectedly/i);
      const staleSignals = killSpy.mock.calls.filter(
        ([target]) => target === -pid || target === pid,
      );
      expect(staleSignals).toEqual([]);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("refuses to replace a worker that exited without close", async () => {
    const fixture = await fixtureWorker("exit-after-result");
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });
    await expect(
      client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    const pid = await waitForMarker(fixture.marker);
    // Give the exit event time to fire without waiting for close teardown.
    await waitForExit(pid);
    await expect(
      client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      }),
    ).rejects.toThrow(/exited without close|exited unexpectedly|retiring/i);
  });

  it("rejects a response that exceeds the request output bound", async () => {
    const fixture = await fixtureWorker("oversized");
    const client = new GuardianWorkerClient(guardianEvidenceScope(fixture.directory), {
      workerPath: fixture.workerPath,
    });

    await expect(
      client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
        maxStdoutBytes: 8,
      }),
    ).rejects.toThrow(/stdout exceeds the requested bound/i);
    await client.close();
  });

  it.skipIf(process.platform === "win32")(
    "runs the production isolated Guardian runtime and closes after a tool round",
    async () => {
      const fixture = await sourceWorkerWithFakeSandbox();
      const runtime = createIsolatedGuardianToolRuntime(guardianEvidenceScope(fixture.directory), {
        workerPath: fixture.workerPath,
      });
      expect(runtime.tools.length).toBeGreaterThan(0);

      const result = await runtime.execute({
        type: "toolCall",
        id: "isolated-inspect",
        name: "inspect",
        arguments: { command: "printf isolated-ok" },
      });
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result.content)).toContain("isolated-ok");

      await expect(runtime.close?.()).resolves.toBeUndefined();
    },
  );
});
