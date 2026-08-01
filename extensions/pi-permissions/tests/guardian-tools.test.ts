import { chmod, mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createGuardianToolRuntime,
  createSandboxedGuardianToolRuntime,
  type GuardianToolFactory,
} from "../src/guardian-tools.ts";
import type { SandboxManagerLike } from "../src/sandbox.ts";

type PiGuardianToolFactory = (cwd: string) => ReturnType<typeof createReadOnlyTools>;

type FakeToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: undefined;
  isError: boolean;
};

type FakeExecute = (
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal,
) => Promise<FakeToolResult>;

function fakeTool(
  name: string,
  execute: ReturnType<typeof vi.fn<FakeExecute>> = vi.fn(
    async (_toolCallId: string, _params: unknown, _signal?: AbortSignal) => ({
      content: [],
      details: undefined,
      isError: false,
    }),
  ),
) {
  return {
    name,
    label: name,
    description: `${name} description`,
    parameters: Type.Object({ path: Type.String() }),
    execute,
  };
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function fakeRg(directory: string, body: string): Promise<string> {
  const executable = join(directory, "rg");
  await writeFile(executable, `#!${process.execPath}\n${body}`);
  await chmod(executable, 0o755);
  return executable;
}

function passThroughSandboxManager(): SandboxManagerLike & {
  wrapWithSandbox: ReturnType<typeof vi.fn<SandboxManagerLike["wrapWithSandbox"]>>;
} {
  return {
    initialize: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
    wrapWithSandbox: vi.fn(async (command: string) => command),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function hangingSandboxManager(markerPath: string): SandboxManagerLike {
  const script = [
    'const { writeFileSync } = require("node:fs");',
    "writeFileSync(process.argv[1], String(process.pid));",
    "setInterval(() => {}, 1_000);",
  ].join("");
  return {
    initialize: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
    wrapWithSandbox: vi.fn(async () =>
      [process.execPath, "-e", script, markerPath].map(shellQuote).join(" ")),
  };
}

async function waitForPid(markerPath: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const value = await import("node:fs/promises").then(({ readFile }) =>
        readFile(markerPath, "utf8"));
      const pid = Number(value);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // The child has not written its marker yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for child marker ${markerPath}`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!processIsAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processIsAlive(pid);
}

function forceKillProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

describe("createGuardianToolRuntime", () => {
  it("uses the installed Pi Agent read-only tool factory contract", () => {
    expectTypeOf<GuardianToolFactory>().toEqualTypeOf<PiGuardianToolFactory>();
  });

  it("exposes exactly the read-only Guardian tools", () => {
    const runtime = createGuardianToolRuntime("/workspace", () => [
      fakeTool("read"),
      fakeTool("grep"),
      fakeTool("find"),
      fakeTool("ls"),
    ]);

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls"]);
    expect(runtime.tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([
        "bash",
        "write",
        "edit",
        "network",
        "mcp",
        "plugin",
        "skill",
        "approval",
      ]),
    );
  });

  it("executes injected tools with the caller abort signal", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (_toolCallId: string, _params: unknown, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      return {
        content: [{ type: "text" as const, text: "file contents" }],
        details: undefined,
        isError: false,
      };
    });
    const runtime = createGuardianToolRuntime("/workspace", () => [
      fakeTool("read", execute),
      fakeTool("grep"),
      fakeTool("find"),
      fakeTool("ls"),
    ]);

    const result = await runtime.execute(
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
      controller.signal,
    );

    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { path: "README.md" },
      controller.signal,
      undefined,
    );
    expect(result).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "file contents" }],
    });
  });

  it("does not impose a workspace-only boundary on the Codex-equivalent read-only surface", async () => {
    const execute = vi.fn(async (_toolCallId: string, _params: unknown) => ({
      content: [{ type: "text" as const, text: "external read-only evidence" }],
      details: undefined,
      isError: false,
    }));
    const runtime = createGuardianToolRuntime("/workspace", () => [fakeTool("read", execute)]);

    await expect(
      runtime.execute({
        type: "toolCall",
        id: "call-external",
        name: "read",
        arguments: { path: "/etc/hosts" },
      }),
    ).resolves.toMatchObject({
      isError: false,
      content: [{ type: "text", text: "external read-only evidence" }],
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects tools that are not in the Guardian runtime map", async () => {
    const runtime = createGuardianToolRuntime("/workspace", () => [
      fakeTool("read"),
      fakeTool("grep"),
      fakeTool("find"),
      fakeTool("ls"),
    ]);

    await expect(
      runtime.execute(
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "id" } },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/not available/i);
  });
});

describe("createSandboxedGuardianToolRuntime sandbox boundary", () => {
  it("sends unresolved read paths into the sandbox before filesystem probing", async () => {
    const cwd = await temporaryDirectory("pi-guardian-parent-read-probe-");
    const requestedPath = join(cwd, "Capture 1 PM.txt");
    const parentVisibleVariant = join(cwd, "Capture 1\u202fPM.txt");
    await writeFile(parentVisibleVariant, "sandbox-only evidence\n");
    const manager = passThroughSandboxManager();
    const runtime = createSandboxedGuardianToolRuntime(cwd, manager, {
      resolveRgPath: () => undefined,
    });

    const result = await runtime.execute({
      type: "toolCall",
      id: "read-without-parent-probe",
      name: "read",
      arguments: { path: requestedPath },
    });

    expect(result).toMatchObject({ isError: false });
    const firstSandboxedCommand = manager.wrapWithSandbox.mock.calls[0]?.[0] ?? "";
    expect(firstSandboxedCommand).toContain(Buffer.from(requestedPath).toString("base64"));
    expect(firstSandboxedCommand).not.toContain(
      Buffer.from(parentVisibleVariant).toString("base64"),
    );
  });

  it("reads a bounded line window beyond the Guardian binary byte cap", async () => {
    const cwd = await temporaryDirectory("pi-guardian-large-read-offset-");
    const file = join(cwd, "large.txt");
    const precedingLines = 1_100_000;
    await writeFile(file, `${"skip\n".repeat(precedingLines)}target\n`);
    const runtime = createSandboxedGuardianToolRuntime(cwd, passThroughSandboxManager(), {
      resolveRgPath: () => undefined,
    });

    const result = await runtime.execute({
      type: "toolCall",
      id: "read-large-offset",
      name: "read",
      arguments: { path: file, offset: precedingLines + 1, limit: 1 },
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringMatching(/^target/) }),
    ]);
  });

  it.each([
    ["read", { path: "evidence.txt" }],
    ["ls", { path: "." }],
    ["find", { pattern: "*.ts" }],
    ["grep", { pattern: "needle", path: "." }],
  ])("terminates the underlying %s child when Guardian aborts", async (name, arguments_) => {
    const cwd = await temporaryDirectory(`pi-guardian-${name}-abort-`);
    const markerPath = join(cwd, `${name}.pid`);
    const rgPath = await fakeRg(cwd, "setInterval(() => {}, 1_000);\n");
    const runtime = createSandboxedGuardianToolRuntime(
      cwd,
      hangingSandboxManager(markerPath),
      { resolveRgPath: () => rgPath },
    );
    const controller = new AbortController();
    const execution = runtime.execute(
      {
        type: "toolCall",
        id: `${name}-abort-child`,
        name,
        arguments: arguments_,
      },
      controller.signal,
    );
    const pid = await waitForPid(markerPath);

    controller.abort();
    const outcome = await Promise.race([
      execution,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 500)),
    ]);
    const exited = await waitForProcessExit(pid);
    if (!exited) forceKillProcessGroup(pid);
    await Promise.race([
      execution.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);

    expect(outcome).not.toBe("pending");
    expect(exited).toBe(true);
  });

  it("executes all four tools through the sandbox and reads an external absolute path", async () => {
    const cwd = await temporaryDirectory("pi-guardian-cwd-");
    const external = await temporaryDirectory("pi-guardian-external-");
    const externalFile = join(external, "evidence.txt");
    await writeFile(externalFile, "needle evidence\n");
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "match.ts"), "export const match = true;\n");
    const rgPath = await fakeRg(external, `
const path = require("node:path");
const args = process.argv.slice(2);
const searchRoot = args.at(-1);
if (args.includes("--files")) {
  process.stdout.write(path.join(searchRoot, "src", "match.ts") + "\\n");
} else {
  process.stdout.write(JSON.stringify({
    type: "match",
    data: {
      path: { text: searchRoot },
      lines: { text: "needle evidence\\n" },
      line_number: 1,
    },
  }) + "\\n");
}
`);
    const manager = passThroughSandboxManager();
    const runtime = createSandboxedGuardianToolRuntime(cwd, manager, {
      resolveRgPath: () => rgPath,
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls"]);

    let calls = manager.wrapWithSandbox.mock.calls.length;
    const readResult = await runtime.execute({
      type: "toolCall",
      id: "read-external",
      name: "read",
      arguments: { path: externalFile },
    });
    expect(readResult).toMatchObject({ isError: false });
    expect(readResult.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("needle evidence") }),
    ]);
    expect(manager.wrapWithSandbox.mock.calls.length).toBeGreaterThan(calls);

    calls = manager.wrapWithSandbox.mock.calls.length;
    const grepController = new AbortController();
    const grepResult = await runtime.execute(
      {
        type: "toolCall",
        id: "grep-external",
        name: "grep",
        arguments: { pattern: "needle", path: externalFile },
      },
      grepController.signal,
    );
    expect(grepResult).toMatchObject({ isError: false });
    expect(grepResult.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("evidence.txt:1: needle evidence") }),
    ]);
    expect(manager.wrapWithSandbox.mock.calls.length).toBeGreaterThan(calls);
    expect(manager.wrapWithSandbox.mock.calls.at(-1)?.[3]).toBe(grepController.signal);

    calls = manager.wrapWithSandbox.mock.calls.length;
    const findController = new AbortController();
    const findResult = await runtime.execute(
      {
        type: "toolCall",
        id: "find-src",
        name: "find",
        arguments: { pattern: "*.ts" },
      },
      findController.signal,
    );
    expect(findResult).toMatchObject({ isError: false });
    expect(findResult.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("src/match.ts") }),
    ]);
    expect(manager.wrapWithSandbox.mock.calls.length).toBeGreaterThan(calls);
    expect(manager.wrapWithSandbox.mock.calls.at(-1)?.[3]).toBe(findController.signal);

    calls = manager.wrapWithSandbox.mock.calls.length;
    const lsResult = await runtime.execute({
      type: "toolCall",
      id: "ls-src",
      name: "ls",
      arguments: { path: cwd },
    });
    expect(lsResult).toMatchObject({ isError: false });
    expect(lsResult.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("src/") }),
    ]);
    expect(manager.wrapWithSandbox.mock.calls.length).toBeGreaterThan(calls);
    expect(manager.initialize).not.toHaveBeenCalled();
    expect(manager.reset).not.toHaveBeenCalled();
  });

  it("uses sandboxed rg globbing for find without an fd download", async () => {
    const cwd = await temporaryDirectory("pi-guardian-find-");
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "first.ts"), "first\n");
    await writeFile(join(cwd, "src", "second.ts"), "second\n");
    const rgPath = await fakeRg(cwd, `
const path = require("node:path");
const args = process.argv.slice(2);
const required = ["--files", "--hidden", "*.ts", "!**/node_modules/**", "!**/.git/**"];
if (!required.every((value) => args.includes(value))) {
  process.stderr.write("missing required rg file-list arguments");
  process.exit(2);
}
const searchRoot = args.at(-1);
process.stdout.write([
  path.join(searchRoot, "src", "first.ts"),
  path.join(searchRoot, "src", "second.ts"),
].join("\\n") + "\\n");
`);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const manager = passThroughSandboxManager();
    const runtime = createSandboxedGuardianToolRuntime(cwd, manager, {
      resolveRgPath: () => rgPath,
    });

    const result = await runtime.execute({
      type: "toolCall",
      id: "find-no-download",
      name: "find",
      arguments: { pattern: "*.ts", limit: 1 },
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringMatching(/^src\/first\.ts\n\n\[1 results limit reached\]$/),
      }),
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(manager.wrapWithSandbox.mock.calls.at(-1)?.[3]).toBeUndefined();
  });

  it("accepts sandboxed output above the execFile default and below the Guardian bound", async () => {
    const cwd = await temporaryDirectory("pi-guardian-large-rg-output-");
    const rgPath = await fakeRg(cwd, `
const path = require("node:path");
const searchRoot = process.argv.at(-1);
const suffix = "x".repeat(300) + ".ts";
for (let index = 0; index < 4_000; index++) {
  process.stdout.write(path.join(searchRoot, String(index).padStart(4, "0") + "-" + suffix) + "\\n");
}
`);
    const runtime = createSandboxedGuardianToolRuntime(cwd, passThroughSandboxManager(), {
      resolveRgPath: () => rgPath,
    });

    const result = await runtime.execute({
      type: "toolCall",
      id: "find-large-bounded-output",
      name: "find",
      arguments: { pattern: "*.ts", limit: 5_000 },
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringMatching(/^0000-x+\.ts/),
      }),
    ]);
  });

  it("preserves split UTF-8 and consumes complete lines before bounding the residual", async () => {
    const cwd = await temporaryDirectory("pi-guardian-split-output-");
    const rgPath = await fakeRg(cwd, `
const path = require("node:path");
const searchRoot = process.argv.at(-1);
const first = Buffer.from(path.join(searchRoot, "目录", "文件.ts") + "\\n");
const splitAt = first.indexOf(Buffer.from("目")) + 1;
process.stdout.write(first.subarray(0, splitAt));
setTimeout(() => {
  const lines = [];
  for (let index = 0; index < 700; index++) {
    lines.push(path.join(searchRoot, "bulk", String(index).padStart(4, "0") + "-" + "y".repeat(160) + ".ts"));
  }
  process.stdout.write(Buffer.concat([
    first.subarray(splitAt),
    Buffer.from(lines.join("\\n") + "\\n"),
  ]));
}, 20);
`);
    const runtime = createSandboxedGuardianToolRuntime(cwd, passThroughSandboxManager(), {
      resolveRgPath: () => rgPath,
    });

    const result = await runtime.execute({
      type: "toolCall",
      id: "find-split-output",
      name: "find",
      arguments: { pattern: "*.ts", limit: 1_000 },
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringMatching(/^目录\/文件\.ts\n/) }),
    ]);
  });

  it("returns controlled missing-rg errors without downloading tools", async () => {
    const cwd = await temporaryDirectory("pi-guardian-missing-rg-");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const manager = passThroughSandboxManager();
    const runtime = createSandboxedGuardianToolRuntime(cwd, manager, {
      resolveRgPath: () => undefined,
    });

    const grepResult = await runtime.execute({
      type: "toolCall",
      id: "grep-missing",
      name: "grep",
      arguments: { pattern: "needle" },
    });
    const findResult = await runtime.execute({
      type: "toolCall",
      id: "find-missing",
      name: "find",
      arguments: { pattern: "*.ts" },
    });

    for (const result of [grepResult, findResult]) {
      expect(result).toMatchObject({ isError: true });
      expect(result.content).toEqual([
        expect.objectContaining({ text: expect.stringMatching(/ripgrep \(rg\).*not available/i) }),
      ]);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-rg executable from the sandbox resolver boundary", async () => {
    const cwd = await temporaryDirectory("pi-guardian-untrusted-resolver-");
    const manager = passThroughSandboxManager();
    const runtime = createSandboxedGuardianToolRuntime(cwd, manager, {
      resolveRgPath: () => process.execPath,
    });

    const result = await runtime.execute({
      type: "toolCall",
      id: "grep-untrusted-resolver",
      name: "grep",
      arguments: { pattern: "needle" },
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("ripgrep (rg) is not available") }),
    ]);
    expect(manager.wrapWithSandbox).not.toHaveBeenCalled();
  });

  it("preserves sandboxed grep options, context, limits, and exit semantics", async () => {
    const cwd = await temporaryDirectory("pi-guardian-grep-");
    const sourcePath = join(cwd, "source.ts");
    await writeFile(sourcePath, "before\nneedle\nafter\nsecond needle\n");
    const rgPath = await fakeRg(cwd, `
const args = process.argv.slice(2);
const pattern = args.at(-2);
const searchRoot = args.at(-1);
if (pattern === "absent") process.exit(1);
if (pattern === "provider-error") {
  process.stderr.write("authorization=guardian-secret");
  process.exit(2);
}
const required = ["--json", "--line-number", "--color=never", "--hidden", "--ignore-case", "--fixed-strings", "--glob", "*.ts", "--context", "1"];
if (!required.every((value) => args.includes(value))) {
  process.stderr.write("missing required grep arguments");
  process.exit(2);
}
for (const [type, lineNumber, text] of [
  ["context", 1, "before\\n"],
  ["match", 2, "needle\\n"],
  ["context", 3, "after\\n"],
  ["match", 4, "second needle\\n"],
]) {
  process.stdout.write(JSON.stringify({
    type,
    data: {
      path: { text: searchRoot },
      lines: { text },
      line_number: lineNumber,
    },
  }) + "\\n");
}
`);
    const manager = passThroughSandboxManager();
    const runtime = createSandboxedGuardianToolRuntime(cwd, manager, {
      resolveRgPath: () => rgPath,
    });

    const limited = await runtime.execute({
      type: "toolCall",
      id: "grep-options",
      name: "grep",
      arguments: {
        pattern: "needle",
        path: sourcePath,
        glob: "*.ts",
        ignoreCase: true,
        literal: true,
        context: 1,
        limit: 1,
      },
    });
    expect(limited).toMatchObject({ isError: false });
    expect(limited.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining(
          "source.ts-1- before\nsource.ts:2: needle\nsource.ts-3- after",
        ),
      }),
    ]);
    expect(limited.content).not.toEqual([
      expect.objectContaining({ text: expect.stringContaining("source.ts:4") }),
    ]);

    const noMatches = await runtime.execute({
      type: "toolCall",
      id: "grep-no-matches",
      name: "grep",
      arguments: { pattern: "absent", path: sourcePath },
    });
    expect(noMatches).toMatchObject({ isError: false });
    expect(noMatches.content).toEqual([
      expect.objectContaining({ text: "No matches found" }),
    ]);

    const providerError = await runtime.execute({
      type: "toolCall",
      id: "grep-provider-error",
      name: "grep",
      arguments: { pattern: "provider-error", path: sourcePath },
    });
    expect(providerError).toMatchObject({ isError: true });
    expect(providerError.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("authorization: [redacted]") }),
    ]);
  });

  it("uses bounded rg context events without reading a large matched file", async () => {
    const cwd = await temporaryDirectory("pi-guardian-large-context-");
    const sourcePath = join(cwd, "large.ts");
    await writeFile(sourcePath, "before\nneedle\nafter\n");
    await truncate(sourcePath, 256 * 1024 * 1024);
    const rgPath = await fakeRg(cwd, `
const searchRoot = process.argv.at(-1);
for (const [type, lineNumber, text] of [
  ["context", 1, "before\\n"],
  ["match", 2, "needle\\n"],
  ["context", 3, "after\\n"],
]) {
  process.stdout.write(JSON.stringify({
    type,
    data: {
      path: { text: searchRoot },
      lines: { text },
      line_number: lineNumber,
    },
  }) + "\\n");
}
`);
    const manager = passThroughSandboxManager();
    manager.wrapWithSandbox.mockImplementation(async (command: string) =>
      manager.wrapWithSandbox.mock.calls.length > 2
        ? "printf 'large context file read blocked' >&2; exit 2"
        : command);
    const runtime = createSandboxedGuardianToolRuntime(cwd, manager, {
      resolveRgPath: () => rgPath,
    });

    const result = await runtime.execute({
      type: "toolCall",
      id: "grep-large-context",
      name: "grep",
      arguments: { pattern: "needle", path: sourcePath, context: 1 },
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.content).toEqual([
      expect.objectContaining({
        text: "large.ts-1- before\nlarge.ts:2: needle\nlarge.ts-3- after",
      }),
    ]);
    expect(manager.wrapWithSandbox).toHaveBeenCalledTimes(2);
  });

  it("preserves sandboxed grep paths relative to a directory search root", async () => {
    const cwd = await temporaryDirectory("pi-guardian-grep-relative-");
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "source.ts"), "needle\n");
    const rgPath = await fakeRg(cwd, `
process.stdout.write(JSON.stringify({
  type: "match",
  data: {
    path: { text: "src/source.ts" },
    lines: { text: "needle\\n" },
    line_number: 1,
  },
}) + "\\n");
`);
    const runtime = createSandboxedGuardianToolRuntime(cwd, passThroughSandboxManager(), {
      resolveRgPath: () => rgPath,
    });

    const result = await runtime.execute({
      type: "toolCall",
      id: "grep-relative-path",
      name: "grep",
      arguments: { pattern: "needle", path: cwd },
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.content).toEqual([
      expect.objectContaining({ text: "src/source.ts:1: needle" }),
    ]);
  });

  it("returns a sandbox error for a missing find root before running rg", async () => {
    const cwd = await temporaryDirectory("pi-guardian-find-root-");
    const rgPath = await fakeRg(cwd, `
process.stderr.write("rg should not run for a missing root");
process.exit(2);
`);
    const manager = passThroughSandboxManager();
    const runtime = createSandboxedGuardianToolRuntime(cwd, manager, {
      resolveRgPath: () => rgPath,
    });

    const result = await runtime.execute({
      type: "toolCall",
      id: "find-missing-root",
      name: "find",
      arguments: { pattern: "*.ts", path: join(cwd, "missing") },
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("Path not found") }),
    ]);
    expect(manager.wrapWithSandbox).toHaveBeenCalledOnce();
  });

  it("preserves non-not-found grep preflight diagnostics", async () => {
    const cwd = await temporaryDirectory("pi-guardian-grep-preflight-error-");
    const rgPath = await fakeRg(cwd, "process.exit(0);\n");
    const manager = passThroughSandboxManager();
    manager.wrapWithSandbox.mockResolvedValueOnce(
      "printf 'sandbox permission denied' >&2; exit 13",
    );
    const runtime = createSandboxedGuardianToolRuntime(cwd, manager, {
      resolveRgPath: () => rgPath,
    });

    const result = await runtime.execute({
      type: "toolCall",
      id: "grep-preflight-permission",
      name: "grep",
      arguments: { pattern: "needle", path: cwd },
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("sandbox permission denied") }),
    ]);
    expect(result.content).not.toEqual([
      expect.objectContaining({ text: expect.stringContaining("Path not found") }),
    ]);
  });

  it("returns a sandbox tool failure without a direct read-only fallback", async () => {
    const cwd = await temporaryDirectory("pi-guardian-no-fallback-");
    const externalFile = join(await temporaryDirectory("pi-guardian-readable-"), "evidence.txt");
    await writeFile(externalFile, "must not bypass the sandbox\n");
    const manager = passThroughSandboxManager();
    manager.wrapWithSandbox.mockImplementation(async () =>
      "printf 'authorization: guardian-secret' >&2; exit 17");
    const runtime = createSandboxedGuardianToolRuntime(cwd, manager, {
      resolveRgPath: () => undefined,
    });

    const result = await runtime.execute({
      type: "toolCall",
      id: "read-failure",
      name: "read",
      arguments: { path: externalFile },
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("authorization: [redacted]"),
      }),
    ]);
    expect(result.content).not.toEqual([
      expect.objectContaining({ text: expect.stringContaining("must not bypass") }),
    ]);
    expect(manager.wrapWithSandbox).toHaveBeenCalledOnce();
  });

  it.each(["bash", "write", "edit"])(
    "rejects unavailable sandbox Guardian tool %s",
    async (name) => {
      const cwd = await temporaryDirectory(`pi-guardian-${name}-`);
      const runtime = createSandboxedGuardianToolRuntime(cwd, passThroughSandboxManager(), {
        resolveRgPath: () => undefined,
      });

      await expect(
        runtime.execute({
          type: "toolCall",
          id: `call-${name}`,
          name,
          arguments: {},
        }),
      ).rejects.toThrow(`Guardian tool ${name} is not available`);
    },
  );
});
