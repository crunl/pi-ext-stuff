import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GuardianWorkerAbortError,
  GuardianWorkerClient,
  GuardianWorkerProtocolError,
  GuardianWorkerTimeoutError,
} from "../src/guardian-worker-client.ts";

const temporaryDirectories: string[] = [];

async function fixtureWorker(
  mode: "roundtrip" | "hang" | "hang-with-child" | "exit" | "malformed" | "oversized",
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
    if (request.type === "shutdown") process.exit(0);
    if (request.type !== "execute") continue;
    if (mode === "exit") process.exit(23);
    if (mode === "hang") continue;
    if (mode === "hang-with-child") {
      const child = spawn(process.execPath, ["-e", childProgram], {
        detached: false,
        shell: false,
        stdio: "ignore",
      });
      child.unref();
      continue;
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

async function sourceWorkerWithFakeSandbox() {
  const directory = await mkdtemp(join(tmpdir(), "pi-guardian-worker-source-test-"));
  temporaryDirectories.push(directory);
  const workerPath = join(directory, "worker.mjs");
  const sandboxPath = join(directory, "fake-sandbox.mjs");
  const childMarker = join(directory, "child-pid");
  const source = await readFile(new URL("../src/guardian-worker.mjs", import.meta.url), "utf8");
  const sandboxImport = 'import { SandboxManager } from "@anthropic-ai/sandbox-runtime";';
  if (!source.includes(sandboxImport)) throw new Error("guardian worker sandbox import changed");
  await writeFile(
    sandboxPath,
    `export const SandboxManager = {
  isSupportedPlatform: () => true,
  checkDependenciesAsync: async () => ({ errors: [] }),
  initialize: async () => {},
  wrapWithSandboxArgv: async (command) => ({
    argv: ["/bin/bash", "-c", command],
    env: process.env,
  }),
  cleanupAfterCommand: () => {},
  reset: async () => {},
};
`,
  );
  await writeFile(
    workerPath,
    source.replace(sandboxImport, 'import { SandboxManager } from "./fake-sandbox.mjs";'),
  );
  return { directory, workerPath, childMarker };
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
    const client = new GuardianWorkerClient({ workerPath: fixture.workerPath });

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
    const client = new GuardianWorkerClient({ workerPath: fixture.workerPath });
    await client.execute({
      cwd: fixture.directory,
      program: { executable: process.execPath, args: ["-e", ""] },
    });
    const pid = await waitForMarker(fixture.marker);
    const killSpy = vi.spyOn(process, "kill");

    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(killSpy.mock.calls.some(([target]) => target === -pid)).toBe(false);
    killSpy.mockRestore();
  });

  it("terminates a pending worker on caller cancellation", async () => {
    const fixture = await fixtureWorker("hang");
    const client = new GuardianWorkerClient({ workerPath: fixture.workerPath, timeoutMs: 10_000 });
    const controller = new AbortController();
    const pending = client.execute({
      cwd: fixture.directory,
      program: { executable: process.execPath, args: ["-e", ""] },
      signal: controller.signal,
    });
    const pid = await waitForMarker(fixture.marker);
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(GuardianWorkerAbortError);
    await waitForExit(pid);
    await client.close();
  });

  it("terminates a pending worker when the per-call deadline expires", async () => {
    const fixture = await fixtureWorker("hang");
    const client = new GuardianWorkerClient({ workerPath: fixture.workerPath, timeoutMs: 10_000 });
    const pending = client.execute({
      cwd: fixture.directory,
      program: { executable: process.execPath, args: ["-e", ""] },
      timeoutMs: 1_000,
    });
    const pid = await waitForMarker(fixture.marker);

    await expect(pending).rejects.toBeInstanceOf(GuardianWorkerTimeoutError);
    await waitForExit(pid);
    await client.close();
  });

  it.skipIf(process.platform === "win32")(
    "terminates descendants in the worker process group on timeout",
    async () => {
      const fixture = await fixtureWorker("hang-with-child");
      const client = new GuardianWorkerClient({
        workerPath: fixture.workerPath,
        timeoutMs: 10_000,
      });
      const pending = client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
        timeoutMs: 2_000,
      });
      const workerPid = await waitForMarker(fixture.marker);
      const childPid = await waitForMarker(fixture.childMarker);

      await expect(pending).rejects.toBeInstanceOf(GuardianWorkerTimeoutError);
      await waitForExit(workerPid);
      await waitForExit(childPid);
      await client.close();
    },
  );

  it.skipIf(process.platform === "win32")(
    "uses the worker process group for wrapped-child output-limit termination",
    async () => {
      const fixture = await sourceWorkerWithFakeSandbox();
      const client = new GuardianWorkerClient({
        workerPath: fixture.workerPath,
        timeoutMs: 10_000,
      });
      const descendantProgram = `const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(fixture.childMarker)}, String(process.pid));
setInterval(() => {}, 1_000);`;
      const command = `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantProgram)}], {
  detached: false,
  shell: false,
  stdio: "ignore",
});
child.unref();
setTimeout(() => process.stdout.write("x".repeat(128)), 100);
setInterval(() => {}, 1_000);`;

      try {
        const pending = client.execute({
          cwd: fixture.directory,
          program: { executable: process.execPath, args: ["-e", command] },
          maxStdoutBytes: 8,
          timeoutMs: 10_000,
        });
        const descendantPid = await waitForMarker(fixture.childMarker);

        await expect(pending).rejects.toBeInstanceOf(GuardianWorkerProtocolError);
        await waitForExit(descendantPid);
      } finally {
        await client.close();
      }
    },
  );

  it.each(["exit", "malformed"] as const)("fails closed on worker %s", async (mode) => {
    const fixture = await fixtureWorker(mode);
    const client = new GuardianWorkerClient({ workerPath: fixture.workerPath });

    await expect(
      client.execute({
        cwd: fixture.directory,
        program: { executable: process.execPath, args: ["-e", ""] },
      }),
    ).rejects.toBeInstanceOf(GuardianWorkerProtocolError);
    await client.close();
  });

  it("rejects a response that exceeds the request output bound", async () => {
    const fixture = await fixtureWorker("oversized");
    const client = new GuardianWorkerClient({ workerPath: fixture.workerPath });

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
