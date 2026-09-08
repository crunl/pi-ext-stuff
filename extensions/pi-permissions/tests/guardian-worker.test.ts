import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      process.exit(0);
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
    initializeFails?: boolean;
    supported?: boolean;
    errorMessage?: string;
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
  const sandboxImport = 'import { SandboxManager } from "@anthropic-ai/sandbox-runtime";';
  if (!source.includes(sandboxImport)) throw new Error("guardian worker sandbox import changed");
  await writeFile(
    sandboxPath,
    `import { writeFileSync } from "node:fs";
export const SandboxManager = {
  isSupportedPlatform: () => ${JSON.stringify(options.supported ?? true)},
  checkDependenciesAsync: async () => ({ errors: [] }),
  initialize: async (config) => {
    if (${JSON.stringify(options.initializeFails === true)}) throw new Error(${JSON.stringify(options.errorMessage ?? "forced initialization failure")});
    writeFileSync(${JSON.stringify(configMarker)}, JSON.stringify(config));
  },
  wrapWithSandboxArgv: async (command) => {
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
    source.replace(sandboxImport, 'import { SandboxManager } from "./fake-sandbox.mjs";'),
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

  it("cancels the force-close timer after a normal worker exit", async () => {
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

    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    // A clean worker exit can still leave an inspection descendant in the
    // detached worker group, so close always performs the bounded final kill.
    expect(killSpy.mock.calls.some(([target]) => target === -pid)).toBe(true);
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
              denyWrite: [],
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
    await expect(client.close()).rejects.toThrow(/shutdown failed/i);
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
    await expect(client.close()).rejects.toThrow(/shutdown failed/i);
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
});
