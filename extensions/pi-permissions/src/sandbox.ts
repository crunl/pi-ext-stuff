import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type {
  BashOperations,
  EditOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { PermissionsConfig } from "./config.ts";
import {
  createFilesystemPolicy,
  resolveSandboxDenyPattern,
} from "./filesystem-policy.ts";

export interface SandboxManagerLike {
  initialize(
    config: SandboxRuntimeConfig,
    askCallback?: (request: { host: string; port: number | undefined }) => Promise<boolean>,
  ): Promise<void>;
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
  ): Promise<string>;
  reset(): Promise<void>;
}

export interface LocalProxyPorts {
  http?: number;
  socks?: number;
}

function localProxyPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return undefined;
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

export function detectLocalProxyPorts(
  env: NodeJS.ProcessEnv = process.env,
): LocalProxyPorts {
  return {
    http: localProxyPort(
      env.HTTPS_PROXY
      ?? env.https_proxy
      ?? env.HTTP_PROXY
      ?? env.http_proxy,
    ),
    socks: localProxyPort(env.ALL_PROXY ?? env.all_proxy),
  };
}

export function withLocalProxy(
  config: SandboxRuntimeConfig,
  ports: LocalProxyPorts,
  allowedDomains: readonly string[] = config.network.allowedDomains,
): SandboxRuntimeConfig {
  return {
    ...config,
    network: {
      ...config.network,
      allowedDomains: [...allowedDomains],
      ...(ports.http ? { httpProxyPort: ports.http } : {}),
      ...(ports.socks ? { socksProxyPort: ports.socks } : {}),
    },
  };
}

export function withAllowedDomains(
  config: SandboxRuntimeConfig,
  allowedDomains: readonly string[],
): SandboxRuntimeConfig {
  return {
    ...config,
    network: {
      ...config.network,
      allowedDomains: [...allowedDomains],
    },
  };
}

export function withAdditionalWriteRoots(
  config: SandboxRuntimeConfig,
  writeRoots: readonly string[],
): SandboxRuntimeConfig {
  const roots = [...new Set(writeRoots)];
  return {
    ...config,
    filesystem: {
      ...config.filesystem,
      allowWrite: [...new Set([...config.filesystem.allowWrite, ...roots])],
      denyWrite: config.filesystem.denyWrite.filter((path) =>
        !roots.includes(path)),
    },
  };
}

export function createSandboxRuntimeConfig(
  config: PermissionsConfig["sandbox"],
  cwd: string,
  protectedWritePaths?: readonly string[],
): SandboxRuntimeConfig {
  const filesystem = createFilesystemPolicy(
    config,
    cwd,
    protectedWritePaths ? [...protectedWritePaths] : undefined,
  );
  return {
    filesystem: {
      allowWrite: filesystem.allowWrite,
      denyRead: filesystem.denyRead.map((pattern) =>
        resolveSandboxDenyPattern(pattern, cwd)),
      denyWrite: filesystem.denyWrite.map((pattern) =>
        resolveSandboxDenyPattern(pattern, cwd)),
    },
    network: {
      allowedDomains: [...config.network.allowedDomains],
      deniedDomains: [...config.network.deniedDomains],
    },
  };
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export function createSandboxedBashOperations(
  manager: SandboxManagerLike,
  customConfig?: SandboxRuntimeConfig,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      const wrappedCommand = await manager.wrapWithSandbox(
        command,
        undefined,
        customConfig,
        signal,
      );

      return new Promise((resolvePromise, reject) => {
        const child = spawn("/bin/bash", ["-c", wrappedCommand], {
          cwd,
          detached: true,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let timedOut = false;
        let settled = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        const finishError = (error: Error): void => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        };

        const onAbort = (): void => killProcessTree(child);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", finishError);
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);

          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            resolvePromise({ exitCode: code });
          }
        });
      });
    },
  };
}

const FILE_OPERATION_HELPER = `
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const [operation, encodedPath] = process.argv.slice(1);
const path = Buffer.from(encodedPath, "base64").toString("utf8");
async function stdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function main() {
  if (operation === "mkdir") await fs.mkdir(path, { recursive: true });
  else if (operation === "write") await fs.writeFile(path, await stdin());
  else if (operation === "read") process.stdout.write(await fs.readFile(path));
  else if (operation === "access") await fs.access(path, constants.R_OK | constants.W_OK);
  else throw new Error("unsupported file operation");
}
main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`.trim();

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function fileOperationConfig(
  baseConfig: SandboxRuntimeConfig,
  writePaths: readonly string[],
): SandboxRuntimeConfig {
  return {
    ...baseConfig,
    filesystem: {
      ...baseConfig.filesystem,
      allowWrite: [...new Set([
        ...baseConfig.filesystem.allowWrite,
        ...writePaths,
      ])],
    },
  };
}

async function runSandboxedFileOperation(
  manager: SandboxManagerLike,
  config: SandboxRuntimeConfig,
  operation: "mkdir" | "write" | "read" | "access",
  path: string,
  input?: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const command = [
    process.execPath,
    "-e",
    FILE_OPERATION_HELPER,
    operation,
    Buffer.from(path).toString("base64"),
  ].map(shellQuote).join(" ");
  const wrappedCommand = await manager.wrapWithSandbox(
    command,
    undefined,
    config,
    signal,
  );

  return new Promise((resolvePromise, reject) => {
    const child = spawn("/bin/bash", ["-c", wrappedCommand], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const onAbort = (): void => killProcessTree(child);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new Error("aborted"));
      } else if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8") || `sandboxed file operation exited with ${code}`));
      } else {
        resolvePromise(Buffer.concat(stdout));
      }
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

export type SandboxedFileOperations = WriteOperations & EditOperations;

export function createSandboxedFileOperations(
  manager: SandboxManagerLike,
  baseConfig: SandboxRuntimeConfig,
  writePaths: readonly string[] = [],
  signal?: AbortSignal,
): SandboxedFileOperations {
  const config = fileOperationConfig(baseConfig, writePaths);
  return {
    mkdir: async (path) => {
      await runSandboxedFileOperation(manager, config, "mkdir", path, undefined, signal);
    },
    writeFile: async (path, content) => {
      await runSandboxedFileOperation(manager, config, "write", path, content, signal);
    },
    readFile: (path) =>
      runSandboxedFileOperation(manager, config, "read", path, undefined, signal),
    access: async (path) => {
      await runSandboxedFileOperation(manager, config, "access", path, undefined, signal);
    },
  };
}
