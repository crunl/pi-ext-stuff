import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildNonoProfile,
  NONO_PROBE_TIMEOUT_MS,
  NonoSandboxManager,
  PROFILE_PREPARATION_TIMEOUT_MS,
} from "../src/sandbox/nono-enforcer.ts";
import type { SandboxPolicy } from "../src/sandbox.ts";
import { createGuardianReadOnlySandboxConfig } from "../src/sandbox.ts";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  }),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  unlink: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));

const spawnMock = vi.mocked(spawn);
const writeFileMock = vi.mocked(writeFile);

function policy(network: Partial<SandboxPolicy["network"]> = {}): SandboxPolicy {
  return {
    filesystem: {
      allowWrite: ["/workspace"],
      denyRead: ["~/.ssh"],
      denyWrite: [".env"],
    },
    network: {
      allowedDomains: [],
      deniedDomains: ["127.0.0.1", "169.254.169.254"],
      ...network,
    },
  };
}

describe("buildNonoProfile", () => {
  it("translates an empty allowlist into a kernel network block", () => {
    expect(buildNonoProfile(policy())).toEqual({
      filesystem: {
        allow: ["/workspace"],
        deny: ["~/.ssh", ".env"],
      },
      network: { block: true },
    });
  });

  it("uses allow_domain without block when hosts are granted", () => {
    const profile = buildNonoProfile(
      policy({ allowedDomains: ["api.example.com"], deniedDomains: ["127.0.0.1"] }),
    );
    expect(profile).toEqual({
      filesystem: {
        allow: ["/workspace"],
        deny: ["~/.ssh", ".env"],
      },
      network: {
        allow_domain: ["api.example.com"],
        deny_domain: ["127.0.0.1"],
      },
    });
    expect(profile).not.toHaveProperty("network.block");
    expect((profile as { network: Record<string, unknown> }).network.block).toBeUndefined();
  });

  it("omits IPv6 literals from deny_domain while keeping hostnames and IPv4", () => {
    const profile = buildNonoProfile(
      policy({
        allowedDomains: ["api.example.com"],
        deniedDomains: ["::1", "localhost", "127.0.0.1"],
      }),
    );
    const network = (profile as { network: Record<string, unknown> }).network;

    expect(network).toEqual({
      allow_domain: ["api.example.com"],
      deny_domain: ["localhost", "127.0.0.1"],
    });
    expect(JSON.stringify(profile)).not.toContain("::1");
  });

  it("does not render deny_domain alongside a fully blocked network", () => {
    const profile = buildNonoProfile(policy({ deniedDomains: ["::1", "localhost", "127.0.0.1"] }));
    expect((profile as { network: Record<string, unknown> }).network).toEqual({ block: true });
  });

  it("renders only final allow and deny entries, not grantability metadata", () => {
    const profile = buildNonoProfile({
      filesystem: {
        allowWrite: ["/workspace", "/workspace/.git"],
        denyRead: [],
        denyWrite: ["/workspace/.agents"],
        grantableDenyWrite: ["/workspace/.git"],
      },
      network: { allowedDomains: [], deniedDomains: [] },
    });
    const filesystem = (profile as { filesystem: Record<string, unknown> }).filesystem;
    expect(filesystem.allow).toEqual(["/workspace", "/workspace/.git"]);
    expect(filesystem.deny).toEqual(["/workspace/.agents"]);
    expect(JSON.stringify(profile)).not.toMatch(/grantableDenyWrite/);
  });

  it("omits $HOME from filesystem.allow even if the policy lists it", () => {
    const home = homedir();
    const agent = join(home, ".pi", "agent");
    const profile = buildNonoProfile({
      filesystem: {
        allowWrite: [home, "/tmp", agent],
        denyRead: [],
        denyWrite: [],
      },
      network: { allowedDomains: [], deniedDomains: [] },
    });
    const allow = (profile as { filesystem: { allow?: string[] } }).filesystem.allow ?? [];
    expect(allow).not.toContain(home);
    expect(allow).toContain("/tmp");
    expect(allow).toContain(agent);
  });

  it("blocks network for the Guardian read-only policy", () => {
    const profile = buildNonoProfile(createGuardianReadOnlySandboxConfig());
    expect((profile as { network: { block?: boolean } }).network).toEqual({ block: true });
  });
});

describe("NonoSandboxManager.wrapWithSandbox", () => {
  it("kills a hung nono probe at its fixed deadline", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      kill: vi.fn(() => true),
    });
    spawnMock.mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>);
    const manager = new NonoSandboxManager();
    const pending = manager.wrapWithSandbox("printf ok", undefined, policy());
    const expectation = expect(pending).rejects.toThrow(
      `nono probe timed out after ${NONO_PROBE_TIMEOUT_MS}ms`,
    );

    try {
      await vi.advanceTimersByTimeAsync(NONO_PROBE_TIMEOUT_MS);

      await expectation;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets one caller abort without cancelling the shared probe", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      kill: vi.fn(() => true),
    });
    spawnMock.mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>);
    const manager = new NonoSandboxManager();
    const controller = new AbortController();
    const aborted = manager.wrapWithSandbox("printf first", undefined, policy(), controller.signal);
    const abortedExpectation = expect(aborted).rejects.toThrow("aborted");

    try {
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await abortedExpectation;

      const stillShared = manager.wrapWithSandbox("printf second", undefined, policy());
      const sharedExpectation = expect(stillShared).rejects.toThrow(
        `nono probe timed out after ${NONO_PROBE_TIMEOUT_MS}ms`,
      );
      await vi.advanceTimersByTimeAsync(NONO_PROBE_TIMEOUT_MS);
      await sharedExpectation;
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns caller abort while profile preparation is stalled", async () => {
    const controller = new AbortController();
    writeFileMock.mockImplementationOnce(() => new Promise<never>(() => {}));
    const manager = new NonoSandboxManager();
    const pending = manager.wrapWithSandbox("printf ok", undefined, policy(), controller.signal);

    try {
      await vi.waitFor(() => expect(writeFileMock).toHaveBeenCalled());
      controller.abort();

      await expect(pending).rejects.toThrow("aborted");
    } finally {
      writeFileMock.mockReset();
      writeFileMock.mockImplementation(async () => undefined);
    }
  });

  it("fails closed when profile preparation reaches its fixed deadline", async () => {
    vi.useFakeTimers();
    writeFileMock.mockImplementationOnce(() => new Promise<never>(() => {}));
    const manager = new NonoSandboxManager();
    const pending = manager.wrapWithSandbox("printf ok", undefined, policy());
    const expectation = expect(pending).rejects.toThrow(
      `profile preparation timed out after ${PROFILE_PREPARATION_TIMEOUT_MS}ms`,
    );

    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(PROFILE_PREPARATION_TIMEOUT_MS);

      await expectation;
    } finally {
      writeFileMock.mockReset();
      writeFileMock.mockImplementation(async () => undefined);
      vi.useRealTimers();
    }
  });

  it("keeps the user command inside the sandboxed argv", async () => {
    const manager = new NonoSandboxManager();
    const wrapped = await manager.wrapWithSandbox(
      "echo a && curl evil.example",
      undefined,
      policy({ allowedDomains: ["api.example.com"] }),
    );
    expect(spawn).toHaveBeenCalled();
    expect(wrapped).toMatch(/^nono run --silent --profile '.*' -- \/bin\/bash -c /);
    expect(wrapped.endsWith(" -- /bin/bash -c 'echo a && curl evil.example'")).toBe(true);
  });
});
