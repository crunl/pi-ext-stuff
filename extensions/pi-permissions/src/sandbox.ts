import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { PermissionsConfig } from "./config.ts";

export interface SandboxManagerLike {
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
  ): Promise<string>;
  reset(): Promise<void>;
}

function resolveSandboxPath(path: string, cwd: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function createSandboxRuntimeConfig(
  config: PermissionsConfig["sandbox"],
  cwd: string,
): SandboxRuntimeConfig {
  return {
    filesystem: {
      allowWrite: config.profile === "read-only"
        ? []
        : config.filesystem.allowWrite.map((path) => resolveSandboxPath(path, cwd)),
      denyRead: config.filesystem.denyRead.map((path) => resolveSandboxPath(path, cwd)),
      denyWrite: config.filesystem.denyWrite.map((path) => resolveSandboxPath(path, cwd)),
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
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      const wrappedCommand = await manager.wrapWithSandbox(
        command,
        undefined,
        undefined,
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
