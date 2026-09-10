import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Public package entrypoint only. Draft runs select an isolated package copy;
// after pnpm integration the default verifies the actual installed dependency.
const entry = process.env.SRT_NETWORK_MODE_PACKAGE;
const { SandboxRuntimeConfigSchema: schema, SandboxManager: manager } = await import(
  entry ? pathToFileURL(`${entry}/dist/index.js`).href : "@anthropic-ai/sandbox-runtime"
);
const base = {
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
};
afterEach(async () => {
  await manager.reset();
});

describe("SRT network-mode public patch contract (no native execution)", () => {
  it("preserves legacy absence and retains each explicit mode rather than stripping it", () => {
    expect(schema.parse(base).network).not.toHaveProperty("mode");
    for (const mode of ["proxy", "restricted", "direct"]) {
      expect(schema.parse({ ...base, network: { ...base.network, mode } }).network.mode).toBe(mode);
    }
    expect(
      schema.safeParse({ ...base, network: { ...base.network, mode: "offline-ish" } }).success,
    ).toBe(false);
  });

  it("detects the public API and fails closed before initialization and after reset retaining config", async () => {
    expect(typeof manager.getNetworkModeCapabilities).toBe("function");
    const capabilities = manager.getNetworkModeCapabilities();
    expect(capabilities.apiVersion).toBe(1);
    expect(capabilities.modes).toEqual(
      process.platform === "darwin" ? ["proxy", "restricted", "direct"] : [],
    );
    for (const mode of ["proxy", "restricted", "direct"]) {
      const cfg = { ...base, network: { ...base.network, mode } };
      await expect(manager.wrapWithSandboxArgv("true", "/bin/bash", cfg)).rejects.toMatchObject({
        code: process.platform === "darwin" ? "NETWORK_MODE_NOT_READY" : "NETWORK_MODE_UNSUPPORTED",
      });
    }
    manager.updateConfig(base);
    await manager.reset();
    expect(manager.isSandboxingEnabled()).toBe(true);
    expect(await manager.waitForNetworkInitialization()).toBe(false);
    await expect(
      manager.wrapWithSandbox("true", "/bin/bash", {
        ...base,
        network: { ...base.network, mode: "restricted" },
      }),
    ).rejects.toMatchObject({
      code: process.platform === "darwin" ? "NETWORK_MODE_NOT_READY" : "NETWORK_MODE_UNSUPPORTED",
    });
  });

  it("allows dormant host guard/domain policy in restricted but rejects native escape permissions", () => {
    const restricted = {
      ...base,
      network: {
        mode: "restricted",
        allowedDomains: ["example.test"],
        deniedDomains: ["*"],
        parentProxy: {
          http: "http://127.0.0.1:12345",
          https: "http://127.0.0.1:12345",
          noProxy: "",
        },
      },
    };
    expect(schema.safeParse(restricted).success).toBe(true);
    for (const permission of [
      { allowLocalBinding: true },
      { allowAllUnixSockets: true },
      { allowUnixSockets: ["/tmp/test.sock"] },
      { allowMachLookup: ["*"] },
    ]) {
      expect(
        schema.safeParse({ ...restricted, network: { ...restricted.network, ...permission } })
          .success,
      ).toBe(false);
    }
    for (const permission of [
      { enableWeakerNetworkIsolation: true },
      { allowAppleEvents: true },
      { filesystem: { ...base.filesystem, disabled: true } },
    ]) {
      expect(schema.safeParse({ ...restricted, ...permission }).success).toBe(false);
    }
  });

  it("inherits dormant guard and hard-deny configuration in a mode-only per-wrap projection", async () => {
    manager.updateConfig({
      ...base,
      network: {
        ...base.network,
        deniedDomains: ["*"],
        parentProxy: {
          http: "http://127.0.0.1:12345",
          https: "http://127.0.0.1:12345",
          noProxy: "",
        },
      },
    });
    await expect(
      manager.wrapWithSandboxArgv("true", "/bin/bash", { network: { mode: "restricted" } }),
    ).rejects.toMatchObject({
      code: process.platform === "darwin" ? "NETWORK_MODE_NOT_READY" : "NETWORK_MODE_UNSUPPORTED",
    });
  });

  it("rejects explicit modes on unsupported platform routes before any initialization or native work", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      // OS boundary simulation only; this is not Linux/Windows enforcement evidence.
      for (const platform of ["linux", "win32", "freebsd"]) {
        Object.defineProperty(process, "platform", { value: platform });
        expect(manager.getNetworkModeCapabilities().modes).toEqual([]);
        for (const mode of ["proxy", "restricted", "direct"]) {
          const cfg = { ...base, network: { ...base.network, mode } };
          await expect(manager.wrapWithSandboxArgv("true", "/bin/bash", cfg)).rejects.toMatchObject(
            { code: "NETWORK_MODE_UNSUPPORTED" },
          );
          await expect(manager.wrapWithSandbox("true", "/bin/bash", cfg)).rejects.toMatchObject({
            code: "NETWORK_MODE_UNSUPPORTED",
          });
          await expect(manager.initialize(cfg)).rejects.toMatchObject({
            code: "NETWORK_MODE_UNSUPPORTED",
          });
          expect(() => manager.updateConfig(cfg)).toThrow(/macOS backend/);
        }
      }
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  });

  it("does not erase initialized host policy via empty direct per-wrap arrays", async () => {
    if (process.platform !== "darwin") return;
    manager.updateConfig({ ...base, network: { ...base.network, deniedDomains: ["*"] } });
    await expect(
      manager.wrapWithSandboxArgv("true", "/bin/bash", {
        network: { mode: "direct", allowedDomains: [], deniedDomains: [] },
      }),
    ).rejects.toMatchObject({ code: "NETWORK_MODE_INCOMPATIBLE" });
  });

  it("rejects explicit runtime policy conflicts even when a caller bypasses schema parsing", async () => {
    if (process.platform !== "darwin") return;
    manager.updateConfig(base);
    for (const network of [
      { mode: "unknown" },
      { mode: "restricted", allowLocalBinding: true },
      { mode: "direct", deniedDomains: ["*"] },
    ]) {
      await expect(
        manager.wrapWithSandboxArgv("true", "/bin/bash", { network }),
      ).rejects.toMatchObject({
        code: network.mode === "unknown" ? "NETWORK_MODE_INVALID" : "NETWORK_MODE_INCOMPATIBLE",
      });
    }
  });

  it("normalizes undefined inherited mode before checking filesystem conflicts", async () => {
    if (process.platform !== "darwin") return;
    manager.updateConfig({ ...base, network: { ...base.network, mode: "restricted" } });
    await expect(
      manager.wrapWithSandboxArgv("true", "/bin/bash", {
        network: { mode: undefined },
        filesystem: { ...base.filesystem, disabled: true },
      }),
    ).rejects.toMatchObject({ code: "NETWORK_MODE_INCOMPATIBLE" });
    for (const mode of [null, "unknown"]) {
      await expect(
        manager.wrapWithSandboxArgv("true", "/bin/bash", { network: { mode } }),
      ).rejects.toMatchObject({ code: "NETWORK_MODE_INVALID" });
    }
  });

  it("validates inherited credentials and sibling options actually consumed by wrapping", async () => {
    if (process.platform !== "darwin") return;
    manager.updateConfig({
      ...base,
      credentials: { envVars: [{ name: "SYNTHETIC", mode: "mask" }] },
    });
    await expect(
      manager.wrapWithSandboxArgv("true", "/bin/bash", {
        network: { mode: "restricted" },
        credentials: undefined,
      }),
    ).rejects.toMatchObject({ code: "NETWORK_MODE_INCOMPATIBLE" });
    for (const option of ["allowAppleEvents", "enableWeakerNetworkIsolation"]) {
      manager.updateConfig({ ...base, [option]: true });
      await expect(
        manager.wrapWithSandboxArgv("true", "/bin/bash", {
          network: { mode: "restricted" },
          [option]: undefined,
        }),
      ).rejects.toMatchObject({ code: "NETWORK_MODE_INCOMPATIBLE" });
    }
    manager.updateConfig({ ...base, network: { ...base.network, allowLocalBinding: true } });
    await expect(
      manager.wrapWithSandboxArgv("true", "/bin/bash", {
        network: { mode: "restricted", allowLocalBinding: undefined },
      }),
    ).rejects.toMatchObject({ code: "NETWORK_MODE_INCOMPATIBLE" });
  });

  it("rejects direct host-scoped authority or hard denies rather than broadening them", () => {
    for (const policy of [
      { allowedDomains: ["example.test"] },
      { deniedDomains: ["*"] },
      { filterRequest: () => ({ action: "deny" }) },
    ]) {
      expect(
        schema.safeParse({ ...base, network: { ...base.network, mode: "direct", ...policy } })
          .success,
      ).toBe(false);
    }
    expect(
      schema.safeParse({
        ...base,
        network: {
          ...base.network,
          mode: "direct",
          allowLocalBinding: true,
          allowUnixSockets: ["/tmp/test.sock"],
        },
      }).success,
    ).toBe(true);
  });
});
